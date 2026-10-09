/**
 * `wazap demo seed`: a fictional WhatsApp world, filed into a throwaway data
 * dir through the real ingestion, so search and the meaning index can be tried
 * before any account is linked. The world is the evaluation's own fixture
 * (eval/fixtures/world.json, shipped in the package): two accounts, about a
 * hundred and thirty messages, all invented.
 *
 * Nothing here opens a socket: each account is opened stored-only and handed
 * the records the phone would have sent. The default data dir is refused, and
 * so is any dir that holds a real install.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Chat as BaileysChat, Contact as BaileysContact, WAMessage } from "baileys";
import { AccountRegistry } from "./accounts.js";
import { accountPaths, defaultDataDir, paths, type Config } from "./config.js";
import { WazapError } from "./errors.js";
import { say } from "./logger.js";
import { dim, info, ok } from "./ui.js";
import { WhatsAppService } from "./whatsapp.js";

/** The marker that says a data dir was made by `demo seed`, so seeding it again is allowed. */
export const DEMO_MARKER = ".wazap-demo";

export const DEFAULT_FIXTURE = fileURLToPath(new URL("../eval/fixtures/world.json", import.meta.url));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Every message reaches wazap as history; the fixture's own anchor time of day. */
const ANCHOR_TIME = "15:30";
const MONTHS_RO = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie", "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];
const DAY_WORDS: Record<string, number> = { azi: 0, ieri: -1, alaltăieri: -2, alaltaieri: -2, maine: 1, mâine: 1 };

// The world file, as far as the seed reads it. -----------------------------------

interface WorldContact {
  phone: string;
  name?: string;
  pushname?: string;
  saved?: boolean;
  business?: boolean;
}

interface WorldGroup {
  id: string;
  subject: string;
  participants: { who: string; admin?: boolean }[];
}

interface WorldMessage {
  chat: string;
  from: string;
  at: string;
  key?: string;
  text?: string;
  mentions?: string[];
  voice?: { seconds: number; transcript?: string; language?: string };
  media?: { kind: string; caption?: string; filename?: string };
}

type WorldGenerator =
  | {
      type: "chat_lines";
      chat: string;
      count?: number;
      segments: { start: string; end: string; count: number }[];
      lines: { from: string; text: string }[];
    }
  | { type: "monthly"; chat: string; from: string; day: number; time: string; count: number; amounts: string[]; template: string };

interface WorldAccount {
  id: string;
  name: string;
  default?: boolean;
  me: { phone: string; name: string };
  contacts?: Record<string, WorldContact>;
  groups?: Record<string, WorldGroup>;
  messages?: WorldMessage[];
  generate?: WorldGenerator[];
}

export interface World {
  description?: string;
  accounts: WorldAccount[];
}

export function loadWorld(file: string): World {
  let world: World;
  try {
    world = JSON.parse(readFileSync(file, "utf8")) as World;
  } catch (err) {
    throw new WazapError("INVALID_ID", `Cannot read the demo world ${file}: ${err instanceof Error ? err.message : String(err)}`, "Pass --fixture <path to a world JSON>");
  }
  if (!Array.isArray(world.accounts) || world.accounts.length === 0) {
    throw new WazapError("INVALID_ID", `The demo world ${file} has no accounts.`, "Pass --fixture <path to a world JSON>");
  }
  return world;
}

// Time, on this machine's wall clock. ----------------------------------------

function wallMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function onDay(anchorMs: number, deltaDays: number, hhmm: string): number {
  const day = new Date(anchorMs + deltaDays * DAY);
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  return wallMs(day.getFullYear(), day.getMonth() + 1, day.getDate(), hour, minute);
}

/**
 * The anchor every fixture time is relative to: the latest 15:30 at or before
 * now. Before 15:30 that is yesterday's, so a message the fixture puts "today
 * at 14:05" is never dated in the future.
 */
export function demoAnchor(now = Date.now()): number {
  const [hour, minute] = ANCHOR_TIME.split(":").map(Number) as [number, number];
  for (let back = 0; ; back++) {
    const day = new Date(now - back * DAY);
    const at = wallMs(day.getFullYear(), day.getMonth() + 1, day.getDate(), hour, minute);
    if (at <= now) return at;
  }
}

/** The fixture's time grammar: "-3h", "-1h30m", "-3d", "-3d 09:15", "ieri 19:40", "2024-03-10 10:00". */
export function parseAt(spec: string, anchorMs: number): number {
  const text = String(spec).trim();
  let match = /^(azi|ieri|alaltăieri|alaltaieri|maine|mâine) (\d{1,2}:\d{2})$/.exec(text);
  if (match) return onDay(anchorMs, DAY_WORDS[match[1]!]!, match[2]!);
  match = /^-(\d+)d(?: (\d{1,2}:\d{2}))?$/.exec(text);
  if (match) return match[2] ? onDay(anchorMs, -Number(match[1]), match[2]) : anchorMs - Number(match[1]) * DAY;
  match = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/.exec(text);
  if (match) return wallMs(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  match = /^([+-])(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (match && (match[2] || match[3] || match[4])) {
    const ms = Number(match[2] ?? 0) * HOUR + Number(match[3] ?? 0) * 60_000 + Number(match[4] ?? 0) * 1000;
    return match[1] === "-" ? anchorMs - ms : anchorMs + ms;
  }
  throw new WazapError("INVALID_ID", `Unreadable time "${spec}" in the demo world.`);
}

interface Spec extends WorldMessage {
  ts: number;
}

function generated(account: WorldAccount, anchorMs: number): Spec[] {
  const out: Spec[] = [];
  for (const gen of account.generate ?? []) {
    if (gen.type === "chat_lines") {
      const produced: Spec[] = [];
      let line = 0;
      for (const segment of gen.segments) {
        const start = parseAt(segment.start, anchorMs);
        const end = parseAt(segment.end, anchorMs);
        const step = segment.count > 1 ? (end - start) / (segment.count - 1) : 0;
        for (let i = 0; i < segment.count; i++, line++) {
          const entry = gen.lines[line % gen.lines.length]!;
          produced.push({ chat: gen.chat, from: entry.from, at: "", ts: Math.round(start + i * step), text: entry.text });
        }
      }
      const count = gen.count ?? produced.length;
      out.push(...produced.slice(Math.max(0, produced.length - count)));
    } else if (gen.type === "monthly") {
      const anchor = new Date(anchorMs);
      const [hour, minute] = gen.time.split(":").map(Number) as [number, number];
      for (let i = 1; i <= gen.count; i++) {
        let month = anchor.getMonth() + 1 - i;
        let year = anchor.getFullYear();
        while (month < 1) {
          month += 12;
          year -= 1;
        }
        const values: Record<string, string> = { month: MONTHS_RO[month - 1]!, year: String(year), amount: gen.amounts[(i - 1) % gen.amounts.length]! };
        out.push({
          chat: gen.chat,
          from: gen.from,
          at: "",
          ts: wallMs(year, month, gen.day, hour, minute),
          text: gen.template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? ""),
        });
      }
    }
  }
  return out;
}

// Records. ----------------------------------------------------------------

const jidOfPhone = (phone: string): string => `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`;

function keyIdFor(accountId: string, index: number, key: string | undefined): string {
  const seed = key ? `${accountId}:${key}` : `${accountId}:#${index}`;
  return `3EB0${createHash("sha1").update(seed).digest("hex").slice(0, 16).toUpperCase()}`;
}

interface Person {
  jid: string;
  name: string | null;
  pushname: string | null;
  saved: boolean;
  business: boolean;
}

/** One account of the world, as what a phone would hand wazap: contacts, chats, messages and transcripts. */
export interface SeedAccount {
  id: string;
  name: string;
  owner: string;
  contacts: BaileysContact[];
  chats: BaileysChat[];
  messages: WAMessage[];
  transcripts: { sid: string; text: string; language: string; seconds: number }[];
}

export function seedRecords(account: WorldAccount, anchorMs: number): SeedAccount {
  const me = jidOfPhone(account.me.phone);
  const people = new Map<string, Person>([["me", { jid: me, name: account.me.name, pushname: null, saved: false, business: false }]]);
  for (const [key, contact] of Object.entries(account.contacts ?? {})) {
    people.set(key, {
      jid: jidOfPhone(contact.phone),
      name: contact.name ?? null,
      pushname: contact.pushname ?? null,
      saved: contact.saved !== false,
      business: contact.business === true,
    });
  }
  const groups = new Map(Object.entries(account.groups ?? {}).map(([key, group]) => [key, { jid: `${group.id}@g.us`, subject: group.subject }]));

  const specs: Spec[] = [...(account.messages ?? []).map((spec) => ({ ...spec, ts: parseAt(spec.at, anchorMs) })), ...generated(account, anchorMs)];
  const messages: WAMessage[] = [];
  const transcripts: SeedAccount["transcripts"] = [];
  const chatTs = new Map<string, number>();
  specs.forEach((spec, index) => {
    const group = groups.get(spec.chat);
    const peer = people.get(spec.chat);
    const sender = people.get(spec.from);
    if ((!group && !peer) || !sender) throw new WazapError("INVALID_ID", `Message ${index} of ${account.id} names an unknown chat or sender.`);
    const chatJid = group ? group.jid : peer!.jid;
    const fromMe = spec.from === "me";
    const keyId = keyIdFor(account.id, index, spec.key);
    const key = { remoteJid: chatJid, fromMe, id: keyId, ...(group && !fromMe ? { participant: sender.jid } : {}) };
    let message: WAMessage["message"];
    if (spec.voice) {
      message = { audioMessage: { ptt: true, seconds: spec.voice.seconds, mimetype: "audio/ogg; codecs=opus" } };
      if (spec.voice.transcript) {
        transcripts.push({ sid: `${fromMe}_${chatJid}_${keyId}`, text: spec.voice.transcript, language: spec.voice.language ?? "ro", seconds: spec.voice.seconds });
      }
    } else if (spec.media) {
      message = spec.media.filename
        ? { documentMessage: { mimetype: "application/pdf", fileName: spec.media.filename, title: spec.media.filename, caption: spec.media.caption } }
        : { imageMessage: { mimetype: "image/jpeg", caption: spec.media.caption, width: 720, height: 400 } };
    } else if (spec.mentions?.length) {
      const mentionedJid = spec.mentions.map((who) => people.get(who)?.jid).filter((jid): jid is string => jid !== undefined);
      message = { extendedTextMessage: { text: spec.text, contextInfo: { mentionedJid } } };
    } else {
      message = { conversation: spec.text };
    }
    const pushName = !fromMe && !sender.saved ? (sender.pushname ?? undefined) : undefined;
    messages.push({ key, messageTimestamp: Math.floor(spec.ts / 1000), message, ...(pushName ? { pushName } : {}) } as WAMessage);
    chatTs.set(chatJid, Math.max(chatTs.get(chatJid) ?? 0, spec.ts));
  });
  messages.sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));

  const contacts = [...people.entries()]
    .filter(([key, person]) => key !== "me" && person.saved)
    .map(([, person]) => ({ id: person.jid, name: person.name ?? undefined, ...(person.business ? { verifiedName: person.name ?? undefined } : {}) }) as BaileysContact);
  const chats = [...chatTs].map(([jid, ts]) => {
    const group = [...groups.values()].find((entry) => entry.jid === jid);
    return { id: jid, conversationTimestamp: Math.floor(ts / 1000), ...(group ? { name: group.subject } : {}) } as BaileysChat;
  });
  return { id: account.id, name: account.name, owner: me, contacts, chats, messages, transcripts };
}

// The data dir. -----------------------------------------------------------

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Null when `dataDir` may be seeded; otherwise why not. */
export function demoRefusal(dataDir: string): WazapError | null {
  if (canonical(dataDir) === canonical(defaultDataDir())) {
    return new WazapError(
      "INVALID_ID",
      `The demo never seeds ${dataDir}: that is where a real install keeps its accounts.`,
      "Pass --data-dir ./.wazap-demo (or any empty directory)"
    );
  }
  const marked = existsSync(join(dataDir, DEMO_MARKER));
  if (!marked && existsSync(paths(dataDir).accountsFile)) {
    return new WazapError(
      "INVALID_ID",
      `${dataDir} already holds accounts that the demo did not make.`,
      "Pass --data-dir with an empty directory for the demo"
    );
  }
  return null;
}

/**
 * Seeds every account of the world into `config.dataDir`. Seeding again is
 * harmless: each message has a fixed key and is stored once. The embedding
 * queue is left for `wazap embed index --wait`, or a server, to work through.
 */
export async function seedDemo(config: Config, fixture: string = DEFAULT_FIXTURE): Promise<{ accounts: number; messages: number }> {
  const refusal = demoRefusal(config.dataDir);
  if (refusal !== null) throw refusal;
  const world = loadWorld(fixture);
  const anchorMs = demoAnchor();
  const seeds = world.accounts.map((account) => seedRecords(account, anchorMs));
  const defaultId = (world.accounts.find((account) => account.default) ?? world.accounts[0]!).id;

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(config.dataDir, DEMO_MARKER), "Made by `wazap demo seed`: fictional data, safe to delete.\n", { mode: 0o600 });
  const file = { v: 2, default: defaultId, accounts: seeds.map((seed) => ({ id: seed.id, name: seed.name, enabled: true, owner: seed.owner })) };
  writeFileSync(paths(config.dataDir).accountsFile, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  const registry = AccountRegistry.load(config.dataDir);

  let total = 0;
  for (const seed of seeds) {
    const record = registry.get(seed.id);
    if (record === undefined) throw new WazapError("WHATSAPP_ERROR", `The demo account ${seed.id} did not register.`);
    const wa = new WhatsAppService(config, record, accountPaths(config.dataDir, seed.id));
    try {
      await wa.openStored();
      wa.ingestStored(seed);
      await wa.storageIdle();
      for (const transcript of seed.transcripts) {
        wa.db.messages.setTranscript(transcript.sid, transcript.text, {
          provider: "demo",
          at: Date.now(),
          language: transcript.language,
          duration_seconds: transcript.seconds,
        });
      }
      total += seed.messages.length;
      say(ok(`${seed.name} (${seed.id}): ${seed.messages.length} messages in ${seed.chats.length} chats`));
    } finally {
      await wa.stop();
    }
  }
  say(dim(`Fictional data from ${fixture}; nothing was sent anywhere.`));
  return { accounts: seeds.length, messages: total };
}

/** `wazap demo seed [--fixture <path>]`. */
export async function runDemo(config: Config): Promise<void> {
  const [verb] = config.args;
  if (verb !== "seed") {
    throw new WazapError("INVALID_ID", `Cannot run \`wazap demo ${config.args.join(" ")}\`.`, "Run `wazap demo seed --data-dir ./.wazap-demo`");
  }
  await seedDemo(config, config.fixture === undefined ? DEFAULT_FIXTURE : resolve(config.fixture));
  say(info(`Next: \`wazap embed index --wait --data-dir ${config.dataDir}\`, then \`wazap search "<words>" --data-dir ${config.dataDir}\``));
}
