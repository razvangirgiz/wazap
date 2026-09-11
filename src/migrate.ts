import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { AccountRegistry, DEFAULT_ACCOUNT_ID, ensureAccountsFile, writeJsonFile } from "./accounts.js";
import { readLinkedAccount } from "./auth-state.js";
import { accountPaths } from "./config.js";
import { WazapError } from "./errors.js";

/** The six v0 entries that live under the data dir today and move into accounts/default/. */
export const LAYOUT_ENTRIES = ["auth", "store.json", "history", "media", "previews", "notes.json"] as const;

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

function rollbackFix(dataDir: string): string {
  return `Run \`wazap migrate rollback --data-dir ${dataDir}\``;
}

function tryLinkedOwner(authDir: string): string | null {
  try {
    return readLinkedAccount(authDir)?.id ?? null;
  } catch {
    // Corrupt creds still move; doctor reports them after startup.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(file: string): MigrationManifest | null {
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
    throw new WazapError("INVALID_ID", `Could not read ${file}.`, rollbackFix(dirname(file)));
  }
  if (!isRecord(parsed) || parsed.v !== 2 || typeof parsed.at !== "string" || !Array.isArray(parsed.moved)) {
    throw new WazapError("INVALID_ID", `Could not read ${file}.`, rollbackFix(dirname(file)));
  }
  const moved: string[] = [];
  for (const name of parsed.moved) {
    if (typeof name !== "string") {
      throw new WazapError("INVALID_ID", `Could not read ${file}.`, rollbackFix(dirname(file)));
    }
    moved.push(name);
  }
  return { v: 2, at: parsed.at, moved };
}

function writeManifest(file: string, manifest: MigrationManifest): void {
  writeJsonFile(file, manifest);
}

function moveEntry(src: string, dest: string, dataDir: string): void {
  if (isLink(src) || isLink(dest)) {
    throw new WazapError(
      "WHATSAPP_ERROR",
      `Refusing to move ${src}: the layout migrator does not follow or write symlinks.`,
      rollbackFix(dataDir),
    );
  }
  if (existsSync(dest)) {
    throw new WazapError("WHATSAPP_ERROR", `Could not move ${src}: ${dest} already exists.`, rollbackFix(dataDir));
  }
  try {
    renameSync(src, dest);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WazapError("WHATSAPP_ERROR", `Could not move ${src} to ${dest}: ${detail}.`, rollbackFix(dataDir));
  }
}

function seedOwner(dataDir: string): void {
  const registry = ensureAccountsFile(dataDir);
  const owner = tryLinkedOwner(accountPaths(dataDir, DEFAULT_ACCOUNT_ID).authDir);
  const current = registry.get(DEFAULT_ACCOUNT_ID);
  if (current !== undefined && current.owner !== owner) registry.setOwner(DEFAULT_ACCOUNT_ID, owner);
}

function applyMigration(dataDir: string, manifestFile: string, existing: MigrationManifest | null): void {
  const destRoot = accountPaths(dataDir, DEFAULT_ACCOUNT_ID).root;
  mkdirSync(destRoot, { recursive: true, mode: 0o700 });

  const already = new Set(existing?.moved ?? []);
  const at = existing?.at ?? new Date().toISOString();
  const moved = [...already];
  writeManifest(manifestFile, { v: 2, at, moved });

  for (const name of LAYOUT_ENTRIES) {
    const src = join(dataDir, name);
    if (!existsSync(src) || already.has(name)) continue;
    moveEntry(src, join(destRoot, name), dataDir);
    moved.push(name);
    writeManifest(manifestFile, { v: 2, at, moved });
  }

  seedOwner(dataDir);
}

/**
 * One-shot v0 → v1 layout move. Detects `auth/` directly under `dataDir`.
 * Same-filesystem rename, no copy, no symlinks. A missing accounts.json next
 * to an existing `accounts/default/` is created, not treated as an error.
 * Failures name the path and the rollback command.
 */
export function migrateLayout(dataDir: string): void {
  if (!existsSync(dataDir)) return;

  const v0Auth = join(dataDir, "auth");
  if (isLink(v0Auth)) {
    throw new WazapError(
      "WHATSAPP_ERROR",
      `Refusing to move ${v0Auth}: the layout migrator does not follow or write symlinks.`,
      rollbackFix(dataDir),
    );
  }
  const hasV0 = isDir(v0Auth);
  const manifestFile = join(dataDir, "migration.json");
  const manifest = readManifest(manifestFile);
  const defaultRoot = accountPaths(dataDir, DEFAULT_ACCOUNT_ID).root;

  if (hasV0) {
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
  const manifestFile = join(dataDir, "migration.json");
  const manifest = readManifest(manifestFile);
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
    if (!existsSync(src)) continue;
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
