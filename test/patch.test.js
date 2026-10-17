import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { loadPlaybook, variantsToReview } from "../server/playbook.js";
import { parseDocx } from "../server/parse.js";
import { reviewMock, normalize } from "../server/review.js";
import { assemble, redlineParagraphs } from "../server/assemble.js";
import { patchDocx } from "../server/patch.js";

const pb = loadPlaybook();
const original = fs.readFileSync(new URL("../samples/cloudnimbus-saas-formatted.docx", import.meta.url));
const paragraphs = await parseDocx(original);
const deal = { spend: "25k_100k", data: "personal", ai: "yes", commitment: "pilot", critical: "critical" };

function mockAssembled(extra = {}) {
  const results = {};
  for (const { position, case: c } of variantsToReview(pb)) {
    results[c.id] = { status: "done", ...normalize(reviewMock(paragraphs, position, c), paragraphs) };
  }
  Object.assign(results, extra);
  return assemble(pb, { paragraphs, review: { results } }, deal);
}

const textOf = (paras) => paras.map((p) => p.text);
const accepted = (assembled) => redlineParagraphs(paragraphs, assembled.edits)
  .map((p) => p.runs.filter((r) => r.kind !== "del").map((r) => r.text).join("").trim());

async function unzip(buf) {
  const zip = await JSZip.loadAsync(buf);
  return { zip, xml: await zip.file("word/document.xml").async("string") };
}

// Reject every tracked change: drop insertions, turn deletions back into text.
function rejectAll(xml) {
  return xml
    .replace(/<w:ins\b[^>]*\/>/g, "")
    .replace(/<w:ins\b[^>]*>[\s\S]*?<\/w:ins>/g, "")
    .replace(/<w:del\b[^>]*>([\s\S]*?)<\/w:del>/g, "$1")
    .replace(/<w:delText/g, "<w:t").replace(/<\/w:delText>/g, "</w:t>");
}

async function reparse(zip, xml) {
  zip.file("word/document.xml", xml);
  return parseDocx(await zip.generateAsync({ type: "nodebuffer" }));
}

// A hand-written edit that starts inside the bold caption run "Subscription." and ends
// in the plain run after it, plus a numbered insertion after a numbered clause.
const crossRun = {
  status: "done", assessment: "", warnings: [],
  ...normalize({
    edits: [{ paragraph: 3, find: "Subscription. Subject to", replace: "Access. Under", comment: "Crosses a formatting boundary." }],
    insertions: [{ after_paragraph: 4, text: "1.3 Fixed Terms. Online terms are fixed as of the Effective Date.", comment: "New clause." }],
  }, paragraphs),
};

test("accepting every change gives exactly the redlined text", async () => {
  const a = mockAssembled({ "unilateral_changes#1": crossRun, "publicity#1": crossRun });
  const { zip, xml } = await unzip(await patchDocx(original, paragraphs, a));
  const after = textOf(await reparse(zip, xml));
  const expected = accepted(a).filter(Boolean).map((t) => t.replace(/^1\.3 /, ""));
  assert.deepEqual(after, expected);
});

test("rejecting every change gives back the original text", async () => {
  const a = mockAssembled({ "unilateral_changes#1": crossRun });
  const { zip, xml } = await unzip(await patchDocx(original, paragraphs, a));
  assert.deepEqual(textOf(await reparse(zip, rejectAll(xml))), textOf(paragraphs));
});

test("every patched part is well-formed XML", async () => {
  const a = mockAssembled({ "unilateral_changes#1": crossRun });
  const { zip } = await unzip(await patchDocx(original, paragraphs, a));
  for (const name of ["word/document.xml", "word/comments.xml", "word/_rels/document.xml.rels", "[Content_Types].xml"]) {
    const errors = [];
    new DOMParser({ onError: (level, msg) => level !== "warning" && errors.push(msg) })
      .parseFromString(await zip.file(name).async("string"), "text/xml");
    assert.deepEqual(errors, [], name);
  }
});

test("formatting survives: numbering, bold runs, table, header, footer", async () => {
  const before = await unzip(original);
  const a = mockAssembled({ "unilateral_changes#1": crossRun });
  const { zip, xml } = await unzip(await patchDocx(original, paragraphs, a));
  const count = (s, re) => (s.match(re) || []).length;
  // One more numbered paragraph: the inserted clause borrows its neighbour's numbering.
  assert.equal(count(xml, /<w:numPr>/g), count(before.xml, /<w:numPr>/g) + 1);
  assert.equal(count(xml, /<w:tbl>/g), 1);
  assert.ok(zip.file("word/numbering.xml") && zip.file("word/header1.xml") && zip.file("word/footer1.xml"));
  assert.equal(await zip.file("word/numbering.xml").async("string"), await before.zip.file("word/numbering.xml").async("string"));
  // The deleted caption keeps its bold formatting inside the tracked deletion.
  assert.match(xml, /<w:del [^>]*><w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:delText>Subscription\.<\/w:delText>/);
  // The section break on the last paragraph is untouched and appears once.
  assert.equal(count(xml, /<w:sectPr/g), count(before.xml, /<w:sectPr/g));
});

test("one comment per change, wired into the package", async () => {
  const a = mockAssembled();
  const { zip, xml } = await unzip(await patchDocx(original, paragraphs, a));
  const comments = await zip.file("word/comments.xml").async("string");
  assert.equal((comments.match(/<w:comment /g) || []).length, a.edits.length);
  assert.equal((xml.match(/<w:commentReference /g) || []).length, a.edits.length);
  assert.match(await zip.file("word/_rels/document.xml.rels").async("string"), /relationships\/comments"/);
  assert.match(await zip.file("[Content_Types].xml").async("string"), /\/word\/comments\.xml/);
});

test("auto-numbered paragraphs get their displayed section numbers", () => {
  const numbers = paragraphs.filter((p) => p.number).map((p) => p.number);
  assert.deepEqual(numbers.slice(0, 4), ["1.", "1.1", "1.2", "1.3"]);
  assert.equal(paragraphs.find((p) => p.text.startsWith("IN NO EVENT")).number, "8.1");
});

test("revision ids are unique", async () => {
  const { xml } = await unzip(await patchDocx(original, paragraphs, mockAssembled({ "unilateral_changes#1": crossRun })));
  const ids = [...xml.matchAll(/<w:(?:ins|del) w:id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});
