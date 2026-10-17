import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createMatter, getMatter, saveMatter, listMatters, deleteMatter, writeSettings, saveOriginal, readOriginal } from "./store.js";
import { loadPlaybook, variantsToReview, isVisible } from "./playbook.js";
import { parseUpload } from "./parse.js";
import { reviewAll, aiMode, AiNotConfiguredError, MODEL } from "./review.js";
import { assemble, questionsToAsk } from "./assemble.js";
import { buildDocx } from "./docx.js";
import { patchDocx } from "./patch.js";
import { emailConfig, readyEmail, send, isEmail, listOutbox } from "./notify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3330;

// Read once at startup so a typo in the YAML fails loudly instead of mid-review.
const pb = loadPlaybook();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "..", "public")));

function load(req, res) {
  const matter = getMatter(req.params.id);
  if (!matter) res.status(404).json({ error: "Contract not found" });
  return matter;
}

function sendError(res, err) {
  if (err instanceof AiNotConfiguredError) return res.status(412).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: err.message || "Something went wrong" });
}

const running = new Set();

function startReview(matter) {
  if (running.has(matter.id)) return;
  running.add(matter.id);
  matter.review.status = "running";
  matter.review.error = null;
  saveMatter(matter);
  reviewAll(pb, matter.paragraphs, (variantId, result) => {
    matter.review.results[variantId] = result;
    matter.review.done = Object.values(matter.review.results).filter((r) => r.status === "done").length;
    saveMatter(matter);
  }, matter.review.results)
    .then(() => { matter.review.status = "done"; })
    .catch((err) => {
      matter.review.status = "error";
      matter.review.error = err instanceof Anthropic.AuthenticationError ? "The Anthropic API key was rejected. Check it in Settings." : err.message;
    })
    .finally(() => {
      running.delete(matter.id);
      saveMatter(matter);
      if (matter.review.status === "done") notifyReady(matter);
    });
}

// How many questions the submitter will see: follow-ups only appear for some answers,
// so this can be a range.
function questionCount(matter) {
  const ask = questionsToAsk(pb, matter.review.results);
  const needed = pb.questions.filter((q) => ask[q.id]);
  return { fewest: needed.filter((q) => !q.show_if).length, most: needed.length };
}

// Once per contract, when its review finishes. Failures are recorded, not thrown, so a
// mail problem never blocks the review; the submitter can still open the page directly.
async function notifyReady(matter, { force = false } = {}) {
  if (!matter.email || (matter.notification?.sent_at && !force)) return;
  const config = emailConfig();
  try {
    const result = await send(readyEmail(matter, { ...questionCount(matter), appUrl: config.appUrl }), config);
    matter.notification = { to: matter.email, sent_at: new Date().toISOString(), via: result.via, error: null };
  } catch (err) {
    console.error(err);
    matter.notification = { to: matter.email, sent_at: null, via: config.mode, error: err.message };
  }
  saveMatter(matter);
}

// A review that was mid-flight when the server stopped resumes where it left off.
for (const m of listMatters()) if (m.status === "running") startReview(getMatter(m.id));

function publicMatter(matter) {
  const { review } = matter;
  const ask = review.status === "done" ? questionsToAsk(pb, review.results) : {};
  const failed = Object.values(review.results).filter((r) => r.status === "error").length;
  return {
    id: matter.id,
    filename: matter.filename,
    submitter: matter.submitter,
    email: matter.email || "",
    notification: matter.notification || null,
    created_at: matter.created_at,
    review: { status: review.status, done: review.done, total: review.total, failed, error: review.error },
    questions: pb.questions.map((q) => ({
      id: q.id, ask: q.ask, why: q.why, show_if: q.show_if || null, needed: !!ask[q.id],
      answers: q.answers.map((a) => ({ id: a.id, label: a.label, escalates: !!a.escalate })),
    })),
    answers: matter.answers,
    delivered_at: matter.delivered_at,
  };
}

app.get("/api/status", (req, res) => {
  res.json({
    ai: aiMode(), model: MODEL,
    email: { mode: emailConfig().mode, from: emailConfig().from, appUrl: emailConfig().appUrl },
    playbook: { name: pb.name, questions: pb.questions.length, positions: pb.positions.length, variants: variantsToReview(pb).length },
  });
});

// Every field is optional; blank fields leave the saved value alone.
app.post("/api/settings", (req, res) => {
  const field = (k) => String(req.body?.[k] || "").trim();
  const patch = {};
  if (field("apiKey")) {
    if (!field("apiKey").startsWith("sk-ant-")) return res.status(400).json({ error: "That does not look like an Anthropic API key." });
    patch.anthropic_api_key = field("apiKey");
  }
  if (field("resendKey")) {
    if (!field("resendKey").startsWith("re_")) return res.status(400).json({ error: "That does not look like a Resend API key (they start with re_)." });
    patch.resend_api_key = field("resendKey");
  }
  if (field("emailFrom")) patch.email_from = field("emailFrom");
  if (field("appUrl")) {
    if (!/^https?:\/\//.test(field("appUrl"))) return res.status(400).json({ error: "The app link must start with http:// or https://" });
    patch.app_url = field("appUrl");
  }
  writeSettings(patch);
  res.json({ ai: aiMode(), email: emailConfig().mode });
});

app.get("/api/outbox", (req, res) => res.json(listOutbox()));

app.get("/api/matters", (req, res) => res.json(listMatters()));

// The upload is the raw file body; the name travels in a header so no multipart parser is needed.
app.post("/api/matters", express.raw({ type: "application/octet-stream", limit: "20mb" }), async (req, res) => {
  try {
    if (aiMode() === "missing") return res.status(412).json({ error: "Add an Anthropic API key in Settings first." });
    const filename = decodeURIComponent(String(req.get("x-filename") || "contract.docx"));
    if (!req.body?.length) return res.status(400).json({ error: "The file was empty." });
    const email = decodeURIComponent(String(req.get("x-email") || "")).trim();
    if (email && !isEmail(email)) return res.status(400).json({ error: "That email address does not look right." });
    const paragraphs = await parseUpload(filename, req.body);
    const matter = createMatter({
      filename, submitter: decodeURIComponent(String(req.get("x-submitter") || "")), email, paragraphs, total: variantsToReview(pb).length,
    });
    if (/\.docx$/i.test(filename)) saveOriginal(matter.id, req.body);
    startReview(matter);
    res.json(publicMatter(matter));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/matters/:id", (req, res) => {
  const matter = load(req, res);
  if (matter) res.json(publicMatter(matter));
});

app.post("/api/matters/:id/resume", (req, res) => {
  const matter = load(req, res);
  if (!matter) return;
  startReview(matter);
  res.json(publicMatter(matter));
});

app.post("/api/matters/:id/notify", async (req, res) => {
  const matter = load(req, res);
  if (!matter) return;
  if (matter.review.status !== "done") return res.status(409).json({ error: "The review is not finished yet." });
  if (!matter.email) return res.status(400).json({ error: "No email address was given for this contract." });
  await notifyReady(matter, { force: true });
  res.json(publicMatter(matter));
});

app.delete("/api/matters/:id", (req, res) => {
  if (running.has(req.params.id)) return res.status(409).json({ error: "Still reviewing. Try again when it finishes." });
  deleteMatter(req.params.id);
  res.json({ ok: true });
});

app.post("/api/matters/:id/answers", (req, res) => {
  const matter = load(req, res);
  if (!matter) return;
  if (matter.review.status !== "done") return res.status(409).json({ error: "The review is not finished yet." });
  const given = req.body?.answers || {};
  const ask = questionsToAsk(pb, matter.review.results);
  const full = assemble(pb, matter, given).answers;
  const missing = pb.questions.filter((q) => ask[q.id] && isVisible(q, full) && !q.answers.some((a) => a.id === given[q.id]));
  if (missing.length) return res.status(400).json({ error: `Please answer: ${missing.map((q) => q.ask).join(" ")}` });
  matter.answers = given;
  matter.delivered_at = new Date().toISOString();
  saveMatter(matter);
  res.json(summary(matter));
});

function summary(matter) {
  const a = assemble(pb, matter, matter.answers);
  return {
    escalations: a.escalations,
    topics: a.topics,
    changes: a.edits.length,
    conflicts: a.conflicts,
    warnings: a.warnings,
  };
}

app.get("/api/matters/:id/summary", (req, res) => {
  const matter = load(req, res);
  if (!matter) return;
  if (!matter.answers) return res.status(409).json({ error: "Answer the questions first." });
  res.json(summary(matter));
});

app.get("/api/matters/:id/download", async (req, res) => {
  const matter = load(req, res);
  if (!matter) return;
  if (!matter.answers) return res.status(409).json({ error: "Answer the questions first." });
  try {
    const assembled = assemble(pb, matter, matter.answers);
    // Write into the original Word file when we have it; .txt uploads (and contracts
    // submitted before originals were kept) get a freshly built document instead.
    const original = readOriginal(matter.id);
    const buf = original && matter.paragraphs.every((p) => Number.isInteger(p.xml_index))
      ? await patchDocx(original, matter.paragraphs, assembled)
      : await buildDocx(matter.paragraphs, assembled);
    const base = matter.filename.replace(/\.[^.]+$/, "");
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.set("Content-Disposition", `attachment; filename="${base.replace(/[^\w .-]/g, "_")} (redline).docx"`);
    res.send(buf);
  } catch (err) {
    sendError(res, err);
  }
});

// Lawyer view: every variant that was pre-reviewed, whichever answers end up chosen.
app.get("/api/matters/:id/variants", (req, res) => {
  const matter = load(req, res);
  if (!matter) return;
  res.json({
    paragraphs: matter.paragraphs,
    positions: pb.positions.map((p) => ({
      id: p.id,
      topic: p.topic,
      cases: p.cases.map((c) => ({
        id: c.id, when: c.when || null, accept: !!c.accept, position: c.position || "",
        result: c.accept ? null : matter.review.results[c.id] || null,
      })),
    })),
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Intake Last on http://127.0.0.1:${PORT} (AI: ${aiMode()})`);
});
