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
  readonly contacts = new Map<string, ContactNote>();
  readonly handled = new Map<string, HandledMark>();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    let parsed: NotesFile;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as NotesFile;
    } catch {
      return;
    }
    if (parsed?.v !== 1) return;
    for (const [jid, note] of Object.entries(parsed.contacts ?? {})) this.contacts.set(jid, note);
    for (const [jid, mark] of Object.entries(parsed.handled ?? {})) this.handled.set(jid, mark);
  }

  private save(): void {
    const data: NotesFile = {
      v: 1,
      contacts: Object.fromEntries(this.contacts),
      handled: Object.fromEntries(this.handled),
    };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
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
