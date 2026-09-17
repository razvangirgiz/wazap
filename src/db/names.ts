/**
 * How a name someone asks for meets the names stored for people and groups:
 * the fold (case and diacritics, ş/ţ with a cedilla too), words, Romanian case
 * endings ("mamei" is mama, "lui Andrei" is Andrei), a small table of
 * diminutives ("Cristi" for Cristian or Cristina), and the words that name a
 * relationship to the user ("mama", "soția", "dad") rather than a person.
 * Pure tables and functions; contacts.ts scores with them.
 */
import { foldText } from "./fold.js";

/** Folded words: case and diacritics gone, anything that is not a letter or a digit a separator. */
export function nameWords(text: string | null | undefined): string[] {
  if (typeof text !== "string" || text === "") return [];
  return foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** A name a human wrote: not empty, not a number or punctuation standing in for one. */
export function isRealName(value: string | null | undefined): boolean {
  const name = value?.trim() ?? "";
  return name !== "" && !/^[+\d\s()\-.·•∙…*]+$/u.test(name);
}

// ---------------------------------------------------------------- case endings

/**
 * Romanian genitive-dative and article endings, folded, and what the base form
 * ends in instead. In a group whose `every` is false only the longest ending
 * that fits applies ("Andreei" is Andreea, not Andrea); -ului and -lui both
 * apply, since "tatălui" is tata and "fotbalului" is fotbal and only the stored
 * names can tell which one was meant.
 */
export const INFLECTIONS: ReadonlyArray<{ every: boolean; endings: ReadonlyArray<readonly [ending: string, base: string]> }> = [
  {
    every: true,
    endings: [
      ["ului", ""],
      ["lui", ""],
    ],
  },
  {
    every: false,
    endings: [
      ["eei", "eea"],
      ["iei", "ia"],
      ["ei", "a"],
    ],
  },
  {
    every: false,
    endings: [
      ["ul", ""],
      ["le", ""],
    ],
  },
];
const MIN_INFLECTED_CHARS = 4;
const MIN_STEM_CHARS = 2;

/** A folded word and the base forms its ending may stand for, the word itself first. */
export function inflectionForms(word: string): string[] {
  const forms = [word];
  if (word.length < MIN_INFLECTED_CHARS) return forms;
  for (const { every, endings } of INFLECTIONS) {
    for (const [ending, base] of endings) {
      if (!word.endsWith(ending) || word.length - ending.length < MIN_STEM_CHARS) continue;
      const form = word.slice(0, word.length - ending.length) + base;
      if (!forms.includes(form)) forms.push(form);
      if (!every) break;
    }
  }
  return forms;
}

/** Words a query drops before matching: "lui" before a name, "mea"/"my" after a relationship. */
export const NAME_PARTICLES = new Set(["lui", "mea", "meu", "mele", "mei", "my", "dragă", "draga", "dear"].map((word) => foldText(word)));

// ---------------------------------------------------------------- diminutives

/**
 * Given names and the short forms people use for them, Romanian and English,
 * folded. A short form matches its full name (and back) below an exact
 * match; it is never followed further (Sandu is Alexandru, not Alex).
 */
export const DIMINUTIVES: Readonly<Record<string, readonly string[]>> = {
  // Romanian
  alexandru: ["alex", "sandu", "sandi", "alecu", "andu"],
  alexandra: ["alex", "sandra", "alexa"],
  andrei: ["andi", "andy"],
  andreea: ["deea", "andi"],
  ana: ["anuta"],
  maria: ["mari", "mia", "maricica", "mariuca"],
  mihai: ["misu", "mihaita", "mihu", "mike"],
  mihaela: ["miha", "mihaelica", "ela"],
  ion: ["nelu", "ionut", "ionel", "ionica"],
  ioan: ["nelu", "ionut", "ionel"],
  ioana: ["ioanica"],
  gheorghe: ["ghita", "gigi", "gica", "george"],
  george: ["gigi", "ghita"],
  constantin: ["costi", "costel", "costica", "titi", "dinu"],
  cristian: ["cristi", "cris"],
  cristina: ["cristi", "cris", "tina"],
  gabriel: ["gabi"],
  gabriela: ["gabi"],
  daniel: ["dani", "danut", "dan", "danny"],
  daniela: ["dani"],
  florin: ["flo", "florinel"],
  florentina: ["flori", "flo", "tina"],
  vasile: ["vasi", "vasilica", "sile"],
  nicolae: ["nicu", "nicusor", "nae", "nick"],
  nicoleta: ["nico"],
  stefan: ["fane", "stefanel", "stefi"],
  stefania: ["stefi"],
  dumitru: ["mitica", "mitu", "dumi"],
  elena: ["lena", "leni", "ela", "elenuta"],
  ecaterina: ["cati", "rina"],
  catalin: ["cata"],
  catalina: ["cata"],
  valentin: ["vali"],
  valentina: ["vali", "tina"],
  adrian: ["adi"],
  adriana: ["adi"],
  bogdan: ["bogdi", "bodi"],
  iulian: ["iuli", "iulica"],
  iuliana: ["iuli"],
  sebastian: ["sebi", "seba"],
  teodor: ["teo", "doru"],
  teodora: ["teo", "dora"],
  tudor: ["tudi", "doru"],
  octavian: ["tavi"],
  ovidiu: ["ovi"],
  lucian: ["luci"],
  laurentiu: ["lau", "lauri"],
  claudiu: ["clau"],
  claudia: ["clau"],
  emanuel: ["manu", "emi"],
  petru: ["petrica", "petrisor", "pit"],
  aurel: ["relu"],
  cornel: ["nelu", "cornelut"],
  georgiana: ["georgi", "gia"],
  roxana: ["roxi"],
  simona: ["simo", "moni"],
  monica: ["moni"],
  veronica: ["vero"],
  razvan: ["razvi"],
  // English
  alexander: ["alex", "al", "xander", "sasha"],
  william: ["will", "bill", "billy", "liam"],
  robert: ["rob", "bob", "bobby", "robbie"],
  richard: ["rick", "rich", "richie", "dick"],
  james: ["jim", "jimmy", "jamie"],
  john: ["johnny", "jack"],
  michael: ["mike", "mick", "mikey"],
  christopher: ["chris", "topher"],
  christina: ["chris", "tina"],
  elizabeth: ["liz", "lizzy", "beth", "betty", "eliza"],
  katherine: ["kate", "katie", "kathy", "kat"],
  margaret: ["maggie", "meg", "peggy"],
  jennifer: ["jen", "jenny"],
  nicholas: ["nick", "nicky"],
  matthew: ["matt"],
  anthony: ["tony"],
  joseph: ["joe", "joey"],
  thomas: ["tom", "tommy"],
  benjamin: ["ben", "benny"],
  samuel: ["sam", "sammy"],
  samantha: ["sam", "sammy"],
  edward: ["ed", "eddie", "ted"],
  david: ["dave", "davey"],
  steven: ["steve"],
  stephen: ["steve"],
  andrew: ["andy", "drew"],
  charles: ["charlie", "chuck"],
  victoria: ["vicky", "tori"],
  rebecca: ["becky", "becca"],
  susan: ["sue", "suzy"],
};

const RELATED_NAMES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const related = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    let set = related.get(a);
    if (set === undefined) related.set(a, (set = new Set()));
    set.add(b);
  };
  for (const [full, shorts] of Object.entries(DIMINUTIVES)) {
    for (const short of shorts) {
      link(full, short);
      link(short, full);
    }
  }
  return related;
})();

/** The names a folded word is a short form of, or the short forms of the name it is; never itself. */
export function diminutivesOf(word: string): ReadonlySet<string> {
  return RELATED_NAMES.get(word) ?? new Set();
}

// ---------------------------------------------------------------- relationships

/**
 * Words that name someone by their relationship to the user, folded, with
 * the case forms the reducer does not reach. Such a word matches only what
 * the user filed — a saved name, a tag, a detail — never a name someone gave
 * themselves, a group, or what a message says.
 */
export const RELATIONSHIPS: Readonly<Record<string, readonly string[]>> = {
  mother: ["mama", "mami", "mamica", "maica", "mamuca", "mom", "mum", "mommy", "mummy", "mother", "mama mea"],
  father: ["tata", "tati", "taticu", "tatal", "dad", "daddy", "father"],
  wife: ["sotia", "sotie", "nevasta", "nevasta mea", "wife", "wifey"],
  husband: ["sotul", "sot", "barbatul", "husband", "hubby"],
  brother: ["frate", "fratele", "fratior", "fratiorul", "brother", "bro"],
  sister: ["sora", "sorei", "surorii", "sorela", "surioara", "sister", "sis"],
  grandmother: ["bunica", "bunicii", "buni", "mamaie", "mamaia", "granny", "grandma", "grandmother"],
  grandfather: ["bunicul", "bunic", "tataie", "tataia", "grandpa", "grandfather", "gramps"],
  son: ["fiul", "fiu", "baiatul", "son"],
  daughter: ["fiica", "fetita", "daughter"],
  aunt: ["matusa", "matusii", "tanti", "aunt", "auntie"],
  uncle: ["unchiul", "unchi", "nenea", "uncle"],
  mother_in_law: ["soacra", "soacrei"],
  father_in_law: ["socrul", "socru"],
  cousin: ["verisoara", "verisorul", "varul", "cousin"],
  girlfriend: ["iubita", "girlfriend", "gf"],
  boyfriend: ["iubitul", "boyfriend", "bf"],
  partner: ["partenera", "partenerul", "partner"],
  godmother: ["nasa", "nasei"],
  godfather: ["nasul", "nasu"],
};

const RELATION_OF_WORD: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [relation, spellings] of Object.entries(RELATIONSHIPS)) {
    for (const spelling of spellings) {
      const words = nameWords(spelling).filter((word) => !NAME_PARTICLES.has(word));
      if (words.length === 1) map.set(words[0]!, relation);
    }
  }
  return map;
})();

/** The relationship a folded word names, through its case endings; null for any other word. */
export function relationOf(word: string): string | null {
  for (const form of inflectionForms(word)) {
    const relation = RELATION_OF_WORD.get(form);
    if (relation !== undefined) return relation;
  }
  return null;
}

/** Detail keys whose value is what the user calls someone. */
export const NICKNAME_FIELDS: ReadonlySet<string> = new Set(["nickname", "porecla", "alias", "nume"]);
/** Detail keys whose value is how someone is related to the user. */
export const RELATIONSHIP_FIELDS: ReadonlySet<string> = new Set(["relatie", "relationship", "relation"]);

/** Words after a relationship word that say which of the user's numbers for them it is: "Mama mobil". */
const RELATION_QUALIFIERS = new Set(["mobil", "fix", "acasa", "serviciu", "birou", "work", "home", "cell", "mobile", "nou", "noul", "vechi", "new", "old", "ro", "uk"]);

/**
 * Whether a name the user filed says the relationship `relation` is this
 * person: the name is nothing but the relationship ("Mama", "Mami ❤️", "Mom",
 * "Mama mobil"), or ends with it after their name ("Maria mama"). A name that
 * starts with it and goes on to someone else ("Mama Anei", "Mama lui Andrei")
 * is that someone's relative, not the user's. Returns the class: exact for
 * the first, word for the second, null for no match.
 */
export function relationNameMatch(relation: string, text: string | null | undefined): "exact" | "word" | null {
  return relationWordsMatch(relation, nameWords(text));
}

/** relationNameMatch over a name already split into folded words. */
export function relationWordsMatch(relation: string, words: readonly string[]): "exact" | "word" | null {
  if (words.length === 0) return null;
  const at = words.findIndex((word) => relationOf(word) === relation);
  if (at === -1) return null;
  const others = words.filter((word, index) => index !== at && !NAME_PARTICLES.has(word) && relationOf(word) !== relation);
  if (others.length === 0) return "exact";
  if (words.includes("lui")) return null;
  if (others.every((word) => RELATION_QUALIFIERS.has(word) || /^\d+$/.test(word))) return "exact";
  if (at === words.length - 1) return "word";
  return null;
}

// ---------------------------------------------------------------- closeness

/** Edits between two folded words (insert, delete, substitute, swap two neighbours), capped at `max` + 1. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  const width = b.length + 1;
  let before = new Uint16Array(width);
  let previous = new Uint16Array(width);
  let current = new Uint16Array(width);
  for (let j = 0; j < width; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = i;
    for (let j = 1; j < width; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        value = Math.min(value, before[j - 2]! + 1);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [before, previous, current] = [previous, current, before];
  }
  return Math.min(previous[b.length]!, max + 1);
}
