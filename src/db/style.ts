/**
 * How the user writes, from their own messages: what a draft needs to sound
 * like them (F2-3, the draft context). Deterministic counts over the words,
 * no model: the language by its function words (not by diacritics — most
 * people write Romanian without them), diacritics, the form of address (tu or
 * dumneavoastră), length, emoji, and how a message starts and ends.
 */

export interface StyleStats {
  basis: { own_messages: number; days: number; scope: "chat" | "account" };
  language: "ro" | "en" | "other";
  /** How many of the user's longer Romanian messages carry diacritics: unknown without one long enough to tell, none for other languages. */
  diacritics: "none" | "some" | "most" | "unknown";
  address: "tu" | "dumneavoastra" | "unknown";
  length_chars: { p50: number; p90: number };
  /** Share of messages with at least one emoji, 0..1. */
  emoji_rate: number;
  /** Share of messages whose first letter is a capital, 0..1. */
  starts_capital: number;
  /** Share of messages that end in . ! ? or …, emoji and spaces aside, 0..1. */
  ends_punct: number;
}

/**
 * Words only Romanian uses this often, folded. Words both languages share
 * ("am", "in", "a") count for neither. "salut" sits beside "buna" because a
 * short draft is often nothing but a greeting and the words after it: without
 * it, "Salut John, întârzii 10 minute" has no language at all.
 */
const RO_WORDS = new Set(
  (
    "si sa ca nu de la pe cu este sunt ce cum unde cand mai dar sau ma te il ne un pentru din iti imi eu tu el ea noi voi asta " +
    "aici acum doar foarte deja inca daca care fost poti pot vreau stiu bine multumesc mersi azi maine ai e vin trebuie niste " +
    "lui meu mea tau ta vad zic hai bun buna salut acasa ajung va timp aveti puteti sunteti doriti stiti vreti veniti esti vrei stii " +
    "vii faci zici crezi dumneavoastra dvs multumim"
  ).split(" ")
);
const EN_WORDS = new Set(
  (
    "the and to you is are it of that for on with what how when where will can just not do dont yes but or me my your we be " +
    "have this was i so if at get got know see thanks thank please im its ill good there they would could should"
  ).split(" ")
);
/** Romanian clitics joined by a hyphen: "s-a", "mi-a", "i-am", "ți-am". */
const RO_CLITIC = /^(?:s|m|t|l|i|n|v|ne|mi|ti|si|le|ma|te|v-am|ne-am)-\p{L}+$/u;

const RO_DIACRITICS = /[ăâîșşțţĂÂÎȘŞȚŢ]/u;
/** How many letters a message needs before its lack of diacritics says anything. */
const DIACRITIC_MIN_LETTERS = 15;
/**
 * Words written with a diacritic in Romanian, folded: a draft without
 * diacritics lacks them only when it has one of these ("mâine", "și"); "ne
 * vedem la birou" needs none. A clitic counts by its first part ("ți-am").
 */
const NEEDS_DIACRITICS = new Set(
  (
    "si sa ca in intr dintr intr-o intr-un iti imi isi ti cand cat cata cate cati dupa pana maine poimaine alaltaieri asa inca " +
    "fara tau tai lasa acasa buna multumesc multumim poti stiu stii stie stim stiti esti ati sunteti aveti puteti vreti veniti " +
    "spuneti trimiteti ma vad vazut facut intreb intrebat intalnire intarzii intarziere incerc inteleg astept asteptam sedinta " +
    "saptamana sambata duminica marti sase sapte doua masina scoala gradinita impreuna niciodata odata atata placere placut " +
    "parere pret adica cateva catre mancare mananc sotia sotul matusa"
  ).split(" ")
);

/** Second person address; "doamna" and "domnule" name someone as often as they address the reader, so they do not count. */
const FORMAL = new Set(["dumneavoastra", "dvs", "dvs.", "dv", "dumneata"]);
/** Second person plural verbs: formal address in a one-to-one chat, unless the message speaks to several people. */
const FORMAL_VERBS = new Set(["aveti", "puteti", "sunteti", "doriti", "stiti", "vreti", "veniti", "trimiteti", "spuneti", "ati"]);
/** Words that make a plural verb plural, not formal: "ați ajuns amândoi?". */
const SEVERAL_READERS = new Set(["amandoi", "amandoua", "voi", "voua", "vostru", "voastra", "vostri", "voastre", "toti", "toate", "tuturor"]);
const INFORMAL = new Set(["tu", "te", "iti", "ti", "tine", "ta", "tau", "tale", "esti", "poti", "vrei", "stii", "vii", "faci", "zici", "crezi", "hai", "ai"]);
const MIN_ADDRESS_MESSAGES = 2;

const EMOJI = /\p{Extended_Pictographic}/u;
/** Spaces, emoji, and the joiner and variation selector that build emoji sequences, at the end of a message. */
const TRAILING_DECORATION = /(?:\s|\p{Extended_Pictographic}|\u200d|\ufe0f)+$/u;

/** Case- and diacritic-free, the way the tables above are spelled. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}-]+/u)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word !== "");
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const rate = (count: number, total: number): number => (total === 0 ? 0 : Math.round((count / total) * 100) / 100);

/**
 * The style of `texts` — the user's own messages, newest first or in any
 * order. `oneToOne` makes plural verbs count as formal address, which in a
 * group they are not.
 */
export function styleOf(texts: readonly string[], basis: StyleStats["basis"], options: { oneToOne?: boolean } = {}): StyleStats {
  const messages = texts.map((text) => text.trim()).filter((text) => text !== "");
  let ro = 0;
  let en = 0;
  const romanian: string[] = [];
  let formal = 0;
  let informal = 0;
  let emoji = 0;
  let lettered = 0;
  let capital = 0;
  let punct = 0;
  const lengths: number[] = [];
  for (const text of messages) {
    const tokens = words(text);
    let roHits = 0;
    let enHits = 0;
    for (const token of tokens) {
      if (RO_WORDS.has(token) || RO_CLITIC.test(token)) roHits++;
      else if (EN_WORDS.has(token)) enHits++;
    }
    if (roHits > enHits) {
      ro++;
      romanian.push(text);
      const address = addressOf(tokens, options.oneToOne === true);
      if (address === "dumneavoastra") formal++;
      else if (address === "tu") informal++;
    } else if (enHits > roHits) {
      en++;
    }
    lengths.push([...text].length);
    if (EMOJI.test(text)) emoji++;
    const letter = /\p{L}/u.exec(text);
    if (letter !== null) {
      lettered++;
      if (letter[0] !== letter[0].toLowerCase() && letter[0] === letter[0].toUpperCase()) capital++;
    }
    if (/[.!?…]$/u.test(text.replace(TRAILING_DECORATION, ""))) punct++;
  }
  const classified = ro + en;
  const language: StyleStats["language"] = classified === 0 ? "other" : ro / classified >= 0.6 ? "ro" : en / classified >= 0.6 ? "en" : "other";

  let diacritics: StyleStats["diacritics"] = "none";
  if (language === "ro") {
    const long = romanian.filter((text) => (text.match(/\p{L}/gu)?.length ?? 0) >= DIACRITIC_MIN_LETTERS);
    if (long.length === 0) {
      diacritics = "unknown";
    } else {
      const share = long.filter((text) => RO_DIACRITICS.test(text)).length / long.length;
      diacritics = share >= 0.6 ? "most" : share >= 0.1 ? "some" : "none";
    }
  }

  let address: StyleStats["address"] = "unknown";
  if (language === "ro") {
    if (formal >= MIN_ADDRESS_MESSAGES && formal >= informal) address = "dumneavoastra";
    else if (informal >= MIN_ADDRESS_MESSAGES && informal > formal) address = "tu";
  }

  lengths.sort((a, b) => a - b);
  return {
    basis,
    language,
    diacritics,
    address,
    length_chars: { p50: percentile(lengths, 0.5), p90: percentile(lengths, 0.9) },
    emoji_rate: rate(emoji, messages.length),
    starts_capital: rate(capital, lettered),
    ends_punct: rate(punct, messages.length),
  };
}

/** The form of address a Romanian message's words use, or null for none. */
function addressOf(tokens: readonly string[], oneToOne: boolean): "tu" | "dumneavoastra" | null {
  const plural = oneToOne && !tokens.some((token) => SEVERAL_READERS.has(token)) && tokens.some((token) => FORMAL_VERBS.has(token));
  if (plural || tokens.some((token) => FORMAL.has(token))) return "dumneavoastra";
  return tokens.some((token) => INFORMAL.has(token)) ? "tu" : null;
}

/** Quoted words ("…", „…”, «…») and what follows "a zis:" or "said:" are someone else's, not the draft's style. */
function ownWords(text: string): string {
  const unquoted = text.replace(/„[^”"]*[”"]|“[^”]*”|"[^"]*"|«[^»]*»/gu, " ");
  const reported = /\b(?:zis|zice|spus|spune|scris|scrie|[îi]ntrebat|[îi]ntreab[ăa]|r[ăa]spuns|said|says|wrote|writes|asked|told)\s*:/iu.exec(unquoted);
  return reported === null ? unquoted : unquoted.slice(0, reported.index + reported[0].length);
}

/** What one message says about its own style: a draft, read with the tables styleOf reads the user's messages with. */
export interface MessageStyle {
  language: "ro" | "en" | "other";
  /**
   * Romanian only: true when it carries diacritics, false when it has words
   * that need them and none do ("maine", "si"), null otherwise.
   */
  diacritics: boolean | null;
  /** The form of address it uses; null when it names none, or is not Romanian. */
  address: "tu" | "dumneavoastra" | null;
  /** Characters, emoji counting one each. */
  chars: number;
}

/**
 * The style of a single message, for comparing a draft with StyleStats:
 * language by function words, diacritics by the words that need them, and the
 * form of address by the same markers (plural verbs count as formal only
 * `oneToOne`, and not when speaking to several). What it quotes is left out.
 */
export function messageStyle(text: string, options: { oneToOne?: boolean } = {}): MessageStyle {
  const trimmed = text.trim();
  const own = ownWords(trimmed);
  const tokens = words(own);
  let roHits = 0;
  let enHits = 0;
  for (const token of tokens) {
    if (RO_WORDS.has(token) || RO_CLITIC.test(token)) roHits++;
    else if (EN_WORDS.has(token)) enHits++;
  }
  const language: MessageStyle["language"] = roHits > enHits ? "ro" : enHits > roHits ? "en" : "other";
  let diacritics: boolean | null = null;
  let address: MessageStyle["address"] = null;
  if (language === "ro") {
    if (RO_DIACRITICS.test(own)) diacritics = true;
    else if (tokens.some((token) => NEEDS_DIACRITICS.has(token) || NEEDS_DIACRITICS.has(token.split("-")[0]!))) diacritics = false;
    address = addressOf(tokens, options.oneToOne === true);
  }
  return { language, diacritics, address, chars: [...trimmed].length };
}
