/**
 * The one door to `node:sqlite`. Node 22 prints an ExperimentalWarning the
 * first time the module loads; a static import would emit it while ESM links,
 * before any code of ours could stand in the way. Loading it here, on first
 * use and through `require`, lets exactly that warning be dropped: stdout is
 * the MCP protocol, and stderr is the log a user reads when something is wrong.
 * Every other warning still goes through.
 */
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";

export type DatabaseSync = NodeSqlite.DatabaseSync;
export type StatementSync = NodeSqlite.StatementSync;
export type SQLInputValue = NodeSqlite.SQLInputValue;
export type SQLOutputValue = NodeSqlite.SQLOutputValue;
export type SqliteModule = typeof NodeSqlite;

let loaded: SqliteModule | null = null;

/** The warning Node 22 raises for `node:sqlite`, and nothing else. */
export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeof typeOrOptions === "object" && typeOrOptions !== null
        ? (typeOrOptions as { type?: unknown }).type
        : undefined;
  const name = warning instanceof Error ? warning.name : type;
  const message = warning instanceof Error ? warning.message : String(warning);
  return name === "ExperimentalWarning" && /\bSQLite\b/.test(message);
}

export function sqlite(): SqliteModule {
  if (loaded !== null) return loaded;
  const original = process.emitWarning;
  process.emitWarning = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    loaded = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return loaded;
}
