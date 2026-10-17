// Plain JSON files under data/ (one per submitted contract). Local-first: nothing leaves
// the machine except the contract text sent to Claude for review.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.IL_DATA || path.join(here, "..", "data");
const MATTERS_DIR = path.join(DATA_DIR, "matters");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

function matterFile(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Bad matter id");
  return path.join(MATTERS_DIR, `${id}.json`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write then rename so a crash mid-write never leaves a half-written file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeSettings(patch) {
  writeJson(SETTINGS_FILE, { ...readSettings(), ...patch });
}

export function createMatter({ filename, submitter, email, paragraphs, total }) {
  const now = new Date().toISOString();
  const matter = {
    id: crypto.randomUUID(),
    filename,
    submitter: submitter || "",
    email: email || "",
    created_at: now,
    updated_at: now,
    paragraphs,
    review: { status: "running", total, done: 0, results: {}, error: null },
    answers: null,
    delivered_at: null,
    notification: null,
  };
  return saveMatter(matter);
}

export function getMatter(id) {
  try {
    return JSON.parse(fs.readFileSync(matterFile(id), "utf8"));
  } catch {
    return null;
  }
}

export function saveMatter(matter) {
  matter.updated_at = new Date().toISOString();
  writeJson(matterFile(matter.id), matter);
  return matter;
}

export function listMatters() {
  if (!fs.existsSync(MATTERS_DIR)) return [];
  return fs.readdirSync(MATTERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => getMatter(f.slice(0, -5)))
    .filter(Boolean)
    .map(({ id, filename, submitter, created_at, review, delivered_at }) => ({
      id, filename, submitter, created_at, status: review.status, done: review.done, total: review.total, delivered_at,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// The uploaded .docx itself, kept so the redline can be written into the original.
const originalFile = (id) => matterFile(id).replace(/\.json$/, ".docx");

export function saveOriginal(id, buffer) {
  fs.writeFileSync(originalFile(id), buffer);
}

export function readOriginal(id) {
  try {
    return fs.readFileSync(originalFile(id));
  } catch {
    return null;
  }
}

export function deleteMatter(id) {
  fs.rmSync(matterFile(id), { force: true });
  fs.rmSync(originalFile(id), { force: true });
}
