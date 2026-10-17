// Builds the Word samples from samples/cloudnimbus-saas.txt:
//   cloudnimbus-saas.docx            plain paragraphs, typed section numbers
//   cloudnimbus-saas-formatted.docx  auto-numbered sections, bold defined terms split
//                                    across runs, a fee table, header and footer. Used to
//                                    prove the redline keeps the original formatting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Header, Footer, Table, TableRow, TableCell,
  WidthType, AlignmentType, LevelFormat, PageNumber,
} from "docx";
import { parseText } from "../server/parse.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "samples");
const paragraphs = parseText(fs.readFileSync(path.join(dir, "cloudnimbus-saas.txt"), "utf8"));

const plain = new Document({
  sections: [{
    children: paragraphs.map((p) => p.heading
      ? new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(p.text)] })
      : new Paragraph({ children: [new TextRun(p.text)], spacing: { after: 160 } })),
  }],
});
fs.writeFileSync(path.join(dir, "cloudnimbus-saas.docx"), await Packer.toBuffer(plain));

// Bold the clause caption ("Subscription.") and every quoted defined term, so a single
// sentence is spread over several runs with different formatting.
function runs(text) {
  const out = [];
  const caption = text.match(/^([A-Z][A-Za-z ]+\.)\s/);
  if (caption) {
    out.push(new TextRun({ text: caption[1], bold: true }), new TextRun(" "));
    text = text.slice(caption[0].length);
  }
  for (const piece of text.split(/("[^"]+")/)) if (piece) out.push(new TextRun({ text: piece, bold: /^".*"$/.test(piece) }));
  return out;
}

const body = [];
for (const p of paragraphs) {
  const section = p.text.match(/^(\d+)\.\s+(.*)$/);
  const clause = p.text.match(/^\d+\.\d+\s+(.*)$/);
  if (p.heading && section) body.push(new Paragraph({ numbering: { reference: "contract", level: 0 }, children: [new TextRun({ text: section[2], bold: true })], spacing: { before: 240, after: 120 } }));
  else if (p.heading) body.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: p.text, bold: true, size: 28 })], spacing: { after: 240 } }));
  else if (clause) body.push(new Paragraph({ numbering: { reference: "contract", level: 1 }, children: runs(clause[1]), spacing: { after: 120 } }));
  else body.push(new Paragraph({ children: runs(p.text), spacing: { after: 160 } }));
  if (/^2\.1 /.test(p.text)) {
    const cell = (t, bold) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold })] })] });
    body.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [cell("Plan", true), cell("Annual fee", true)] }),
        new TableRow({ children: [cell("Business"), cell("$48,000")] }),
      ],
    }));
  }
}

const formatted = new Document({
  styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
  numbering: {
    config: [{
      reference: "contract",
      levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 360 } } } },
        { level: 1, format: LevelFormat.DECIMAL, text: "%1.%2", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 720 } } } },
      ],
    }],
  },
  sections: [{
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "CloudNimbus Confidential", italics: true })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT] })] })] }) },
    children: body,
  }],
});
fs.writeFileSync(path.join(dir, "cloudnimbus-saas-formatted.docx"), await Packer.toBuffer(formatted));
console.log(`Wrote samples/cloudnimbus-saas.docx and samples/cloudnimbus-saas-formatted.docx (${paragraphs.length} paragraphs)`);
