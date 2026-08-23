import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import { formatAge, isControlMessage, isoWithOffset, messageText, messageType, mediaInfo } from "../dist/messages.js";

const wrap = (message) => ({ key: { fromMe: false, remoteJid: "4072@s.whatsapp.net", id: "X" }, message });

/** [label, message content, expected type, expected text] */
const CASES = [
  ["plain text", { conversation: "hello" }, "text", "hello"],
  ["extended text", { extendedTextMessage: { text: "hello again" } }, "text", "hello again"],
  ["image without caption", { imageMessage: { mimetype: "image/jpeg" } }, "image", "[image]"],
  ["image with caption", { imageMessage: { mimetype: "image/jpeg", caption: "the cat" } }, "image", "[image] the cat"],
  ["video", { videoMessage: { mimetype: "video/mp4" } }, "video", "[video]"],
  ["audio file", { audioMessage: { mimetype: "audio/mpeg", ptt: false } }, "audio", "[audio]"],
  ["voice note", { audioMessage: { mimetype: "audio/ogg", ptt: true } }, "voice", "[voice message]"],
  ["document", { documentMessage: { fileName: "report.pdf" } }, "document", "[document] report.pdf"],
  ["sticker", { stickerMessage: { mimetype: "image/webp" } }, "sticker", "[sticker]"],
  ["named location", { locationMessage: { degreesLatitude: 46.77, degreesLongitude: 23.6, name: "Cluj" } }, "location", "[location] Cluj"],
  ["bare location", { locationMessage: { degreesLatitude: 46.77, degreesLongitude: 23.6 } }, "location", "[location] 46.77, 23.60"],
  ["contact card", { contactMessage: { displayName: "Ana" } }, "contact", "[contact] Ana"],
  ["poll", { pollCreationMessageV3: { name: "Pizza or pasta?", options: [] } }, "poll", "[poll] Pizza or pasta?"],
  ["reaction", { reactionMessage: { text: "👍" } }, "reaction", "[reaction] 👍"],
  ["deleted", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE } }, "deleted", "[deleted]"],
  ["view-once photo", { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } } }, "view_once", "[view-once photo]"],
  ["view-once video", { viewOnceMessageV2: { message: { videoMessage: { mimetype: "video/mp4" } } } }, "view_once", "[view-once video]"],
  ["key distribution", { senderKeyDistributionMessage: { groupId: "g" } }, "system", "[system message]"],
  ["something new", { someFutureMessage: {} }, "unknown", "[unsupported: someFutureMessage]"],
  ["ephemeral wrapper", { ephemeralMessage: { message: { conversation: "disappearing" } } }, "text", "disappearing"],
];

test("every message type maps to a type and a non-empty text", () => {
  for (const [label, content, type, text] of CASES) {
    const raw = wrap(content);
    assert.equal(messageType(raw), type, `${label}: type`);
    assert.equal(messageText(raw), text, `${label}: text`);
  }
});

test("text is never empty, whatever arrives", () => {
  for (const content of [{}, null, { conversation: "" }, { extendedTextMessage: {} }, { imageMessage: { caption: "" } }]) {
    const text = messageText(wrap(content));
    assert.ok(text.length > 0, `empty text for ${JSON.stringify(content)}`);
  }
});

test("media metadata is read from the media node and skipped otherwise", () => {
  const doc = mediaInfo(wrap({ documentMessage: { mimetype: "application/pdf", fileLength: 4096, fileName: "a.pdf" } }));
  assert.deepEqual(doc, { mime: "application/pdf", size: 4096, filename: "a.pdf" });
  assert.equal(mediaInfo(wrap({ conversation: "hi" })), undefined);
  assert.equal(mediaInfo(wrap({ viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } } }))?.mime, "image/jpeg");
});

test("formatAge reports the largest whole unit", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  assert.equal(formatAge(now - 5_000, now), "just now");
  assert.equal(formatAge(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatAge(now - 2 * 3_600_000, now), "2h ago");
  assert.equal(formatAge(now - 3 * 86_400_000, now), "3d ago");
  assert.equal(formatAge(now + 60_000, now), "just now", "clock skew must not print a negative age");
});

test("timestamps are ISO 8601 with a numeric offset, never a bare Z", () => {
  const stamp = isoWithOffset(Date.parse("2026-08-22T12:00:00Z"));
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(stamp), Date.parse("2026-08-22T12:00:00Z"), "the offset must round-trip to the same instant");
});

/** [label, message content, is it machinery rather than something a person sent] */
const CONTROL_CASES = [
  ["history sync notice", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION } }, true],
  ["peer data response", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE } }, true],
  ["app state sync key share", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE } }, true],
  ["sender key distribution", { senderKeyDistributionMessage: { groupId: "g" } }, true],
  ["bare context info", { messageContextInfo: { deviceListMetadataVersion: 2 } }, true],
  ["nothing at all", {}, true],
  ["a retraction is a real event", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE } }, false],
  ["text", { conversation: "hello" }, false],
  ["an unknown future type is not machinery", { someFutureMessage: {} }, false],
];

test("control payloads are told apart from anything a person sent", () => {
  for (const [label, content, expected] of CONTROL_CASES) {
    assert.equal(isControlMessage(wrap(content)), expected, label);
  }
});

test("a stub message is an event to report, not machinery to drop", () => {
  const stub = { ...wrap({}), messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD };
  assert.equal(isControlMessage(stub), false);
  assert.equal(messageType(stub), "system");
});
