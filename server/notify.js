// The "your contract is ready" email. This is the hand-off that makes the inverted flow
// work: the submitter walks away after uploading, and this email brings them back at
// the moment the redline is waiting for them.
//
// Sends through Resend when RESEND_API_KEY is set (env or Settings). Otherwise the email
// is written to data/outbox/ and shown on the in-app Outbox page, so nothing leaves the
// machine during development.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, readSettings } from "./store.js";
import { encode } from "./docxml.js";

const OUTBOX = path.join(DATA_DIR, "outbox");
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export const isEmail = (s) => EMAIL_RE.test(String(s || ""));

export function emailConfig() {
  const s = readSettings();
  const resendKey = process.env.RESEND_API_KEY || s.resend_api_key || "";
  return {
    mode: resendKey ? "resend" : "outbox",
    resendKey,
    from: process.env.EMAIL_FROM || s.email_from || "Intake Last <onboarding@resend.dev>",
    appUrl: (process.env.APP_URL || s.app_url || `http://127.0.0.1:${process.env.PORT || 3330}`).replace(/\/+$/, ""),
  };
}

export function readyEmail(matter, { fewest, most, appUrl }) {
  const link = `${appUrl}/#/m/${matter.id}`;
  const first = matter.submitter ? matter.submitter.split(/\s+/)[0] : "";
  const n = `${fewest === most ? most : `${fewest} to ${most}`} quick question${most === 1 ? "" : "s"}`;
  const subject = `Your reviewed contract is ready: ${matter.filename}`;
  const text = [
    first ? `Hi ${first},` : "Hi,",
    "",
    `We've reviewed ${matter.filename} against our playbook. Answer ${n} about the deal and you can download the redline that fits it, ready to send to the vendor.`,
    "",
    link,
    "",
    "It takes about a minute.",
  ].join("\n");
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5;color:#1d1f24;max-width:520px">
<p>${first ? `Hi ${encode(first)},` : "Hi,"}</p>
<p>We've reviewed <strong>${encode(matter.filename)}</strong> against our playbook. Answer ${n} about the deal and you can download the redline that fits it, ready to send to the vendor.</p>
<p style="margin:28px 0"><a href="${encode(link)}" style="background:#2f5bea;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;display:inline-block">Answer ${n} and download</a></p>
<p style="color:#6b6f78;font-size:14px">It takes about a minute. If the button does not work, open this link: <a href="${encode(link)}">${encode(link)}</a></p>
</div>`;
  return { to: matter.email, subject, text, html, link };
}

export async function send(email, config = emailConfig()) {
  if (config.mode === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { via: "resend", id: (await res.json()).id };
  }
  fs.mkdirSync(OUTBOX, { recursive: true });
  const sent_at = new Date().toISOString();
  const file = `${sent_at.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(OUTBOX, file), JSON.stringify({ ...email, from: config.from, sent_at }, null, 2));
  return { via: "outbox", id: file };
}

export function listOutbox() {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs.readdirSync(OUTBOX)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), "utf8")));
}
