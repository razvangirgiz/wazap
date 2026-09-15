import { test } from "node:test";
import assert from "node:assert/strict";
import { trustedProxies } from "../dist/proxy-trust.js";
import { parseCli } from "../dist/config.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const value of [undefined, "", "   "]) {
  test(`proxy default is only loopback (${JSON.stringify(value)})`, () => {
    assert.deepEqual(trustedProxies(value), ["loopback"]);
  });
}

test("proxy trust supports disabling forwarded headers or naming exact peers", () => {
  assert.deepEqual(trustedProxies("none"), []);
  assert.deepEqual(trustedProxies("loopback, 172.20.0.2/32, ::1/128, 2001:db8::/64"), [
    "loopback",
    "172.20.0.2/32",
    "::1/128",
    "2001:db8::/64",
  ]);
});

for (const value of [
  "true",
  "1",
  "uniquelocal",
  "linklocal",
  "none,127.0.0.1",
  "proxy.example",
  "127.0.0.1,",
  "0.0.0.0/0",
  "::/0",
  "10.0.0.1/33",
  "::1/129",
  "10.0.0.1/no",
  "127.0.0.1/8/extra",
]) {
  test(`invalid proxy trust fails closed (${value})`, () => {
    assert.throws(() => trustedProxies(value), { code: "INVALID_ID" });
  });
}

test("WAZAP_TRUST_PROXY is loaded from the data-dir env and can be overridden", () => {
  const dir = mkdtempSync(join(tmpdir(), "wazap-proxy-config-"));
  const previous = process.env.WAZAP_TRUST_PROXY;
  try {
    delete process.env.WAZAP_TRUST_PROXY;
    writeFileSync(join(dir, ".env"), "WAZAP_TRUST_PROXY=none\n");
    assert.deepEqual(parseCli(["serve", "--data-dir", dir]).config.trustedProxies, []);
    process.env.WAZAP_TRUST_PROXY = "loopback,172.20.0.2";
    assert.deepEqual(parseCli(["serve", "--data-dir", dir]).config.trustedProxies, ["loopback", "172.20.0.2"]);
  } finally {
    if (previous === undefined) delete process.env.WAZAP_TRUST_PROXY;
    else process.env.WAZAP_TRUST_PROXY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
