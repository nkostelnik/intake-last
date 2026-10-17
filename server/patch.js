// Writes the redline into the user's ORIGINAL .docx: tracked deletions and insertions
// go into the existing runs, so numbering, styles, fonts, tables, headers and footers
// all stay exactly as they were. Only the runs an edit touches are rewritten.
import JSZip from "jszip";
import { scanParagraphs, paragraphModel, encode } from "./docxml.js";
import { AUTHOR } from "./docx.js";

const COMMENTS_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const COMMENTS_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const maxId = (xml, re) => Math.max(0, ...[...xml.matchAll(re)].map((m) => Number(m[1])));
const tAttr = (s) => (/^\s|\s$/.test(s) ? ' xml:space="preserve"' : "");

export async function patchDocx(original, paragraphs, assembled, date = new Date().toISOString()) {
  const zip = await JSZip.loadAsync(original);
  const xml = await zip.file("word/document.xml").async("string");
  const commentsXml = await zip.file("word/comments.xml")?.async("string");

  let rev = maxId(xml, /w:id="(\d+)"/g) + 1000;
  let nextComment = commentsXml ? maxId(commentsXml, /<w:comment\b[^>]*w:id="(\d+)"/g) + 1 : 0;
  const mark = () => `w:id="${rev++}" w:author="${encode(AUTHOR)}" w:date="${date}"`;
  const comments = [];
  const commentFor = (e) => {
    if (!e.comment) return null;
    const id = nextComment++;
    comments.push(`<w:comment w:id="${id}" w:author="${encode(AUTHOR)}" w:date="${date}" w:initials="IL"><w:p>`
      + `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${encode(e.topic)}: </w:t></w:r>`
      + `<w:r><w:t>${encode(e.comment)}</w:t></w:r></w:p></w:comment>`);
    return id;
  };
  const commentEnd = (id) => (id === null ? "" : `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`);
  const commentStart = (id) => (id === null ? "" : `<w:commentRangeStart w:id="${id}"/>`);
  const insRun = (rPr, text) => {
    const t = text.replace(/\s*\n\s*/g, " ");
    return `<w:ins ${mark()}><w:r>${rPr}<w:t${tAttr(t)}>${encode(t)}</w:t></w:r></w:ins>`;
  };

  const all = scanParagraphs(xml);
  const byXml = {};
  const after = {};
  for (const e of assembled.edits) {
    if (e.type === "replace") (byXml[paragraphs[e.paragraph].xml_index] ||= []).push(e);
    else {
      // -1 means "before the first paragraph": anchor on it and insert before.
      const key = e.after < 0 ? `before:${paragraphs[0].xml_index}` : paragraphs[e.after].xml_index;
      (after[key] ||= []).push(e);
    }
  }

  let out = "";
  let cursor = 0;
  all.forEach((p, i) => {
    out += xml.slice(cursor, p.start);
    cursor = p.end;
    const model = paragraphModel(p.xml);
    for (const e of after[`before:${i}`] || []) out += newParagraph(model, e);
    out += byXml[i] ? patchParagraph(p.xml, model, byXml[i]) : p.xml;
    for (const e of after[i] || []) out += newParagraph(model, e);
  });
  out += xml.slice(cursor);
  zip.file("word/document.xml", out);

  function patchParagraph(pXml, model, edits) {
    // Edit offsets are into the trimmed text the reviewer saw.
    const lead = model.text.length - model.text.trimStart().length;
    const spans = edits
      .map((e) => ({ e, start: e.start + lead, end: e.end + lead, id: null }))
      .sort((a, b) => a.start - b.start);
    const touched = (r) => spans.some((s) => r.atoms.some((a) => a.start < s.end && s.start < a.end));
    let res = "";
    let at = 0;
    for (const run of model.runs) {
      if (!touched(run)) continue;
      res += pXml.slice(at, run.start);
      at = run.end;
      for (const atom of run.atoms) res += rewriteAtom(run.rPr, atom, spans);
    }
    return res + pXml.slice(at);
  }

  function rewriteAtom(rPr, atom, spans) {
    if (atom.start === atom.end) return `<w:r>${rPr}${atom.tok}</w:r>`;
    const isText = atom.tok.startsWith("<w:t");
    // Cut the atom wherever an edit starts or ends inside it.
    const cuts = new Set([atom.start, atom.end]);
    for (const s of spans) for (const x of [s.start, s.end]) if (x > atom.start && x < atom.end) cuts.add(x);
    const points = [...cuts].sort((a, b) => a - b);
    let res = "";
    for (let k = 0; k < points.length - 1; k++) {
      const [from, to] = [points[k], points[k + 1]];
      const piece = atom.text.slice(from - atom.start, to - atom.start);
      const s = spans.find((x) => from >= x.start && to <= x.end);
      if (!s) {
        res += isText ? `<w:r>${rPr}<w:t${tAttr(piece)}>${encode(piece)}</w:t></w:r>` : `<w:r>${rPr}${atom.tok}</w:r>`;
        continue;
      }
      if (from === s.start) {
        s.id = commentFor(s.e);
        res += commentStart(s.id);
      }
      res += `<w:del ${mark()}><w:r>${rPr}${isText ? `<w:delText${tAttr(piece)}>${encode(piece)}</w:delText>` : atom.tok}</w:r></w:del>`;
      if (to === s.end) {
        if (s.e.replace) res += insRun(rPr, s.e.replace);
        res += commentEnd(s.id);
      }
    }
    return res;
  }

  function newParagraph(anchor, e) {
    // Borrow the anchor's paragraph formatting (style, indent, numbering) but not its
    // section break, change history or paragraph-mark formatting.
    let pPr = (anchor.pPr || "<w:pPr></w:pPr>")
      .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, "")
      .replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "")
      .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, "");
    pPr = pPr.replace("</w:pPr>", `<w:rPr><w:ins ${mark()}/></w:rPr></w:pPr>`);
    // Auto-numbered list: Word supplies the number, so drop one the reviewer typed.
    const text = anchor.numbered ? e.text.replace(/^\s*\d+(\.\d+)*\.?\s+/, "") : e.text;
    const rPr = [...anchor.runs].reverse().find((r) => r.atoms.some((a) => a.text.trim()))?.rPr || "";
    const id = commentFor(e);
    return `<w:p>${pPr}${commentStart(id)}${insRun(rPr, text)}${commentEnd(id)}</w:p>`;
  }

  if (comments.length) await writeComments(zip, commentsXml, comments);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function writeComments(zip, existing, comments) {
  if (existing) {
    zip.file("word/comments.xml", existing.replace(/<\/w:comments>\s*$/, `${comments.join("")}</w:comments>`));
    return;
  }
  zip.file("word/comments.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}">${comments.join("")}</w:comments>`);
  const relsPath = "word/_rels/document.xml.rels";
  const rels = await zip.file(relsPath).async("string");
  if (!rels.includes(COMMENTS_TYPE)) {
    zip.file(relsPath, rels.replace("</Relationships>", `<Relationship Id="rIdIntakeLastComments" Type="${COMMENTS_TYPE}" Target="comments.xml"/></Relationships>`));
  }
  const ct = await zip.file("[Content_Types].xml").async("string");
  if (!ct.includes('PartName="/word/comments.xml"')) {
    zip.file("[Content_Types].xml", ct.replace("</Types>", `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CT}"/></Types>`));
  }
}
