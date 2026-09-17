import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli, readOnlySetting, writesHints } from "../dist/config.js";

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

test("malformed read-only settings cannot silently enable writes or echo their contents", () => {
  for (const value of ["tru", "2", "SYNTHETIC-SECRET"]) {
    assert.throws(() => readOnlySetting(value), err => {
      assert.equal(err.code, "INVALID_ID");
      assert.ok(!err.message.includes(value));
      return true;
    });
  }
});

test("writesHints stay quiet when writes are on", () => {
  assert.deepEqual(writesHints({ readOnly: false, transport: "stdio", publicUrl: null }), []);
});

test("writesHints name the enable command when writes are off", () => {
  const hints = writesHints({ readOnly: true, transport: "stdio", publicUrl: null });
  assert.equal(hints.length, 1);
  assert.match(hints[0], /Write tools are not registered/);
  assert.match(hints[0], /wazap config writes on/);
});

test("writesHints carry no bearer-token note, whatever the transport", () => {
  assert.deepEqual(writesHints({ readOnly: false, transport: "http", publicUrl: "https://wazap.example" }), []);
  const hints = writesHints({ readOnly: true, transport: "http", publicUrl: "https://wazap.example" });
  assert.equal(hints.length, 1);
  assert.doesNotMatch(hints[0], /token/i);
});

test("concurrency and HTTP budgets default generously, and only a positive number changes them", () => {
  const keys = ["WAZAP_MAX_INFLIGHT", "WAZAP_MAX_INFLIGHT_TOTAL", "WAZAP_HTTP_BUDGET", "WAZAP_RETENTION"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "wazap-limits-config-"));
  const load = () => parseCli(["serve", "--data-dir", dir]).config;
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(
      (({ maxInFlight, maxInFlightTotal, httpPostBudget, retention }) => ({ maxInFlight, maxInFlightTotal, httpPostBudget, retention }))(load()),
      { maxInFlight: 8, maxInFlightTotal: 32, httpPostBudget: 240, retention: false }
    );
    Object.assign(process.env, { WAZAP_MAX_INFLIGHT: "12", WAZAP_MAX_INFLIGHT_TOTAL: "0", WAZAP_HTTP_BUDGET: "junk", WAZAP_RETENTION: "1" });
    const tuned = load();
    assert.equal(tuned.maxInFlight, 12);
    assert.equal(tuned.maxInFlightTotal, 32, "zero does not lift a safety limit");
    assert.equal(tuned.httpPostBudget, 240);
    assert.equal(tuned.retention, true);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
