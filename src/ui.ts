/**
 * Every ANSI escape wazap emits lives here. Helpers return plain text when
 * colour is off, so piped and captured output keeps the same visible words.
 */
import { homedir } from "node:os";
import { sep } from "node:path";

const RESET = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

/** stderr carries every human-readable line, so stderr decides colour. */
export function colorEnabled(): boolean {
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined) return forced !== "0";
  const disabled = process.env.NO_COLOR;
  if (disabled !== undefined && disabled !== "") return false;
  return process.stderr.isTTY === true;
}

/**
 * Whether to draw for a person rather than for a pipe. Deliberately not
 * colorEnabled(): NO_COLOR at a terminal still wants the roomy layout, and
 * FORCE_COLOR in a pipe must not reshape output something else is parsing.
 */
export function humanLayout(): boolean {
  return process.stderr.isTTY === true;
}

function paint(code: string, text: string): string {
  return colorEnabled() ? `${code}${text}${RESET}` : text;
}

function brandCode(): string {
  const rich =
    (process.env.TERM ?? "").includes("256color") || /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
  return rich ? "\x1b[38;5;42m" : "\x1b[32m";
}

export function brand(text: string): string {
  return paint(brandCode(), text);
}

export function dim(text: string): string {
  return paint("\x1b[2m", text);
}

export function bold(text: string): string {
  return paint("\x1b[1m", text);
}

export function red(text: string): string {
  return paint("\x1b[31m", text);
}

export function yellow(text: string): string {
  return paint("\x1b[33m", text);
}

/** Anything the user is meant to type. */
export function cmd(text: string): string {
  return paint("\x1b[36m", text);
}

export function ok(text: string): string {
  return `${paint("\x1b[32m", "✓")} ${text}`;
}

export function fail(text: string): string {
  return `${red("✗")} ${text}`;
}

export function info(text: string): string {
  return `${dim("–")} ${text}`;
}

export function warn(text: string): string {
  return `${yellow("!")} ${text}`;
}

/** A repair the user can run, under the line that reported the problem. */
export function fix(text: string): string {
  return `  ${yellow(`→ ${text}`)}`;
}

export function step(n: number, total: number, title: string): string {
  return `\nStep ${n} of ${total} · ${bold(title)}`;
}

function charWidth(code: number): number {
  if (code >= 0x0300 && code <= 0x036f) return 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff);
  return wide ? 2 : 1;
}

export function width(text: string): number {
  let total = 0;
  for (const char of text) total += charWidth(char.codePointAt(0)!);
  return total;
}

export function box(text: string): string {
  const rule = "─".repeat(width(text) + 2);
  return [`  ╭${rule}╮`, `  │ ${text} │`, `  ╰${rule}╯`].join("\n");
}

function nextLine(action: string, tail: string): string {
  return humanLayout() ? `Next  ${action}${tail}` : `Next: ${action}${tail}`;
}

/** A command to type. */
export function next(command: string, note?: string): string {
  return nextLine(cmd(command), note === undefined ? "" : `   ${dim(note)}`);
}

/** An instruction to follow. Not cyan: cyan means "type this". */
export function nextHint(instruction: string): string {
  return nextLine(bold(instruction), "");
}

export function tilde(path: string): string {
  const home = homedir();
  if (home === "") return path;
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Home-relative for a human; pipes and tests get the path they can act on. */
export function shortPath(path: string): string {
  return humanLayout() ? tilde(path) : path;
}

/** All but the first three digits, so a screenshot cannot leak the number. */
export function maskNumber(digits: string): string {
  const kept = digits.slice(0, 3);
  const body = kept + "x".repeat(Math.max(0, digits.length - kept.length));
  const groups = (body.slice(2).match(/.{1,3}/g) ?? []).join(" ");
  return `+${body.slice(0, 2)}${groups === "" ? "" : ` ${groups}`}`;
}

/** A wrapped line would outlive the erase, which clears one physical line. */
function clamp(text: string): string {
  const room = (process.stderr.columns ?? 80) - 2;
  if (width(text) <= room) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = charWidth(char.codePointAt(0)!);
    if (used + size > room - 1) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

export interface Spinner {
  update(text: string): void;
  stop(final?: string): void;
}

/**
 * Animated only at a terminal: a `\r` rewrite is noise in a pipe, so there the
 * text is printed once and the final line replaces nothing.
 */
export function spinner(text: string): Spinner {
  if (process.stderr.isTTY !== true) {
    process.stderr.write(`${text}\n`);
    return {
      update: () => {},
      stop: (final) => {
        if (final !== undefined) process.stderr.write(`${final}\n`);
      },
    };
  }

  let current = text;
  let frame = 0;
  const render = (): void => {
    process.stderr.write(`${CLEAR_LINE}${brand(FRAMES[frame % FRAMES.length]!)} ${clamp(current)}`);
  };
  render();
  const timer = setInterval(() => {
    frame++;
    render();
  }, FRAME_MS);
  timer.unref();

  return {
    update: (next) => {
      current = next;
      render();
    },
    stop: (final) => {
      clearInterval(timer);
      process.stderr.write(CLEAR_LINE);
      if (final !== undefined) process.stderr.write(`${final}\n`);
    },
  };
}
