/**
 * Markers on a message's words, for ordering what a summary shows (catch_up,
 * F2-2): whether it names an amount, a date, a time, an address, a link, or
 * asks something. Deterministic and table-driven, Romanian and English, with
 * diacritics optional. It says only that a kind of value is there; it never
 * extracts or interprets one — turning "vineri la 7" into an instant stays the
 * assistant's job.
 *
 *   signalsOf("Plătești 150 lei până vineri la 10?")  // Set { "amount", "date", "time", "question" }
 *
 * Precision comes before recall: a marker that is wrong reorders a summary
 * for nothing, one that is missing only leaves a message where it was. The
 * guards are the homographs that make that trade in practice: "mai" (May /
 * "more"), "luni" (Monday / "months"), "ora" only as "ora 7", "la 10" not
 * before a unit ("la 10 km"), "calea" / "piața" only before a name, "nr. 5"
 * alone (an order number) not an address. test/signals.test.mjs holds the
 * sentence set and the precision and recall each marker must keep.
 */
import { foldText } from "./db/index.js";

export type Signal = "amount" | "date" | "time" | "address" | "link" | "question";

export const SIGNALS: readonly Signal[] = ["amount", "date", "time", "address", "link", "question"];

// ---------------------------------------------------------------- tables

/** Currencies after a number: "150 lei", "20 de euro", "5k eur". Folded, lowercase. */
const CURRENCY_WORDS = ["lei", "leu", "ron", "bani", "euro", "euri", "eur", "usd", "dolari", "dolar", "dollars", "dollar", "bucks", "gbp", "lire", "chf"];
/** Currencies before a number: "RON 150", "€20". */
const CURRENCY_PREFIXES = ["ron", "eur", "usd", "gbp", "lei"];
/** Words that make a bare number a sum of money: "chiria e 400", "total 1200". */
const MONEY_WORDS = [
  "pret", "pretul", "costa", "costul", "suma", "suma de", "total", "totalul", "avans", "avansul", "chirie", "chiria", "rest", "restul",
  "platesti", "plateste", "platit", "platiti", "achita", "achitat", "achitati", "transfera", "transferat", "datorez", "datoreaza", "imprumut",
  "price", "costs", "cost", "paid", "pay", "owe", "owes", "rent", "fee", "deposit",
];
/** What may stand between a money word and its number without making it something else: "chiria e 400", "suma de 300". */
const MONEY_GAP = /^(?:\s+(?:e|este|era|de|la|doar|cam|vreo|aprox|aproximativ|is|was|of|about|only|around|just|you|me|us|them|him|her|back|ul|a)){0,3}\s*[:=]?\s*$/;

const MONTHS_UNAMBIGUOUS = [
  "ianuarie", "februarie", "martie", "aprilie", "iunie", "iulie", "septembrie", "octombrie", "noiembrie", "decembrie",
  "january", "february", "april", "june", "july", "september", "october", "november", "december",
];
/** A month name that is also a common word or name: only a date next to a day number. */
const MONTHS_AMBIGUOUS = ["mai", "may", "march", "august"];
const MONTH_ABBREVIATIONS = ["ian", "jan", "feb", "mar", "apr", "iun", "jun", "iul", "jul", "aug", "sep", "sept", "oct", "nov", "noi", "dec"];

const WEEKDAYS_RO = ["marti", "miercuri", "joi", "vineri", "sambata", "duminica"];
const WEEKDAYS_EN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
/** Days named relative to today; each is only a day, never another common word. */
const RELATIVE_DAYS = [
  "azi", "astazi", "maine", "poimaine", "ieri", "alaltaieri", "diseara", "deseara", "la noapte", "saptamana viitoare", "saptamana asta",
  "weekendul asta", "weekendul viitor", "luna viitoare", "today", "tomorrow", "yesterday", "tonight", "next week", "this weekend",
  "next weekend", "next month", "day after tomorrow",
];
/** What makes "luni" the months, not Monday: a count before it, or "de zile" / "în urmă" after it. */
const LUNI_COUNTS = /(?:\d+|doua|trei|patru|cinci|sase|sapte|opt|noua|zece|douasprezece|cateva|multe|ultimele|urmatoarele|primele|niste|vreo|doar)\s*$/;
const LUNI_AS_MONTHS_AFTER = /^\s*(?:de\s+zile|in\s+urma|la\s+rand|intregi|la\s+sut)/;

/** Units that make "la 10" a quantity, not an hour: "la 10 km", "la 5 minute". */
const QUANTITY_UNITS =
  "%|pas|din|beri|cafele|sticle|mese|camere|copii|prieteni|nopti|puncte|goluri|bilete|locuri|poze|pagini|capitole|kilograme|litri|grame|lei|leu|ron|bani|euro|eur|usd|km|kg|g|m|cm|mm|l|ml|min|minute|minut|ore|ora de mers|zile|zi|saptamani|luni|ani|an|secunde|grade|persoane|oameni|bucati|buc|mesaje|metri|metru|pasi|lucruri|clienti|years|year|days|day|weeks|months|minutes|mins|hours|hrs|people|percent|points|pts|miles|mi|times|x";
/** A unit right after a number: "10 km", "30%", "de 5 minute". */
const UNIT_AHEAD = `\\s?(?:de\\s+|of\\s+)?(?:${QUANTITY_UNITS})(?![a-z0-9])`;
const HOUR_INTRODUCERS = ["la", "pe la", "ora", "orele", "in jur de", "pana la", "de la", "intre", "at", "around", "by", "from", "until", "till", "before", "after"];

const STREET_PREFIXES = ["str", "strada", "bd", "bdul", "b-dul", "bulevardul", "calea", "aleea", "sos", "soseaua", "splaiul", "piata", "intrarea", "prelungirea"];
const ADDRESS_PARTS = ["nr", "numarul", "bl", "bloc", "blocul", "sc", "scara", "ap", "apt", "apartament", "apartamentul", "et", "etaj", "etajul", "interfon", "cod postal"];
const STREET_SUFFIXES_EN = ["street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd", "lane", "ln", "drive", "court", "ct", "place", "square", "sq", "way"];

const TLDS = "ro|com|net|org|eu|io|app|dev|co|uk|de|fr|it|es|md|info|biz|me|ly|gl|to|link|shop|store|online|site|gov|edu";

/** Questions without a question mark: how a sentence starts. */
const QUESTION_STARTS_RO = [
  "ce faci", "ce mai faci", "ce zici", "ce parere", "ce ora", "ce zi", "cand", "unde", "cum", "cine", "cat", "cati", "cate", "care", "de ce", "oare",
  "poti", "puteti", "ai putea", "ati putea", "ai timp", "aveti", "esti", "sunteti", "vii", "veniti", "stii", "stiti", "vrei", "vreti",
  "ramane", "e ok", "este ok", "se poate", "ai ajuns", "ai vazut", "ai primit", "ati primit",
];
const QUESTION_STARTS_EN = [
  "what", "when", "where", "who", "whom", "whose", "why", "how", "which", "can you", "could you", "would you", "will you", "do you", "did you",
  "does", "are you", "is it", "is there", "have you", "shall we", "should we", "any chance", "you coming", "u coming", "can we", "can i",
];
/** Starts that read as a question word but open an exclamation or a statement. */
const NOT_QUESTIONS = [
  /^ce (?:bine|frumos|frumoasa|tare|misto|dragut|draguta|pacat|noroc|super|ciudat|interesant|urat|greu|usor|mult|multa|multi|repede|haios|haioasa|dragalas|minunat|fain|nasol|trist|rau|bun|buna)\b/,
  /^cand (?:am|a|au|eram|era|erai|ati|ne-am|m-am|s-a|l-am|i-am|te-am|ai fost|o sa|vei|voi|termin|ajung)\b/,
  /^cum (?:am|a|au|ziceam|spuneam|am zis|ti-am zis|v-am zis|ti-am spus|era|stii|se vede)\b/,
  /^unde (?:am|a|au|eram|era)\b/,
  /^care (?:e|este) (?:problema|faza)\b(?!.*\?)/,
  /^cine (?:a|au|stie)\b/,
  /^cat (?:de )?(?:bine|frumos|tare|mult|repede|greu)\b/,
  /^how (?:nice|cool|sweet|lovely|awesome|great|funny|sad|kind)\b/,
  /^what (?:a|an)\b/,
  /^why not\b(?!.*\?)/,
  /^when i\b/,
  /^where i\b/,
  /^who knows\b/,
];

// ---------------------------------------------------------------- helpers

/** An alternation of literal words, longest first, a space matching any run of spaces. */
const words = (list: readonly string[]): string =>
  [...list]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
    .join("|");

const DAY = "(?:0?[1-9]|[12]\\d|3[01])";
const NUMBER = "\\d{1,3}(?:[.,\\s]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";

const LINK = new RegExp(
  `(?:\\bhttps?://[^\\s<>"']+|\\bwww\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)+[^\\s<>"']*|(?<![@\\w.-])[a-z0-9][a-z0-9-]{0,62}(?:\\.[a-z0-9-]{1,63})*\\.(?:${TLDS})(?:/[^\\s<>"']*)?(?=$|[\\s,;!?)\\]]|\\.(?:\\s|$)))`,
  "gu"
);
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gu;

const AMOUNT_AFTER = new RegExp(
  `(?<![\\w.,])(?:${NUMBER})\\s?(?:k|mii|mil|milioane|m)?\\s?(?:de\\s+)?(?:${words(CURRENCY_WORDS)})\\b|(?<![\\w.,])(?:${NUMBER})\\s?(?:€|\\$|£)`,
  "u"
);
const AMOUNT_BEFORE = new RegExp(`(?:€|\\$|£)\\s?\\d|\\b(?:${words(CURRENCY_PREFIXES)})\\s?\\d`, "u");
const IBAN = /\b[a-z]{2}\d{2}(?:\s?[a-z0-9]{4}){3,7}(?:\s?[a-z0-9]{1,4})?\b/u;
const MONEY_WORD = new RegExp(`\\b(?:${words(MONEY_WORDS)})\\b`, "gu");
const QUANTITY_AFTER = new RegExp(`^(?:${UNIT_AHEAD}|[./-]\\d)`, "u");

const DATE_NUMERIC = [
  new RegExp(`(?<![\\d.,/:-])${DAY}[./-](?:0?[1-9]|1[0-2])[./-](?:\\d{4}|\\d{2})(?![\\d.,/:-]|[.,]\\d)`, "u"),
  /(?<![\d.,/:-])\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d-])/u,
  new RegExp(`(?<![\\d.,/:-])${DAY}[./](?:0[1-9]|1[0-2])(?![\\d.,/:]|${UNIT_AHEAD})`, "u"),
];
const HOUR_BEFORE_NUMERIC = /(?:\bla|\bora|\borele|\bpe la|\bat|\baround|\bby)\s+$/u;
const MONTH_UNAMBIGUOUS = new RegExp(`\\b(?:${words(MONTHS_UNAMBIGUOUS)})\\b`, "u");
/** "mai" as "more": "4 mai mulți", "2 mai devreme". */
const MAI_AS_MORE = "\\s+(?:mult|multe|multi|multa|putin|putine|putini|bine|bun|buna|buni|tarziu|devreme|repede|departe|aproape|mare|mari|mic|mica|jos|sus|incolo|incet|tare|ales|tot|toti|dinainte)\\b";
const MONTH_WITH_DAY = new RegExp(
  `(?<![\\d.,])${DAY}(?:st|nd|rd|th)?\\s+(?:de\\s+|of\\s+)?(?:${words([...MONTHS_AMBIGUOUS, ...MONTH_ABBREVIATIONS])})\\b(?!${MAI_AS_MORE})\\.?|\\b(?:${words([...MONTHS_AMBIGUOUS, ...MONTH_ABBREVIATIONS])})\\.?\\s+${DAY}(?:st|nd|rd|th)?(?![a-z0-9]|${UNIT_AHEAD}|[.,:]\\d)`,
  "u"
);
const MONTH_NAMED = /\b(?:luna|month of)\s+(?:mai|may|august|march)\b/u;
const WEEKDAY = new RegExp(`\\b(?:${words([...WEEKDAYS_RO, ...WEEKDAYS_EN])})\\b`, "u");
const RELATIVE_DAY = new RegExp(`\\b(?:${words(RELATIVE_DAYS)})\\b`, "u");
const LUNI = /\bluni\b/gu;

const TIME_CLOCK = /(?<![\d.,/:])(?:[01]?\d|2[0-3])(?::|h)[0-5]\d(?![\d.,/:])/u;
const TIME_MERIDIEM = /(?<![\d.,])(?:0?[1-9]|1[0-2])(?:[:.][0-5]\d)?\s?(?:am|pm|a\.m\.|p\.m\.)(?!\w)/u;
const TIME_INTRODUCED = new RegExp(
  `\\b(?:${words(HOUR_INTRODUCERS)})\\s+(?:ora\\s+|orele\\s+)?(?:[01]?\\d|2[0-3])(?:[:.,][0-5]\\d)?(?![\\d.,/]|${UNIT_AHEAD}|\\s?(?:${words([...MONTHS_AMBIGUOUS, ...MONTHS_UNAMBIGUOUS, ...MONTH_ABBREVIATIONS])})\\b|[./-]\\d)`,
  "u"
);
const TIME_WORDS = /\b(?:la pranz|la amiaza|la miezul noptii|noon|midnight|o'clock)\b/u;

const STREET = new RegExp(`\\b(?:${words(STREET_PREFIXES)})\\b\\.?\\s+`, "gu");
/** A number, block or flat — not "apartament 2 camere", which is its size. */
const ADDRESS_PART = new RegExp(
  `\\b(${words(ADDRESS_PARTS)})\\b\\.?\\s*[a-z]?\\d{1,4}[a-z]?\\b(?!\\s*(?:camere|camera|rooms?|bedrooms?|dormitoare|persoane|locuri))`,
  "gu"
);
const STREET_EN = new RegExp(`\\b\\d{1,5}[a-z]?\\s+(?:[a-z]+\\s+){1,3}(?:${words(STREET_SUFFIXES_EN)})\\b`, "u");
const ADDRESS_KEYWORD = /\b(?:adresa|address)\s*(?:e|este|is|:)\s*\S+(?:\s+\S+){0,6}?\s+\d/u;

const QUESTION_START = new RegExp(`^(?:${words([...QUESTION_STARTS_RO, ...QUESTION_STARTS_EN])})\\b`, "u");

// ---------------------------------------------------------------- detectors

function hasAmount(text: string): boolean {
  if (AMOUNT_AFTER.test(text) || AMOUNT_BEFORE.test(text)) return true;
  const iban = IBAN.exec(text);
  if (iban !== null && (iban[0].match(/\d/g)?.length ?? 0) >= 10) return true;
  for (const match of text.matchAll(MONEY_WORD)) {
    const rest = text.slice(match.index + match[0].length);
    const number = /\d/.exec(rest);
    if (number === null || number.index > 24) continue;
    if (!MONEY_GAP.test(rest.slice(0, number.index))) continue;
    const tail = rest.slice(number.index);
    const value = /^\d+(?:[.,]\d+)*/.exec(tail)![0];
    const after = tail.slice(value.length);
    // "chiria pe 3 luni", "total 5 persoane", "avans 10%": a count or a share, not a sum.
    if (QUANTITY_AFTER.test(after)) continue;
    return true;
  }
  return false;
}

function hasDate(text: string): boolean {
  for (const pattern of DATE_NUMERIC) {
    const match = pattern.exec(text);
    if (match !== null && !HOUR_BEFORE_NUMERIC.test(text.slice(0, match.index))) return true;
  }
  if (MONTH_UNAMBIGUOUS.test(text) || MONTH_WITH_DAY.test(text) || MONTH_NAMED.test(text)) return true;
  if (WEEKDAY.test(text) || RELATIVE_DAY.test(text)) return true;
  for (const match of text.matchAll(LUNI)) {
    if (LUNI_COUNTS.test(text.slice(0, match.index))) continue;
    if (LUNI_AS_MONTHS_AFTER.test(text.slice(match.index + match[0].length))) continue;
    return true;
  }
  return false;
}

function hasTime(text: string): boolean {
  return TIME_CLOCK.test(text) || TIME_MERIDIEM.test(text) || TIME_INTRODUCED.test(text) || TIME_WORDS.test(text);
}

/**
 * A street prefix counts before a name — a capital letter in the words as
 * written ("Calea Victoriei", not "calea cea mai bună"), a number, or "nr" —
 * or when the message also gives a number, block or flat. Two parts alone
 * ("bl. A3, ap. 12") are an address; one ("comanda nr. 5") is not.
 */
function hasAddress(folded: string, original: string): boolean {
  const aligned = folded.length === original.length;
  const parts = new Set<string>();
  for (const match of folded.matchAll(ADDRESS_PART)) parts.add(match[1]!.replace(/^(?:numarul)$/, "nr").replace(/^(?:bloc|blocul)$/, "bl").replace(/^(?:scara)$/, "sc").replace(/^(?:apt|apartament|apartamentul)$/, "ap").replace(/^(?:etaj|etajul)$/, "et"));
  if (parts.size >= 2) return true;
  for (const match of folded.matchAll(STREET)) {
    const at = match.index + match[0].length;
    const next = folded.slice(at);
    if (/^(?:nr\b|\d)/.test(next)) return true;
    if (!/^[a-z]/.test(next)) continue;
    const written = aligned ? original.charAt(at) : "";
    if (written !== "" && written === written.toUpperCase() && written !== written.toLowerCase()) return true;
    if (parts.size >= 1) return true;
  }
  return STREET_EN.test(folded) || ADDRESS_KEYWORD.test(folded);
}

function hasQuestion(text: string): boolean {
  if (text.includes("?")) return true;
  for (const sentence of text.split(/[.!\n;]+|,\s*(?=\S)/u)) {
    const trimmed = sentence.trim().replace(/^(?:si|dar|ok|bun|salut|buna|hei|hey|hi|hello|so|and|but|deci|atunci|apropo|btw)\b[,\s]*/u, "");
    if (trimmed.split(/\s+/).length < 2) continue;
    if (!QUESTION_START.test(trimmed)) continue;
    if (NOT_QUESTIONS.some((pattern) => pattern.test(trimmed))) continue;
    return true;
  }
  return false;
}

/** The markers a message's words carry. An empty set for empty or placeholder-only text. */
export function signalsOf(text: string | null | undefined): Set<Signal> {
  const found = new Set<Signal>();
  if (typeof text !== "string" || text.trim() === "") return found;
  // Placeholders the service renders ("[image] caption") keep only their caption.
  const original = text.replace(/^\[[^\]\n]{1,60}\]\s*/u, "");
  const folded = foldText(original);
  const links = folded.match(LINK);
  let rest = folded;
  let restOriginal = original;
  if (links !== null) {
    found.add("link");
    // A link's digits and query string say nothing about the sentence around it.
    rest = folded.replace(LINK, (link) => " ".repeat(link.length));
    restOriginal = folded.length === original.length ? original.split("").map((ch, i) => (rest[i] === " " && folded[i] !== " " ? " " : ch)).join("") : original;
  }
  rest = rest.replace(EMAIL, (email) => " ".repeat(email.length));
  if (hasAmount(rest)) found.add("amount");
  if (hasDate(rest)) found.add("date");
  if (hasTime(rest)) found.add("time");
  if (hasAddress(rest, restOriginal)) found.add("address");
  if (hasQuestion(rest)) found.add("question");
  return found;
}
