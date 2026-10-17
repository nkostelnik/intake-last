// Three screens: submit a contract, wait for (or come back to) the review, then answer
// the intake questions to get the version that fits the deal. Plus a lawyer view.
const app = document.getElementById("app");
let status = null;
let pollTimer = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

async function refreshStatus() {
  status = await api("/api/status");
  const badge = document.getElementById("ai-badge");
  badge.textContent = { live: "Claude connected", mock: "Demo mode (mock reviewer)", missing: "No API key" }[status.ai];
  badge.className = `badge ${status.ai}`;
  document.getElementById("outbox-link").hidden = status.email.mode !== "outbox";
}

// ---------- routing ----------

function route() {
  clearTimeout(pollTimer);
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "m" && parts[1]) return parts[2] === "lawyer" ? lawyerView(parts[1]) : matterView(parts[1]);
  if (parts[0] === "outbox") return outbox();
  home();
}
window.addEventListener("hashchange", route);

// ---------- home: submit ----------

async function home() {
  const matters = await api("/api/matters");
  app.innerHTML = `
    <section class="hero">
      <h1>Send us the contract. That's it.</h1>
      <p>We review it against the ${esc(status.playbook.name)} playbook right away. No forms up front. When it's ready, a few quick questions get you the version that fits your deal.</p>
    </section>
    <section class="card">
      <form id="upload">
        <label class="drop" id="drop">
          <input type="file" id="file" accept=".docx,.txt" hidden>
          <strong id="drop-label">Drop a .docx here, or click to choose</strong>
          <span class="muted">Vendor or SaaS agreement on the vendor's paper</span>
        </label>
        <div class="row">
          <input id="submitter" placeholder="Your name">
          <input id="email" type="email" placeholder="Your email" autocomplete="email">
        </div>
        <div class="row">
          <span class="muted grow">We'll email you a link when the review is done. Nothing else to fill out.</span>
          <button id="submit" disabled>Submit for review</button>
        </div>
        <p id="upload-msg" class="error"></p>
      </form>
    </section>
    ${matters.length ? `
    <section>
      <h2>Submitted contracts</h2>
      <ul class="list">
        ${matters.map((m) => `
          <li><a href="#/m/${m.id}">${esc(m.filename)}</a>
            <span class="muted">${esc(m.submitter)} ${new Date(m.created_at).toLocaleString()}</span>
            <span class="pill ${m.delivered_at ? "ok" : m.status}">${m.delivered_at ? "Delivered" : m.status === "done" ? "Ready: answer questions" : m.status === "running" ? `Reviewing ${m.done}/${m.total}` : esc(m.status)}</span>
          </li>`).join("")}
      </ul>
    </section>` : ""}`;

  const file = document.getElementById("file");
  const drop = document.getElementById("drop");
  const pick = (f) => {
    if (!f) return;
    file.chosen = f;
    document.getElementById("drop-label").textContent = f.name;
    document.getElementById("submit").disabled = false;
  };
  file.addEventListener("change", () => pick(file.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); pick(e.dataTransfer.files[0]); });
  document.getElementById("upload").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("submit");
    btn.disabled = true;
    btn.textContent = "Uploading...";
    try {
      const m = await api("/api/matters", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.chosen.name),
          "X-Submitter": encodeURIComponent(document.getElementById("submitter").value.trim()),
          "X-Email": encodeURIComponent(document.getElementById("email").value.trim()),
        },
        body: file.chosen,
      });
      location.hash = `#/m/${m.id}`;
    } catch (err) {
      document.getElementById("upload-msg").textContent = err.message;
      btn.disabled = false;
      btn.textContent = "Submit for review";
    }
  });
}

// ---------- matter: wait, ask, deliver ----------

const visible = (q, answers) => !q.show_if || Object.entries(q.show_if).every(([k, list]) => [].concat(list).map(String).includes(answers[k]));
const flow = (m, answers) => m.questions.filter((q) => q.needed && visible(q, answers));

async function matterView(id) {
  const m = await api(`/api/matters/${id}`);
  if (m.review.status === "running") return reviewing(m);
  if (m.review.status !== "done") return reviewFailed(m);
  if (m.answers) return delivered(m);
  readyToAsk(m);
}

function reviewing(m) {
  const pct = m.review.total ? Math.round((m.review.done / m.review.total) * 100) : 0;
  app.innerHTML = `
    <section class="card center">
      <p class="eyebrow">${esc(m.filename)}</p>
      <h1>Reviewing your contract</h1>
      <p>We're preparing every version you might need, so there's nothing to fill out yet.</p>
      <p>${m.email ? `You can close this page. We'll email <strong>${esc(m.email)}</strong> when it's ready.` : "You can close this page and come back to this link."}</p>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <p class="muted">${m.review.done} of ${m.review.total} playbook positions reviewed</p>
    </section>`;
  pollTimer = setTimeout(route, 1500);
}

function reviewFailed(m) {
  app.innerHTML = `
    <section class="card center">
      <h1>The review stopped</h1>
      <p class="error">${esc(m.review.error || m.review.status)}</p>
      <button id="resume">Resume review</button>
    </section>`;
  document.getElementById("resume").onclick = async () => {
    await api(`/api/matters/${m.id}/resume`, { method: "POST" });
    route();
  };
}

function notice(m) {
  const n = m.notification;
  if (!m.email || !n) return "";
  const where = n.via === "outbox" ? ` (kept in the <a href="#/outbox">outbox</a> because email sending is not set up)` : "";
  if (n.sent_at) return `<p class="muted small">Ready email sent to ${esc(n.to)} ${new Date(n.sent_at).toLocaleString()}${where}. <button class="link" id="resend">Send again</button></p>`;
  return `<p class="error small">The ready email to ${esc(n.to)} failed: ${esc(n.error)} <button class="link" id="resend">Try again</button></p>`;
}

function readyToAsk(m) {
  const most = m.questions.filter((q) => q.needed).length;
  const fewest = flow(m, {}).length;
  const skipped = m.questions.length - most;
  app.innerHTML = `
    <section class="card center">
      <p class="eyebrow">${esc(m.filename)}</p>
      <h1>Your reviewed contract is ready</h1>
      <p>We've redlined it against our playbook. Answer ${fewest === most ? most : `${fewest} to ${most}`} quick question${most === 1 ? "" : "s"} about the deal and we'll hand you the version that fits.</p>
      ${skipped ? `<p class="muted">We skipped ${skipped} question${skipped === 1 ? "" : "s"} that would not change anything in this contract.</p>` : ""}
      ${m.review.failed ? `<p class="error">${m.review.failed} topic${m.review.failed === 1 ? "" : "s"} could not be reviewed automatically and will be flagged for a lawyer.</p>` : ""}
      <button id="start" class="big">Get my contract</button>
      ${notice(m)}
      <p><a href="#/m/${m.id}/lawyer" class="muted">Lawyer view: every pre-reviewed version</a></p>
    </section>`;
  document.getElementById("start").onclick = () => ask(m, {}, 0);
  document.getElementById("resend")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      await api(`/api/matters/${m.id}/notify`, { method: "POST" });
      route();
    } catch (err) {
      e.target.insertAdjacentHTML("afterend", `<span class="error"> ${esc(err.message)}</span>`);
    }
  });
}

function ask(m, answers, i) {
  const steps = flow(m, answers);
  if (i >= steps.length) return submit(m, answers);
  const q = steps[i];
  app.innerHTML = `
    <section class="card question">
      <div class="steps">${steps.map((_, n) => `<span class="${n < i ? "done" : n === i ? "now" : ""}"></span>`).join("")}</div>
      <p class="eyebrow">Question ${i + 1} of ${steps.length}</p>
      <h1>${esc(q.ask)}</h1>
      ${q.why ? `<p class="muted">${esc(q.why)}</p>` : ""}
      <div class="answers">
        ${q.answers.map((a) => `<button class="answer ${answers[q.id] === a.id ? "picked" : ""}" data-id="${esc(a.id)}">${esc(a.label)}</button>`).join("")}
      </div>
      ${i > 0 ? `<button class="link" id="back">Back</button>` : ""}
    </section>`;
  app.querySelectorAll(".answer").forEach((b) => b.addEventListener("click", () => {
    const next = { ...answers, [q.id]: b.dataset.id };
    // Drop answers to questions this choice just hid, so stale answers never count.
    for (const other of m.questions) if (!visible(other, next)) delete next[other.id];
    ask(m, next, i + 1);
  }));
  document.getElementById("back")?.addEventListener("click", () => ask(m, answers, i - 1));
}

async function submit(m, answers) {
  app.innerHTML = `<section class="card center"><h1>Assembling your contract...</h1></section>`;
  try {
    await api(`/api/matters/${m.id}/answers`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers }),
    });
    route();
  } catch (err) {
    app.innerHTML = `<section class="card center"><p class="error">${esc(err.message)}</p><button onclick="location.reload()">Try again</button></section>`;
  }
}

async function delivered(m) {
  const s = await api(`/api/matters/${m.id}/summary`);
  const changed = s.topics.filter((t) => t.changes);
  const flags = [...s.conflicts, ...s.warnings];
  app.innerHTML = `
    <section class="card center">
      <p class="eyebrow">${esc(m.filename)}</p>
      <h1>${s.escalations.length ? "Your redline is ready, with one more step" : "Your redline is ready"}</h1>
      ${s.escalations.map((e) => `<p class="escalate">${esc(e)}</p>`).join("")}
      <a class="button big" href="/api/matters/${m.id}/download">Download redline (.docx)</a>
      <p class="muted">${s.changes} tracked change${s.changes === 1 ? "" : "s"} with a comment on each, ready to send to the vendor.</p>
    </section>
    <section class="card">
      <h2>What we changed</h2>
      <ul class="topics">
        ${s.topics.map((t) => `
          <li class="${t.error ? "bad" : t.changes ? "changed" : "same"}">
            <strong>${esc(t.topic)}</strong>
            <span class="pill">${t.error ? "Needs a lawyer" : t.changes ? `${t.changes} change${t.changes === 1 ? "" : "s"}` : "No change"}</span>
            <p>${esc(t.error ? t.error : t.assessment)}</p>
          </li>`).join("")}
      </ul>
      ${flags.length ? `<h3>Flags for Legal</h3><ul class="flags">${flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <p class="muted">${changed.length} of ${s.topics.length} playbook topics changed. Automated first-pass redline: not legal advice. Legal may still need to review.</p>
      <div class="row">
        <button class="secondary" id="redo">Change my answers</button>
        <a href="#/m/${m.id}/lawyer" class="muted">Lawyer view</a>
      </div>
    </section>`;
  document.getElementById("redo").onclick = () => ask(m, m.answers || {}, 0);
}

// ---------- lawyer view ----------

const describeWhen = (when, questions) => !when ? "All other answers" : Object.entries(when).map(([qid, list]) => {
  const q = questions.find((x) => x.id === qid);
  const labels = [].concat(list).map((a) => q.answers.find((x) => x.id === String(a))?.label || a);
  return `${q.ask} ${labels.join(" / ")}`;
}).join("; and ");

async function lawyerView(id) {
  const [m, v] = await Promise.all([api(`/api/matters/${id}`), api(`/api/matters/${id}/variants`)]);
  const para = (i) => v.paragraphs[i]?.text || "";
  const editHtml = (e) => e.type === "insert"
    ? `<div class="edit"><span class="where">New paragraph after [${e.after}]</span><ins>${esc(e.text)}</ins><em>${esc(e.comment)}</em></div>`
    : `<div class="edit"><span class="where">[${e.paragraph}]</span>${esc(para(e.paragraph).slice(Math.max(0, e.start - 60), e.start))}<del>${esc(e.find)}</del><ins>${esc(e.replace)}</ins>${esc(para(e.paragraph).slice(e.end, e.end + 60))}<em>${esc(e.comment)}</em></div>`;
  app.innerHTML = `
    <section>
      <p><a href="#/m/${id}">Back to contract</a></p>
      <h1>Every pre-reviewed version</h1>
      <p class="muted">${esc(m.filename)}. Each case below was reviewed before the user answered anything. Their answers pick one case per topic.</p>
    </section>
    ${v.positions.map((p) => `
      <section class="card">
        <h2>${esc(p.topic)}</h2>
        ${p.cases.map((c) => `
          <div class="case">
            <p class="when">${esc(describeWhen(c.when, m.questions))}</p>
            ${c.accept ? `<p class="muted">Accept as written.</p>` : `
              <p class="position">${esc(c.position)}</p>
              ${!c.result ? `<p class="muted">Not reviewed yet.</p>` : c.result.status === "error" ? `<p class="error">${esc(c.result.error)}</p>` : `
                <p>${esc(c.result.assessment)}</p>
                ${c.result.edits.length ? c.result.edits.map(editHtml).join("") : `<p class="muted">No edits needed.</p>`}
                ${c.result.warnings.map((w) => `<p class="error">${esc(w)}</p>`).join("")}`}`}
          </div>`).join("")}
      </section>`).join("")}`;
}

// ---------- outbox (emails kept locally when sending is not set up) ----------

async function outbox() {
  const mails = await api("/api/outbox");
  app.innerHTML = `
    <section>
      <h1>Outbox</h1>
      <p class="muted">${status.email.mode === "resend"
        ? "Email sending is on. These were saved before it was set up."
        : "Email sending is not set up, so ready emails are kept here instead of sent. Add a Resend key in Settings to send them for real."}</p>
    </section>
    ${mails.length ? mails.map((m) => `
      <section class="card mail">
        <p class="muted small">To ${esc(m.to)}, ${new Date(m.sent_at).toLocaleString()}<br>From ${esc(m.from)}</p>
        <h2>${esc(m.subject)}</h2>
        <iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(m.html.replace(/<a /g, '<a target="_blank" '))}"></iframe>
      </section>`).join("") : `<p class="muted">No emails yet.</p>`}`;
}

// ---------- settings ----------

document.getElementById("settings-btn").onclick = () => {
  document.getElementById("emailFrom").placeholder = status.email.from;
  document.getElementById("appUrl").placeholder = status.email.appUrl;
  document.getElementById("settings").showModal();
};
document.getElementById("save-key").addEventListener("click", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("settings-msg");
  try {
    await api("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(["apiKey", "resendKey", "emailFrom", "appUrl"].map((k) => [k, document.getElementById(k).value]))),
    });
    document.getElementById("settings").close();
    await refreshStatus();
  } catch (err) {
    msg.textContent = err.message;
  }
});

refreshStatus().then(route);
