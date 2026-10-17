// Loads the playbook YAML and answers the two questions the rest of the app asks of it:
// "what are all the variants to pre-review?" and "given these answers, which variant
// applies to each position?"
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLAYBOOK_FILE = process.env.IL_PLAYBOOK || path.join(here, "..", "playbook", "vendor-saas.yaml");

export function loadPlaybook(file = PLAYBOOK_FILE) {
  return validate(YAML.parse(fs.readFileSync(file, "utf8")));
}

export function validate(pb) {
  const fail = (msg) => { throw new Error(`Playbook: ${msg}`); };
  if (!Array.isArray(pb?.questions) || !Array.isArray(pb?.positions)) fail("needs questions and positions lists");
  const answers = {};
  for (const q of pb.questions) {
    if (!q.id || !q.ask || !q.answers?.length) fail(`question ${q.id || "?"} needs id, ask and answers`);
    if (answers[q.id]) fail(`duplicate question id ${q.id}`);
    q.answers = q.answers.map((a) => ({ ...a, id: String(a.id) }));
    answers[q.id] = q.answers.map((a) => a.id);
    q.default = q.default === undefined ? q.answers[0].id : String(q.default);
    if (!answers[q.id].includes(q.default)) fail(`question ${q.id} default is not one of its answers`);
  }
  const checkWhen = (when, where) => {
    for (const [qid, list] of Object.entries(when || {})) {
      if (!answers[qid]) fail(`${where} refers to unknown question ${qid}`);
      for (const a of [].concat(list)) if (!answers[qid].includes(String(a))) fail(`${where}: ${a} is not an answer to ${qid}`);
    }
  };
  for (const q of pb.questions) if (q.show_if) checkWhen(q.show_if, `question ${q.id} show_if`);
  const seen = new Set();
  for (const p of pb.positions) {
    if (!p.id || !p.topic || !p.cases?.length) fail(`position ${p.id || "?"} needs id, topic and cases`);
    if (seen.has(p.id)) fail(`duplicate position id ${p.id}`);
    seen.add(p.id);
    p.cases.forEach((c, i) => {
      const where = `position ${p.id} case ${i + 1}`;
      checkWhen(c.when, where);
      if (!c.accept && !c.position) fail(`${where} needs accept: true or a position`);
      if (!c.when && i !== p.cases.length - 1) fail(`${where} has no "when" so it must be the last case`);
      c.id = `${p.id}#${i + 1}`;
    });
    if (p.cases.at(-1).when) fail(`position ${p.id} needs a last case with no "when" (the fallback)`);
  }
  return pb;
}

const matches = (when, answers) =>
  Object.entries(when || {}).every(([qid, list]) => [].concat(list).map(String).includes(answers[qid]));

export function isVisible(q, answers) {
  return !q.show_if || matches(q.show_if, answers);
}

// Fill in defaults for hidden or unanswered questions so every position resolves.
export function completeAnswers(pb, given) {
  const out = {};
  for (const q of pb.questions) {
    const a = given[q.id];
    out[q.id] = isVisible(q, out) && q.answers.some((x) => x.id === a) ? a : q.default;
  }
  return out;
}

export function resolveCase(position, answers) {
  return position.cases.find((c) => matches(c.when, answers));
}

export function dependsOn(position) {
  return [...new Set(position.cases.flatMap((c) => Object.keys(c.when || {})))];
}

// Every case that needs a contract review. Accepted cases need none.
export function variantsToReview(pb) {
  return pb.positions.flatMap((p) => p.cases.filter((c) => !c.accept).map((c) => ({ position: p, case: c })));
}
