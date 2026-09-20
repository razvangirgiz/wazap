/**
 * Put a test process on a chosen instant, so the suite can be run at the hours
 * that break it: a minute before local midnight, a minute after, the day a zone
 * moves its clocks, 29 February. `--import ./test/fake-clock.mjs` with
 * FAKE_CLOCK_MS set to the epoch ms to start from; without the variable the
 * module does nothing, so it is harmless in a normal run.
 *
 * The name is deliberately not WAZAP_-prefixed: test/helpers.mjs strips every
 * WAZAP_* variable from the children it spawns, so a `wazap` the suite starts
 * would have kept the machine's clock while its parent was on the fixture's —
 * the two-clock split that hid the legacy fixture's decay. The sweep puts the
 * module in NODE_OPTIONS so every node process in the tree shares one clock.
 *
 * The clock is offset, never frozen. `Date.now` keeps ticking from the instant
 * it was put on, because a stopped clock does not fail a day-boundary test — it
 * hangs every timer, TTL and `waitFor` in the suite instead.
 *
 * What is patched, and what deliberately is not:
 *
 *  - `Date.now`, and `new Date()` called with no arguments. Those are the two
 *    ways the tree reads the wall clock.
 *  - `new Date(ms)` and the rest of the constructor are untouched: a caller
 *    that names its moment already has one.
 *  - `performance.now` and `process.hrtime` stay on the real monotonic clock.
 *    They measure elapsed work — the chunk budgets in db/messages.ts and the
 *    import — and shifting them would either stall a loop or cut it short,
 *    which is not what this sweep is looking for.
 *  - The zone is not patched here. `TZ` in the environment is what Node reads
 *    for every local-time API, and the sweep sets it per run.
 *
 * `Date.now` stays writable on purpose. test/helpers.mjs reads it once as its
 * own "real" clock and reassigns it in `clockAt`/`clockAtHour`, and the
 * zero-argument constructor asks for the current `Date.now` at every call, so a
 * fixture that pins its own hour still agrees with `new Date()`.
 */

const RealDate = Date;
const target = process.env.FAKE_CLOCK_MS;

if (target !== undefined && target !== "") {
  const at = Number(target);
  if (!Number.isFinite(at)) throw new Error(`FAKE_CLOCK_MS is not an epoch in ms: ${target}`);

  const realNow = RealDate.now;
  const shift = at - realNow();
  // The current reader of the clock: replaced when something assigns `Date.now`.
  let now = () => realNow() + shift;

  globalThis.Date = new Proxy(RealDate, {
    construct(target_, args, newTarget) {
      if (args.length === 0) return Reflect.construct(target_, [now()], newTarget);
      return Reflect.construct(target_, args, newTarget);
    },
    // `Date()` without `new` is the current moment as a string.
    apply() {
      return new RealDate(now()).toString();
    },
    get(target_, prop, receiver) {
      if (prop === "now") return now;
      return Reflect.get(target_, prop, receiver);
    },
    set(target_, prop, value, receiver) {
      if (prop === "now") {
        now = value;
        return true;
      }
      return Reflect.set(target_, prop, value, receiver);
    },
    getOwnPropertyDescriptor(target_, prop) {
      if (prop === "now") return { value: now, writable: true, enumerable: false, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target_, prop);
    },
    defineProperty(target_, prop, descriptor) {
      // `t.mock.method(Date, "now", …)` defines the property rather than assigning it,
      // and `mock.restoreAll` defines the descriptor it read back.
      if (prop === "now") {
        if (!("value" in descriptor)) throw new Error("Date.now redefined as an accessor; the fake clock only tracks a value");
        now = descriptor.value;
        return true;
      }
      return Reflect.defineProperty(target_, prop, descriptor);
    },
  });
}
