/**
 * A fixture world, from JSON into a running wazap: accounts on fake sockets,
 * then contacts, chats, groups and messages delivered as the Baileys events a
 * phone would send, so they go through the real ingestion. Notes, tags and
 * details go through the service's own setters, transcripts through the
 * database, media bytes through the download seam.
 *
 * Import scripts/eval/clock.mjs before this module in a process that has not
 * read the time yet.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { AccountHub } from "../../dist/account-hub.js";
import { attachSocket, sandboxSocket } from "../../test/sandbox.mjs";
import { fromWallClock, wallClock } from "./clock.mjs";
import { mediaBytes } from "./media.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Messages older than this reach wazap as history (`append`), newer ones as live (`notify`). */
const LIVE_WINDOW_MS = 12 * HOUR;
const MONTHS_RO = [
  "ianuarie",
  "februarie",
  "martie",
  "aprilie",
  "mai",
  "iunie",
  "iulie",
  "august",
  "septembrie",
  "octombrie",
  "noiembrie",
  "decembrie",
];

// ---------------------------------------------------------------------------
// The world file.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `patch` over `base`: objects merge, arrays and scalars replace, a key
 * written `+name` appends to the array `name`, and an array of records with
 * `id` (the accounts) takes an object keyed by id.
 */
export function mergeWorld(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(base) && isPlainObject(patch) && base.every((entry) => isPlainObject(entry) && "id" in entry)) {
    return base.map((entry) => (patch[entry.id] === undefined ? entry : mergeWorld(entry, patch[entry.id])));
  }
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith("+")) {
      const name = key.slice(1);
      out[name] = [...(out[name] ?? []), ...value];
    } else {
      out[key] = key in base ? mergeWorld(base[key], value) : value;
    }
  }
  return out;
}

export function loadWorld(path, patch) {
  const world = JSON.parse(readFileSync(path, "utf8"));
  return mergeWorld(world, patch);
}

// ---------------------------------------------------------------------------
// Time.
// ---------------------------------------------------------------------------

const DAY_WORDS = { azi: 0, ieri: -1, alaltăieri: -2, alaltaieri: -2, maine: 1, mâine: 1 };

/** A wall-clock time on the day `deltaDays` from the anchor's. */
function onDay(anchorMs, deltaDays, hhmm) {
  const day = wallClock(anchorMs + deltaDays * DAY);
  const [hour, minute] = hhmm.split(":").map(Number);
  return fromWallClock(day.year, day.month, day.day, hour, minute);
}

/**
 * The instant a fixture time names, relative to the anchor: "-3h", "-40m",
 * "-1h30m", "+5s", "-3d" (that many days ago, same time), "-3d 09:15",
 * "azi 08:10", "ieri 19:40", "alaltăieri 21:00", or "2024-03-10 10:00".
 */
export function parseAt(spec, anchorMs) {
  const text = String(spec).trim();
  let match = /^(azi|ieri|alaltăieri|alaltaieri|maine|mâine) (\d{1,2}:\d{2})$/.exec(text);
  if (match) return onDay(anchorMs, DAY_WORDS[match[1]], match[2]);
  match = /^-(\d+)d(?: (\d{1,2}:\d{2}))?$/.exec(text);
  if (match) return match[2] ? onDay(anchorMs, -Number(match[1]), match[2]) : anchorMs - Number(match[1]) * DAY;
  match = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/.exec(text);
  if (match) return fromWallClock(...match.slice(1).map(Number));
  match = /^([+-])(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (match && (match[2] || match[3] || match[4])) {
    const ms = Number(match[2] ?? 0) * HOUR + Number(match[3] ?? 0) * 60_000 + Number(match[4] ?? 0) * 1000;
    return match[1] === "-" ? anchorMs - ms : anchorMs + ms;
  }
  throw new Error(`Unreadable fixture time "${spec}"`);
}

// ---------------------------------------------------------------------------
// Messages.
// ---------------------------------------------------------------------------

function keyIdFor(accountId, index, key) {
  const seed = key ? `${accountId}:${key}` : `${accountId}:#${index}`;
  return `3EB0${createHash("sha1").update(seed).digest("hex").slice(0, 16).toUpperCase()}`;
}

/** The generated lines of a world's `generate` entries, as ordinary message specs. */
export function expandGenerated(account, anchorMs) {
  const out = [];
  for (const gen of account.generate ?? []) {
    if (gen.type === "chat_lines") {
      // Each segment spreads its share of the lines evenly over its span, so
      // a busy group talks through the day and sleeps at night; `count`, or
      // the account's `limits[chat]` a case patches in, keeps only the newest.
      let line = 0;
      const produced = [];
      for (const segment of gen.segments) {
        const start = parseAt(segment.start, anchorMs);
        const end = parseAt(segment.end, anchorMs);
        const step = segment.count > 1 ? (end - start) / (segment.count - 1) : 0;
        for (let i = 0; i < segment.count; i++, line++) {
          const entry = gen.lines[line % gen.lines.length];
          produced.push({ chat: gen.chat, from: entry.from, ts: Math.round(start + i * step), text: entry.text });
        }
      }
      const count = account.limits?.[gen.chat] ?? gen.count ?? produced.length;
      out.push(...produced.slice(Math.max(0, produced.length - count)));
    } else if (gen.type === "monthly") {
      const anchor = wallClock(anchorMs);
      const [hour, minute] = gen.time.split(":").map(Number);
      for (let i = 1; i <= gen.count; i++) {
        let month = anchor.month - i;
        let year = anchor.year;
        while (month < 1) {
          month += 12;
          year -= 1;
        }
        const values = {
          month: MONTHS_RO[month - 1],
          year: String(year),
          amount: gen.amounts[(i - 1) % gen.amounts.length],
        };
        out.push({
          chat: gen.chat,
          from: gen.from,
          ts: fromWallClock(year, month, gen.day, hour, minute),
          text: gen.template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? ""),
        });
      }
    } else {
      throw new Error(`Unknown generator "${gen.type}"`);
    }
  }
  return out;
}

const jidOfPhone = (phone) => `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`;

/** People, groups and messages of one account, resolved to jids and instants. */
function resolveAccount(account, anchorMs, refs) {
  const me = { jid: jidOfPhone(account.me.phone), name: account.me.name, phone: account.me.phone };
  const shift = (account.shift_hours ?? 0) * HOUR;
  const people = new Map([["me", { key: "me", jid: me.jid, name: me.name, saved: false, me: true }]]);
  for (const [key, contact] of Object.entries(account.contacts ?? {})) {
    if (refs.contacts[key]) throw new Error(`Contact key "${key}" is used twice; keys are unique across accounts`);
    const person = {
      key,
      jid: jidOfPhone(contact.phone),
      phone: contact.phone,
      name: contact.name ?? null,
      pushname: contact.pushname ?? null,
      saved: contact.saved !== false,
      business: contact.business === true,
      note: contact.note ?? null,
      tags: contact.tags ?? [],
      fields: contact.fields ?? {},
    };
    people.set(key, person);
    refs.contacts[key] = { jid: person.jid, phone: `+${person.phone}`, name: person.name ?? person.pushname, account: account.id };
  }
  const groups = new Map();
  for (const [key, group] of Object.entries(account.groups ?? {})) {
    if (refs.groups[key]) throw new Error(`Group key "${key}" is used twice`);
    const jid = `${group.id}@g.us`;
    const participants = group.participants.map((entry) => {
      const person = people.get(entry.who);
      if (!person) throw new Error(`Group "${key}" names unknown participant "${entry.who}"`);
      return { jid: person.jid, admin: entry.admin === true };
    });
    const owner = group.owner ? people.get(group.owner)?.jid : undefined;
    groups.set(key, { key, jid, subject: group.subject, owner, participants, announce: group.announce === true });
    refs.groups[key] = { jid, name: group.subject, account: account.id };
  }
  const specs = [
    ...(account.messages ?? []).map((spec) => ({ ...spec, ts: parseAt(spec.at, anchorMs) })),
    ...expandGenerated(account, anchorMs),
  ].map((spec) => ({ ...spec, ts: spec.ts - shift }));
  const messages = specs.map((spec, index) => {
    const group = groups.get(spec.chat);
    const peer = people.get(spec.chat);
    if (!group && !peer) throw new Error(`Message ${index} of ${account.id} is in unknown chat "${spec.chat}"`);
    const sender = people.get(spec.from);
    if (!sender) throw new Error(`Message ${index} of ${account.id} is from unknown "${spec.from}"`);
    const chatJid = group ? group.jid : peer.jid;
    const fromMe = spec.from === "me";
    const keyId = keyIdFor(account.id, index, spec.key);
    const sid = `${fromMe ? "true" : "false"}_${chatJid}_${keyId}`;
    if (spec.key) {
      if (refs.messages[spec.key]) throw new Error(`Message key "${spec.key}" is used twice`);
      refs.messages[spec.key] = { id: sid, chat: chatJid, account: account.id, type: messageTypeOf(spec), text: spec.text ?? spec.media?.caption ?? null };
    }
    return { spec, chatJid, group, sender, fromMe, keyId, sid };
  });
  return { me, people, groups, messages };
}

/** The type wazap reports for a fixture message, as the scorer's `only_when` reads it. */
function messageTypeOf(spec) {
  if (spec.voice) return "voice";
  if (spec.media) return mediaBytes(spec.media.kind).mimetype.startsWith("image/") ? "image" : "document";
  return "text";
}

/** The Baileys message a fixture message arrives as, and the media bytes behind it. */
function baileysMessage(entry, people) {
  const { spec, chatJid, group, sender, fromMe, keyId } = entry;
  const key = { remoteJid: chatJid, fromMe, id: keyId, ...(group && !fromMe ? { participant: sender.jid } : {}) };
  let message;
  let media = null;
  if (spec.voice) {
    media = mediaBytes("voice");
    message = { audioMessage: { ptt: true, seconds: spec.voice.seconds, mimetype: media.mimetype, fileLength: media.bytes.length } };
  } else if (spec.media) {
    media = mediaBytes(spec.media.kind);
    if (media.mimetype.startsWith("image/")) {
      message = { imageMessage: { mimetype: media.mimetype, fileLength: media.bytes.length, caption: spec.media.caption, width: 720, height: 400 } };
    } else {
      message = {
        documentMessage: {
          mimetype: media.mimetype,
          fileLength: media.bytes.length,
          fileName: spec.media.filename,
          title: spec.media.filename,
          caption: spec.media.caption,
        },
      };
    }
  } else if (spec.mentions?.length) {
    const mentionedJid = spec.mentions.map((who) => people.get(who)?.jid).filter(Boolean);
    message = { extendedTextMessage: { text: spec.text, contextInfo: { mentionedJid } } };
  } else {
    message = { conversation: spec.text };
  }
  const pushName = !fromMe && !sender.saved ? (sender.pushname ?? undefined) : undefined;
  return {
    raw: {
      key,
      messageTimestamp: Math.floor(spec.ts / 1000),
      message,
      ...(pushName ? { pushName } : {}),
    },
    media,
  };
}

// ---------------------------------------------------------------------------
// Building it.
// ---------------------------------------------------------------------------

/** Config for a hub that serves the evaluation and talks to nobody. */
export function evalConfig(dataDir) {
  return {
    dataDir,
    readOnly: false,
    syncFullHistory: false,
    persistHistory: true,
    transport: "http",
    httpHost: "127.0.0.1",
    httpPort: 0,
    readToken: null,
    writeToken: null,
    rateLimitPerMinute: 0,
    command: "serve",
    loginCode: false,
  };
}

/**
 * Build `world` into `dataDir` (which must be empty and throwaway). Effects of
 * every account land in `effects`; `faults` is consulted on relays. Resolves
 * with the hub, the per-account parts and the references cases use.
 */
export async function buildWorld({ world, anchorMs, dataDir, effects, faults, onEffect }) {
  const accounts = world.accounts;
  const defaultAccount = accounts.find((account) => account.default) ?? accounts[0];
  const refs = { contacts: {}, groups: {}, messages: {}, accounts: {}, me: {} };
  const resolved = new Map(accounts.map((account) => [account.id, resolveAccount(account, anchorMs, refs)]));

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = {
    v: 2,
    default: defaultAccount.id,
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      enabled: true,
      owner: resolved.get(account.id).me.jid,
      ...(account.writes === false ? { writes: false } : {}),
      ...(account.draft_context === false ? { draft_context: false } : {}),
    })),
  };
  writeFileSync(join(dataDir, "accounts.json"), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dataDir, "accounts.json.required"), "", { mode: 0o600 });
  const { AccountRegistry } = await import("../../dist/accounts.js");
  const hub = new AccountHub(evalConfig(dataDir), AccountRegistry.load(dataDir));

  const parts = new Map();
  for (const account of accounts) {
    const { me, people, groups, messages } = resolved.get(account.id);
    refs.accounts[account.id] = { id: account.id, name: account.name };
    refs.me[account.id] = { jid: me.jid, phone: `+${me.phone}`, name: me.name };
    const svc = hub.get(account.id);
    await svc.bootStorage();
    const buffers = new Map();
    const groupsByJid = new Map([...groups.values()].map((group) => [group.jid, group]));
    const sock = sandboxSocket({ accountId: account.id, me, effects, groups: groupsByJid, faults, onEffect });
    attachSocket(svc, sock, {
      me,
      status: account.status ?? "connected",
      mediaBuffer: async (_sock, sid) => {
        const bytes = buffers.get(sid);
        if (!bytes) throw Object.assign(new Error("gone"), { code: "MEDIA_GONE" });
        return bytes;
      },
    });

    const saved = [...people.values()].filter((person) => !person.me && person.saved);
    sock.ev.emit(
      "contacts.upsert",
      saved.map((person) => ({ id: person.jid, name: person.name, ...(person.business ? { verifiedName: person.name } : {}) }))
    );
    const chatTs = new Map();
    for (const entry of messages) chatTs.set(entry.chatJid, Math.max(chatTs.get(entry.chatJid) ?? 0, entry.spec.ts));
    const chats = [...chatTs].map(([jid, ts]) => {
      const group = groupsByJid.get(jid);
      return { id: jid, conversationTimestamp: Math.floor(ts / 1000), ...(group ? { name: group.subject } : {}) };
    });
    for (const group of groups.values()) {
      if (!chatTs.has(group.jid)) chats.push({ id: group.jid, name: group.subject });
    }
    sock.ev.emit("chats.upsert", chats);

    const ordered = [...messages].sort((a, b) => a.spec.ts - b.spec.ts);
    const history = [];
    const live = [];
    for (const entry of ordered) {
      const { raw, media } = baileysMessage(entry, people);
      if (media) buffers.set(entry.sid, media.bytes);
      (entry.spec.ts < anchorMs - LIVE_WINDOW_MS ? history : live).push(raw);
    }
    if (history.length) sock.ev.emit("messages.upsert", { type: "append", messages: history });
    if (live.length) sock.ev.emit("messages.upsert", { type: "notify", messages: live });

    for (const person of people.values()) {
      if (person.me) continue;
      if (person.note) await svc.setContactNote(person.jid, person.note);
      if (person.tags.length || Object.keys(person.fields).length) {
        await svc.updateContactDetails(person.jid, { addTags: person.tags, fields: person.fields });
      }
    }
    for (const entry of messages) {
      const voice = entry.spec.voice;
      if (!voice?.transcript) continue;
      const ok = svc.db.messages.setTranscript(entry.sid, voice.transcript, {
        language: voice.language ?? "ro",
        duration_seconds: voice.seconds,
      });
      if (!ok) throw new Error(`Transcript for ${entry.spec.key ?? entry.sid} did not land`);
    }
    parts.set(account.id, { svc, sock, me, people, groups, buffers, spec: account });
  }
  for (const { svc } of parts.values()) {
    await svc.storageIdle();
    await svc.recallIdle();
  }
  return { hub, parts, refs, defaultAccount: defaultAccount.id };
}

/**
 * Deliver one message into a running world, as it would arrive now: `spec` is
 * a fixture message ({ account, chat, from, text, voice, media, mentions }).
 */
export function deliver(world, spec, ts = Date.now()) {
  const part = world.parts.get(spec.account ?? world.defaultAccount);
  if (!part) throw new Error(`No account "${spec.account}"`);
  const group = part.groups.get(spec.chat);
  const peer = part.people.get(spec.chat);
  const sender = part.people.get(spec.from ?? spec.chat);
  if ((!group && !peer) || !sender) throw new Error(`Unknown chat or sender in ${JSON.stringify(spec)}`);
  const chatJid = group ? group.jid : peer.jid;
  const fromMe = spec.from === "me";
  const keyId = spec.key_id ?? keyIdFor(part.spec.id, Date.now(), spec.key ?? `inject-${ts}`);
  const sid = `${fromMe ? "true" : "false"}_${chatJid}_${keyId}`;
  const { raw, media } = baileysMessage({ spec: { ...spec, ts }, chatJid, group, sender, fromMe, keyId, sid }, part.people);
  if (media) part.buffers.set(sid, media.bytes);
  part.sock.ev.emit("messages.upsert", { type: spec.append ? "append" : "notify", messages: [raw] });
  if (spec.key) world.refs.messages[spec.key] = { id: sid, chat: chatJid, account: part.spec.id, type: messageTypeOf(spec), text: spec.text ?? null };
  return sid;
}

/** Resolve "$contacts.elena.jid"-style references anywhere inside `value`. */
export function resolveRefs(value, refs) {
  if (typeof value === "string" && value.startsWith("$")) {
    const path = value.slice(1).split(".");
    let node = refs;
    for (const part of path) {
      node = node?.[part];
      if (node === undefined) throw new Error(`Unknown reference ${value}`);
    }
    return node;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, refs));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, refs)]));
  return value;
}
