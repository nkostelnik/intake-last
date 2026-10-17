// Delivery time. Picks the pre-reviewed variant each position resolves to under the
// user's answers, merges their edits into one redline, and works out which intake
// questions are worth asking at all.
import { completeAnswers, resolveCase, dependsOn, isVisible } from "./playbook.js";

// What a case does to the document, as a comparable string. Two cases with the same
// signature produce the same redline, so a question choosing between them is moot.
function signature(c, results) {
  if (c.accept) return "[]";
  const r = results[c.id];
  if (!r || r.status !== "done") return `pending:${c.id}`;
  return JSON.stringify(r.edits.map((e) => [e.type, e.paragraph, e.after, e.find, e.replace, e.text]));
}

function combos(pb, qids) {
  return qids.reduce(
    (acc, qid) => acc.flatMap((a) => pb.questions.find((q) => q.id === qid).answers.map((x) => ({ ...a, [qid]: x.id }))),
    [{}],
  );
}

function changesOutcome(pb, q, results) {
  return pb.positions.some((p) => {
    const deps = dependsOn(p);
    if (!deps.includes(q.id)) return false;
    return combos(pb, deps.filter((d) => d !== q.id)).some((base) => {
      const sigs = new Set(q.answers.map((a) => signature(resolveCase(p, { ...base, [q.id]: a.id }), results)));
      return sigs.size > 1;
    });
  });
}

// Returns { [questionId]: true } for every question the user should be asked.
export function questionsToAsk(pb, results) {
  const ask = {};
  for (const q of pb.questions) {
    if (q.answers.some((a) => a.escalate) || changesOutcome(pb, q, results)) ask[q.id] = true;
  }
  // A question that controls whether another asked question is shown must be asked too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const q of pb.questions) {
      if (!ask[q.id] || !q.show_if) continue;
      for (const dep of Object.keys(q.show_if)) if (!ask[dep]) ask[dep] = grew = true;
    }
  }
  return ask;
}

export function assemble(pb, matter, given) {
  const answers = completeAnswers(pb, given || {});
  const results = matter.review.results;
  const escalations = [];
  for (const q of pb.questions) {
    const a = q.answers.find((x) => x.id === answers[q.id]);
    if (a?.escalate && isVisible(q, answers)) escalations.push(a.escalate);
  }
  const topics = [];
  const edits = [];
  const conflicts = [];
  const warnings = [];
  const spans = {};
  let nextComment = 0;
  for (const p of pb.positions) {
    const c = resolveCase(p, answers);
    if (c.accept) {
      topics.push({ topic: p.topic, case: c.id, accepted: true, changes: 0, assessment: "No change needed for this deal." });
      continue;
    }
    const r = results[c.id];
    if (!r || r.status !== "done") {
      topics.push({ topic: p.topic, case: c.id, accepted: false, changes: 0, error: r?.error || "Not reviewed", assessment: "" });
      warnings.push(`${p.topic}: review failed, so this topic was not redlined. A lawyer should check it.`);
      continue;
    }
    let kept = 0;
    for (const e of r.edits) {
      if (e.type === "replace") {
        const taken = (spans[e.paragraph] ||= []);
        const clash = taken.find((s) => e.start < s.end && s.start < e.end);
        if (clash) {
          conflicts.push(`${p.topic} and ${clash.topic} both edit the same words in paragraph ${e.paragraph}. Kept the ${clash.topic} change; a lawyer should reconcile them.`);
          continue;
        }
        taken.push({ start: e.start, end: e.end, topic: p.topic });
      }
      edits.push({ ...e, topic: p.topic, commentId: nextComment++ });
      kept++;
    }
    warnings.push(...r.warnings.map((w) => `${p.topic}: ${w}`));
    topics.push({ topic: p.topic, case: c.id, accepted: false, changes: kept, assessment: r.assessment });
  }
  return { answers, escalations, topics, edits, conflicts, warnings };
}

// Lays the edits over the original paragraphs as runs of unchanged, deleted and
// inserted text. Inserted paragraphs come out as their own entries.
export function redlineParagraphs(paragraphs, edits) {
  const out = [];
  const byPara = {};
  const insertsAfter = {};
  for (const e of edits) {
    if (e.type === "replace") (byPara[e.paragraph] ||= []).push(e);
    else (insertsAfter[e.after] ||= []).push(e);
  }
  const pushInserts = (i) => {
    for (const e of insertsAfter[i] || []) out.push({ heading: false, inserted: true, runs: [{ kind: "ins", text: e.text, comment: e }] });
  };
  pushInserts(-1);
  paragraphs.forEach((p, i) => {
    const runs = [];
    let at = 0;
    for (const e of (byPara[i] || []).sort((a, b) => a.start - b.start)) {
      if (e.start > at) runs.push({ kind: "same", text: p.text.slice(at, e.start) });
      runs.push({ kind: "del", text: p.text.slice(e.start, e.end), comment: e });
      if (e.replace) runs.push({ kind: "ins", text: e.replace });
      at = e.end;
    }
    if (at < p.text.length) runs.push({ kind: "same", text: p.text.slice(at) });
    out.push({ heading: p.heading, runs });
    pushInserts(i);
  });
  return out;
}
