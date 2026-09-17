/**
 * The media the evaluation's messages carry, made in code so no binary file
 * sits in the repository and the bytes are the same on every run: a photo of a
 * water meter reading 004512, a one-page PDF bank statement and a voice note
 * that is only its container header.
 */
import jpeg from "jpeg-js";

/** Which of the seven segments (a b c d e f g) each digit lights. */
const SEGMENTS = {
  0: "abcdef",
  1: "bc",
  2: "abged",
  3: "abgcd",
  4: "fgbc",
  5: "afgcd",
  6: "afgedc",
  7: "abc",
  8: "abcdefg",
  9: "abcdfg",
};

function fillRect(pixels, width, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
}

/** A meter face: dark digits on a light counter window, framed, with ticks under it. */
export function meterPhoto(reading = "004512") {
  const width = 720;
  const height = 400;
  const pixels = Buffer.alloc(width * height * 4);
  fillRect(pixels, width, 0, 0, width, height, [196, 200, 204]);
  fillRect(pixels, width, 40, 70, 640, 230, [40, 44, 48]);
  fillRect(pixels, width, 60, 90, 600, 190, [245, 243, 235]);
  const digitW = 70;
  const digitH = 140;
  const stroke = 14;
  const gap = 28;
  const startX = 60 + Math.floor((600 - (reading.length * digitW + (reading.length - 1) * gap)) / 2);
  const top = 115;
  reading.split("").forEach((ch, index) => {
    const x = startX + index * (digitW + gap);
    const lit = SEGMENTS[ch] ?? "";
    // A "1" lit on the right edge leaves a gap that reads as a decimal point; centre it.
    const right = ch === "1" ? x + Math.floor((digitW - stroke) / 2) : x + digitW - stroke;
    // One ink: red last digits would read as decimals on a real meter.
    const ink = [20, 20, 20];
    const half = Math.floor(digitH / 2);
    const seg = {
      a: [x, top, digitW, stroke],
      g: [x, top + half - Math.floor(stroke / 2), digitW, stroke],
      d: [x, top + digitH - stroke, digitW, stroke],
      f: [x, top, stroke, half],
      b: [right, top, stroke, half],
      e: [x, top + half, stroke, half],
      c: [right, top + half, stroke, half],
    };
    for (const name of lit) fillRect(pixels, width, ...seg[name], ink);
  });
  for (let i = 0; i < 12; i++) fillRect(pixels, width, 80 + i * 48, 320, 6, 30, [30, 30, 30]);
  return jpeg.encode({ data: pixels, width, height }, 90).data;
}

/** A minimal, valid one-page PDF whose text is `lines`. */
export function statementPdf(lines = ["Extras de cont - august 2026", "Cont RO12 BANK 0000 1111 2222", "Sold final: 18.430,55 lei"]) {
  const escape = (text) => text.replace(/[\\()]/g, (ch) => `\\${ch}`);
  const stream = [
    "BT",
    "/F1 16 Tf",
    "72 760 Td",
    ...lines.flatMap((line, index) => (index === 0 ? [`(${escape(line)}) Tj`] : ["0 -24 Td", `(${escape(line)}) Tj`])),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A voice note's bytes: the Ogg capture pattern and nothing a decoder could play. */
export function voiceNote() {
  return Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);
}

/** The bytes for a fixture media kind. */
export function mediaBytes(kind) {
  switch (kind) {
    case "meter_photo":
      return { bytes: meterPhoto(), mimetype: "image/jpeg" };
    case "statement_pdf":
      return { bytes: statementPdf(), mimetype: "application/pdf" };
    case "voice":
      return { bytes: voiceNote(), mimetype: "audio/ogg; codecs=opus" };
    default:
      throw new Error(`Unknown fixture media "${kind}"`);
  }
}
