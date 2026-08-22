import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";
import { RESET_FIX, WazapError } from "./errors.js";

export interface LinkedAccount {
  /** Canonical `<digits>@s.whatsapp.net`. */
  id: string;
  name: string;
  number: string;
}

const CREDS_FILE = "creds.json";

function fileFor(dir: string, name: string): string {
  return join(dir, name.replace(/\//g, "__").replace(/:/g, "-"));
}

/**
 * Baileys' useMultiFileAuthState contract, with every write done as
 * tmp-file-then-rename. The stock implementation truncates the target before
 * writing, so a kill -9 in that window leaves unreadable creds and the account
 * has to be re-linked.
 */
export async function useAtomicAuthState(
  dir: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(path: string, task: () => Promise<T>): Promise<T> => {
    const next = (queues.get(path) ?? Promise.resolve()).then(task, task);
    queues.set(
      path,
      next.catch(() => undefined),
    );
    return next;
  };

  const writeData = (value: unknown, name: string): Promise<void> => {
    const path = fileFor(dir, name);
    return serialize(path, async () => {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(value, BufferJSON.replacer), { mode: 0o600 });
      await rename(tmp, path);
    });
  };

  const readData = async (name: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(fileFor(dir, name), "utf8"), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = (name: string): Promise<void> => {
    const path = fileFor(dir, name);
    return serialize(path, () => unlink(path).catch(() => undefined));
  };

  const creds = (await readCreds(dir)) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
              }
              data[id] = value as SignalDataTypeMap[T];
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const bucket = data[category as keyof typeof data] ?? {};
            for (const id in bucket) {
              const value = bucket[id];
              const name = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, name) : removeData(name));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, CREDS_FILE),
  };
}

/** Stored credentials, or null when nothing is linked yet. */
async function readCreds(dir: string): Promise<AuthenticationCreds | null> {
  let text: string;
  try {
    text = await readFile(fileFor(dir, CREDS_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text, BufferJSON.reviver) as AuthenticationCreds;
  } catch {
    throw new WazapError("SESSION_CORRUPT", `Stored credentials in ${dir} are unreadable.`, RESET_FIX);
  }
}

/** The linked account, or null when no account is linked. Throws SESSION_CORRUPT. */
export function readLinkedAccount(dir: string): LinkedAccount | null {
  let text: string;
  try {
    text = readFileSync(fileFor(dir, CREDS_FILE), "utf8");
  } catch {
    return null;
  }
  let creds: AuthenticationCreds;
  try {
    creds = JSON.parse(text, BufferJSON.reviver) as AuthenticationCreds;
  } catch {
    throw new WazapError("SESSION_CORRUPT", `Stored credentials in ${dir} are unreadable.`, RESET_FIX);
  }
  if (!creds.registered || !creds.me?.id) return null;
  const number = creds.me.id.split(":")[0]!.split("@")[0]!;
  return { id: `${number}@s.whatsapp.net`, name: creds.me.name || "", number };
}

export function clearAuth(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
