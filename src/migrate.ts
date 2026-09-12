import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AccountRegistry, DEFAULT_ACCOUNT_ID, ensureAccountsFile, isRecord, writeJsonFile } from "./accounts.js";
import { readLinkedAccount } from "./auth-state.js";
import { accountPaths, paths } from "./config.js";
import { WazapError } from "./errors.js";
import { lockHolder } from "./lock.js";

/** Flat-layout names that move into accounts/default/. qr.png is leftover login art. */
export const LAYOUT_ENTRIES = ["auth", "store.json", "history", "media", "previews", "notes.json", "qr.png"] as const;

export interface MigrationManifest {
  v: 2;
  at: string;
  moved: string[];
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function existsHere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function leftoverEntries(dataDir: string): string[] {
  return LAYOUT_ENTRIES.filter((name) => existsHere(join(dataDir, name)));
}

function rollbackFix(dataDir: string): string {
  return `Run \`wazap migrate rollback --data-dir ${dataDir}\``;
}

/**
 * Moving `auth/` out from under a live process breaks it, and whatever it
 * recreates at the root then blocks both migrate and rollback. The holder can
 * only be a pre-migration build: every newer one migrated at its own start.
 */
function refuseWhileRunning(dataDir: string): void {
  const running = lockHolder(paths(dataDir).lockFile);
  if (running === null) return;
  throw new WazapError(
    "WHATSAPP_ERROR",
    `wazap is running (pid ${running}) on the old data layout.`,
    `stop it first (\`wazap service stop\` if it is the background service, otherwise \`kill ${running}\`), then run this again`,
  );
}

function migrateFail(dataDir: string, message: string): WazapError {
  return new WazapError("WHATSAPP_ERROR", message, rollbackFix(dataDir));
}

function tryLinkedOwner(authDir: string): string | null {
  try {
    return readLinkedAccount(authDir)?.id ?? null;
  } catch {
    // Corrupt creds still move; doctor reports them after startup.
    return null;
  }
}

function readManifest(file: string, dataDir: string): MigrationManifest | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WazapError("INVALID_ID", `Could not read ${file}.`, rollbackFix(dataDir));
  }
  if (!isRecord(parsed) || parsed.v !== 2 || typeof parsed.at !== "string" || !Array.isArray(parsed.moved)) {
    throw new WazapError("INVALID_ID", `Could not read ${file}.`, rollbackFix(dataDir));
  }
  const moved: string[] = [];
  for (const name of parsed.moved) {
    if (typeof name !== "string") {
      throw new WazapError("INVALID_ID", `Could not read ${file}.`, rollbackFix(dataDir));
    }
    moved.push(name);
  }
  return { v: 2, at: parsed.at, moved };
}

function writeManifest(file: string, manifest: MigrationManifest, dataDir: string): void {
  try {
    writeJsonFile(file, manifest);
  } catch (err) {
    if (err instanceof WazapError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw migrateFail(dataDir, `Could not write ${file}: ${detail}.`);
  }
}

function refuseLink(path: string, dataDir: string): void {
  if (isLink(path)) {
    throw migrateFail(
      dataDir,
      `Refusing to move ${path}: the layout migrator does not follow or write symlinks.`,
    );
  }
}

function moveEntry(src: string, dest: string, dataDir: string): void {
  refuseLink(src, dataDir);
  refuseLink(dest, dataDir);
  if (existsHere(dest)) {
    throw migrateFail(dataDir, `Could not move ${src}: ${dest} already exists.`);
  }
  try {
    renameSync(src, dest);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw migrateFail(dataDir, `Could not move ${src} to ${dest}: ${detail}.`);
  }
}

function seedOwner(dataDir: string): void {
  try {
    const registry = ensureAccountsFile(dataDir);
    const owner = tryLinkedOwner(accountPaths(dataDir, DEFAULT_ACCOUNT_ID).authDir);
    const current = registry.get(DEFAULT_ACCOUNT_ID);
    if (current !== undefined && current.owner !== owner) registry.setOwner(DEFAULT_ACCOUNT_ID, owner);
  } catch (err) {
    if (err instanceof WazapError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw migrateFail(dataDir, `Could not write accounts.json in ${dataDir}: ${detail}.`);
  }
}

function applyMigration(dataDir: string, manifestFile: string, existing: MigrationManifest | null): void {
  const destRoot = accountPaths(dataDir, DEFAULT_ACCOUNT_ID).root;
  refuseLink(join(dataDir, "accounts"), dataDir);
  refuseLink(destRoot, dataDir);
  try {
    mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw migrateFail(dataDir, `Could not create ${destRoot}: ${detail}.`);
  }

  const at = existing?.at ?? new Date().toISOString();
  const moved = new Set(existing?.moved ?? []);

  for (const name of LAYOUT_ENTRIES) {
    const src = join(dataDir, name);
    const dest = join(destRoot, name);
    const srcHere = existsHere(src);
    const destHere = existsHere(dest);
    if (srcHere) {
      moveEntry(src, dest, dataDir);
      moved.add(name);
      writeManifest(manifestFile, { v: 2, at, moved: [...moved] }, dataDir);
      continue;
    }
    if (destHere) moved.add(name);
  }

  writeManifest(manifestFile, { v: 2, at, moved: [...moved] }, dataDir);
  seedOwner(dataDir);
}

/**
 * One-shot flat layout → accounts/default. Detects leftover names at the data-dir
 * root, not only `auth/`. Same-filesystem rename, no copy, no symlinks. A
 * missing accounts.json next to an existing `accounts/default/` is created, not
 * treated as an error. Failures name the path and the rollback command.
 */
export function migrateLayout(dataDir: string): void {
  if (!existsSync(dataDir)) return;

  const leftover = leftoverEntries(dataDir);
  const manifestFile = join(dataDir, "migration.json");
  const manifest = readManifest(manifestFile, dataDir);
  const defaultRoot = accountPaths(dataDir, DEFAULT_ACCOUNT_ID).root;

  if (leftover.length > 0) {
    refuseWhileRunning(dataDir);
    applyMigration(dataDir, manifestFile, manifest);
    return;
  }

  if (isDir(defaultRoot) && !existsSync(join(dataDir, "accounts.json"))) seedOwner(dataDir);
}

/**
 * Reverse `migration.json`. Extra accounts beyond default block it, so a
 * later add cannot be smashed back into a flat v0 dir.
 */
export function rollbackMigration(dataDir: string): MigrationManifest {
  refuseWhileRunning(dataDir);
  const manifestFile = join(dataDir, "migration.json");
  const manifest = readManifest(manifestFile, dataDir);
  if (manifest === null) {
    throw new WazapError("INVALID_ID", `No migration.json in ${dataDir}.`, "Nothing to roll back");
  }

  const registry = AccountRegistry.load(dataDir);
  if (registry.all().length > 1) {
    throw new WazapError(
      "INVALID_ID",
      "Cannot roll back: more than one account exists.",
      "Remove extra accounts first, then run `wazap migrate rollback`",
    );
  }

  const destRoot = accountPaths(dataDir, DEFAULT_ACCOUNT_ID).root;
  for (const name of [...manifest.moved].reverse()) {
    const src = join(destRoot, name);
    const dest = join(dataDir, name);
    if (!existsHere(src)) continue;
    moveEntry(src, dest, dataDir);
  }

  try {
    unlinkSync(manifestFile);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(join(dataDir, "accounts.json"));
  } catch {
    /* never written, or already gone */
  }
  try {
    rmdirSync(destRoot);
  } catch {
    /* still holds leftover files */
  }
  try {
    rmdirSync(join(dataDir, "accounts"));
  } catch {
    /* still holds other accounts, or never empty */
  }

  return manifest;
}
