// Unit test for the bulk-InMail composer's ineligible-recipient notice matcher. Pure function,
// no seat/browser needed. Run: `node --test extension/tests/composer-notices.test.mjs`.
//
// The two positive strings are verbatim from the live composer on PROD run 26eb7ce9 (job 290,
// 2026-07-27) — the run that messaged 0 of 97 because these informational banners were treated
// as a hard block. Now they defer the BATCH (LinkedIn never says WHICH recipients it drops).
import { test } from "node:test";
import assert from "node:assert/strict";
import { noticesAreBlocking, classifyNotices } from "../runtime-strategies/recruiter.mjs";

// The two families need OPPOSITE handling, so misclassifying is worse than not detecting:
// team_contacted RETIRES people (note + move to 'contacted'), rate_limited_24h must leave them
// uncontacted for a later retry. Live proof this matters: on PROD job 290 five consecutive
// batches were 100% team-contacted and zero were 24h.
test("notices are classified into the right family", () => {
  assert.equal(classifyNotices([
    "7 recipients have been contacted by someone on your team this month. Remove",
  ]).kind, "team_contacted");
  assert.equal(classifyNotices([
    "6 recipients cannot be contacted more than once within 24 hours. They will not receive this message.",
  ]).kind, "rate_limited_24h");
  // BOTH present → the conservative family wins; retiring a 24h-blocked person would mark
  // someone contacted that we never messaged.
  assert.equal(classifyNotices([
    "7 recipients have been contacted by someone on your team this month. Remove",
    "6 recipients cannot be contacted more than once within 24 hours. They will not receive this message.",
  ]).kind, "rate_limited_24h");
  // A bare count says nothing about which family → conservative.
  assert.equal(classifyNotices(["6 recipients"]).kind, "rate_limited_24h");
  assert.equal(classifyNotices([], "Compose Message To: View all 5 Send").kind, null);
  // Spanish
  assert.equal(classifyNotices([
    "7 destinatarios han sido contactados por alguien de tu equipo este mes.",
  ]).kind, "team_contacted");
  assert.equal(classifyNotices([
    "6 destinatarios no se pueden contactar más de una vez en 24 horas.",
  ]).kind, "rate_limited_24h");
});

test("the real LinkedIn banners are detected", () => {
  assert.equal(noticesAreBlocking([
    "7 recipients have been contacted by someone on your team this month. Remove",
  ]), true);
  assert.equal(noticesAreBlocking([
    "6 recipients cannot be contacted more than once within 24 hours. They will not receive this message.",
  ]), true);
  // Both at once, plus an unrelated notice.
  assert.equal(noticesAreBlocking([
    "Save as new template",
    "6 recipients cannot be contacted more than once within 24 hours. They will not receive this message.",
  ]), true);
});

test("Spanish variants are detected (the seat's locale flips)", () => {
  assert.equal(noticesAreBlocking([
    "6 destinatarios no se pueden contactar más de una vez en 24 horas. No recibirán este mensaje.",
  ]), true);
  assert.equal(noticesAreBlocking([
    "7 destinatarios han sido contactados por alguien de tu equipo este mes.",
  ]), true);
});

test("selector-independent fallback: the phrases are caught in the composer's whole text", () => {
  // No notice ELEMENT matched (the notice markup is unverified on the live seat) — the modal's
  // scoped text alone must still defer the batch.
  assert.equal(noticesAreBlocking([], "Compose Message To: View all 5 6 recipients cannot be "
    + "contacted more than once within 24 hours. They will not receive this message. Send"), true);
  assert.equal(noticesAreBlocking([], "Compose Message 7 recipients have been contacted by "
    + "someone on your team this month. Remove Send"), true);
  // …but a bare count in the composer's own recipient row must NOT (that would defer every
  // batch and never send anything).
  assert.equal(noticesAreBlocking([], "Compose Message To: 25 recipients View all 25 Send"), false);
  // As a notice ELEMENT, the same count IS a defer signal.
  assert.equal(noticesAreBlocking(["6 recipients"], ""), true);
});

test("our own message body never triggers a defer", () => {
  // The real template from job 290 — mentions "message", a URL and numbers.
  assert.equal(noticesAreBlocking([
    "Hi {firstName}, I hope you're doing well! My name is María Fernanda, and I'm part of the "
    + "Recruitment Team at Akurey. I came across your profile on LinkedIn, and I believe your "
    + "background could be a great match for our Staff Software Engineer opportunity. "
    + "https://www.akurey.com/careers/requirements?pId=290",
  ]), false);
  assert.equal(noticesAreBlocking(["Job opportunity"]), false);
  assert.equal(noticesAreBlocking(["11/589 InMail Credits"]), false);
  assert.equal(noticesAreBlocking([]), false);
  assert.equal(noticesAreBlocking(undefined), false);
});
