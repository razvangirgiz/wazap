import { test } from "node:test";
import assert from "node:assert/strict";
import { errorCode, withCode } from "../dist/error-code.js";

const URL_TOKEN = "https://hook.example/private?token=SYNTHETIC-SECRET";

test("a fetch failure yields its cause code and never its message", () => {
  const err = new TypeError(`fetch failed for ${URL_TOKEN}`, { cause: Object.assign(new Error(URL_TOKEN), { code: "ECONNREFUSED" }) });
  assert.equal(errorCode(err), "ECONNREFUSED");
  assert.equal(withCode(err), " (ECONNREFUSED)");
});

test("certificate, resolver and undici codes pass; free text posing as a code does not", () => {
  for (const code of ["CERT_HAS_EXPIRED", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(errorCode(Object.assign(new Error("x"), { code })), code);
  }
  assert.equal(errorCode(Object.assign(new Error("x"), { code: URL_TOKEN })), undefined);
  assert.equal(errorCode(Object.assign(new Error("x"), { code: "lowercase" })), undefined);
});

test("a child's exit code and a named error class are causes; a bare Error is not", () => {
  assert.equal(errorCode(Object.assign(new Error("Command failed: ffmpeg /tmp/private.ogg"), { code: 1 })), "exit 1");
  assert.equal(errorCode(Object.assign(new Error("slow"), { name: "TimeoutError" })), "TimeoutError");
  assert.equal(errorCode(new Error(URL_TOKEN)), undefined);
  assert.equal(errorCode(new TypeError(URL_TOKEN)), undefined);
  assert.equal(withCode("not an error"), "");
});
