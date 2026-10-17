import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import JSZip from "jszip";
import { loadPlaybook, validate, completeAnswers, variantsToReview } from "../server/playbook.js";
import { parseText } from "../server/parse.js";
import { reviewMock, normalize } from "../server/review.js";
import { assemble, questionsToAsk, redlineParagraphs } from "../server/assemble.js";
import { buildDocx } from "../server/docx.js";

const pb = loadPlaybook();
const paragraphs = parseText(fs.readFileSync(new URL("../samples/cloudnimbus-saas.txt", import.meta.url), "utf8"));

function mockResults() {
  const results = {};
  for (const { position, case: c } of variantsToReview(pb)) {
    results[c.id] = { status: "done", ...normalize(reviewMock(paragraphs, position, c), paragraphs) };
  }
  return results;
}
const matter = (results) => ({ paragraphs, review: { results } });

test("playbook loads and every position ends with a fallback case", () => {
  assert.ok(pb.questions.length >= 4);
  for (const p of pb.positions) assert.equal(p.cases.at(-1).when, undefined);
  assert.equal(variantsToReview(pb).length, pb.positions.flatMap((p) => p.cases).filter((c) => !c.accept).length);
});

test("validate rejects a case that names an unknown answer", () => {
  const bad = { questions: [{ id: "q", ask: "?", answers: [{ id: "a" }] }], positions: [{ id: "p", topic: "t", cases: [{ when: { q: ["zzz"] }, position: "x" }, { position: "y" }] }] };
  assert.throws(() => validate(bad), /zzz is not an answer/);
});

test("hidden questions fall back to their default", () => {
  const a = completeAnswers(pb, { data: "none", ai: "yes" });
  assert.equal(a.ai, "no", "ai is hidden when no data is shared, so the given answer is ignored");
  assert.equal(completeAnswers(pb, { data: "personal", ai: "yes" }).ai, "yes");
});

test("different answers pick different pre-reviewed cases", () => {
  const results = mockResults();
  const pilot = assemble(pb, matter(results), { spend: "under_25k", data: "none", commitment: "pilot", critical: "inconvenient" });
  const big = assemble(pb, matter(results), { spend: "100k_250k", data: "personal", ai: "yes", commitment: "ongoing", critical: "critical" });
  const caseFor = (a, topic) => a.topics.find((t) => t.topic === topic).case;
  assert.equal(caseFor(pilot, "Limitation of liability"), "liability_cap#1");
  assert.equal(caseFor(big, "Limitation of liability"), "liability_cap#4");
  assert.ok(pilot.topics.find((t) => t.topic === "Data protection and security").accepted);
  assert.ok(!big.topics.find((t) => t.topic === "Uptime and service levels").accepted);
  assert.ok(big.edits.length > pilot.edits.length);
});

test("escalating answers are reported", () => {
  const a = assemble(pb, matter(mockResults()), { spend: "over_250k", data: "sensitive", ai: "no", commitment: "ongoing", critical: "critical" });
  assert.equal(a.escalations.length, 2);
});

test("a question is skipped when no answer changes the redline", () => {
  const results = mockResults();
  assert.ok(questionsToAsk(pb, results).commitment);
  // Pretend the contract already met both renewal and both price positions.
  for (const id of ["renewal#1", "renewal#2", "price_increase#1", "price_increase#2"]) results[id] = { status: "done", assessment: "", edits: [], warnings: [] };
  const ask = questionsToAsk(pb, results);
  assert.equal(ask.commitment, undefined);
  assert.ok(ask.spend, "spend escalates, so it is always asked");
});

test("a question that controls another asked question's visibility is kept", () => {
  const results = mockResults();
  for (const c of pb.positions.find((p) => p.id === "data_protection").cases) if (!c.accept) results[c.id] = { status: "done", assessment: "", edits: [], warnings: [] };
  assert.ok(questionsToAsk(pb, results).data);
});

test("normalize drops edits whose text is not in the paragraph, and overlapping edits", () => {
  const n = normalize({ edits: [
    { paragraph: 3, find: "not in there", replace: "x", comment: "" },
    { paragraph: 3, find: "Subject to this Agreement", replace: "Under this Agreement", comment: "" },
    { paragraph: 3, find: "this Agreement and", replace: "y", comment: "" },
  ], insertions: [] }, paragraphs);
  assert.equal(n.edits.length, 1);
  assert.equal(n.warnings.length, 2);
});

test("edits from two topics on the same words are flagged, not both applied", () => {
  const results = mockResults();
  const target = results["unilateral_changes#1"].edits[0];
  results["publicity#1"] = { status: "done", assessment: "", warnings: [], edits: [{ ...target, replace: "something else" }] };
  const a = assemble(pb, matter(results), { spend: "under_25k", data: "none", commitment: "pilot", critical: "inconvenient" });
  assert.equal(a.conflicts.length, 1);
});

test("redline runs keep unchanged text and mark deletions and insertions", () => {
  const edits = [{ type: "replace", paragraph: 3, start: 4, end: 16, find: "Subscription", replace: "Access", comment: "c", topic: "t", commentId: 0 }];
  const out = redlineParagraphs(paragraphs, edits);
  assert.equal(out.length, paragraphs.length);
  assert.deepEqual(out[3].runs.map((r) => r.kind), ["same", "del", "ins", "same"]);
  assert.equal(out[3].runs.map((r) => (r.kind === "ins" ? "" : r.text)).join(""), paragraphs[3].text);
});

test("the delivered .docx has tracked changes and comments", async () => {
  const a = assemble(pb, matter(mockResults()), { spend: "25k_100k", data: "personal", ai: "yes", commitment: "ongoing", critical: "critical" });
  const zip = await JSZip.loadAsync(await buildDocx(paragraphs, a));
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /<w:ins /);
  assert.match(xml, /<w:del /);
  assert.match(xml, /<w:delText/);
  const comments = await zip.file("word/comments.xml").async("string");
  assert.equal((comments.match(/<w:comment /g) || []).length, a.edits.length);
});
