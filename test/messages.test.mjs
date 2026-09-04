import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import { callInfo, formatAge, isControlMessage, isStubEvent, isoWithOffset, messageText, messageType, mediaInfo } from "../dist/messages.js";

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
  ["voice note with a length", { audioMessage: { mimetype: "audio/ogg", ptt: true, seconds: 42 } }, "voice", "[voice message · 0:42]"],
  ["audio file with a length", { audioMessage: { mimetype: "audio/mpeg", ptt: false, seconds: 185 } }, "audio", "[audio · 3:05]"],
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
  ["so is someone turning on disappearing messages", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING } }, false],
  ["so is a group member label change", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE } }, false],
  ["an edit is applied to the message it edits, not shown twice", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT } }, true],
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

const StubType = proto.WebMessageInfo.StubType;
const Outcome = proto.Message.CallLogMessage.CallOutcome;

const callLog = (log, { fromMe = false, extra = {} } = {}) => ({
  key: { fromMe, remoteJid: "4072@s.whatsapp.net", id: "C" },
  message: { callLogMesssage: log, ...extra },
});

const callStub = (messageStubType) => ({ ...wrap(undefined), messageStubType });

/** [label, whole message, expected text]. Every one of these must type as "call". */
const CALL_CASES = [
  ["incoming answered", callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 360 }), "[voice call · 6 min]"],
  ["incoming answered, no duration", callLog({ callOutcome: Outcome.CONNECTED }), "[voice call]"],
  ["incoming missed video", callLog({ isVideo: true, callOutcome: Outcome.MISSED }), "[missed video call]"],
  ["incoming rejected", callLog({ callOutcome: Outcome.REJECTED }), "[rejected voice call]"],
  ["outgoing nobody picked up", callLog({ callOutcome: Outcome.MISSED }, { fromMe: true }), "[outgoing voice call · unanswered]"],
  ["outgoing rejected", callLog({ isVideo: true, callOutcome: Outcome.REJECTED }, { fromMe: true }), "[outgoing video call · rejected]"],
  ["outgoing answered, seconds", callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 45 }, { fromMe: true }), "[outgoing voice call · 45s]"],
  ["an hour and change", callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 3900 }), "[voice call · 1h 5 min]"],
  ["silenced by do not disturb", callLog({ callOutcome: Outcome.SILENCED_BY_DND }), "[missed voice call]"],
  // getContentType is blind to callLogMesssage, so without the call check first this would read "[system message]".
  ["alongside context info", callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 90 }, { extra: { messageContextInfo: { deviceListMetadataVersion: 2 } } }), "[voice call · 2 min]"],
  ["missed voice stub", callStub(StubType.CALL_MISSED_VOICE), "[missed voice call]"],
  ["missed video stub", callStub(StubType.CALL_MISSED_VIDEO), "[missed video call]"],
  ["missed group voice stub", callStub(StubType.CALL_MISSED_GROUP_VOICE), "[missed voice call]"],
  ["missed group video stub", callStub(StubType.CALL_MISSED_GROUP_VIDEO), "[missed video call]"],
  ["baileys' group offer placeholder", wrap({ call: { callKey: new Uint8Array([7]) } }), "[group call]"],
];

test("a call is a type of its own, whatever shape it arrives in", () => {
  for (const [label, raw, text] of CALL_CASES) {
    assert.equal(messageType(raw), "call", `${label}: type`);
    assert.equal(messageText(raw), text, `${label}: text`);
  }
});

test("callInfo reports kind, direction, outcome and duration", () => {
  assert.deepEqual(callInfo(callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 360 })), {
    kind: "voice",
    direction: "incoming",
    outcome: "answered",
    duration_seconds: 360,
  });
  assert.deepEqual(callInfo(callLog({ isVideo: true, callOutcome: Outcome.MISSED }, { fromMe: true })), {
    kind: "video",
    direction: "outgoing",
    outcome: "unanswered",
  });
  assert.deepEqual(callInfo(callStub(StubType.CALL_MISSED_GROUP_VIDEO)), {
    kind: "video",
    direction: "incoming",
    outcome: "missed",
  });
  assert.deepEqual(callInfo(callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 12, participants: [{ jid: "4073@s.whatsapp.net" }, {}] })), {
    kind: "voice",
    direction: "incoming",
    outcome: "answered",
    duration_seconds: 12,
    participants: ["4073@s.whatsapp.net"],
  });
  assert.equal(callInfo(wrap({ conversation: "hi" })), undefined, "an ordinary message is not a call");
  assert.equal(callInfo(callLog({ callOutcome: Outcome.MISSED }))?.duration_seconds, undefined, "a call nobody took has no duration");
});

test("a missed-call stub is an event to report, not machinery to drop", () => {
  for (const stub of [StubType.CALL_MISSED_VOICE, StubType.CALL_MISSED_VIDEO, StubType.CALL_MISSED_GROUP_VOICE, StubType.CALL_MISSED_GROUP_VIDEO]) {
    assert.equal(isStubEvent(callStub(stub)), true, `stub ${stub}`);
    assert.equal(isControlMessage(callStub(stub)), false, `stub ${stub}`);
  }
  assert.equal(isControlMessage(wrap({ call: { callKey: new Uint8Array([7]) } })), false);
  assert.equal(isControlMessage(callLog({ callOutcome: Outcome.CONNECTED })), false);
});

test("a direct message with an empty participant is from the chat, not from us", async () => {
  const { buildMessageView } = await import("../dist/messages.js");
  const raw = proto.WebMessageInfo.fromObject({
    key: { remoteJid: "117261398495351@lid", fromMe: false, id: "3AC5", participant: "" },
    message: { conversation: "Da" },
    messageTimestamp: 1_788_551_624,
    pushName: "Sorin",
  });
  const view = buildMessageView(raw, {
    canonical: (jid) => (jid === "117261398495351@lid" ? "40723321578@s.whatsapp.net" : jid),
    nameFor: (jid) => (jid === "40723321578@s.whatsapp.net" ? "Sorin" : jid),
    ownId: "40700000001@s.whatsapp.net",
    chatId: "40723321578@s.whatsapp.net",
    edited: false,
    reactions: [],
  });
  assert.equal(view.from_me, false);
  assert.equal(view.sender.id, "40723321578@s.whatsapp.net", "the sender is the person on the other end");
  assert.equal(view.sender.name, "Sorin");
});

test("a GIF reads as a gif, a video as a video", () => {
  const gif = wrap({ videoMessage: { mimetype: "video/mp4", gifPlayback: true } });
  const video = wrap({ videoMessage: { mimetype: "video/mp4", caption: "uite" } });
  assert.equal(messageText(gif), "[gif]");
  assert.equal(messageType(gif), "video");
  assert.equal(messageText(video), "[video] uite");
});

test("an animated sticker is a sticker and an album header is a notice with its count", () => {
  const lottie = wrap({ lottieStickerMessage: { mimetype: "application/was" } });
  assert.equal(messageType(lottie), "sticker");
  assert.equal(messageText(lottie), "[sticker]");
  const album = wrap({ albumMessage: { expectedImageCount: 3, expectedVideoCount: 1 } });
  assert.equal(messageType(album), "system", "hidden from a catch-up: the photos follow on their own");
  assert.equal(messageText(album), "[album · 4 items]");
});
