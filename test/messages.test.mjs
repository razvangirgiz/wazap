import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";

import {
  buildMessageView,
  callInfo,
  formatAge,
  isControlMessage,
  isStubEvent,
  isUserMessage,
  isoWithOffset,
  mediaInfo,
  messageText,
  messageType,
} from "../dist/messages.js";

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
  [
    "voice note with a length",
    { audioMessage: { mimetype: "audio/ogg", ptt: true, seconds: 42 } },
    "voice",
    "[voice message · 0:42]",
  ],
  [
    "audio file with a length",
    { audioMessage: { mimetype: "audio/mpeg", ptt: false, seconds: 185 } },
    "audio",
    "[audio · 3:05]",
  ],
  ["document", { documentMessage: { fileName: "report.pdf" } }, "document", "[document] report.pdf"],
  ["sticker", { stickerMessage: { mimetype: "image/webp" } }, "sticker", "[sticker]"],
  [
    "named location",
    { locationMessage: { degreesLatitude: 46.77, degreesLongitude: 23.6, name: "Cluj" } },
    "location",
    "[location] Cluj",
  ],
  [
    "bare location",
    { locationMessage: { degreesLatitude: 46.77, degreesLongitude: 23.6 } },
    "location",
    "[location] 46.77, 23.60",
  ],
  ["contact card", { contactMessage: { displayName: "Ana" } }, "contact", "[contact] Ana"],
  ["poll", { pollCreationMessageV3: { name: "Pizza or pasta?", options: [] } }, "poll", "[poll] Pizza or pasta?"],
  ["reaction", { reactionMessage: { text: "👍" } }, "reaction", "[reaction] 👍"],
  ["deleted", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE } }, "deleted", "[deleted]"],
  [
    "view-once photo",
    { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } } },
    "view_once",
    "[view-once photo]",
  ],
  [
    "view-once video",
    { viewOnceMessageV2: { message: { videoMessage: { mimetype: "video/mp4" } } } },
    "view_once",
    "[view-once video]",
  ],
  ["key distribution", { senderKeyDistributionMessage: { groupId: "g" } }, "system", "[system message]"],
  ["something new", { someFutureMessage: {} }, "unknown", "[unsupported: someFutureMessage]"],
  ["ephemeral wrapper", { ephemeralMessage: { message: { conversation: "disappearing" } } }, "text", "disappearing"],
  [
    "template, four-row: title, body, footer, then the buttons",
    {
      templateMessage: {
        hydratedFourRowTemplate: {
          hydratedTitleText: "Comanda ta",
          hydratedContentText: "A fost livrată.",
          hydratedFooterText: "Curier",
          hydratedButtons: [
            { urlButton: { displayText: "Urmărește", url: "https://example.test/t/1" }, index: 0 },
            { quickReplyButton: { displayText: "OK", id: "1" }, index: 1 },
          ],
        },
      },
    },
    "text",
    "Comanda ta\nA fost livrată.\nCurier\n(buttons: Urmărește · OK)",
  ],
  [
    "template, interactive: the label shows, the code to copy does not",
    {
      templateMessage: {
        interactiveMessageTemplate: {
          header: { title: "Cod" },
          body: { text: "Folosește codul" },
          nativeFlowMessage: {
            buttons: [
              { name: "cta_copy", buttonParamsJson: JSON.stringify({ display_text: "Copiază", copy_code: "123456" }) },
              { name: "cta_url", buttonParamsJson: "not json" },
            ],
          },
        },
      },
    },
    "text",
    "Cod\nFolosește codul\n(buttons: Copiază)",
  ],
  ["template with nothing to read", { templateMessage: { templateId: "1" } }, "text", "[template]"],
  [
    "interactive message",
    {
      interactiveMessage: {
        body: { text: "Alege" },
        footer: { text: "Banca" },
        nativeFlowMessage: {
          buttons: [{ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "Da", id: "y" }) }],
        },
      },
    },
    "text",
    "Alege\nBanca\n(buttons: Da)",
  ],
  [
    "buttons message",
    {
      buttonsMessage: {
        contentText: "Confirmi?",
        footerText: "Clinica",
        buttons: [
          { buttonId: "a", buttonText: { displayText: "Da" } },
          { buttonId: "b", buttonText: { displayText: "Nu" } },
        ],
      },
    },
    "text",
    "Confirmi?\nClinica\n(buttons: Da · Nu)",
  ],
  [
    "list message",
    {
      listMessage: {
        title: "Programare",
        description: "Alege o oră",
        buttonText: "Vezi",
        sections: [{ title: "Dimineața", rows: [{ title: "9:00", rowId: "1" }, { title: "10:00", rowId: "2" }] }],
      },
    },
    "text",
    "Programare\nAlege o oră\n(options: 9:00 · 10:00)",
  ],
  ["button reply", { buttonsResponseMessage: { selectedButtonId: "a", selectedDisplayText: "Da" } }, "text", "Da"],
  ["list reply", { listResponseMessage: { title: "10:00", singleSelectReply: { selectedRowId: "2" } } }, "text", "10:00"],
  [
    "template button reply",
    { templateButtonReplyMessage: { selectedId: "1", selectedDisplayText: "Urmărește", selectedIndex: 0 } },
    "text",
    "Urmărește",
  ],
  [
    "a message kept off linked devices",
    { placeholderMessage: { type: 0 } },
    "unknown",
    "[message not shown on linked devices; read it on the phone]",
  ],
  ["phone number request", { requestPhoneNumberMessage: {} }, "text", "[asked for your phone number]"],
  [
    "order: count and total, never the token",
    {
      orderMessage: {
        itemCount: 2,
        totalAmount1000: 150000,
        totalCurrencyCode: "RON",
        orderTitle: "Pizza",
        token: "secret-token",
        orderId: "o1",
      },
    },
    "text",
    "[order · 2 items · 150.00 RON] Pizza",
  ],
  [
    "product",
    { productMessage: { product: { title: "Tricou", productId: "p1" }, body: "Mai e pe stoc?" } },
    "text",
    "[product] Tricou · Mai e pe stoc?",
  ],
  [
    "status mention",
    { statusMentionMessage: { quotedStatus: { conversation: "x" } } },
    "text",
    "[mentioned you in their status]",
  ],
  [
    "scheduled call",
    { scheduledCallCreationMessage: { scheduledTimestampMs: 1_789_500_000_000, callType: 2, title: "Sincron" } },
    "text",
    `[scheduled video call · ${isoWithOffset(1_789_500_000_000)}] Sincron`,
  ],
  [
    "poll result snapshot",
    {
      pollResultSnapshotMessage: {
        name: "Pizza?",
        pollVotes: [
          { optionName: "Da", optionVoteCount: 3 },
          { optionName: "Nu", optionVoteCount: 1 },
        ],
      },
    },
    "poll",
    "[poll results] Pizza? · Da: 3 · Nu: 1",
  ],
  [
    "channel admin invite",
    { newsletterAdminInviteMessage: { newsletterJid: "1@newsletter", newsletterName: "Știri", caption: "Te fac admin" } },
    "text",
    "[channel admin invite] Știri · Te fac admin",
  ],
  ["sticker pack", { stickerPackMessage: { name: "Pisici", stickers: [{}, {}] } }, "sticker", "[sticker pack · 2 stickers] Pisici"],
  [
    "pin in a direct chat, by the other side",
    { pinInChatMessage: { key: { remoteJid: "4072@s.whatsapp.net", fromMe: true, id: "T" }, type: 1 } },
    "system",
    "[4072 pinned a message]",
  ],
];

test("every message type maps to a type and a non-empty text", () => {
  for (const [label, content, type, text] of CASES) {
    const raw = wrap(content);
    assert.equal(messageType(raw), type, `${label}: type`);
    assert.equal(messageText(raw), text, `${label}: text`);
  }
});

test("text is never empty, whatever arrives", () => {
  for (const content of [
    {},
    null,
    { conversation: "" },
    { extendedTextMessage: {} },
    { imageMessage: { caption: "" } },
  ]) {
    const text = messageText(wrap(content));
    assert.ok(text.length > 0, `empty text for ${JSON.stringify(content)}`);
  }
});

test("media metadata is read from the media node and skipped otherwise", () => {
  const doc = mediaInfo(
    wrap({ documentMessage: { mimetype: "application/pdf", fileLength: 4096, fileName: "a.pdf" } })
  );
  assert.deepEqual(doc, { mime: "application/pdf", size: 4096, filename: "a.pdf" });
  assert.equal(mediaInfo(wrap({ conversation: "hi" })), undefined);
  assert.equal(
    mediaInfo(wrap({ viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } } }))?.mime,
    "image/jpeg"
  );
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
  [
    "history sync notice",
    { protocolMessage: { type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION } },
    true,
  ],
  [
    "peer data response",
    { protocolMessage: { type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE } },
    true,
  ],
  [
    "app state sync key share",
    { protocolMessage: { type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE } },
    true,
  ],
  ["sender key distribution", { senderKeyDistributionMessage: { groupId: "g" } }, true],
  ["bare context info", { messageContextInfo: { deviceListMetadataVersion: 2 } }, true],
  ["nothing at all", {}, true],
  ["a retraction is a real event", { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE } }, false],
  [
    "so is someone turning on disappearing messages",
    { protocolMessage: { type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING } },
    false,
  ],
  [
    "so is a group member label change",
    { protocolMessage: { type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE } },
    false,
  ],
  [
    "an edit is applied to the message it edits, not shown twice",
    { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT } },
    true,
  ],
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

const Stub = proto.WebMessageInfo.StubType;
const GROUP_JID = "120363414132891692@g.us";
const MEDEEA = "40711111111@s.whatsapp.net";

/** A group notice the way Baileys builds one: no message, a stub type, the key naming who made the change. */
const groupStub = (messageStubType, messageStubParameters, { participant = MEDEEA, fromMe = false } = {}) => ({
  key: { fromMe, remoteJid: GROUP_JID, id: "2904102002", participant },
  messageStubType,
  messageStubParameters,
  messageTimestamp: 1_789_460_615,
});

/** A member label change, which WhatsApp sends as a protocol message rather than a stub. */
const memberLabel = (label) => ({
  key: { fromMe: false, remoteJid: GROUP_JID, id: "3A0F56CBF8F7D459AD5A", participant: MEDEEA },
  message: {
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
      memberLabel: { label, labelTimestamp: 1_789_460_811 },
    },
  },
  messageTimestamp: 1_789_460_812,
});

/** A participant as a live notice carries them. */
const party = (id, phoneNumber) => JSON.stringify({ id, ...(phoneNumber ? { phoneNumber } : {}), admin: null });

/** [label, notice, expected text] */
const GROUP_NOTICE_CASES = [
  [
    "add, live: a lid with its number",
    groupStub(Stub.GROUP_PARTICIPANT_ADD, [party("111222333444555@lid", "40723124956@s.whatsapp.net")]),
    "[40711111111 added 40723124956]",
  ],
  [
    "add, synced history: bare jids",
    groupStub(Stub.GROUP_PARTICIPANT_ADD, ["40723124956@s.whatsapp.net", "40722827322@s.whatsapp.net"]),
    "[40711111111 added 40723124956, 40722827322]",
  ],
  [
    "add of a lid nobody paired",
    groupStub(Stub.GROUP_PARTICIPANT_ADD, [party("111222333444555@lid")]),
    "[40711111111 added unknown (lid …4555)]",
  ],
  [
    "add by the linked account",
    groupStub(Stub.GROUP_PARTICIPANT_ADD, [party("40723124956@s.whatsapp.net")], { fromMe: true }),
    "[You added 40723124956]",
  ],
  [
    "remove",
    groupStub(Stub.GROUP_PARTICIPANT_REMOVE, [party("40722827322@s.whatsapp.net")]),
    "[40711111111 removed 40722827322]",
  ],
  ["remove of oneself", groupStub(Stub.GROUP_PARTICIPANT_REMOVE, [party(MEDEEA)]), "[40711111111 left]"],
  ["leave", groupStub(Stub.GROUP_PARTICIPANT_LEAVE, [party(MEDEEA)]), "[40711111111 left]"],
  [
    "promote",
    groupStub(Stub.GROUP_PARTICIPANT_PROMOTE, [party("40723124956@s.whatsapp.net")]),
    "[40711111111 made 40723124956 admin]",
  ],
  [
    "demote",
    groupStub(Stub.GROUP_PARTICIPANT_DEMOTE, [party("40723124956@s.whatsapp.net")]),
    "[40711111111 dismissed 40723124956 as admin]",
  ],
  [
    "subject",
    groupStub(Stub.GROUP_CHANGE_SUBJECT, ["Râșnov 18-20 septembrie"]),
    '[40711111111 renamed the group to "Râșnov 18-20 septembrie"]',
  ],
  [
    "announcement mode, live",
    groupStub(Stub.GROUP_CHANGE_ANNOUNCE, ["on"]),
    "[40711111111 allowed only admins to send messages]",
  ],
  [
    "info lock, synced history",
    groupStub(Stub.GROUP_CHANGE_RESTRICT, ["false"]),
    "[40711111111 allowed every member to edit the group info]",
  ],
  ["new invite link, code kept out", groupStub(Stub.GROUP_CHANGE_INVITE_LINK, ["AbCdEf123"]), "[40711111111 reset the invite link]"],
  [
    "photo change nobody is named for",
    groupStub(Stub.GROUP_CHANGE_ICON, [], { participant: null }),
    "[Someone changed the group photo]",
  ],
  ["a stub wazap does not spell out", groupStub(Stub.E2E_ENCRYPTED, []), "[system message · E2E_ENCRYPTED]"],
  [
    "member label cleared, a protocol message and not a stub",
    memberLabel(""),
    "[40711111111 cleared their member label]",
  ],
  ["member label set", memberLabel("șofer"), '[40711111111 set their member label to "șofer"]'],
];

test("a group notice says who made which change, to whom", () => {
  for (const [label, raw, text] of GROUP_NOTICE_CASES) {
    assert.equal(messageType(raw), "system", label);
    assert.equal(isControlMessage(raw), false, label);
    assert.equal(messageText(raw), text, label);
  }
});

test("a group notice view puts names to the actor and the targets, and carries them structured", () => {
  const LID_MEDEEA = "999888777666555@lid";
  const ANA = "40723124956@s.whatsapp.net";
  const names = { [MEDEEA]: "Medeea", [ANA]: "Ana" };
  const ctx = {
    canonical: (jid) => (jid === LID_MEDEEA ? MEDEEA : jid),
    nameFor: (jid) => names[jid] ?? jid.split("@")[0],
    ownId: "40700000001@s.whatsapp.net",
    chatId: GROUP_JID,
    edited: false,
    reactions: [],
  };

  const added = buildMessageView(
    groupStub(Stub.GROUP_PARTICIPANT_ADD, [party("111222333444555@lid", ANA), party("40722827322@s.whatsapp.net")], {
      participant: LID_MEDEEA,
    }),
    ctx
  );
  assert.equal(added.type, "system");
  assert.equal(added.text, "[Medeea added Ana (40723124956), 40722827322]");
  assert.deepEqual(added.system, {
    action: "add",
    actor: { id: MEDEEA, name: "Medeea", phone: "40711111111" },
    targets: [
      { id: ANA, name: "Ana", phone: "40723124956" },
      { id: "40722827322@s.whatsapp.net", name: "40722827322", phone: "40722827322" },
    ],
  });

  const renamed = buildMessageView(groupStub(Stub.GROUP_CHANGE_SUBJECT, ["Râșnov"]), ctx);
  assert.equal(renamed.text, '[Medeea renamed the group to "Râșnov"]');
  assert.deepEqual(renamed.system, {
    action: "set_subject",
    actor: { id: MEDEEA, name: "Medeea", phone: "40711111111" },
    targets: [],
    value: "Râșnov",
  });

  const plain = buildMessageView(wrap({ conversation: "salut" }), { ...ctx, chatId: "4072@s.whatsapp.net" });
  assert.equal(plain.system, undefined, "a message a person sent carries no notice");
});

test("isUserMessage is a person sending something, either way", () => {
  assert.equal(isUserMessage(wrap({ conversation: "hi" })), true);
  assert.equal(isUserMessage(wrap({ imageMessage: { mimetype: "image/jpeg" } })), true);
  assert.equal(isUserMessage(wrap({ someFutureMessage: {} })), true);
  assert.equal(
    isUserMessage({
      key: { fromMe: true, remoteJid: "4072@s.whatsapp.net", id: "X" },
      message: { conversation: "hi" },
    }),
    true,
    "a message the person sent themselves is still a person's message"
  );
  const stub = { ...wrap({}), messageStubType: proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD };
  assert.equal(isUserMessage(stub), false);
  assert.equal(
    isUserMessage({ ...wrap(undefined), messageStubType: proto.WebMessageInfo.StubType.E2E_ENCRYPTED }),
    false
  );
  assert.equal(
    isUserMessage(wrap({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION } })),
    false
  );
  assert.equal(
    isUserMessage(wrap({ protocolMessage: { type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING } })),
    false
  );
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
  [
    "outgoing nobody picked up",
    callLog({ callOutcome: Outcome.MISSED }, { fromMe: true }),
    "[outgoing voice call · unanswered]",
  ],
  [
    "outgoing rejected",
    callLog({ isVideo: true, callOutcome: Outcome.REJECTED }, { fromMe: true }),
    "[outgoing video call · rejected]",
  ],
  [
    "outgoing answered, seconds",
    callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 45 }, { fromMe: true }),
    "[outgoing voice call · 45s]",
  ],
  ["an hour and change", callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 3900 }), "[voice call · 1h 5 min]"],
  ["silenced by do not disturb", callLog({ callOutcome: Outcome.SILENCED_BY_DND }), "[missed voice call]"],
  // getContentType is blind to callLogMesssage, so without the call check first this would read "[system message]".
  [
    "alongside context info",
    callLog(
      { callOutcome: Outcome.CONNECTED, durationSecs: 90 },
      { extra: { messageContextInfo: { deviceListMetadataVersion: 2 } } }
    ),
    "[voice call · 2 min]",
  ],
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
  assert.deepEqual(
    callInfo(
      callLog({ callOutcome: Outcome.CONNECTED, durationSecs: 12, participants: [{ jid: "4073@s.whatsapp.net" }, {}] })
    ),
    {
      kind: "voice",
      direction: "incoming",
      outcome: "answered",
      duration_seconds: 12,
      participants: ["4073@s.whatsapp.net"],
    }
  );
  assert.equal(callInfo(wrap({ conversation: "hi" })), undefined, "an ordinary message is not a call");
  assert.equal(
    callInfo(callLog({ callOutcome: Outcome.MISSED }))?.duration_seconds,
    undefined,
    "a call nobody took has no duration"
  );
});

test("a missed-call stub is an event to report, not machinery to drop", () => {
  for (const stub of [
    StubType.CALL_MISSED_VOICE,
    StubType.CALL_MISSED_VIDEO,
    StubType.CALL_MISSED_GROUP_VOICE,
    StubType.CALL_MISSED_GROUP_VIDEO,
  ]) {
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

test("an album child is the photo or video it wraps, and an encrypted edit is a notice", () => {
  const child = wrap({
    associatedChildMessage: { message: { videoMessage: { mimetype: "video/mp4", caption: "vacanță" } } },
  });
  assert.equal(messageType(child), "video");
  assert.equal(messageText(child), "[video] vacanță");
  assert.equal(mediaInfo(child)?.mime, "video/mp4");
  const edit = wrap({ secretEncryptedMessage: { targetMessageKey: { id: "X" }, secretEncType: 2 } });
  assert.equal(messageType(edit), "system");
  assert.equal(messageText(edit), "[edited a message]");
});

const PINNED = { remoteJid: GROUP_JID, fromMe: false, id: "3A1B2C3D", participant: "40723124956@s.whatsapp.net" };

/** A notice WhatsApp sends as a payload of its own rather than a stub: a pin, a keep, a shared history. */
const groupPayload = (message, { participant = MEDEEA, fromMe = false } = {}) => ({
  key: { fromMe, remoteJid: GROUP_JID, id: "3EB0A1", participant },
  message,
  messageTimestamp: 1_789_460_900,
});

const historyBundle = (messageCount) => ({
  messageHistoryBundle: {
    mimetype: "application/x-protobuf",
    messageHistoryMetadata: {
      historyReceivers: ["40723124956@s.whatsapp.net"],
      oldestMessageTimestamp: 1_789_000_000,
      messageCount,
    },
  },
});

/** [label, notice, expected text] */
const PAYLOAD_NOTICE_CASES = [
  [
    "pin",
    groupPayload({ pinInChatMessage: { key: PINNED, type: 1 }, messageContextInfo: {} }),
    "[40711111111 pinned a message]",
  ],
  [
    "unpin by the linked account",
    groupPayload({ pinInChatMessage: { key: PINNED, type: 2 } }, { fromMe: true }),
    "[You unpinned a message]",
  ],
  ["keep", groupPayload({ keepInChatMessage: { key: PINNED, keepType: 1 } }), "[40711111111 kept a message]"],
  ["undo a keep", groupPayload({ keepInChatMessage: { key: PINNED, keepType: 2 } }), "[40711111111 unkept a message]"],
  ["pin, as the stub that names who pinned", groupStub(Stub.PINNED_MESSAGE_IN_CHAT, [MEDEEA]), "[40711111111 pinned a message]"],
  [
    "chat history shared with a new member",
    groupPayload(historyBundle(25), { fromMe: true }),
    "[You shared the chat history (25 messages) with 40723124956]",
  ],
  ["one message of history", groupPayload(historyBundle(1)), "[40711111111 shared the chat history (1 message) with 40723124956]"],
];

test("a pin, a keep and a shared history say who did it, and are not messages to post", () => {
  for (const [label, raw, text] of PAYLOAD_NOTICE_CASES) {
    assert.equal(messageType(raw), "system", label);
    assert.equal(isControlMessage(raw), false, label);
    assert.equal(isUserMessage(raw), false, label);
    assert.equal(messageText(raw), text, label);
  }
});

const MISSING = "[missing message: it could not be decrypted on this device; it may still be on the phone]";

/** A notice in a direct chat, the way synced history files one. */
const dmStub = (messageStubType, messageStubParameters = []) => ({
  key: { fromMe: false, remoteJid: "4072@s.whatsapp.net", id: "S1" },
  messageStubType,
  messageStubParameters,
  messageTimestamp: 1_789_460_615,
});

/** [label, notice, expected text] */
const STUB_NOTICE_CASES = [
  ["undecryptable, from synced history", groupStub(Stub.CIPHERTEXT, []), MISSING],
  ["undecryptable, live: the error is the parameter and stays out", dmStub(Stub.CIPHERTEXT, ["Bad MAC"]), MISSING],
  [
    "default disappearing timer",
    dmStub(Stub.DISAPPEARING_MODE, ["604800", "111222333444555@lid"]),
    "[disappearing messages on by default: new messages disappear after 7 days]",
  ],
  [
    "a one-day timer",
    dmStub(Stub.DISAPPEARING_MODE, ["86400"]),
    "[disappearing messages on by default: new messages disappear after 1 day]",
  ],
  ["blocked", dmStub(Stub.BLOCK_CONTACT, ["true"]), "[you blocked this contact]"],
  ["unblocked", dmStub(Stub.BLOCK_CONTACT, ["false"]), "[you unblocked this contact]"],
  [
    "username change, the names kept out",
    dmStub(Stub.CHANGE_USERNAME, ["", "ana.pop", "111222333444555@lid", "abcdef"]),
    "[this contact changed their username]",
  ],
  [
    "a group linked into a community",
    groupStub(Stub.COMMUNITY_LINK_SUB_GROUP, ["120363000000000009@g.us", "Părinți clasa a V-a"]),
    '[the group "Părinți clasa a V-a" was added to the community]',
  ],
  [
    "business chat managed by Meta, from the start",
    dmStub(Stub.BIZ_PRIVACY_MODE_INIT_FB, [""]),
    "[this business uses a secure service from Meta to manage this chat]",
  ],
  [
    "business chat moved to Meta",
    dmStub(Stub.BIZ_PRIVACY_MODE_TO_FB, [""]),
    "[this business now uses a secure service from Meta to manage this chat]",
  ],
];

test("a notice with nobody to name is spelled out instead of naming its stub type", () => {
  for (const [label, raw, text] of STUB_NOTICE_CASES) {
    assert.equal(messageType(raw), "system", label);
    assert.equal(isControlMessage(raw), false, label);
    assert.equal(isUserMessage(raw), false, label);
    assert.equal(messageText(raw), text, label);
  }
});

test("a pin view names who pinned and carries the pinned message's id", () => {
  const LID_MEDEEA = "999888777666555@lid";
  const ctx = {
    canonical: (jid) => (jid === LID_MEDEEA ? MEDEEA : jid),
    nameFor: (jid) => (jid === MEDEEA ? "Medeea" : jid.split("@")[0]),
    ownId: "40700000001@s.whatsapp.net",
    chatId: GROUP_JID,
    edited: false,
    reactions: [],
  };
  const medeea = { id: MEDEEA, name: "Medeea", phone: "40711111111" };

  const pinned = buildMessageView(
    groupPayload(
      { pinInChatMessage: { key: PINNED, type: 1, senderTimestampMs: 1_789_460_899_000 }, messageContextInfo: {} },
      { participant: LID_MEDEEA }
    ),
    ctx
  );
  assert.equal(pinned.type, "system");
  assert.equal(pinned.text, "[Medeea pinned a message]");
  assert.deepEqual(pinned.system, {
    action: "pin_message",
    actor: medeea,
    targets: [],
    value: `false_${GROUP_JID}_3A1B2C3D`,
  });

  const unpinned = buildMessageView(
    groupPayload({ pinInChatMessage: { key: { ...PINNED, fromMe: true }, type: 2 } }, { fromMe: true }),
    ctx
  );
  assert.equal(unpinned.system.action, "unpin_message");
  assert.equal(unpinned.system.value, `true_${GROUP_JID}_3A1B2C3D`, "the pinned message's own id, as read_messages lists it");

  const shared = buildMessageView(groupPayload(historyBundle(25), { participant: LID_MEDEEA }), ctx);
  assert.equal(shared.text, "[Medeea shared the chat history (25 messages) with 40723124956]");
  assert.deepEqual(shared.system, {
    action: "share_history",
    actor: medeea,
    targets: [{ id: "40723124956@s.whatsapp.net", name: "40723124956", phone: "40723124956" }],
    value: "25",
  });
});

test("a business message is found by its words; a message kept off this device is not", async () => {
  const { searchableText } = await import("../dist/messages.js");
  const template = wrap({
    templateMessage: { hydratedFourRowTemplate: { hydratedContentText: "Coletul tău a ajuns la easybox" } },
  });
  assert.equal(searchableText(template), "Coletul tău a ajuns la easybox");
  assert.equal(isUserMessage(template), true, "a person's inbox gets it like any other message");
  assert.equal(searchableText(wrap({ placeholderMessage: { type: 0 } })), null);
});

test("an event says what, when and where, and a canceled one says so", async () => {
  const { searchableText } = await import("../dist/messages.js");
  // WhatsApp sends the start in seconds; it reads in local time, like every timestamp.
  const start = 1_789_900_000;
  const when = isoWithOffset(start * 1000);
  const event = (fields) => wrap({ eventMessage: { name: "Botez", startTime: start, ...fields } });

  /** [label, message, expected text] */
  const cases = [
    [
      "with a place and a description",
      event({
        location: { name: "Biserica Sf. Nicolae", degreesLatitude: 45.6, degreesLongitude: 25.6 },
        description: "Vă așteptăm",
      }),
      `[event] Botez · ${when} · Biserica Sf. Nicolae\nVă așteptăm`,
    ],
    ["without a place", event({}), `[event] Botez · ${when}`],
    ["a place known only by its address", event({ location: { address: "Str. Lungă 1" } }), `[event] Botez · ${when} · Str. Lungă 1`],
    [
      "canceled",
      event({ isCanceled: true, location: { name: "Biserica" } }),
      `[canceled event] Botez · ${when} · Biserica`,
    ],
    [
      "a call link stays out",
      event({ joinLink: "https://call.whatsapp.com/video/Zq8TokenForTheCall", isScheduleCall: true }),
      `[event] Botez · ${when}`,
    ],
  ];
  for (const [label, raw, text] of cases) {
    assert.equal(messageType(raw), "event", label);
    assert.equal(messageText(raw), text, label);
    assert.equal(isUserMessage(raw), true, label);
  }
  assert.match(searchableText(event({ description: "Vă așteptăm la ora 12" })) ?? "", /Vă așteptăm la ora 12/);
});

test("a group invite names the group and never carries its invite code", async () => {
  const { searchableText } = await import("../dist/messages.js");
  const { asWebhookPayload } = await import("../dist/webhook.js");
  const CODE = "Kx7QpZ2mN4vB9aL1";
  const CHAT = "40723124956@s.whatsapp.net";
  const invite = (fields) => ({
    key: { fromMe: false, remoteJid: CHAT, id: "3EB0INV" },
    message: {
      groupInviteMessage: {
        groupJid: "120363000000000007@g.us",
        inviteCode: CODE,
        inviteExpiration: 1_790_000_000,
        groupName: "Familia",
        jpegThumbnail: new Uint8Array([1, 2, 3]),
        ...fields,
      },
    },
    messageTimestamp: 1_789_460_900,
  });

  const raw = invite({ caption: "Intră în grupul familiei" });
  assert.equal(messageType(raw), "invite");
  assert.equal(messageText(raw), "[group invite] Familia · Intră în grupul familiei");
  assert.equal(messageText(invite({})), "[group invite] Familia");

  const view = buildMessageView(raw, {
    canonical: (jid) => jid,
    nameFor: (jid) => jid.split("@")[0],
    ownId: "40700000001@s.whatsapp.net",
    chatId: CHAT,
    edited: false,
    reactions: [],
  });
  assert.equal(view.type, "invite");
  assert.equal(messageText(raw).includes(CODE), false, "not in the text");
  assert.equal(JSON.stringify(view).includes(CODE), false, "not anywhere in the view");
  const searchable = searchableText(raw);
  assert.match(searchable ?? "", /Familia/);
  assert.equal(searchable.includes(CODE), false, "not in what recall indexes");

  const payload = asWebhookPayload({
    event: "message_received",
    view,
    account: { id: "default", name: "Default" },
    isSelfChat: false,
  });
  assert.equal(payload.kind, "other");
  assert.equal(JSON.stringify(payload).includes(CODE), false, "not in what the webhook posts");
});
