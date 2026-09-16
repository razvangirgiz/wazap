import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateWAMessageContent, prepareWAMessageMedia } from "baileys";
import { WhatsAppService } from "../dist/whatsapp.js";
import { messageIdFor } from "../dist/messages.js";
import { videoFrame } from "../dist/previews.js";
import { gifToMp4 } from "../dist/gif.js";
import { localProvider, which } from "../dist/transcribe/local.js";
import { readTranscribeSettings } from "../dist/transcribe/settings.js";
import { MODELS } from "../dist/transcribe/models.js";
import { connectedService } from "./helpers.mjs";

const run = promisify(execFile);
const ffmpeg = which("ffmpeg");
const ME = "40700000001@s.whatsapp.net";
const PEER = "40700000002@s.whatsapp.net";

for (const operation of ["send", "confirm", "edit"]) {
  for (const preview of [
    null,
    {
      title: "Safe title",
      "canonical-url": "https://preview.example/",
      "matched-text": "https://preview.example/private?synthetic-token=abc",
    },
  ]) {
    test(`${operation} uses the controlled preview (${preview ? "card" : "fallback"}), never Baileys's fetcher`, async (t) => {
      const previous = process.env;
      process.env = { ...previous, WAZAP_WEBHOOK: "off", WAZAP_TRANSCRIBE: "off", WAZAP_RECALL: "off" };
      t.after(() => {
        process.env = previous;
      });
      const { svc, sock } = connectedService(WhatsAppService, {
        prefix: "wazap-link-security-",
        id: ME,
        name: "Test",
        config: { readOnly: false },
      });
      t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
      sock.ev.emit("chats.upsert", [{ id: PEER }]);
      const key = { remoteJid: PEER, id: "M1", fromMe: true };
      sock.ev.emit("messages.upsert", {
        type: "append",
        messages: [{ key, message: { conversation: "original" }, messageTimestamp: Math.floor(Date.now() / 1000) }],
      });
      let fetches = 0;
      let sends = 0;
      let previews = 0;
      svc.previewLink = async () => {
        previews++;
        return preview;
      };
      sock.sendMessage = async (_jid, content) => {
        sends++;
        assert.equal(content.linkPreview, preview);
        const generated = await generateWAMessageContent(content, {
          getUrlInfo: async () => {
            fetches++;
            return undefined;
          },
        });
        const encoded = generated.protocolMessage?.editedMessage ?? generated;
        assert.equal(encoded.extendedTextMessage?.title, preview?.title);
        return { key };
      };
      // A confirmed draft is built by wazap, with the card it made, and relayed.
      sock.relayMessage = async (_jid, message) => {
        sends++;
        assert.equal(message.extendedTextMessage?.title, preview?.title);
      };
      const text = "https://preview.example/private?synthetic-token=abc";
      if (operation === "send") await svc.sendMessage(PEER, text);
      else if (operation === "confirm") {
        const draft = await svc.draft({ kind: "text", chatId: PEER, text });
        assert.equal(previews, 0, "drafting must not fetch anything");
        await svc.confirm(draft.draft_id);
      } else await svc.editMessage(messageIdFor(key, PEER), text);
      assert.equal(sends, 1);
      assert.equal(fetches, 0);
      assert.equal(previews, 1);
      svc.effectiveReadOnly = true;
      await assert.rejects(svc.sendMessage(PEER, text), { code: "READ_ONLY" });
      assert.equal(previews, 1, "a refused write must not trigger a preview request");
    });
  }
}

test("outgoing video disables Baileys's thumbnail fallback even without ffmpeg", async (t) => {
  const previous = process.env;
  process.env = { ...previous, PATH: "", WAZAP_WEBHOOK: "off", WAZAP_TRANSCRIBE: "off", WAZAP_RECALL: "off" };
  t.after(() => {
    process.env = previous;
  });
  const { svc, sock } = connectedService(WhatsAppService, {
    prefix: "wazap-video-security-",
    id: ME,
    name: "Test",
    config: { readOnly: false },
  });
  t.after(() => rmSync(svc.config.dataDir, { recursive: true, force: true }));
  const file = join(svc.config.dataDir, "video.mp4");
  writeFileSync(file, "synthetic video");
  sock.ev.emit("chats.upsert", [{ id: PEER }]);
  let sends = 0;
  sock.sendMessage = async (_jid, content) => {
    sends++;
    assert.equal(content.jpegThumbnail, "");
    const encoded = await prepareWAMessageMedia(content, {
      upload: async () => ({ mediaUrl: "https://synthetic.invalid/video", directPath: "/video" }),
    });
    assert.equal(encoded.videoMessage.jpegThumbnail.length, 0);
    return { key: { remoteJid: PEER, id: "SENT", fromMe: true } };
  };
  await svc.sendMedia(PEER, { file_path: file }, { asDocument: false, asVoice: false, asGif: false });
  assert.equal(sends, 1);
});

async function playlist(t) {
  const dir = mkdtempSync(join(tmpdir(), "wazap-playlist-security-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const segment = join(dir, "private-fixture.ts");
  await run(
    ffmpeg,
    [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=32x32:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "mpeg2video",
      "-c:a",
      "aac",
      "-f",
      "mpegts",
      segment,
    ],
    { timeout: 10000 }
  );
  const bytes = Buffer.from(
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\n${segment}\n#EXT-X-ENDLIST\n`
  );
  return { dir, bytes };
}

test(
  "every ffmpeg consumer restricts protocols and demuxers before opening untrusted input",
  { skip: process.platform === "win32" ? "POSIX fixture executable" : false },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "wazap-ffmpeg-args-"));
    const log = join(dir, "args.jsonl");
    const bin = join(dir, "ffmpeg");
    writeFileSync(
      bin,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(1);\n`,
      { mode: 0o700 }
    );
    const previous = process.env.PATH;
    process.env.PATH = dir;
    t.after(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    });
    const settings = readTranscribeSettings({ WAZAP_TRANSCRIBE: "local", WAZAP_WHISPER_BIN: bin }, dir);
    mkdirSync(settings.modelsDir);
    writeFileSync(join(settings.modelsDir, MODELS[settings.model].file), "fixture");
    const file = join(dir, "audio.ogg");
    writeFileSync(file, "fixture");
    await videoFrame(Buffer.from("fixture"));
    await assert.rejects(gifToMp4(Buffer.from("fixture")));
    await assert.rejects(localProvider.transcribe(settings, file, {}));
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 4, "two frame offsets, GIF conversion and local transcription");
    for (const args of calls) {
      const input = args.indexOf("-i");
      const protocol = args.indexOf("-protocol_whitelist");
      const format = args.indexOf("-format_whitelist");
      assert.ok(protocol >= 0 && protocol < input);
      assert.equal(args[protocol + 1], "file");
      assert.ok(format >= 0 && format < input);
      for (const forbidden of ["hls", "concat", "sdp", "image2"])
        assert.ok(!args[format + 1].split(",").includes(forbidden));
    }
  }
);

const needsFfmpeg = { skip: ffmpeg === null ? "ffmpeg not installed" : false };

test("a video attachment cannot use a playlist to preview another local file", needsFfmpeg, async (t) => {
  const { dir, bytes } = await playlist(t);
  assert.ok(await videoFrame(readFileSync(join(dir, "private-fixture.ts"))), "a regular video still produces a frame");
  assert.equal(await videoFrame(bytes), null);
});

test("a purported GIF cannot use a playlist to convert another local file", needsFfmpeg, async (t) => {
  const { bytes } = await playlist(t);
  await assert.rejects(gifToMp4(bytes), { code: "MEDIA_UNAVAILABLE" });
});

test(
  "local transcription rejects playlist references before whisper can see the decoded audio",
  { skip: ffmpeg === null || process.platform === "win32" ? "requires ffmpeg and a POSIX fixture executable" : false },
  async (t) => {
    const { dir, bytes } = await playlist(t);
    const file = join(dir, "voice.ogg");
    writeFileSync(file, bytes);
    const bin = join(dir, "whisper-fixture");
    const marker = join(dir, "whisper-called");
    writeFileSync(
      bin,
      `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'called');const at=process.argv.indexOf('-of');fs.writeFileSync(process.argv[at+1]+'.json',JSON.stringify({transcription:[{text:'synthetic private fixture'}]}));\n`,
      { mode: 0o700 }
    );
    const settings = readTranscribeSettings({ WAZAP_TRANSCRIBE: "local", WAZAP_WHISPER_BIN: bin }, dir);
    mkdirSync(settings.modelsDir);
    writeFileSync(join(settings.modelsDir, MODELS[settings.model].file), "synthetic model");
    const valid = await localProvider.transcribe(settings, join(dir, "private-fixture.ts"), {});
    assert.equal(valid.text, "synthetic private fixture", "a regular recording still reaches the stub recognizer");
    rmSync(marker);
    await assert.rejects(localProvider.transcribe(settings, file, {}), (err) => {
      assert.equal(err.code, "TRANSCRIBE_FAILED");
      assert.match(err.message, /^ffmpeg/);
      return true;
    });
    assert.throws(() => readFileSync(marker), { code: "ENOENT" });
  }
);
