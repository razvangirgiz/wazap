/**
 * Synthetic-store timing harness: how long the hot paths take at a plausible
 * account size. Run `npm run build` first — this imports dist/, like the tests.
 *
 *   node scripts/bench-store.mjs                 # synthetic store
 *   node scripts/bench-store.mjs --real          # hydrate from $WAZAP store.json
 */
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "../test/helpers.mjs";

const ME = "40700000000@s.whatsapp.net";
const CHATS = 60;
const MSGS_PER_CHAT = 500;
const WORDS = "factura plata depozit curier maine salut revizuire contract livrare facturare".split(" ");

const { svc, sock } = connectedService(WhatsAppService, {
  prefix: "wazap-bench-",
  id: ME,
  name: "Bench",
  config: { persistHistory: true },
});
// The fake socket has no signal repository; learnLidPhones asks it for lid→pn.
sock.signalRepository = { lidMapping: { getPNsForLIDs: async () => [] } };

function msg(jid, i, text) {
  return {
    key: { id: `m${i}`, remoteJid: jid, fromMe: i % 7 === 0 },
    messageTimestamp: Math.floor(Date.now() / 1000) - i * 30,
    pushName: "Bench",
    message: { conversation: text },
  };
}

function fillSynthetic() {
  for (let c = 0; c < CHATS; c++) {
    const jid = c % 6 === 0 ? `${1000 + c}@g.us` : `4070${String(c).padStart(5, "0")}@s.whatsapp.net`;
    const messages = [];
    for (let i = 0; i < MSGS_PER_CHAT; i++) {
      messages.push(msg(jid, i, `${WORDS[i % WORDS.length]} mesaj ${i} pe chat ${c}`));
    }
    sock.ev.emit("messaging-history.set", {
      chats: [{ id: jid, name: `Chat ${c}`, unreadCount: c % 3 }],
      contacts: [{ id: jid, name: `Contact ${c}` }],
      messages,
      isLatest: true,
      progress: 100,
    });
  }
}

function fillReal() {
  const file = join(homedir(), ".wazap", "accounts", "default", "store.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  svc.store.hydrate(snapshot);
  for (const contact of svc.store.contacts.values()) svc.relearnLid(contact);
  for (const [lid, pn] of svc.store.lids) svc.learnLid(lid, pn);
  for (const key of [...svc.store.byChat.keys(), ...svc.store.chats.keys(), ...svc.store.contacts.keys()]) {
    if (key.endsWith("@lid")) svc.foldAlias(key);
  }
  svc.foldReactions();
}

const real = process.argv.includes("--real");
const t0 = performance.now();
if (real) fillReal();
else fillSynthetic();
const fillMs = performance.now() - t0;

console.log(
  `store: ${svc.store.chats.size} chats, ${svc.store.contacts.size} contacts, ${svc.store.messages.size} messages (fill ${fillMs.toFixed(0)}ms)`
);

async function bench(label, fn, runs = 5) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(
    `${label.padEnd(34)} min ${times[0].toFixed(1)}ms  med ${times[Math.floor(times.length / 2)].toFixed(1)}ms  max ${times.at(-1).toFixed(1)}ms`
  );
}

await bench("getStatus", () => svc.getStatus());
await bench("serialize", () => svc.store.serialize(), 3);
await bench("searchMessages 'factura'", () => svc.searchMessages("factura", undefined, 20));
await bench("searchMessages absent term", () => svc.searchMessages("zzqxtoken", undefined, 20));
await bench("getRecentMessages 24h", () => svc.getRecentMessages(24, "all"));
await bench("listChats", () => svc.listChats("all", 50));
await bench("getUnanswered", () => svc.getUnanswered(0, 24 * 30, 20));
await bench("searchContacts 'factur'", () => svc.searchContacts("factur", 20));
await bench("readMessages 50", () => {
  const jid = [...svc.store.byChat.keys()][0];
  return svc.readMessages(jid, 50);
});

await svc.stop();
process.exit(0);
