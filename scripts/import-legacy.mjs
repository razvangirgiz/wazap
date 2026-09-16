/**
 * Dry run of the legacy import: one account's legacy files (store.json,
 * history/, retention.json, notes.json, recall/, the beta archive) into a
 * separate account database, then the verification against what the legacy
 * service shows. Run `npm run build` first — this imports dist/.
 *
 *   node scripts/import-legacy.mjs --data-dir <copy of ~/.wazap> [--account default] [--db <path>] [--json]
 *
 * Point it at a copy of a data dir, never the live one: the legacy files are
 * only read, but the verification replays them through the service's boot
 * path, and a running server may be appending meanwhile.
 *
 * The database goes to --db, by default `<data dir>-import/<account>/wazap.sqlite`
 * beside the data dir, and never inside it. Run again to resume an import
 * that stopped, or to get the stored report of one that finished.
 *
 * The output holds counts, timings and keys only. No message text is printed,
 * and every phone number, lid and group id is masked.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const dist = (path) => new URL(`../dist/${path}`, import.meta.url).href;
const { AccountDb } = await import(dist("db/index.js"));
const { importLegacyAccount, scrubQuote } = await import(dist("legacy-import/index.js"));
const { accountPaths } = await import(dist("config.js"));
const { lockHolder } = await import(dist("lock.js"));
const { maskNumber } = await import(dist("ui.js"));

const { values: args } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    account: { type: "string", default: "default" },
    db: { type: "string" },
    json: { type: "boolean", default: false },
    retention: { type: "boolean", default: false },
    "no-verify": { type: "boolean", default: false },
  },
});

function fail(message) {
  console.error(`import-legacy: ${message}`);
  process.exit(2);
}

if (!args["data-dir"]) fail("--data-dir is required (point it at a copy of the data dir)");
const dataDir = resolve(args["data-dir"]);
if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) fail("--data-dir is not a directory");
const accountId = args.account;
const paths = accountPaths(dataDir, accountId);
if (!existsSync(paths.root)) fail(`no account directory for "${accountId}"`);

const dbPath = resolve(args.db ?? join(dirname(dataDir), `${basename(dataDir)}-import`, accountId, "wazap.sqlite"));
const inside = relative(dataDir, dbPath);
if (!inside.startsWith("..") && !isAbsolute(inside)) fail("--db must not be inside the data dir");
if (lockHolder(join(dataDir, "server.lock")) !== null) {
  console.error("import-legacy: a wazap server holds this data dir; import from a copy instead.");
}

/** Phone numbers, lids and group ids, masked wherever they appear in a key or a file name. */
function mask(text) {
  return String(text).replace(/(\d{5,})(?=[@:]|\.jsonl)/g, (digits) => maskNumber(digits).replace(/\s/g, ""));
}

function masked(value) {
  if (Array.isArray(value)) return value.map(masked);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [mask(k), masked(v)]));
  return typeof value === "string" ? mask(value) : value;
}

const db = AccountDb.open(dbPath, { scrubQuote, checkpointDelayMs: 0 });
const started = Date.now();
let report;
try {
  report = await importLegacyAccount({
    dataDir,
    accountId,
    accountPaths: paths,
    db,
    options: { retention: args.retention, verify: !args["no-verify"], workDir: dirname(dbPath) },
  });
} finally {
  db.close();
}

const output = {
  account: accountId,
  db: basename(dbPath),
  wallMs: Date.now() - started,
  ...masked({ ...report, owner: report.owner === null ? null : "linked" }),
};

if (args.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`state: ${output.state}${output.alreadyDone ? " (already done)" : ""}, runs: ${output.runs}, wall: ${output.wallMs} ms`);
  for (const [name, phase] of Object.entries(output.phases)) {
    const skipped = Object.entries(phase.skipped).map(([k, v]) => `${k}=${v}`).join(" ");
    const details = Object.entries(phase.details).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(
      `${name.padEnd(9)} read=${phase.read} imported=${phase.imported} updated=${phase.updated} ${phase.durationMs} ms` +
        (skipped ? ` | skipped ${skipped}` : "") +
        (details ? ` | ${details}` : "")
    );
  }
  console.log(`totals: ${JSON.stringify(output.totals)}`);
  if (output.malformedFiles.length > 0) console.log(`malformed files: ${JSON.stringify(output.malformedFiles)}`);
  if (output.verification) console.log(`verification: ${JSON.stringify(output.verification, null, 2)}`);
}
