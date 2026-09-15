/**
 * stdout is the MCP JSON-RPC channel, and dependencies still print to the
 * console: libsignal logs whole session records, private keys included, with
 * console.info, which Node writes to stdout. Installed before anything else
 * loads, this sends every console line to stderr and cuts a session record
 * down to the phrase that announced it, so the keys never leave the process.
 */

/** How libsignal opens a line whose next argument is a session record. */
const SESSION_PHRASES = [
  "Closing session",
  "Opening session",
  "Removing old closed session",
  "Migrating session to",
  "Closing open session",
  "Session already closed",
];

/** The arguments a console call may print: a session line keeps its phrase and nothing after it. */
export function redactConsoleArgs(args: unknown[]): unknown[] {
  const [first] = args;
  if (typeof first !== "string") return args;
  const phrase = SESSION_PHRASES.find((candidate) => first.startsWith(candidate));
  return phrase === undefined ? args : [phrase];
}

export function installConsoleGuard(target: Console = console): void {
  const toStderr = target.error.bind(target);
  const toStderrWarn = target.warn.bind(target);
  const guarded = (...args: unknown[]): void => toStderr(...redactConsoleArgs(args));
  // table, group, count and timeLog print through log, so they follow it here.
  target.log = guarded;
  target.info = guarded;
  target.debug = guarded;
  target.dir = (item: unknown): void => toStderr(...redactConsoleArgs([item]));
  target.warn = (...args: unknown[]): void => toStderrWarn(...redactConsoleArgs(args));
  target.error = guarded;
}
