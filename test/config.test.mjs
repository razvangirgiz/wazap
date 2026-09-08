import { test } from "node:test";
import assert from "node:assert/strict";

import { isRemoteHttp, readOnlySetting, writesHints } from "../dist/config.js";

const CASES = [
  [undefined, false, "unset registers write tools; config prints writes: on (default)"],
  ["", false, "empty is not an explicit on-value"],
  ["0", false, "0 is the stored yes from login / config writes on"],
  ["false", false, "a boolean false from a bundle checkbox"],
  ["1", true],
  ["true", true],
  ["yes", true],
  ["on", true],
  ["TRUE", true],
];

for (const [value, expected, note] of CASES) {
  test(`readOnlySetting(${JSON.stringify(value)}) is ${expected}${note ? ` (${note})` : ""}`, () => {
    assert.equal(readOnlySetting(value), expected);
  });
}

test("isRemoteHttp is true for HTTP transport or a public URL", () => {
  assert.equal(isRemoteHttp({ transport: "stdio", publicUrl: null }), false);
  assert.equal(isRemoteHttp({ transport: "http", publicUrl: null }), true);
  assert.equal(isRemoteHttp({ transport: "stdio", publicUrl: "https://wazap.example" }), true);
});

test("writesHints stay quiet when writes are on and the server is local", () => {
  assert.deepEqual(writesHints({ readOnly: false, transport: "stdio", publicUrl: null }), []);
});

test("writesHints name the enable command when writes are off", () => {
  const hints = writesHints({ readOnly: true, transport: "stdio", publicUrl: null });
  assert.equal(hints.length, 1);
  assert.match(hints[0], /Write tools are not registered/);
  assert.match(hints[0], /wazap config writes on/);
});

test("writesHints on HTTP say a write token is not writes being on", () => {
  const hints = writesHints({ readOnly: true, transport: "http", publicUrl: "https://wazap.example" });
  assert.equal(hints.length, 2);
  assert.match(hints[0], /Write tools are not registered/);
  assert.match(hints[1], /write token is not the same as writes being enabled/i);
  assert.match(hints[1], /read token never registers write tools/i);
});
