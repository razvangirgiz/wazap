/**
 * The evaluation's clock. Every run happens "today at 15:30, Bucharest time",
 * whenever it really runs, so a case that says "this morning" or "yesterday
 * at 19:40" means the same messages on every run. The date is the real local
 * date by default, because the Claude CLI tells the model today's date on its
 * own and the two must agree; the time of day is fixed.
 *
 * Import this module before anything that reads the time: it sets the time
 * zone and replaces the global Date with one that runs from the anchor. Time
 * still flows (drafts expire, waits time out), only the starting point moves.
 */
export const TIME_ZONE = "Europe/Bucharest";
process.env.TZ = TIME_ZONE;

const RealDate = globalThis.Date;
let offsetMs = 0;

class EvalDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offsetMs);
    else super(...args);
  }

  static now() {
    return RealDate.now() + offsetMs;
  }
}

// Installed at import, before any module that could keep a reference to
// `Date.now`; until setClock runs it reads the real time.
globalThis.Date = EvalDate;

/** From now on `Date.now()` in this process reads `anchorMs` plus the real time elapsed since this call. */
export function setClock(anchorMs) {
  offsetMs = anchorMs - RealDate.now();
}

export function realNow() {
  return RealDate.now();
}

const pad = (n) => String(n).padStart(2, "0");

/** The parts of an instant on the Bucharest wall clock. */
export function wallClock(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(new RealDate(ms))
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}

/** The instant a Bucharest wall-clock time names (TZ is set above, so the local constructor is Bucharest). */
export function fromWallClock(year, month, day, hour = 0, minute = 0, second = 0) {
  return new RealDate(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * The anchor for a run: `spec` is "YYYY-MM-DD HH:MM", "YYYY-MM-DDTHH:MM", "HH:MM"
 * (today) or empty (today at `defaultTime`).
 */
export function anchorFor(spec, defaultTime = "15:30") {
  const today = wallClock(RealDate.now());
  const text = (spec ?? "").trim();
  let date = { year: today.year, month: today.month, day: today.day };
  let time = defaultTime;
  const full = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?$/.exec(text);
  if (full) {
    date = { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]) };
    time = full[4] ?? defaultTime;
  } else if (/^\d{2}:\d{2}$/.test(text)) {
    time = text;
  } else if (text !== "") {
    throw new Error(`Unreadable anchor "${spec}": use "YYYY-MM-DD HH:MM" or "HH:MM"`);
  }
  const [hour, minute] = time.split(":").map(Number);
  return fromWallClock(date.year, date.month, date.day, hour, minute);
}

const WEEKDAYS_RO = ["duminică", "luni", "marți", "miercuri", "joi", "vineri", "sâmbătă"];
const MONTHS_RO = ["ian.", "feb.", "mar.", "apr.", "mai", "iun.", "iul.", "aug.", "sept.", "oct.", "nov.", "dec."];
const MONTHS_RO_LONG = [
  "ianuarie",
  "februarie",
  "martie",
  "aprilie",
  "mai",
  "iunie",
  "iulie",
  "august",
  "septembrie",
  "octombrie",
  "noiembrie",
  "decembrie",
];

/** "Azi e joi, 17 sept. 2026, 15:30, ora României." */
export function anchorSentence(ms) {
  const w = wallClock(ms);
  return `Azi e ${WEEKDAYS_RO[w.weekday]}, ${w.day} ${MONTHS_RO[w.month - 1]} ${w.year}, ${pad(w.hour)}:${pad(w.minute)}, ora României.`;
}

/** Template values a case may use for dates relative to the anchor: {{today_weekday}}, {{tomorrow_date}}… */
export function calendarWords(ms) {
  const out = {};
  const day = 86_400_000;
  for (const [name, delta] of [
    ["yesterday", -1],
    ["today", 0],
    ["tomorrow", 1],
  ]) {
    const w = wallClock(ms + delta * day);
    out[`${name}_weekday`] = WEEKDAYS_RO[w.weekday];
    out[`${name}_day`] = String(w.day);
    out[`${name}_month`] = MONTHS_RO_LONG[w.month - 1];
    out[`${name}_iso`] = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  }
  return out;
}
