/**
 * The one-time move of an account's legacy files (store.json, history/,
 * retention.json, notes.json, recall/, the 0.15-beta archive.sqlite) into its
 * account database, and the check that the database shows what the legacy
 * service showed. The service runs it at boot, before it serves the account
 * (`WhatsAppService.bootStorage`); `scripts/import-legacy.mjs` runs it on a copy.
 *
 *   const db = AccountDb.open(path, { scrubQuote });
 *   await db.resume();
 *   const report = await importLegacyAccount({ dataDir, accountId, accountPaths, db, options: { retention } });
 *   if (report.state !== "done") ... // report.verification says what differs, by key
 *
 * What the wiring must know:
 * - Open the database with this module's `scrubQuote`, or quotes of deleted
 *   messages keep their embedded copy.
 * - The legacy files are only read. Verification replays them in memory
 *   through main's boot path (legacy-replay.ts), with the import's clock, and
 *   removes any `.legacy-verify-*` copy an older run left beside the database
 *   (or in `workDir`).
 * - `state: "done"` means imported and verified; a later call returns the
 *   stored report and writes nothing. `"imported"` means the rows are in but
 *   verification found an unexpected difference (or was off); calling again
 *   re-runs only the verification.
 * - `retention` must be the service's WAZAP_RETENTION. The first run's value
 *   is kept for every resumed run.
 * - A linked account binds the database to its number (OWNER_MISMATCH if the
 *   file belongs to another). An unlinked account imports without an owner
 *   and leaves the beta archive alone, since nothing can prove it is theirs.
 * - A message more than FUTURE_SLACK_MS ahead of the clock is left out.
 */
export { importLegacyAccount, DEFAULT_IMPORT_CHUNK, IMPORT_META, type ImportArgs, type ImportOptions } from "./importer.js";
export { verifyLegacyImport, SAMPLE_KEYS, type VerifyArgs } from "./verify.js";
export { scrubQuote } from "./scrub.js";
export { FUTURE_SLACK_MS, STORY_TTL_MS } from "./convert.js";
export { IMPORT_PHASES } from "./report.js";
export type * from "./report.js";
