/**
 * Run the suite again and again on clocks that break day arithmetic, and report
 * what only fails there.
 *
 * Two time bombs already went off in this tree: catch_up's fixtures landed on
 * yesterday when a run crossed local midnight (099300f), and the legacy account
 * aged past its story when a service booted a day after the recording (70082ef).
 * Both were invisible at the hour the suite is usually run. This walks the hours
 * on purpose: a zone times a run, an instant starts it, and a test that passes at
 * the baseline but fails in some cell is one more of them.
 *
 *   node scripts/clock-sweep.mjs            # the whole matrix
 *   node scripts/clock-sweep.mjs --quick    # the few cells `npm run check:clock` runs
 *   node scripts/clock-sweep.mjs --zones UTC,Pacific/Auckland --moments eve,new-year
 *   node scripts/clock-sweep.mjs --files test/catchup.test.mjs
 *   node scripts/clock-sweep.mjs --no-baseline --node <path to another node>
 *
 * The clock is set per run by test/fake-clock.mjs, which offsets it rather than
 * freezing it, so timers and TTLs still elapse. It goes in NODE_OPTIONS rather
 * than on the command line, so the `wazap` processes the suite spawns are on the
 * same clock as the test that started them; a run where only the parent moved
 * would be the two-clock split that hid the legacy fixture's decay. The zone is
 * `TZ` in the child's environment. Nothing touches the machine's clock.
 *
 * One clock stays real either way: the filesystem's. A file the product stamps
 * with `utimes` is dated by the machine, so a test that moves its own clock into
 * the past and then reads an mtime back is comparing two different clocks — the
 * fixture has to date what it writes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Zones chosen for what each one does to a day boundary: UTC is what CI runs on,
 * Bucharest is where the author runs and is UTC+2/+3, Los Angeles is a day behind
 * UTC for most of its afternoon, Auckland is a day ahead of it, Kolkata sits on a
 * half-hour offset that catches arithmetic done in whole hours, and Lord Howe
 * moves its clocks by half an hour rather than a whole one.
 */
const ZONES = ["UTC", "Europe/Bucharest", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata", "Australia/Lord_Howe"];

/**
 * Moments given as local wall clock, resolved in whichever zone times the run,
 * so "one minute to midnight" is that zone's midnight and not UTC's.
 * The dates are fixed rather than relative to today, so a cell that fails once
 * fails again tomorrow and can be handed to someone else as a command.
 */
const MOMENTS = [
  { id: "noon", at: [2027, 6, 15, 12, 0, 0], why: "a control: mid-afternoon on a Tuesday, the hour a suite is usually run" },
  { id: "eve", at: [2026, 12, 31, 23, 59, 30], why: "thirty seconds to midnight, and to a new year" },
  { id: "new-year", at: [2027, 1, 1, 0, 0, 30], why: "thirty seconds past midnight, in a year the fixtures were not written in" },
  { id: "small-hours", at: [2027, 6, 15, 0, 5, 0], why: "00:05, where anything placed hours back falls on yesterday" },
  { id: "sun-late", at: [2027, 2, 28, 23, 59, 30], why: "a Sunday about to become Monday: a weekday label and a week boundary at once" },
  { id: "mon-early", at: [2027, 3, 1, 0, 0, 30], why: "the Monday after, and the first of a month" },
  { id: "leap-day", at: [2028, 2, 29, 23, 59, 30], why: "29 February about to become 1 March" },
];

/** The cells `npm run check:clock` runs: the two midnights that caught the first two bombs, in the two zones that differ most. */
const QUICK = [
  ["UTC", "small-hours"],
  ["Pacific/Auckland", "eve"],
  ["America/Los_Angeles", "dst-after"],
];

// ------------------------------------------------------------------ zone math

function zoneOffsetMs(zone, at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const f = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant at which `zone` reads the given wall clock. Solved by iteration
 * because the offset depends on the answer; on a spring-forward the named hour
 * does not exist and this lands on the hour the zone jumped to, which is the
 * moment worth testing anyway.
 */
function instantOf(zone, [year, month, day, hour, minute, second]) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let at = asUtc;
  for (let i = 0; i < 4; i++) at = asUtc - zoneOffsetMs(zone, at);
  return at;
}

/** The first moment after `from` at which `zone` changes its offset, or null within `days`. */
function nextTransition(zone, from, days = 400) {
  const HOUR = 3_600_000;
  let lo = from;
  let offset = zoneOffsetMs(zone, lo);
  for (let hourIndex = 1; hourIndex <= days * 24; hourIndex++) {
    const at = from + hourIndex * HOUR;
    const next = zoneOffsetMs(zone, at);
    if (next === offset) continue;
    let hi = at;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (zoneOffsetMs(zone, mid) === offset) lo = mid;
      else hi = mid;
    }
    return hi;
  }
  return null;
}

/** Every cell for a zone: the fixed wall-clock moments, then the two sides of its next clock change. */
function cellsFor(zone, wanted) {
  const cells = MOMENTS.map((moment) => ({ zone, id: moment.id, at: instantOf(zone, moment.at), why: moment.why }));
  const change = nextTransition(zone, Date.UTC(2026, 9, 1));
  if (change !== null) {
    const before = zoneOffsetMs(zone, change - 60_000) / 3_600_000;
    const after = zoneOffsetMs(zone, change + 60_000) / 3_600_000;
    const label = `${before >= 0 ? "+" : ""}${before} to ${after >= 0 ? "+" : ""}${after}`;
    cells.push({ zone, id: "dst-before", at: change - 30 * 60_000, why: `half an hour before this zone moves its clocks (${label})` });
    cells.push({ zone, id: "dst-after", at: change + 30 * 60_000, why: `half an hour after it (${label})` });
  }
  return wanted === null ? cells : cells.filter((cell) => wanted.has(cell.id));
}

// ----------------------------------------------------------------- one run

const TAP_FAIL = /^\s*not ok \d+ - (.*)$/;
const TAP_LOCATION = /^\s*location: '(.*)'$/;

/** The failing test names in a TAP stream, each with the file it was declared in. */
function failures(tap) {
  const found = [];
  const lines = tap.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const failed = TAP_FAIL.exec(lines[i]);
    if (failed === null) continue;
    let file = "?";
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const where = TAP_LOCATION.exec(lines[j]);
      if (where === null) continue;
      file = where[1].replace(`${ROOT}/`, "").replace(/:\d+:\d+$/, "");
      break;
    }
    found.push(`${file} › ${failed[1].trim()}`);
  }
  return found;
}

const CLOCK = pathToFileURL(join(ROOT, "test", "fake-clock.mjs")).href;

function runSuite({ node, zone, at, files, label }) {
  const args = ["--test", "--test-reporter=tap", "--import", "./test/no-color.mjs", ...files];
  const env = { ...process.env, TZ: zone };
  if (at === null) delete env.FAKE_CLOCK_MS;
  else {
    env.FAKE_CLOCK_MS = String(at);
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${CLOCK}`.trim();
  }
  const began = Date.now();
  const ran = spawnSync(node, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env });
  const tap = `${ran.stdout ?? ""}\n${ran.stderr ?? ""}`;
  return { label, zone, at, seconds: Math.round((Date.now() - began) / 1000), status: ran.status, failures: failures(tap), tap };
}

// -------------------------------------------------------------------- driver

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const quick = process.argv.includes("--quick");
const node = flag("node", process.execPath);
const files = (flag("files") ?? "test/*.test.mjs").split(/[, ]+/);
const zonesAsked = flag("zones");
const momentsAsked = flag("moments");

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  console.error("clock-sweep: dist/ is missing — run `npm run build` first.");
  process.exit(1);
}

const zones = zonesAsked !== null ? zonesAsked.split(",") : quick ? [...new Set(QUICK.map(([zone]) => zone))] : ZONES;
const wanted = momentsAsked !== null ? new Set(momentsAsked.split(",")) : null;
let cells = zones.flatMap((zone) => cellsFor(zone, wanted));
if (quick && momentsAsked === null) {
  const asked = new Set(QUICK.map((pair) => pair.join("|")));
  cells = cells.filter((cell) => asked.has(`${cell.zone}|${cell.id}`));
}

const stamp = (zone, at) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" }).format(at);

console.log(`clock-sweep: ${cells.length} cell${cells.length === 1 ? "" : "s"} on ${node === process.execPath ? `node ${process.version}` : node}`);
console.log(`files: ${files.join(" ")}\n`);

let known = new Set();
if (!process.argv.includes("--no-baseline")) {
  process.stdout.write("baseline (real clock, this machine's zone) … ");
  const base = runSuite({ node, zone: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone, at: null, files, label: "baseline" });
  known = new Set(base.failures);
  console.log(`${base.failures.length} failing, ${base.seconds}s`);
  for (const name of base.failures) console.log(`  already red: ${name}`);
  console.log("");
}

// A cell's whole TAP is kept when it fails: the name of a test says which one
// broke, never why, and the run that found it is forty seconds gone.
const kept = mkdtempSync(join(tmpdir(), "clock-sweep-"));

const clockBound = new Map();
const why = new Map();
let red = 0;
for (const cell of cells) {
  process.stdout.write(`${cell.zone} @ ${cell.id} (${stamp(cell.zone, cell.at)}) … `);
  const run = runSuite({ node, zone: cell.zone, at: cell.at, files, label: `${cell.zone}/${cell.id}` });
  const fresh = run.failures.filter((name) => !known.has(name));
  console.log(fresh.length === 0 ? `ok (${run.seconds}s)` : `${fresh.length} NEW failing (${run.seconds}s)`);
  for (const name of fresh) {
    console.log(`  ${name}`);
    if (!clockBound.has(name)) clockBound.set(name, []);
    clockBound.get(name).push(`${cell.zone}/${cell.id}`);
  }
  if (fresh.length > 0) {
    red++;
    why.set(`${cell.zone}/${cell.id}`, cell.why);
    const tap = join(kept, `${cell.zone.replace(/\//g, "-")}.${cell.id}.tap`);
    writeFileSync(tap, run.tap);
    console.log(`  why: ${cell.why}`);
    console.log(`  tap: ${tap}`);
    console.log(`  again: TZ=${cell.zone} FAKE_CLOCK_MS=${cell.at} NODE_OPTIONS="--import ${CLOCK}" ${node} --test --import ./test/no-color.mjs ${files.join(" ")}`);
  }
}

console.log(`\n=== ${clockBound.size} clock-bound test${clockBound.size === 1 ? "" : "s"} across ${red}/${cells.length} cells ===`);
for (const [name, where] of [...clockBound].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${name}\n  fails at: ${where.join(", ")}`);
  if (where.length === 1) console.log(`  one cell only — re-run it before calling it the clock's doing; a suite under load has its own races.`);
}
if (clockBound.size === 0) console.log("nothing the clock or the zone moves.");
process.exit(clockBound.size === 0 ? 0 : 1);
