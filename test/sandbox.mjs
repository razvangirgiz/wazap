/**
 * A WhatsApp that is not there: the Baileys socket surface wazap drives,
 * answering reads with stubs and writing down every write instead of sending
 * it. Shared by the assistant evaluation server (scripts/eval/server.mjs) and
 * the tests that keep it honest, so a refactor of the service's private seams
 * (sockClient, wireEvents, generation, mediaBuffer) is fixed in one place.
 *
 * Nothing here opens a network connection. `effects` is the list of what would
 * have reached WhatsApp, in order.
 */

/** Socket methods that ask WhatsApp something and change nothing anyone sees. */
const READS = new Set([
  "onWhatsApp",
  "groupMetadata",
  "groupInviteCode",
  "groupGetInviteInfo",
  "groupRequestParticipantsList",
  "fetchStatus",
  "profilePictureUrl",
  "fetchBlocklist",
  "fetchMessageHistory",
  "resyncAppState",
  "updateMediaMessage",
  "waUploadToServer",
  "presenceSubscribe",
  "sendPresenceUpdate",
  "end",
]);

/** The words of an outgoing message, whatever shape Baileys built it in. */
export function messageWords(message) {
  if (!message || typeof message !== "object") return null;
  const inner = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message;
  return (
    inner.conversation ??
    inner.extendedTextMessage?.text ??
    inner.imageMessage?.caption ??
    inner.videoMessage?.caption ??
    inner.documentMessage?.caption ??
    (inner.pollCreationMessage ?? inner.pollCreationMessageV3)?.name ??
    inner.locationMessage?.name ??
    null
  );
}

function kindOfRelay(message) {
  const inner = message ?? {};
  if (inner.pollCreationMessage || inner.pollCreationMessageV3) return "poll";
  if (inner.locationMessage) return "location";
  if (inner.imageMessage || inner.videoMessage || inner.documentMessage || inner.audioMessage) return "media";
  return "message";
}

/** One sendMessage content, reduced to what an assertion reads. */
function describeContent(content = {}) {
  if (content.react) return { kind: "react", emoji: content.react.text ?? "", target_key: content.react.key?.id ?? null };
  if (content.edit) return { kind: "edit", text: content.text ?? null, target_key: content.edit.id ?? null };
  if (content.delete) return { kind: "delete", target_key: content.delete.id ?? null };
  if (content.pin) return { kind: "pin_message", target_key: content.pin.id ?? null };
  if (typeof content.text === "string") return { kind: "message", text: content.text };
  if (content.poll) return { kind: "poll", text: content.poll.name ?? null };
  if (content.location) return { kind: "location", text: content.location.name ?? null };
  if (content.forward) return { kind: "message", text: messageWords(content.forward.message), forwarded: true };
  return { kind: "other" };
}

/** Group metadata the way Baileys hands it back, from a fixture's group. */
export function groupMetadataOf(group) {
  return {
    id: group.jid,
    subject: group.subject,
    owner: group.owner ?? undefined,
    desc: group.description ?? undefined,
    creation: group.creation ?? undefined,
    announce: Boolean(group.announce),
    restrict: false,
    memberAddMode: false,
    joinApprovalMode: false,
    participants: group.participants.map((p) => ({ id: p.jid, admin: p.admin ? "admin" : null })),
  };
}

/**
 * A socket for one account. `account` names it in the effects; `groups` maps a
 * group jid to its fixture group; `faults` is consulted on every relay.
 */
export function sandboxSocket({ accountId, me, effects, groups = new Map(), faults = [], now = () => Date.now(), onEffect }) {
  const listeners = new Map();
  let seq = 0;
  const record = (entry) => {
    const effect = { seq: effects.length + 1, at: now(), account: accountId, ...entry };
    effects.push(effect);
    onEffect?.(effect);
    return effect;
  };
  const base = {
    user: { id: me.jid, name: me.name },
    ev: {
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      off(event, fn) {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== fn));
      },
      removeAllListeners(event) {
        listeners.delete(event);
      },
      emit(event, arg) {
        for (const fn of listeners.get(event) ?? []) fn(arg);
      },
    },
    authState: { creds: { me: { id: me.jid, name: me.name } }, keys: { get: async () => ({}), set: async () => {} } },
    end() {},
    onWhatsApp: async (...jids) => jids.flat().map((jid) => ({ jid, exists: true })),
    waUploadToServer: async () => ({ mediaUrl: "https://example.invalid/media", directPath: "/media" }),
    updateMediaMessage: async (message) => message,
    fetchStatus: async () => [],
    profilePictureUrl: async () => undefined,
    fetchBlocklist: async () => [],
    resyncAppState: async () => {},
    // Never answers: older history "is being asked for" and never comes, which
    // is what a phone that is offline looks like.
    fetchMessageHistory: async () => `eval-history-${++seq}`,
    groupMetadata: async (jid) => {
      const group = groups.get(jid);
      if (!group) {
        const err = new Error("item-not-found");
        err.output = { statusCode: 404 };
        throw err;
      }
      return groupMetadataOf(group);
    },
    groupInviteCode: async () => "EVALINVITECODE",
    relayMessage: async (jid, message, options = {}) => {
      const fault = faults.find((entry) => entry.account === accountId && entry.jid === jid && !entry.spent);
      record({
        method: "relayMessage",
        kind: kindOfRelay(message),
        jid,
        text: messageWords(message),
        key_id: options.messageId ?? null,
        ...(fault ? { fault: fault.mode } : {}),
      });
      if (fault) {
        if (fault.once !== false) fault.spent = true;
        fault.onRelay?.({ jid, message, keyId: options.messageId });
        throw new Error(fault.mode === "timeout" ? "Timed Out" : "Connection Closed");
      }
      return options.messageId;
    },
    sendMessage: async (jid, content, _options) => {
      record({ method: "sendMessage", jid, ...describeContent(content) });
      return {
        key: { remoteJid: jid, fromMe: true, id: `EVALSENT${String(effects.length).padStart(6, "0")}` },
        message: typeof content?.text === "string" ? { conversation: content.text } : {},
        messageTimestamp: Math.floor(now() / 1000),
      };
    },
    readMessages: async (keys) => {
      record({ method: "readMessages", kind: "read_receipts", jid: keys?.[0]?.remoteJid ?? null, count: keys?.length ?? 0 });
    },
    chatModify: async (modification, jid) => {
      record({ method: "chatModify", kind: "chat_modify", jid, action: Object.keys(modification ?? {})[0] ?? null });
    },
    groupLeave: async (jid) => {
      record({ method: "groupLeave", kind: "group_leave", jid });
    },
    groupParticipantsUpdate: async (jid, ids, action) => {
      record({ method: "groupParticipantsUpdate", kind: "group_update", jid, action, participants: ids });
      return ids.map((id) => ({ jid: id, status: "200" }));
    },
    groupCreate: async (subject, ids) => {
      const jid = `120363999${String(effects.length).padStart(9, "0")}@g.us`;
      record({ method: "groupCreate", kind: "group_create", jid, text: subject, participants: ids });
      return { id: jid, subject, participants: ids.map((id) => ({ id, admin: null })) };
    },
  };
  // Anything else wazap calls on the socket is a write the fake does not
  // model: it is recorded, so an assertion on "no effects" still catches it.
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== "string" || key === "then") return undefined;
      if (READS.has(key)) return async () => undefined;
      return async (...args) => {
        record({ method: key, kind: "other", jid: typeof args[0] === "string" ? args[0] : null });
        return undefined;
      };
    },
  });
}

/**
 * Make `svc` a connected account on `sock`, the way the tests' connectedService
 * does: the event wiring, the linked identity and a finished initial sync.
 * `stubs` replaces the media download and the transcriber.
 */
export function attachSocket(svc, sock, { me, status = "connected", mediaBuffer, transcriber } = {}) {
  svc.sockClient = sock;
  svc.wireEvents(sock, ++svc.generation);
  svc.account = { id: me.jid, name: me.name, number: me.jid.split("@")[0] };
  svc.status = status;
  svc.initialSyncDone = true;
  if (mediaBuffer) svc.mediaBuffer = mediaBuffer;
  if (transcriber) svc.transcriber = transcriber;
  return svc;
}
