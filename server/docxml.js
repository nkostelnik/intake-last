// A small, regex-based model of WordprocessingML paragraphs: just enough to read the
// text of each paragraph and to know which run (and which piece of a run) holds each
// character. Both the parser and the redline patcher use it, so the character offsets
// Claude's edits point at always line up with the original document.

const ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
export const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e]);
export const encode = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Top-level paragraphs that contain no nested paragraphs (text boxes nest them). Table
// cell paragraphs count; paragraphs inside text boxes do not.
export function scanParagraphs(xml) {
  const out = [];
  const stack = [];
  for (const m of xml.matchAll(/<w:p(?=[\s>/])[^>]*>|<\/w:p>/g)) {
    if (m[0] === "</w:p>") {
      const open = stack.pop();
      if (!open) continue;
      if (stack.length) stack.at(-1).nested = true;
      else if (!open.nested) out.push({ start: open.start, end: m.index + m[0].length });
    } else if (!m[0].endsWith("/>")) {
      stack.push({ start: m.index, nested: false });
    }
  }
  return out.map((p) => ({ ...p, xml: xml.slice(p.start, p.end) }));
}

// Text-bearing children of a run, one "atom" each. Tabs and breaks are one character.
// Any namespace, so things like mc:AlternateContent survive when a run is rewritten.
const CHILD = /<([A-Za-z0-9]+:[A-Za-z]+)\b[^>]*\/>|<([A-Za-z0-9]+:[A-Za-z]+)\b[^>]*>[\s\S]*?<\/\2>/g;
// Live runs only: anything inside a tracked deletion or move-from is skipped. Self-closing
// <w:del/> (a deleted paragraph mark) must not be read as the start of a block.
const RUNS = /<w:(?:del|moveFrom)\b[^>]*\/>|<w:(del|moveFrom)\b[^>]*>[\s\S]*?<\/w:\1>|<w:r(?:\s[^>]*?)?(?<!\/)>[\s\S]*?<\/w:r>/g;

function atomText(tok) {
  const name = tok.match(/^<([A-Za-z0-9]+:[A-Za-z]+)/)[1];
  if (name === "w:t") return tok.endsWith("/>") ? "" : decode(tok.replace(/^<w:t\b[^>]*>|<\/w:t>$/g, ""));
  if (name === "w:tab" || name === "w:ptab") return "\t";
  if (name === "w:br" || name === "w:cr") return "\n";
  if (name === "w:noBreakHyphen") return "-";
  return "";
}

export function paragraphModel(pXml) {
  const pPr = pXml.match(/^<w:p\b[^>]*>\s*(<w:pPr>[\s\S]*?<\/w:pPr>)/)?.[1] || "";
  const runs = [];
  let text = "";
  for (const m of pXml.matchAll(RUNS)) {
    if (!m[0].startsWith("<w:r")) continue;
    const inner = m[0].replace(/^<w:r\b[^>]*>|<\/w:r>$/g, "");
    const rPr = inner.match(/^\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/)?.[1] || "";
    const body = rPr ? inner.slice(inner.indexOf(rPr) + rPr.length) : inner;
    const atoms = [];
    for (const [tok] of body.matchAll(CHILD)) {
      const t = atomText(tok);
      atoms.push({ tok, text: t, start: text.length, end: text.length + t.length });
      text += t;
    }
    runs.push({ start: m.index, end: m.index + m[0].length, rPr, atoms });
  }
  const style = pPr.match(/<w:pStyle w:val="([^"]+)"/)?.[1] || "";
  return { pPr, runs, text, style, numbered: /<w:numPr>/.test(pPr) };
}

// Word computes list numbers ("8.1") at display time, so they are not in the text.
// This works them out from numbering.xml so the reviewer can see section numbers and
// get cross-references right. Covers direct numbering with the common formats; style-
// linked numbering and restart overrides are not modelled.
const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
function formatNumber(n, fmt) {
  if (fmt === "lowerLetter" || fmt === "upperLetter") {
    const s = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
    return fmt === "upperLetter" ? s.toUpperCase() : s;
  }
  if (fmt === "lowerRoman" || fmt === "upperRoman") {
    let s = "";
    for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
    return fmt === "upperRoman" ? s.toUpperCase() : s;
  }
  return String(n);
}

export function numberingLabeler(numberingXml = "") {
  const abstract = {};
  for (const [, id, body] of numberingXml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    abstract[id] = {};
    for (const [, ilvl, lvl] of body.matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      abstract[id][ilvl] = {
        start: Number(lvl.match(/<w:start w:val="(\d+)"/)?.[1] || 1),
        fmt: lvl.match(/<w:numFmt w:val="([^"]+)"/)?.[1] || "decimal",
        text: decode(lvl.match(/<w:lvlText w:val="([^"]*)"/)?.[1] || ""),
      };
    }
  }
  const nums = {};
  for (const [, numId, aid] of numberingXml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"/g)) nums[numId] = aid;
  const counters = {};
  return (pPr) => {
    const numId = pPr.match(/<w:numId w:val="(\d+)"/)?.[1];
    const ilvl = Number(pPr.match(/<w:ilvl w:val="(\d+)"/)?.[1] || 0);
    const levels = abstract[nums[numId]];
    if (!levels?.[ilvl] || numId === "0") return "";
    const c = (counters[numId] ||= {});
    c[ilvl] = c[ilvl] === undefined ? levels[ilvl].start : c[ilvl] + 1;
    for (const k of Object.keys(c)) if (Number(k) > ilvl) delete c[k];
    if (levels[ilvl].fmt === "bullet" || levels[ilvl].fmt === "none") return "";
    return levels[ilvl].text.replace(/%(\d)/g, (_, d) => {
      const l = Number(d) - 1;
      return formatNumber(c[l] ?? levels[l]?.start ?? 1, levels[l]?.fmt);
    }).trim();
  };
}
