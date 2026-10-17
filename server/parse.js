// Turns an uploaded contract into a flat list of paragraphs: [{ text, heading }].
// Paragraph indexes are the coordinates every redline edit points at. For .docx files
// each paragraph also records `xml_index`, its position among the document's paragraphs,
// so the redline can be written back into the original file.
import JSZip from "jszip";
import { scanParagraphs, paragraphModel, numberingLabeler } from "./docxml.js";

export async function parseDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("That file is not a Word document (no word/document.xml).");
  const label = numberingLabeler(await zip.file("word/numbering.xml")?.async("string"));
  const paragraphs = [];
  scanParagraphs(xml).forEach((p, xml_index) => {
    const m = paragraphModel(p.xml);
    const text = m.text.trim();
    // Count every numbered paragraph, even empty ones, so later numbers come out right.
    const number = m.numbered ? label(m.pPr) : "";
    if (!text) return;
    const para = { text, heading: /heading|title/i.test(m.style), xml_index };
    if (number) para.number = number;
    paragraphs.push(para);
  });
  if (!paragraphs.length) throw new Error("No text found in that document.");
  return paragraphs;
}

export function parseText(text) {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n|\n(?=\s*\d+(\.\d+)*\.?\s)/)
    .filter(Boolean)
    .map((t) => t.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map((t) => ({ text: t, heading: t.length < 60 && !/[.;:]$/.test(t) && t === t.toUpperCase() }));
  if (!paragraphs.length) throw new Error("No text found.");
  return paragraphs;
}

export async function parseUpload(filename, buffer) {
  if (/\.docx$/i.test(filename)) return parseDocx(buffer);
  if (/\.(txt|md)$/i.test(filename)) return parseText(buffer.toString("utf8"));
  throw new Error("Upload a .docx or .txt file.");
}
