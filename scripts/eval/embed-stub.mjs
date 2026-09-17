/**
 * A deterministic stand-in for llama-server's /embedding, so semantic recall
 * works in the evaluation without a model: words that mean the same thing share
 * one slot (the approach of test/recall.test.mjs), diacritics fold, and filler
 * words carry no weight. Crude on purpose: it is enough for "the address Ana
 * sent" to reach "Vă aștept pe Lalelelor 7", and it answers the same every run.
 */
import http from "node:http";

const DIMS = 768;

const CONCEPTS = [
  ["adresa", "adresă", "address", "strada", "str", "lalelelor", "unde", "locatia", "location"],
  ["petrecere", "party", "petrecerea", "ziua", "aniversare", "serbez", "zi", "nastere"],
  ["factura", "facturi", "facturile", "invoice", "bill"],
  ["iban", "cont", "transfer", "plata", "platit", "payment", "bancar"],
  ["contract", "contractul", "contractului", "agreement"],
  ["contor", "index", "indexul", "apa", "meter", "citire"],
  ["dentist", "dentista", "dentistul", "stomatolog", "programare", "programarea", "control"],
  ["sedinta", "sedintei", "meeting", "intalnire", "call"],
  ["colet", "coletul", "livrat", "awb", "curier", "package"],
  ["cina", "dinner", "masa"],
];

const FILLER = new Set(
  "si sa de la pe in cu ca ce am ai a al ale o un una este e nu da mi ti va ne vă the a an of to and is are for on at my your".split(" ")
);

const PROMPT_PREFIX = /^(task: search result \| query: |title: none \| text: |query: |passage: )/;

function fold(word) {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function slotOf(word) {
  const folded = fold(word);
  for (const [index, group] of CONCEPTS.entries()) if (group.some((entry) => fold(entry) === folded)) return `c${index}`;
  return folded;
}

export function vectorFor(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of text.replace(PROMPT_PREFIX, "").split(/[^\p{L}\p{N}]+/u)) {
    if (word === "" || FILLER.has(fold(word))) continue;
    const slot = slotOf(word);
    let hash = 0;
    for (const ch of slot) hash = (hash * 31 + ch.codePointAt(0)) % 9973;
    vector[hash % DIMS] += slot.startsWith("c") ? 3 : 1;
  }
  if (vector.every((value) => value === 0)) vector[0] = 1;
  return vector;
}

/** Listens on loopback; resolves with `{ url, close }`. */
export function startEmbedStub() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/embedding") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const texts = [JSON.parse(body).content].flat();
        const reply = texts.map((text, index) => ({ index, embedding: [vectorFor(String(text))] }));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    );
  });
}
