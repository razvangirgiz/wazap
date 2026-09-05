import { atomicWrite } from "./atomic-file.js";
/**
 * What the user told wazap about people and threads, kept on this machine
 * only: a note on a contact ("Hermi, my agent"), and "handled" marks that
 * take a chat off the waiting list until the other side writes again.
 * Nothing here is sent to WhatsApp.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ContactNote {
  note: string;
  updated_at: string;
}

export interface HandledMark {
  /** The ask that was open when the user said they had handled it. A newer ask reopens the chat. */
  ask_id: string;
  at: string;
}

interface NotesFile {
  v: 1;
  contacts?: Record<string, ContactNote>;
  handled?: Record<string, HandledMark>;
}

export class Notes {
  error: string | null = null;
  private loadError: string | null = null;
  readonly contacts = new Map<string, ContactNote>();
  readonly handled = new Map<string, HandledMark>();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    let parsed: NotesFile;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as NotesFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.error = this.loadError = error instanceof Error ? error.message : String(error);
      return;
    }
    if (parsed?.v !== 1) {
      this.error = this.loadError = "Unsupported notes file version";
      return;
    }
    for (const [jid, note] of Object.entries(parsed.contacts ?? {})) this.contacts.set(jid, note);
    for (const [jid, mark] of Object.entries(parsed.handled ?? {})) this.handled.set(jid, mark);
  }

  private save(): void {
    if (this.loadError) throw new Error(`Cannot overwrite unreadable notes: ${this.loadError}`);
    const data: NotesFile = {
      v: 1,
      contacts: Object.fromEntries(this.contacts),
      handled: Object.fromEntries(this.handled),
    };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      atomicWrite(this.file, `${JSON.stringify(data, null, 2)}\n`);
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  remap(from: string, to: string): void {
    let changed = false;
    for (const map of [this.contacts, this.handled] as Array<Map<string, any>>) {
      const old = map.get(from);
      if (old) {
        if (!map.has(to)) map.set(to, old);
        map.delete(from);
        changed = true;
      }
    }
    if (changed) this.save();
  }
  noteFor(jid: string): string | undefined {
    return this.contacts.get(jid)?.note;
  }

  /** An empty note removes the entry. */
  setNote(jid: string, note: string): void {
    const trimmed = note.trim();
    if (trimmed) this.contacts.set(jid, { note: trimmed, updated_at: new Date().toISOString() });
    else this.contacts.delete(jid);
    this.save();
  }

  markHandled(jid: string, askId: string): void {
    this.handled.set(jid, { ask_id: askId, at: new Date().toISOString() });
    this.save();
  }

  /** True when the ask now open is the one the user already dealt with. */
  isHandled(jid: string, askId: string): boolean {
    return this.handled.get(jid)?.ask_id === askId;
  }
}
