import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import { messageExpiry } from "../dist/message-expiry.js";

const base = () => ({ key: { id: "synthetic", remoteJid: "40700000002@s.whatsapp.net" }, messageTimestamp: 100,
  message: { conversation: "synthetic body" } });
const context = (expiration) => ({ extendedTextMessage: { text: "synthetic", contextInfo: { expiration, ephemeralSettingTimestamp: 1 } } });
const cases = [
  ["ordinary", {}, undefined],
  ["protobuf zero defaults", { ephemeralDuration: 0, ephemeralStartTimestamp: 0 }, undefined],
  ["outer duration", { ephemeralDuration: 10 }, 110_000],
  ["explicit earlier start", { ephemeralDuration: 10, ephemeralStartTimestamp: 90 }, 100_000],
  ["later start does not extend", { ephemeralDuration: 10, ephemeralStartTimestamp: 200 }, 110_000],
  ["start without message timestamp", { ephemeralDuration: 10, ephemeralStartTimestamp: 90, messageTimestamp: undefined }, 100_000],
  ["context without wrapper", { message: context(10) }, 110_000],
  ["ephemeral wrapper", { message: { ephemeralMessage: { message: context(10) } } }, 110_000],
  ["device + document + ephemeral", { message: { deviceSentMessage: { message: { documentWithCaptionMessage: {
    message: { ephemeralMessage: { message: context(10) } } } } } } }, 110_000],
  ["edited payload", { message: { editedMessage: { message: context(10) } } }, 110_000],
  ["view-once payload context", { message: { viewOnceMessageV2: { message: context(10) } } }, 110_000],
  ["shortest conflicting duration", { ephemeralDuration: 5, message: context(10) }, 105_000],
  ["missing duration", { message: { ephemeralMessage: { message: { conversation: "synthetic" } } } }, 0],
  ["empty wrapper", { message: { ephemeralMessage: {} } }, 0],
  ["zero duration in wrapper", { message: { ephemeralMessage: { message: context(0) } } }, 0],
  ["no valid start", { ephemeralDuration: 10, messageTimestamp: 0 }, 0],
  ["negative duration", { ephemeralDuration: -1 }, 0],
  ["fractional duration", { ephemeralDuration: 0.5 }, 0],
  ["non-finite duration", { ephemeralDuration: Infinity }, 0],
  ["overflow deadline", { ephemeralDuration: Number.MAX_SAFE_INTEGER }, 0],
  ["malformed timestamp", { ephemeralDuration: 10, messageTimestamp: "not-a-timestamp" }, 0],
  ["chat timer protocol is not message TTL", { message: { protocolMessage: { type: 3, ephemeralExpiration: 10 } } }, undefined],
  ["quoted TTL does not expire the enclosing message", { message: { extendedTextMessage: { text: "ordinary quote",
    contextInfo: { quotedMessage: context(10) } } } }, undefined],
  ["keep-in-chat is not an indefinite exemption", { ephemeralDuration: 10, keepInChat: { keepType: 1 } }, 110_000],
];
for (const [name, patch, expected] of cases) test(`message expiry: ${name}`, () => {
  assert.equal(messageExpiry({ ...base(), ...patch }), expected);
});

test("message expiry accepts decoded protobuf Long timestamps", () => {
  const raw = proto.WebMessageInfo.fromObject({ ...base(), ephemeralDuration: 10, ephemeralStartTimestamp: "100", messageTimestamp: "100" });
  assert.equal(messageExpiry(proto.WebMessageInfo.decode(proto.WebMessageInfo.encode(raw).finish())), 110_000);
});

test("message expiry bounds wrapper traversal, including cycles in local objects", () => {
  const message = {}; message.ephemeralMessage = { message };
  assert.equal(messageExpiry({ ...base(), message }), 0);
});
