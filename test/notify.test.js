import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the data folder at a temp dir before the modules read it.
process.env.IL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "intake-last-"));
delete process.env.RESEND_API_KEY;
const { readyEmail, send, listOutbox, isEmail, emailConfig } = await import("../server/notify.js");

const matter = { id: "8a3ac021-066b-4631-9865-1a948493a2a3", filename: "Acme <MSA>.docx", submitter: "Pat Requester", email: "pat@example.com" };

test("the ready email links straight to the questions for this contract", () => {
  const e = readyEmail(matter, { fewest: 4, most: 5, appUrl: "https://intake.example.com" });
  assert.equal(e.to, "pat@example.com");
  assert.equal(e.link, `https://intake.example.com/#/m/${matter.id}`);
  assert.match(e.text, /Hi Pat,/);
  assert.match(e.text, /Answer 4 to 5 quick questions/);
  assert.ok(e.html.includes(`href="${e.link}"`));
  assert.ok(e.html.includes("Acme &lt;MSA&gt;.docx"), "file name is escaped in HTML");
});

test("a single question reads naturally", () => {
  assert.match(readyEmail(matter, { fewest: 1, most: 1, appUrl: "x" }).text, /Answer 1 quick question about/);
});

test("without a Resend key, email goes to the local outbox", async () => {
  assert.equal(emailConfig().mode, "outbox");
  const result = await send(readyEmail(matter, { fewest: 3, most: 3, appUrl: "http://127.0.0.1:3330" }));
  assert.equal(result.via, "outbox");
  const [saved] = listOutbox();
  assert.equal(saved.to, "pat@example.com");
  assert.match(saved.subject, /ready/);
});

test("email addresses are sanity-checked", () => {
  assert.ok(isEmail("a.b@example.co"));
  for (const bad of ["", "pat", "pat@", "pat@example", "a b@example.com", "<x>@example.com"]) assert.equal(isEmail(bad), false, bad);
});
