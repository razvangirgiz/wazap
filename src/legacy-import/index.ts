/**
 * The one-time move of an account's legacy files (store.json, history/,
 * retention.json, notes.json, recall/, the 0.15-beta archive) into its
 * account database, and the check that the database shows what the legacy
 * service showed. Not wired into the service yet: F1-b2 runs it at boot.
 *
 *   const db = AccountDb.open(path, { scrubQuote });
 *   const report = await importLegacyAccount({ dataDir, accountId, accountPaths, db, options: { retention } });
 *   if (report.state !== "done") ... // report.verification says what differs, by key
 */
export { importLegacyAccount, DEFAULT_IMPORT_CHUNK, IMPORT_META, type ImportArgs, type ImportOptions } from "./importer.js";
export { verifyLegacyImport, SAMPLE_KEYS, type VerifyArgs } from "./verify.js";
export { scrubQuote } from "./scrub.js";
export { FUTURE_SLACK_MS, STORY_TTL_MS } from "./convert.js";
export { IMPORT_PHASES } from "./report.js";
export type * from "./report.js";
