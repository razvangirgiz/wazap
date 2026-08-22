import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizePhone, resolveChatId, isGroupId } from "../dist/ids.js";

const lidToPn = (lid) => (lid === "99887766@lid" ? "15550100" : undefined);

const CANONICAL = [
  ["15550100", "15550100@s.whatsapp.net"],
  ["+15550100", "15550100@s.whatsapp.net"],
  ["+1 555-0100", "15550100@s.whatsapp.net"],
  ["15550100@s.whatsapp.net", "15550100@s.whatsapp.net"],
  ["15550100@c.us", "15550100@s.whatsapp.net"],
  ["15550100:12@s.whatsapp.net", "15550100@s.whatsapp.net"],
  ["120363000000000000@g.us", "120363000000000000@g.us"],
  ["99887766@lid", "15550100@s.whatsapp.net"],
  ["11112222@lid", "11112222@lid"],
];

test("resolveChatId canonicalizes every accepted id form", () => {
  for (const [input, expected] of CANONICAL) {
    assert.equal(resolveChatId(input, lidToPn), expected, `resolveChatId(${JSON.stringify(input)})`);
  }
});

test("resolveChatId is idempotent", () => {
  for (const [, expected] of CANONICAL) {
    assert.equal(resolveChatId(expected, lidToPn), expected, `re-resolving ${expected}`);
  }
});

const BAD_PHONES = ["0722123456", "1234567", "1234567890123456", "+40 abc"];

test("a number without a country code is INVALID_PHONE with an example", () => {
  for (const input of BAD_PHONES) {
    assert.throws(
      () => resolveChatId(input, lidToPn),
      (err) => {
        assert.equal(err.code, "INVALID_PHONE", `${input} should be INVALID_PHONE, got ${err.code}`);
        assert.match(err.fix, /\+15550100/);
        return true;
      },
      `resolveChatId(${JSON.stringify(input)})`,
    );
  }
});

const BAD_IDS = ["", "   ", "someone@newsletter", "abc@s.whatsapp.net", "@g.us", "not an id@"];

test("anything else is INVALID_ID", () => {
  for (const input of BAD_IDS) {
    assert.throws(
      () => resolveChatId(input, lidToPn),
      (err) => {
        assert.equal(err.code, "INVALID_ID", `${JSON.stringify(input)} should be INVALID_ID, got ${err.code}`);
        return true;
      },
      `resolveChatId(${JSON.stringify(input)})`,
    );
  }
});

test("normalizePhone returns bare digits for E.164 input", () => {
  assert.equal(normalizePhone("+1 555 0100"), "15550100");
  assert.equal(normalizePhone("15550100"), "15550100");
  assert.throws(() => normalizePhone("0722123456"), { code: "INVALID_PHONE" });
});

test("isGroupId only accepts group jids", () => {
  assert.equal(isGroupId("120363000000000000@g.us"), true);
  assert.equal(isGroupId("15550100@s.whatsapp.net"), false);
});
