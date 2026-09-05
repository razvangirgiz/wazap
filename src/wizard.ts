/**
 * Full-screen setup/login at a terminal: black background, the ASCII logo
 * ghosted at the top of a centered block, and a step counter on every screen.
 * Pipes never enter here; they keep the log.
 */
import { createInterface } from "node:readline/promises";
import { BANNER_ART } from "./banner.js";
import {
  humanLayout,
  centerBlock,
  colorEnabled,
  setSpinnerHost,
  stripAnsi,
  width,
  SPINNER_FRAMES,
  SPINNER_MS,
} from "./ui.js";

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";
const BLACK = "\x1b[48;2;0;0;0m";
const FG = "\x1b[38;2;214;214;210m";
const GHOST = "\x1b[38;2;58;64;60m";
const MUTED = "\x1b[38;2;110;118;112m";
const TITLE = "\x1b[1m\x1b[38;2;244;244;240m";
const BRAND = "\x1b[38;2;0;215;135m";
const GREEN = "\x1b[38;2;61;214;140m";
const RED = "\x1b[38;2;240;113;120m";
const YELLOW = "\x1b[38;2;230;184;77m";
const REST = `${BLACK}${FG}`;

function tint(code: string, text: string): string {
  return colorEnabled() ? `${code}${text}${REST}` : text;
}

export function wizBrand(text: string): string {
  return tint(BRAND, text);
}
export function wizDim(text: string): string {
  return tint(MUTED, text);
}
export function wizBold(text: string): string {
  return tint(TITLE, text);
}
export function wizOk(text: string): string {
  return `${tint(GREEN, "✓")} ${text}`;
}
export function wizFail(text: string): string {
  return `${tint(RED, "✗")} ${text}`;
}
export function wizInfo(text: string): string {
  return `${tint(MUTED, "–")} ${text}`;
}
export function wizWarn(text: string): string {
  return `${tint(YELLOW, "!")} ${text}`;
}

function cols(): number {
  return process.stderr.columns ?? 80;
}
function rows(): number {
  return process.stderr.rows ?? 24;
}

function ghostLogo(): string[] {
  return BANNER_ART.split("\n").map((line) => tint(GHOST, line));
}

/** The lines of one wizard screen, before they are placed on the terminal. */
export function wizardLines(n: number, total: number, title: string, body: readonly string[] = []): string[] {
  return [...ghostLogo(), "", tint(MUTED, `${n} / ${total}`), wizBold(title), "", ...body];
}

/** Status line the 80ms spinner paints. Glyph and copy stay on one row. */
export function wizardSpinLine(frame: number, text: string): string {
  return `${tint(BRAND, SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!)} ${text}`;
}

const CSI = /^\x1b\[[0-9;]*m/;

/** Visible characters in `text` after stripping SGR, not counting a leading indent. */
export function contentChars(text: string): number {
  return [...stripAnsi(text).replace(/^\s*/, "")].length;
}

/**
 * The first `chars` visible characters of `text`, keeping SGR sequences so a
 * painted prefix does not leak colour onto the next line.
 */
export function typePrefix(text: string, chars: number): string {
  const match = /^(\s*)([\s\S]*)$/.exec(text);
  const pad = match?.[1] ?? "";
  const rest = match?.[2] ?? text;
  let taken = 0;
  let out = "";
  let i = 0;
  while (i < rest.length && taken < chars) {
    const seq = CSI.exec(rest.slice(i));
    if (seq) {
      out += seq[0];
      i += seq[0].length;
      continue;
    }
    const cp = rest.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out += ch;
    i += ch.length;
    taken += 1;
  }
  return `${pad}${out}`;
}

/** QR, the pairing box, block drawing: dump the whole line, do not type it. */
export function isArtLine(text: string): boolean {
  const packed = stripAnsi(text).replace(/ /g, "");
  if (packed.length < 6) return false;
  let art = 0;
  for (const ch of packed) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x2500 && code <= 0x259f) art += 1;
  }
  return art / packed.length >= 0.4;
}

function charDelay(ch: string): number {
  if (ch === " " || ch === "\t") return 0;
  if (",.;:!?".includes(ch)) return 32;
  return 12;
}

function typewriterOff(): boolean {
  const flag = process.env.WAZAP_TYPEWRITER;
  return flag === "0" || flag === "off";
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const TYPE_CAP_MS = 800;
const LINE_GAP_MS = 28;
const LOGO_LINES = BANNER_ART.split("\n").length;

export interface RevealOpts {
  /** Default true for next/paint. False snaps the frame (errors, in-progress Finish). */
  reveal?: boolean;
}

export interface Wizard {
  readonly total: number;
  readonly n: number;
  next(title: string, body?: readonly string[], opts?: RevealOpts): Promise<void>;
  paint(body: readonly string[], opts?: RevealOpts): Promise<void>;
  spin(text: string): void;
  stopSpin(final?: string): void;
  tick(line: string): void;
  done(line: string): void;
  prompt(question: string): Promise<string>;
  close(): void;
}

let active: WizardImpl | null = null;
let exitHooked = false;

function write(text: string): void {
  process.stderr.write(text);
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    active?.close();
  });
}

class WizardImpl implements Wizard {
  n = 0;
  #title = "";
  #body: string[] = [];
  #open = false;
  #frame = 0;
  #spinText: string | null = null;
  #footer: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #spinRow: number | null = null;
  #gen = 0;
  #onResize = (): void => {
    void this.#render({ reveal: false });
  };

  constructor(readonly total: number) {}

  enter(): void {
    if (this.#open) return;
    this.#open = true;
    hookExit();
    setSpinnerHost(this);
    write(`${ALT_ENTER}${BLACK}${FG}${HIDE_CURSOR}${CLEAR}`);
    process.on("SIGWINCH", this.#onResize);
  }

  async next(title: string, body: readonly string[] = [], opts: RevealOpts = {}): Promise<void> {
    this.#haltSpin();
    this.n += 1;
    this.#title = title;
    this.#body = [...body];
    await this.#render({ reveal: opts.reveal !== false });
  }

  async paint(body: readonly string[], opts: RevealOpts = {}): Promise<void> {
    this.#body = [...body];
    await this.#render({ reveal: opts.reveal !== false, bodyOnly: true });
  }

  spin(text: string): void {
    const same = this.#spinText === text;
    this.#spinText = text;
    this.#footer = null;
    this.#ensureTimer();
    if (same && this.#spinRow !== null) this.#paintSpinLine();
    else void this.#render({ reveal: false });
  }

  stopSpin(final?: string): void {
    this.#haltSpin();
    if (final !== undefined) this.#footer = final;
    void this.#render({ reveal: false });
  }

  tick(line: string): void {
    this.spin(line);
  }

  done(line: string): void {
    this.stopSpin(line);
  }

  async prompt(question: string): Promise<string> {
    this.#haltSpin();
    const line = `${wizBrand("?")} ${question}`;
    this.#body = [...this.#body, "", line];
    await this.#render({ reveal: true, leaveCursor: true, onlyLast: true });
    write(SHOW_CURSOR);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question("");
    } finally {
      rl.close();
      write(HIDE_CURSOR);
    }
  }

  close(): void {
    if (!this.#open) return;
    this.#gen += 1;
    this.#haltSpin();
    this.#open = false;
    process.off("SIGWINCH", this.#onResize);
    if (active === this) active = null;
    setSpinnerHost(null);
    write(`${SHOW_CURSOR}${ALT_LEAVE}`);
  }

  #haltSpin(): void {
    this.#spinText = null;
    this.#footer = null;
    this.#spinRow = null;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #ensureTimer(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      this.#frame += 1;
      this.#paintSpinLine();
    }, SPINNER_MS);
    this.#timer.unref();
  }

  #statusLine(): string | null {
    if (this.#spinText !== null) return wizardSpinLine(this.#frame, this.#spinText);
    return this.#footer;
  }

  #content(): string[] {
    const status = this.#statusLine();
    const body = status === null ? this.#body : [...this.#body, status];
    return wizardLines(this.n, this.total, this.#title, body);
  }

  #paintSpinLine(): void {
    if (this.#spinText === null || this.#spinRow === null) {
      void this.#render({ reveal: false });
      return;
    }
    const placed = centerBlock(this.#content(), cols(), rows());
    const line = (placed[this.#spinRow - 1] ?? "").replace(/\x1b\[0m/g, REST);
    write(`${BLACK}\x1b[${this.#spinRow};1H\x1b[2K${line}`);
  }

  #blit(placed: readonly string[], opts: { leaveCursor?: boolean } = {}): void {
    const keep = opts.leaveCursor === true;
    const last = placed.length - 1;
    write(`${BLACK}${FG}\x1b[H`);
    for (let i = 0; i < placed.length; i++) {
      const line = placed[i]!.replace(/\x1b\[0m/g, REST);
      if (keep && i === last) write(`\x1b[2K${line}`);
      else write(`\x1b[2K${line}\n`);
    }
    if (!keep) write("\x1b[J");
  }

  #place(full: readonly string[], typed: readonly string[]): string[] {
    const inner = Math.max(0, ...full.map(width));
    const left = Math.max(0, Math.floor((cols() - inner) / 2));
    const pad = " ".repeat(left);
    const body = typed.map((line) => `${pad}${line}`);
    const top = body.length >= rows() ? 1 : Math.floor((rows() - body.length) / 2);
    return [...Array<string>(top).fill(""), ...body];
  }

  #shouldType(index: number, line: string, lines: readonly string[]): boolean {
    if (index < LOGO_LINES + 2) return false;
    if (stripAnsi(line).trim() === "") return false;
    if (isArtLine(line)) return false;
    if (this.#spinText !== null && index === lines.length - 1) return false;
    return true;
  }

  async #typewriter(opts: { leaveCursor?: boolean; onlyLast?: boolean; bodyOnly?: boolean } = {}): Promise<void> {
    const gen = this.#gen;
    const full = this.#content();
    const typeable = full.map((line, index) => this.#shouldType(index, line, full));
    if (opts.onlyLast === true) {
      for (let i = 0; i < typeable.length - 1; i++) typeable[i] = false;
    }
    if (opts.bodyOnly === true) {
      const bodyStart = LOGO_LINES + 4;
      for (let i = 0; i < Math.min(bodyStart, typeable.length); i++) typeable[i] = false;
    }

    const typed = full.map((line, index) => (typeable[index] ? "" : line));
    this.#blit(this.#place(full, typed), opts);

    const caret = tint(BRAND, "▍");
    const jobs: { index: number; chars: string[] }[] = [];
    for (let i = 0; i < full.length; i++) {
      if (!typeable[i]) continue;
      const visible = [...stripAnsi(full[i]!).replace(/^\s*/, "")];
      if (visible.length === 0) continue;
      jobs.push({ index: i, chars: visible });
    }

    let budget = 0;
    for (const job of jobs) for (const ch of job.chars) budget += charDelay(ch);
    budget += Math.max(0, jobs.length - 1) * LINE_GAP_MS;
    const scale = budget > TYPE_CAP_MS ? TYPE_CAP_MS / budget : 1;

    for (let j = 0; j < jobs.length; j++) {
      const job = jobs[j]!;
      for (let n = 1; n <= job.chars.length; n++) {
        if (this.#gen !== gen || !this.#open) return;
        typed[job.index] = `${typePrefix(full[job.index]!, n)}${n < job.chars.length ? caret : ""}${REST}`;
        this.#blit(this.#place(full, typed), opts);
        await sleep(charDelay(job.chars[n - 1]!) * scale);
      }
      typed[job.index] = full[job.index]!;
      if (j < jobs.length - 1) await sleep(LINE_GAP_MS * scale);
    }

    if (this.#gen !== gen || !this.#open) return;
    this.#blit(centerBlock(full, cols(), rows()), opts);
  }

  async #render(
    opts: { leaveCursor?: boolean; reveal?: boolean; onlyLast?: boolean; bodyOnly?: boolean } = {},
  ): Promise<void> {
    this.enter();
    const gen = ++this.#gen;
    const lines = this.#content();
    const placed = centerBlock(lines, cols(), rows());
    this.#spinRow = this.#spinText === null ? null : placed.length;
    if (opts.reveal === true && !typewriterOff()) {
      const resume = this.#timer !== null;
      if (this.#timer !== null) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
      await this.#typewriter(opts);
      if (resume && this.#spinText !== null) this.#ensureTimer();
      if (this.#gen !== gen) return;
    } else {
      this.#blit(placed, opts);
    }
  }
}

export function startWizard(total: number): Wizard {
  active?.close();
  const wizard = new WizardImpl(total);
  active = wizard;
  wizard.enter();
  return wizard;
}

export function activeWizard(): Wizard | null {
  return active;
}

/** How many screens setup will show at a terminal. */
export function setupWizardSteps(opts: { linked: boolean; npx: boolean; askWrites: boolean; loginCode: boolean }): number {
  let n = 0;
  if (!opts.linked) {
    if (opts.loginCode) n += 2;
    else n += 1;
    n += 1;
    if (opts.askWrites) n += 1;
  }
  n += 1;
  if (opts.npx) n += 1;
  n += 3;
  return n;
}

export function loginWizardSteps(loginCode: boolean, askWrites: boolean): number {
  return (loginCode ? 2 : 1) + 1 + (askWrites ? 1 : 0);
}

/** Only start a wizard at a real terminal. */
export function maybeWizard(total: number): Wizard | null {
  if (!humanLayout()) return null;
  return startWizard(total);
}
