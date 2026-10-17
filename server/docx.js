// Writes the assembled redline as a Word document with real tracked changes (so the
// recipient can accept or reject each one) and a margin comment explaining each change.
import {
  Document, Packer, Paragraph, TextRun, InsertedTextRun, DeletedTextRun,
  CommentRangeStart, CommentRangeEnd, CommentReference,
} from "docx";
import { redlineParagraphs } from "./assemble.js";

export const AUTHOR = "Intake Last";

export async function buildDocx(paragraphs, assembled) {
  const date = new Date().toISOString();
  let rev = 1;
  const runOf = (r, bold) => {
    if (r.kind === "same") return new TextRun({ text: r.text, bold });
    const Run = r.kind === "del" ? DeletedTextRun : InsertedTextRun;
    return new Run({ text: r.text, bold, id: rev++, author: AUTHOR, date });
  };
  const comments = [];
  const body = redlineParagraphs(paragraphs, assembled.edits).map((p) => {
    const children = [];
    for (let i = 0; i < p.runs.length; i++) {
      const r = p.runs[i];
      if (!r.comment) {
        children.push(runOf(r, p.heading));
        continue;
      }
      const id = r.comment.commentId;
      comments.push({
        id,
        author: AUTHOR,
        initials: "IL",
        date: new Date(date),
        children: [new Paragraph({ children: [new TextRun({ text: `${r.comment.topic}: `, bold: true }), new TextRun(r.comment.comment || "")] })],
      });
      children.push(new CommentRangeStart(id), runOf(r, p.heading));
      // A replacement is a deletion followed by its insertion; keep both inside one comment.
      const next = p.runs[i + 1];
      if (r.kind === "del" && next?.kind === "ins" && !next.comment) children.push(runOf(next, p.heading)), i++;
      children.push(new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] }));
    }
    return new Paragraph({ children, spacing: { after: 160 } });
  });
  const doc = new Document({
    creator: AUTHOR,
    features: { trackRevisions: true },
    comments: { children: comments },
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children: body }],
  });
  return Packer.toBuffer(doc);
}
