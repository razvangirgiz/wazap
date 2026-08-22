import { test } from "node:test";
import assert from "node:assert/strict";

import { RateLimiter } from "../dist/ratelimit.js";

/** A limiter on a clock we control, so the test never sleeps. */
function limiterAt(perMinute) {
  let now = 0;
  const limiter = new RateLimiter(perMinute, () => now);
  return { limiter, advance: (ms) => (now += ms) };
}

test("spends the whole bucket, then refuses", () => {
  const { limiter } = limiterAt(20);
  for (let i = 0; i < 20; i++) limiter.take();
  assert.throws(
    () => limiter.take(),
    (err) => {
      assert.equal(err.code, "RATE_LIMITED");
      assert.match(err.fix, /^Wait \d+ seconds$/);
      return true;
    },
  );
});

test("refills over time instead of staying jammed", () => {
  const { limiter, advance } = limiterAt(60);
  for (let i = 0; i < 60; i++) limiter.take();
  assert.throws(() => limiter.take(), { code: "RATE_LIMITED" });
  advance(1000);
  limiter.take();
  assert.throws(() => limiter.take(), { code: "RATE_LIMITED" });
});

test("never refills past the bucket size", () => {
  const { limiter, advance } = limiterAt(5);
  advance(60 * 60 * 1000);
  for (let i = 0; i < 5; i++) limiter.take();
  assert.throws(() => limiter.take(), { code: "RATE_LIMITED" });
});

test("a limit of 0 disables the limiter", () => {
  const { limiter } = limiterAt(0);
  assert.equal(limiter.enabled, false);
  for (let i = 0; i < 1000; i++) limiter.take();
});
