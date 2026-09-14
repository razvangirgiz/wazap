/**
 * What the user told wazap about people and threads, kept on this machine
 * only: a note on a contact ("Hermi, my agent"), and "handled" marks that
 * take a chat off the waiting list until the other side writes again.
 * Nothing here is sent to WhatsApp.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ContactNote {
  note: string;
  updated_at: string;
}

/** The agent's filing on a person: tags ("client") and key-value details ("role": "contabil"). */
export interface ContactFields {
  tags?: string[];
  fields?: Record<string, string>;
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
  fields?: Record<string, ContactFields>;
}

export class Notes {
  /** Why the file on disk could not be read, or why the last save failed. Null when healthy. */
  error: string | null = null;
  private loadError: string | null = null;
  readonly contacts = new Map<string, ContactNote>();
  readonly handled = new Map<string, HandledMark>();
  readonly fields = new Map<string, ContactFields>();

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
    for (const [jid, fields] of Object.entries(parsed.fields ?? {})) this.fields.set(jid, fields);
  }

  private save(): void {
    // A file that never read cleanly must not be overwritten with a fresh one.
    if (this.loadError) throw new Error(`Cannot overwrite unreadable notes: ${this.loadError}`);
    const data: NotesFile = {
      v: 1,
      contacts: Object.fromEntries(this.contacts),
      handled: Object.fromEntries(this.handled),
      fields: Object.fromEntries(this.fields),
    };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
      this.error = null;
    } catch (error) {
      rmSync(tmp, { force: true });
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
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

  fieldsFor(jid: string): ContactFields | undefined {
    return this.fields.get(jid);
  }

  /**
   * Apply tag/field edits (already normalized by the caller). A person left
   * with no tags and no fields loses the entry, like an emptied note.
   */
  updateFields(
    jid: string,
    edit: { addTags?: string[]; removeTags?: string[]; set?: Record<string, string>; removeFields?: string[] }
  ): ContactFields | undefined {
    const current = this.fields.get(jid);
    const tags = new Set(current?.tags ?? []);
    for (const tag of edit.removeTags ?? []) tags.delete(tag);
    for (const tag of edit.addTags ?? []) tags.add(tag);
    const fields = { ...(current?.fields ?? {}) };
    for (const key of edit.removeFields ?? []) delete fields[key];
    for (const [key, value] of Object.entries(edit.set ?? {})) fields[key] = value;
    if (tags.size === 0 && Object.keys(fields).length === 0) {
      this.fields.delete(jid);
    } else {
      const next: ContactFields = { updated_at: new Date().toISOString() };
      if (tags.size > 0) next.tags = [...tags].sort();
      if (Object.keys(fields).length > 0) next.fields = fields;
      this.fields.set(jid, next);
    }
    this.save();
    return this.fields.get(jid);
  }

  /**
   * Everything remembered about `from` moves to `to` — for when a lid turns
   * out to be a phone jid already known. What `to` holds wins a conflict.
   */
  mergeInto(from: string, to: string): void {
    if (from === to) return;
    const note = this.contacts.get(from);
    const mark = this.handled.get(from);
    const details = this.fields.get(from);
    if (!note && !mark && !details) return;
    if (note) {
      if (!this.contacts.has(to)) this.contacts.set(to, note);
      this.contacts.delete(from);
    }
    if (mark) {
      if (!this.handled.has(to)) this.handled.set(to, mark);
      this.handled.delete(from);
    }
    if (details) {
      const existing = this.fields.get(to);
      const next: ContactFields = { updated_at: details.updated_at };
      const tags = [...new Set([...(details.tags ?? []), ...(existing?.tags ?? [])])].sort();
      const merged = { ...(details.fields ?? {}), ...(existing?.fields ?? {}) };
      if (tags.length > 0) next.tags = tags;
      if (Object.keys(merged).length > 0) next.fields = merged;
      this.fields.set(to, next);
      this.fields.delete(from);
    }
    this.save();
  }

  /** True when the ask now open is the one the user already dealt with. */
  isHandled(jid: string, askId: string): boolean {
    return this.handled.get(jid)?.ask_id === askId;
  }
}
