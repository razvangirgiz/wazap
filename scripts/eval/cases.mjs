/**
 * The evaluation's cases and tool maps: loading, checking their shape, and
 * turning a case's references ($contacts.elena.jid, {{tomorrow_weekday}}) into
 * the values of one built world.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CASES_DIR = join(REPO_ROOT, "eval", "cases");
export const TOOL_MAP_DIR = join(REPO_ROOT, "eval", "tool-map");
export const SUBSETS_FILE = join(REPO_ROOT, "eval", "subsets.json");
export const WORLD_FILE = join(REPO_ROOT, "eval", "fixtures", "world.json");

export const SEVERITIES = ["critical", "major", "minor"];
const HOOKS = new Set(["expire_drafts", "inject", "send_fault", "status"]);
const WHEN = new Set(["always", "draft_open", "no_effects"]);
export const CHECKS = new Set([
  "must_call",
  "must_not_call",
  "max_calls",
  "no_calls",
  "accounts_covered",
  "accounts_only",
  "order",
  "after_call",
  "effects_none",
  "effects_exact",
  "effects_all",
  "effects_count",
  "answer_regex",
  "answer_not_regex",
  "answer_order",
  "end_state",
  "results_unique",
  "any_of",
  "all_of",
  "not",
]);

function fail(where, message) {
  throw new Error(`${where}: ${message}`);
}

/** Every check of an assertion tree, for validation. */
function validateAssertion(assertion, where, names) {
  if (typeof assertion !== "object" || assertion === null) fail(where, "an assertion is an object");
  const keys = Object.keys(assertion).filter((key) => key !== "name" && key !== "note");
  if (keys.length !== 1 || !CHECKS.has(keys[0])) fail(where, `an assertion has exactly one check among ${[...CHECKS].join(", ")}; got ${keys.join(", ")}`);
  if (names) {
    if (typeof assertion.name !== "string" || assertion.name === "") fail(where, "a top-level assertion needs a name");
    if (names.has(assertion.name)) fail(where, `assertion name "${assertion.name}" is used twice`);
    names.add(assertion.name);
  }
  const check = keys[0];
  const spec = assertion[check];
  if (check === "any_of" || check === "all_of") {
    if (!Array.isArray(spec) || spec.length === 0) fail(where, `${check} takes a non-empty list`);
    spec.forEach((inner, index) => validateAssertion(inner, `${where}.${check}[${index}]`));
  } else if (check === "not") {
    validateAssertion(spec, `${where}.not`);
  } else if ((check === "answer_regex" || check === "answer_not_regex") && typeof spec?.pattern !== "string") {
    fail(where, `${check} needs a pattern`);
  }
}

export function validateCase(theCase, file = theCase?.id ?? "case") {
  const where = basename(file);
  if (typeof theCase.id !== "string" || !/^[PN]\d{1,2}b?$/.test(theCase.id)) fail(where, "id must look like P18 or N6");
  if (!SEVERITIES.includes(theCase.severity)) fail(where, `severity must be one of ${SEVERITIES.join(", ")}`);
  if (typeof theCase.title !== "string" || theCase.title === "") fail(where, "title is required");
  if (!Array.isArray(theCase.turns) || theCase.turns.length === 0) fail(where, "turns must be a non-empty list");
  theCase.turns.forEach((turn, index) => {
    if (typeof turn.user !== "string" || turn.user === "") fail(where, `turn ${index + 1} needs user text`);
    if (turn.when !== undefined && !WHEN.has(turn.when)) fail(where, `turn ${index + 1}: unknown when "${turn.when}"`);
    for (const hook of turn.before ?? []) if (!HOOKS.has(hook.hook)) fail(where, `turn ${index + 1}: unknown hook "${hook.hook}"`);
  });
  for (const hook of theCase.setup ?? []) if (!HOOKS.has(hook.hook)) fail(where, `unknown setup hook "${hook.hook}"`);
  if (theCase.session?.token !== undefined && !["write", "read"].includes(theCase.session.token)) fail(where, "session.token is write or read");
  if (!Array.isArray(theCase.assert) || theCase.assert.length === 0) fail(where, "at least one deterministic assertion is required");
  const names = new Set();
  theCase.assert.forEach((assertion, index) => validateAssertion(assertion, `${where}.assert[${index}]`, names));
  for (const rubric of theCase.judge ?? []) {
    if (typeof rubric.id !== "string" || typeof rubric.rubric !== "string") fail(where, "each judge rubric needs id and rubric");
  }
  return theCase;
}

/** Every case in eval/cases, validated, in id order (P before N, numerically). */
export function loadCases(dir = CASES_DIR) {
  const cases = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => validateCase(JSON.parse(readFileSync(join(dir, name), "utf8")), name));
  const ids = new Set();
  for (const theCase of cases) {
    if (ids.has(theCase.id)) throw new Error(`case id ${theCase.id} is used twice`);
    ids.add(theCase.id);
  }
  return cases.sort(caseOrder);
}

export function caseOrder(a, b) {
  const key = (id) => [id[0] === "P" ? 0 : 1, Number.parseInt(id.slice(1), 10), id.endsWith("b") ? 1 : 0];
  const [x, y] = [key(a.id), key(b.id)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function loadToolMap(nameOrPath = "1.0") {
  const path = nameOrPath.endsWith(".json") ? resolve(nameOrPath) : join(TOOL_MAP_DIR, `${nameOrPath}.json`);
  const map = JSON.parse(readFileSync(path, "utf8"));
  if (map.placeholder) throw new Error(`${basename(path)} is a placeholder; fill it in before scoring against it`);
  return { ...map, path };
}

/** The ids a `--cases` value names: "all", a subset from eval/subsets.json, or a comma list (ranges like N6-N12 allowed). */
export function selectCases(all, selection = "all") {
  const byId = new Map(all.map((theCase) => [theCase.id, theCase]));
  if (selection === "all") return all;
  const subsets = JSON.parse(readFileSync(SUBSETS_FILE, "utf8"));
  const wanted = new Set();
  const add = (token) => {
    if (token === "critical") {
      for (const theCase of all) if (theCase.severity === "critical") wanted.add(theCase.id);
      return;
    }
    if (subsets[token]) {
      subsets[token].cases.forEach(add);
      return;
    }
    const range = /^([PN])(\d+)-\1?(\d+)$/.exec(token);
    if (range) {
      for (let n = Number(range[2]); n <= Number(range[3]); n++) if (byId.has(`${range[1]}${n}`)) wanted.add(`${range[1]}${n}`);
      return;
    }
    if (!byId.has(token)) throw new Error(`No case or subset "${token}"`);
    wanted.add(token);
  };
  selection.split(",").map((token) => token.trim()).filter(Boolean).forEach(add);
  return all.filter((theCase) => wanted.has(theCase.id));
}

/** `{{name}}` from the world's calendar inside strings; `$path` references to the world's refs. */
export function resolveCase(value, refs) {
  if (typeof value === "string") {
    const templated = value.replace(/\{\{(\w+)\}\}/g, (whole, name) => refs.calendar?.[name] ?? whole);
    if (!templated.startsWith("$")) return templated;
    let node = refs;
    for (const part of templated.slice(1).split(".")) {
      node = node?.[part];
      if (node === undefined) throw new Error(`Unknown reference ${templated}`);
    }
    return node;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveCase(entry, refs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveCase(entry, refs)]));
  return value;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Content hashes of what a result depends on: the cases, the world and the tool map. */
export function inputHashes(cases, toolMap) {
  return {
    cases: sha256(JSON.stringify(cases)).slice(0, 16),
    world: sha256(readFileSync(WORLD_FILE, "utf8")).slice(0, 16),
    tool_map: sha256(readFileSync(toolMap.path, "utf8")).slice(0, 16),
  };
}
