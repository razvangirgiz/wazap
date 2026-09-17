/**
 * The service's side of db.contacts.find: a group WhatsApp delivers as
 * read-only is one the account left, and is never a candidate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { WhatsAppService } from "../dist/whatsapp.js";
import { connectedService } from "./helpers.mjs";

const ME = "40700000001@s.whatsapp.net";
const STILL_IN = "120363000000000001@g.us";
const LEFT = "120363000000000002@g.us";

test("a group the account left is not a candidate, one it is in is", () => {
  const { svc, sock } = connectedService(WhatsAppService, { prefix: "wazap-find-", id: ME, name: "Răzvan" });
  sock.ev.emit("chats.upsert", [
    { id: STILL_IN, name: "Fotbal marți" },
    { id: LEFT, name: "Fotbal joi", readOnly: true },
  ]);
  const found = svc.db.contacts.find({ name: "fotbal", kind: "group", limit: 5 });
  assert.deepEqual(
    found.candidates.map((candidate) => candidate.jid),
    [STILL_IN]
  );
});
