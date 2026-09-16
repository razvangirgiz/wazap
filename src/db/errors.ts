/**
 * What the storage layer refuses, and why. These codes stay inside the
 * storage boundary: the service maps them to the tool-facing WazapError codes
 * when it wires the database in.
 */
export type StorageErrorCode =
  /** The file was written by a newer wazap; opening it could corrupt what that version relies on. */
  | "SCHEMA_TOO_NEW"
  /** A read-only open found a schema this version would still have to migrate. */
  | "SCHEMA_OUTDATED"
  /** A read-only open of a file that does not exist. */
  | "NOT_FOUND"
  /** A write through a connection opened read-only. */
  | "READ_ONLY"
  /** An argument the storage layer cannot store faithfully: a zero timestamp, a malformed id. */
  | "INVALID_INPUT"
  /** The file belongs to another WhatsApp account. */
  | "OWNER_MISMATCH"
  /** More than 2^20 messages in one second; the chronological id space for it is full. */
  | "ID_SPACE_EXHAUSTED"
  /** The connection was closed. */
  | "CLOSED";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly fix?: string;

  constructor(code: StorageErrorCode, message: string, fix?: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.fix = fix;
  }
}
