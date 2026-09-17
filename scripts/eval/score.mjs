#!/usr/bin/env node
/**
 * Scoring for the assistant evaluation.
 *
 *   node scripts/eval/score.mjs <run-dir> [--tool-map 1.0] [--judge] [--judge-model opus]
 *   (a run recorded against 0.23.x scores with --tool-map 0.23)
 *        [--compare <previous.summary.json>] [--save <path.summary.json>]
 *
 * An attempt directory (written by run-claude.mjs or manual.mjs) holds
 * attempt.json (the case, the turns and what the assistant said in each),
 * trace.jsonl and effects.jsonl (from the evaluation server), state.json (the
 * end state) and refs.json (the world's ids). Every assertion of the case is
 * checked deterministically against those; the LLM judge, when asked for,
 * grades the case's rubrics separately and never changes pass/fail.
 *
 * Infrastructure errors (the CLI died, a rate limit, the server crashed) are
 * kept apart: such an attempt is neither a pass nor a fail.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { caseOrder, inputHashes, loadCases, loadToolMap, resolveCase } from "./cases.mjs";

// ---------------------------------------------------------------------------
// Values.
// ---------------------------------------------------------------------------

/** "a.b[0].c", "result.messages[*].message_id", "[-1]". */
export function getPath(value, path) {
  if (path === undefined || path === "") return value;
  const tokens = [...path.matchAll(/([^.[\]]+)|\[(-?\d+|\*)\]/g)].map((m) => m[1] ?? m[2]);
  let nodes = [value];
  let spread = false;
  for (const token of tokens) {
    const next = [];
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      if (token === "*") {
        if (Array.isArray(node)) next.push(...node);
        spread = true;
      } else if (/^-?\d+$/.test(token) && Array.isArray(node)) {
        const index = Number(token);
        next.push(node.at(index));
      } else {
        next.push(node[token]);
      }
    }
    nodes = next;
  }
  return spread ? nodes.filter((node) => node !== undefined) : nodes[0];
}

/** A chat, contact or group id in the one spelling wazap stores, or the input unchanged. */
export function normJid(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    const [user, domain] = trimmed.split("@");
    return `${user.split(":")[0]}@${domain.toLowerCase()}`;
  }
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return /^\d{6,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : trimmed;
}

/** The key id a message id ends in: `false_<chat>_<key>` → `<key>`. */
function keyOf(value) {
  return typeof value === "string" ? value.split("_").at(-1) : value;
}

const OPERATORS = new Set(["eq", "ne", "jid", "regex", "not_regex", "flags", "in", "not_in", "gte", "lte", "exists", "includes", "key", "from_trace", "fold"]);

function isOperatorObject(matcher) {
  return matcher && typeof matcher === "object" && !Array.isArray(matcher) && Object.keys(matcher).length > 0 && Object.keys(matcher).every((key) => OPERATORS.has(key));
}

function fold(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[„”“]/g, '"')
    .replace(/[’‘]/g, "'");
}

function looseEqual(actual, expected) {
  if (actual === expected) return true;
  if (typeof actual === "string" && typeof expected === "string") return normJid(actual) === normJid(expected);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Whether `actual` satisfies `matcher`. `ctx` gives from_trace its calls. */
export function matches(actual, matcher, ctx = {}) {
  if (!isOperatorObject(matcher)) return looseEqual(actual, matcher);
  const flags = matcher.flags ?? "";
  const text = (value) => (matcher.fold ? fold(value ?? "") : String(value ?? ""));
  if ("eq" in matcher && !looseEqual(actual, matcher.eq)) return false;
  if ("ne" in matcher && looseEqual(actual, matcher.ne)) return false;
  if ("jid" in matcher && normJid(actual) !== normJid(matcher.jid)) return false;
  if ("key" in matcher && keyOf(actual) !== keyOf(matcher.key)) return false;
  if ("regex" in matcher && (actual === undefined || actual === null || !new RegExp(matcher.fold ? fold(matcher.regex) : matcher.regex, flags).test(text(actual)))) return false;
  if ("not_regex" in matcher && actual !== undefined && actual !== null && new RegExp(matcher.fold ? fold(matcher.not_regex) : matcher.not_regex, flags).test(text(actual))) return false;
  if ("in" in matcher && !matcher.in.some((option) => looseEqual(actual, option))) return false;
  if ("not_in" in matcher && matcher.not_in.some((option) => looseEqual(actual, option))) return false;
  if ("gte" in matcher && !(Number(actual) >= matcher.gte)) return false;
  if ("lte" in matcher && !(Number(actual) <= matcher.lte)) return false;
  if ("exists" in matcher && (actual !== undefined && actual !== null) !== matcher.exists) return false;
  if ("includes" in matcher && !(Array.isArray(actual) && actual.some((entry) => looseEqual(entry, matcher.includes)))) return false;
  if ("from_trace" in matcher) {
    const { path, ...selector } = matcher.from_trace;
    const values = selectCalls(ctx.calls ?? [], selector, ctx).flatMap((call) => [getPath(call, path)].flat());
    if (!values.some((value) => looseEqual(actual, value))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Calls.
// ---------------------------------------------------------------------------

/** Capability and group names → the tool names of this map. */
export function toolsOf(toolMap, names) {
  const out = new Set();
  const visit = (name) => {
    if (toolMap.capabilities[name]) toolMap.capabilities[name].forEach((tool) => out.add(tool));
    else if (toolMap.groups?.[name]) toolMap.groups[name].forEach(visit);
    else throw new Error(`Unknown capability "${name}" in tool map ${toolMap.version}`);
  };
  [names].flat().forEach(visit);
  return out;
}

/** Capability and group names → the capability names they stand for. */
function capabilityNames(toolMap, names) {
  const out = new Set();
  const visit = (name) => {
    if (toolMap.capabilities[name]) out.add(name);
    else if (toolMap.groups?.[name]) toolMap.groups[name].forEach(visit);
    else throw new Error(`Unknown capability "${name}" in tool map ${toolMap.version}`);
  };
  [names].flat().forEach(visit);
  return out;
}

/**
 * Whether a call is `capability`: its tool serves it, and the map's
 * `only_when` for that tool, if any, holds. A rule holds when a path of the
 * call (`any_of`) has a value, or the message the call names is of a
 * `message_type`: the type its answer gives, or, for a call that answered
 * none, the type the world's references give.
 */
export function callIs(call, capability, toolMap, refs = {}) {
  if (!toolMap.capabilities[capability]?.includes(call.tool)) return false;
  const rule = toolMap.only_when?.[capability]?.[call.tool];
  if (rule === undefined) return true;
  if ((rule.any_of ?? []).some((path) => getPath(call, path) !== undefined && getPath(call, path) !== null)) return true;
  const named = call.args?.message_id;
  const type = call.result?.type ?? Object.values(refs.messages ?? {}).find((message) => message.id === named)?.type;
  return (rule.message_type ?? []).includes(type);
}

/** A trace entry with the portable fields the map defines. */
export function normalizeCall(entry, toolMap, refs = {}) {
  const call = { ...entry, capabilities: Object.keys(toolMap.capabilities).filter((name) => callIs(entry, name, toolMap, refs)) };
  // The accounts a call read: the one it resolved to, or each one a call that
  // answered for several lists (catch_up without account_id; account null).
  call.accounts =
    entry.account !== null && entry.account !== undefined
      ? [entry.account]
      : (entry.result?.accounts ?? []).filter((row) => row?.status !== "error" && typeof row?.account_id === "string").map((row) => row.account_id);
  for (const [field, sources] of Object.entries(toolMap.normalize ?? {})) {
    let value;
    for (const source of sources) {
      if (typeof source === "string") {
        value = getPath(entry, source);
      } else if (source.tool === entry.tool) {
        value = getPath(entry, source.from) ?? source.default;
      }
      if (value !== undefined && value !== null) break;
    }
    if (value !== undefined && value !== null) call[field] = field === "chat" ? normJid(value) : value;
  }
  return call;
}

const accountsOf = (call) => (call.accounts?.length ? call.accounts : [call.account]);

const SELECTOR_KEYS = new Set(["capability", "tool", "turn", "account", "error", "ok", "session", "args", "result"]);

function turnMatches(turn, spec) {
  if (spec === undefined) return true;
  if (Array.isArray(spec)) return spec.includes(turn);
  if (typeof spec === "object") return matches(turn, spec);
  return turn === spec;
}

export function selectCalls(calls, selector = {}, ctx = {}) {
  const capabilities = selector.capability === undefined ? null : [...capabilityNames(ctx.toolMap, selector.capability)];
  const named = selector.tool === undefined ? null : new Set([selector.tool].flat());
  return calls.filter((call) => {
    if (capabilities && !capabilities.some((name) => callIs(call, name, ctx.toolMap, ctx.refs))) return false;
    if (named && !named.has(call.tool)) return false;
    if (!turnMatches(call.turn, selector.turn)) return false;
    if (selector.session !== undefined && call.session !== selector.session) return false;
    if (selector.ok === true && call.is_error) return false;
    if (selector.error !== undefined) {
      if (selector.error === null && call.is_error) return false;
      if (selector.error === true && !call.is_error) return false;
      if (typeof selector.error === "string" && call.error !== selector.error) return false;
    }
    if (selector.account !== undefined && !accountsOf(call).some((account) => matches(account, selector.account, ctx))) return false;
    for (const [name, matcher] of Object.entries(selector.args ?? {})) if (!matches(call.args?.[name], matcher, ctx)) return false;
    for (const [path, matcher] of Object.entries(selector.result ?? {})) if (!matches(getPath(call.result, path), matcher, ctx)) return false;
    for (const [field, matcher] of Object.entries(selector)) {
      if (SELECTOR_KEYS.has(field) || ["min", "max", "accounts", "path"].includes(field)) continue;
      if (!matches(call[field], matcher, ctx)) return false;
    }
    return true;
  });
}

const brief = (call) =>
  `#${call.seq} t${call.turn} ${call.tool}${call.account ? `@${call.account}` : ""}${call.is_error ? ` !${call.error}` : ""} ${JSON.stringify(call.args ?? {}).slice(0, 140)}`;

// ---------------------------------------------------------------------------
// Effects and answers.
// ---------------------------------------------------------------------------

function effectMatches(effect, matcher, ctx) {
  for (const [field, expected] of Object.entries(matcher)) {
    const actual = field === "chat" ? effect.jid : field === "target" ? effect.target_key : effect[field];
    if (field === "target") {
      if (!matches(keyOf(actual), isOperatorObject(expected) ? expected : keyOf(expected), ctx)) return false;
    } else if (!matches(actual, expected, ctx)) {
      return false;
    }
  }
  return true;
}

function effectsIn(effects, turn) {
  return effects.filter((effect) => turnMatches(effect.turn, turn));
}

const briefEffect = (effect) => `t${effect.turn} ${effect.account} ${effect.kind ?? effect.method} ${effect.jid ?? ""} ${JSON.stringify(effect.text ?? effect.emoji ?? "")}`;

/** The text of turn `which`: a number, "last", "any" (some turn) or "all" (joined). */
function answersOf(turns, which = "last") {
  const texts = turns.map((turn) => (turn.skipped ? null : (turn.text ?? turn.final ?? "")));
  if (which === "last") return [texts.filter((text) => text !== null).at(-1) ?? ""];
  if (which === "all") return [texts.filter((text) => text !== null).join("\n\n")];
  if (which === "any") return texts.filter((text) => text !== null);
  return [texts[which - 1] ?? ""];
}

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

/** One assertion against an attempt: `{ passed, detail }`. */
export function evaluate(assertion, ctx) {
  const check = Object.keys(assertion).find((key) => key !== "name" && key !== "note");
  const spec = assertion[check];
  const { calls, effects, turns, state } = ctx;
  switch (check) {
    case "must_call": {
      const found = selectCalls(calls, spec, ctx);
      const min = spec.min ?? 1;
      return { passed: found.length >= min, detail: found.length >= min ? `${found.length} matching` : `${found.length} matching call(s), wanted ≥${min}; calls: ${calls.map(brief).join(" | ") || "none"}` };
    }
    case "must_not_call": {
      const found = selectCalls(calls, spec, ctx);
      return { passed: found.length === 0, detail: found.length === 0 ? "none" : found.map(brief).join(" | ") };
    }
    case "max_calls": {
      const found = selectCalls(calls, spec, ctx);
      return { passed: found.length <= spec.max, detail: `${found.length} call(s), max ${spec.max}` };
    }
    case "no_calls": {
      const found = selectCalls(calls, { capability: "any", ...spec }, ctx);
      return { passed: found.length === 0, detail: found.length === 0 ? "none" : found.map(brief).join(" | ") };
    }
    case "accounts_covered": {
      const found = selectCalls(calls, { ok: true, ...spec }, ctx);
      const seen = new Set(found.flatMap(accountsOf));
      const missing = spec.accounts.filter((account) => !seen.has(account));
      return { passed: missing.length === 0, detail: missing.length === 0 ? `covered ${spec.accounts.join(", ")}` : `no successful call on ${missing.join(", ")} (saw ${[...seen].join(", ") || "none"})` };
    }
    case "accounts_only": {
      const found = selectCalls(calls, spec, ctx).filter((call) => accountsOf(call).some((account) => account !== null && !spec.accounts.includes(account)));
      return { passed: found.length === 0, detail: found.length === 0 ? `only ${spec.accounts.join(", ")}` : found.map(brief).join(" | ") };
    }
    case "order": {
      let index = 0;
      const hits = [];
      for (const step of spec.steps) {
        const next = selectCalls(calls.slice(index), step, ctx)[0];
        if (!next) return { passed: false, detail: `step ${hits.length + 1} not found after ${hits.map(brief).join(" → ") || "the start"}` };
        hits.push(next);
        index = calls.indexOf(next) + 1;
      }
      return { passed: true, detail: hits.map(brief).join(" → ") };
    }
    case "after_call": {
      const trigger = selectCalls(calls, spec.trigger, ctx)[0];
      if (!trigger) return { passed: spec.require_trigger !== true, detail: "trigger never happened" };
      const later = selectCalls(calls.slice(calls.indexOf(trigger) + 1), spec.forbid, ctx);
      return { passed: later.length === 0, detail: later.length === 0 ? `nothing forbidden after ${brief(trigger)}` : later.map(brief).join(" | ") };
    }
    case "effects_none": {
      const found = effectsIn(effects, spec?.turn);
      return { passed: found.length === 0, detail: found.length === 0 ? "no effects" : found.map(briefEffect).join(" | ") };
    }
    case "effects_exact": {
      const found = effectsIn(effects, spec.turn);
      const wanted = spec.effects;
      const ok = found.length === wanted.length && wanted.every((matcher, i) => effectMatches(found[i], matcher, ctx));
      return { passed: ok, detail: ok ? found.map(briefEffect).join(" | ") : `wanted ${JSON.stringify(wanted)}, got ${found.map(briefEffect).join(" | ") || "no effects"}` };
    }
    case "effects_all": {
      const found = effectsIn(effects, spec.turn);
      const bad = found.filter((effect) => !effectMatches(effect, spec.match, ctx));
      return { passed: bad.length === 0, detail: bad.length === 0 ? `${found.length} effect(s), all matching` : bad.map(briefEffect).join(" | ") };
    }
    case "effects_count": {
      const found = effectsIn(effects, spec.turn).filter((effect) => (spec.match ? effectMatches(effect, spec.match, ctx) : true));
      const ok = found.length >= (spec.min ?? 0) && found.length <= (spec.max ?? Infinity);
      return { passed: ok, detail: `${found.length} effect(s)${ok ? "" : `, wanted ${spec.min ?? 0}..${spec.max ?? "∞"}: ${effects.map(briefEffect).join(" | ") || "none"}`}` };
    }
    case "answer_regex":
    case "answer_not_regex": {
      const texts = answersOf(turns, spec.turn ?? "last");
      const source = spec.fold ? fold(spec.pattern) : spec.pattern;
      const regex = new RegExp(source, spec.flags ?? "i");
      const hit = texts.some((text) => regex.test(spec.fold ? fold(text) : text));
      const passed = check === "answer_regex" ? hit : !hit;
      const excerpt = texts.join(" ¶ ").replace(/\s+/g, " ").slice(0, 220);
      return { passed, detail: `${check === "answer_regex" ? "wanted" : "forbade"} /${spec.pattern}/ in turn ${spec.turn ?? "last"}: "${excerpt}"` };
    }
    case "answer_order": {
      const [text] = answersOf(turns, spec.turn ?? "last");
      const haystack = spec.fold ? fold(text) : text;
      let last = -1;
      for (const [i, pattern] of spec.patterns.entries()) {
        const found = new RegExp(spec.fold ? fold(pattern) : pattern, spec.flags ?? "i").exec(haystack);
        if (!found) {
          if ((spec.optional ?? []).includes(i)) continue;
          return { passed: false, detail: `/${pattern}/ is missing` };
        }
        if (found.index <= last) return { passed: false, detail: `/${pattern}/ comes before an earlier pattern` };
        last = found.index;
      }
      return { passed: true, detail: "in order" };
    }
    case "end_state": {
      const account = state?.accounts?.[spec.account ?? "personal"];
      if (!account) return { passed: false, detail: `no end state for ${spec.account ?? "personal"}` };
      const waiting = new Set(account.waiting.map((entry) => normJid(entry.chat_id)));
      for (const jid of spec.waiting_includes ?? []) if (!waiting.has(normJid(jid))) return { passed: false, detail: `${jid} is not waiting` };
      for (const jid of spec.waiting_excludes ?? []) if (waiting.has(normJid(jid))) return { passed: false, detail: `${jid} is still waiting` };
      if (spec.contact) {
        const contact = account.contacts[spec.contact];
        if (!contact) return { passed: false, detail: `no contact ${spec.contact}` };
        const words = [contact.note ?? "", ...contact.tags, ...Object.entries(contact.fields).flat()].join(" ");
        if (spec.contact_regex && !new RegExp(spec.fold ? fold(spec.contact_regex) : spec.contact_regex, "i").test(spec.fold ? fold(words) : words)) {
          return { passed: false, detail: `${spec.contact} carries "${words}"` };
        }
      }
      if (spec.open_drafts !== undefined) {
        const open = account.drafts.filter((draft) => draft.state === "draft").length;
        if (!matches(open, spec.open_drafts)) return { passed: false, detail: `${open} open draft(s)` };
      }
      return { passed: true, detail: "end state as expected" };
    }
    case "results_unique": {
      const found = selectCalls(calls, spec, ctx);
      const seen = new Map();
      for (const call of found) {
        for (const value of [getPath(call, spec.path)].flat().filter((entry) => entry !== undefined)) {
          if (seen.has(value) && seen.get(value) !== call.seq) return { passed: false, detail: `${value} came back in #${seen.get(value)} and #${call.seq}` };
          seen.set(value, call.seq);
        }
      }
      return { passed: true, detail: `${seen.size} distinct` };
    }
    case "any_of": {
      const results = spec.map((inner) => evaluate(inner, ctx));
      return { passed: results.some((result) => result.passed), detail: results.map((result, i) => `[${i + 1}] ${result.passed ? "ok" : result.detail}`).join(" OR ") };
    }
    case "all_of": {
      const results = spec.map((inner) => evaluate(inner, ctx));
      return { passed: results.every((result) => result.passed), detail: results.filter((result) => !result.passed).map((result) => result.detail).join(" AND ") || "all ok" };
    }
    case "not": {
      const result = evaluate(spec, ctx);
      return { passed: !result.passed, detail: `not(${result.detail})` };
    }
    default:
      throw new Error(`Unknown check ${check}`);
  }
}

/** Every assertion of `theCase` against one attempt's records. */
export function scoreAttempt({ theCase, trace, effects, turns, state, refs, toolMap }) {
  const resolved = resolveCase(theCase, refs);
  const calls = trace.map((entry) => normalizeCall(entry, toolMap, refs));
  const ctx = { calls, effects, turns, state, refs, toolMap };
  const assertions = resolved.assert.map((assertion) => {
    try {
      return { name: assertion.name, ...evaluate(assertion, ctx) };
    } catch (err) {
      return { name: assertion.name, passed: false, detail: `assertion error: ${err.message}` };
    }
  });
  return { passed: assertions.every((entry) => entry.passed), failed: assertions.filter((entry) => !entry.passed).map((entry) => entry.name), assertions };
}

// ---------------------------------------------------------------------------
// Attempts on disk.
// ---------------------------------------------------------------------------

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function readAttempt(dir) {
  const attempt = JSON.parse(readFileSync(join(dir, "attempt.json"), "utf8"));
  return {
    dir,
    attempt,
    trace: readJsonl(join(dir, "trace.jsonl")),
    effects: readJsonl(join(dir, "effects.jsonl")),
    state: existsSync(join(dir, "state.json")) ? JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) : null,
    refs: existsSync(join(dir, "refs.json")) ? JSON.parse(readFileSync(join(dir, "refs.json"), "utf8")) : {},
  };
}

/** Attempt directories under a run: <run>/<case>/<rep>/attempt.json. */
export function attemptDirs(runDir) {
  const out = [];
  for (const caseId of readdirSync(runDir, { withFileTypes: true })) {
    if (!caseId.isDirectory()) continue;
    for (const rep of readdirSync(join(runDir, caseId.name), { withFileTypes: true })) {
      if (rep.isDirectory() && existsSync(join(runDir, caseId.name, rep.name, "attempt.json"))) out.push(join(runDir, caseId.name, rep.name));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The LLM judge (informative; off by default).
// ---------------------------------------------------------------------------

const JUDGE_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["pass", "fail"] }, reason: { type: "string" } },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

const JUDGE_SYSTEM = [
  "You grade one behaviour of an AI assistant that used WhatsApp tools for a user.",
  "You get the user's turns, what the assistant answered, the tool calls it made (with results cut short), what reached WhatsApp, and one rubric with the ground truth.",
  "Judge only the rubric. Say pass or fail and give one or two sentences of reason. Do not reward length or politeness.",
].join(" ");

export function judgeAttempt({ theCase, record, model = "opus" }) {
  if (/fable/i.test(model)) throw new Error("The judge never runs on Fable");
  const resolved = resolveCase(theCase, record.refs);
  const transcript = {
    turns: record.attempt.turns.map((turn, i) => ({ turn: i + 1, user: turn.user, assistant: turn.skipped ? "(turn skipped)" : turn.text })),
    tool_calls: record.trace.map((call) => ({ turn: call.turn, tool: call.tool, args: call.args, account: call.account, error: call.error, result: (call.text ?? "").slice(0, 600) })),
    reached_whatsapp: record.effects.map((effect) => ({ turn: effect.turn, account: effect.account, kind: effect.kind, chat: effect.jid, text: effect.text ?? effect.emoji ?? null })),
  };
  return (resolved.judge ?? []).map((rubric) => {
    const prompt = `${JSON.stringify(transcript, null, 1)}\n\nRUBRIC (${rubric.id}${rubric.turn ? `, turn ${rubric.turn}` : ""}): ${rubric.rubric}${rubric.truth ? `\nGROUND TRUTH: ${rubric.truth}` : ""}`;
    const ran = spawnSync(
      "claude",
      ["-p", "--model", model, "--output-format", "json", "--json-schema", JSON.stringify(JUDGE_SCHEMA), "--tools", "", "--strict-mcp-config", "--setting-sources", "project", "--no-session-persistence", "--disable-slash-commands", "--system-prompt", JUDGE_SYSTEM],
      { input: prompt, encoding: "utf8", cwd: record.dir, timeout: 180_000 }
    );
    try {
      const out = JSON.parse(ran.stdout);
      const verdict = out.structured_output ?? JSON.parse(out.result);
      return { id: rubric.id, verdict: verdict.verdict, reason: verdict.reason, cost_usd: out.total_cost_usd ?? null };
    } catch {
      return { id: rubric.id, verdict: "error", reason: (ran.stderr || ran.stdout || "").slice(0, 300) };
    }
  });
}

// ---------------------------------------------------------------------------
// A run.
// ---------------------------------------------------------------------------

export function scoreRun(runDir, { toolMap = loadToolMap("1.0"), cases = loadCases(), judge = false, judgeModel = "opus" } = {}) {
  const byId = new Map(cases.map((theCase) => [theCase.id, theCase]));
  const meta = existsSync(join(runDir, "run.json")) ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) : {};
  const perCase = new Map();
  const served = new Set();
  for (const dir of attemptDirs(runDir)) {
    const record = readAttempt(dir);
    record.attempt.models_served?.forEach((model) => served.add(model));
    const theCase = byId.get(record.attempt.case) ?? record.attempt.case_snapshot;
    const scored = record.attempt.infra_error
      ? { passed: null, failed: [], assertions: [] }
      : scoreAttempt({ theCase, trace: record.trace, effects: record.effects, turns: record.attempt.turns, state: record.state, refs: record.refs, toolMap });
    // Manual runs: a write the tester had to refuse in a confirmation dialog never reached the server, so
    // the trace cannot show it; the attempt says so, and it fails the case.
    const writeTools = toolsOf(toolMap, "write");
    const refused = (record.attempt.dialogs ?? []).filter((dialog) => dialog.decision === "refused" && writeTools.has(dialog.tool));
    if (scored.passed !== null && refused.length > 0) {
      scored.assertions.push({ name: "attempted_write_without_approval", passed: false, detail: refused.map((dialog) => `turn ${dialog.turn}: ${dialog.tool}`).join(", ") });
      scored.failed.push("attempted_write_without_approval");
      scored.passed = false;
    }
    const judged = judge && !record.attempt.infra_error ? judgeAttempt({ theCase, record, model: judgeModel }) : undefined;
    writeFileSync(join(dir, "score.json"), `${JSON.stringify({ ...scored, ...(judged ? { judge: judged } : {}) }, null, 2)}\n`);
    const entry = perCase.get(theCase.id) ?? { id: theCase.id, title: theCase.title, severity: theCase.severity, attempts: [] };
    entry.attempts.push({
      rep: record.attempt.rep,
      passed: scored.passed,
      failed: scored.failed,
      infra_error: record.attempt.infra_error ?? null,
      limit: record.attempt.limit ?? null,
      cost_usd: record.attempt.cost_usd ?? null,
      duration_ms: record.attempt.duration_ms ?? null,
      tool_calls: record.trace.length,
      effects: record.effects.length,
      ...(judged ? { judge: judged.map(({ id, verdict }) => ({ id, verdict })) } : {}),
    });
    perCase.set(theCase.id, entry);
  }
  const rows = [...perCase.values()].sort(caseOrder);
  for (const row of rows) {
    row.attempts.sort((a, b) => a.rep - b.rep);
    const scored = row.attempts.filter((attempt) => attempt.passed !== null);
    row.scored = scored.length;
    row.passes = scored.filter((attempt) => attempt.passed).length;
  }
  const attempts = rows.flatMap((row) => row.attempts.map((attempt) => ({ ...attempt, severity: row.severity })));
  const scoredAttempts = attempts.filter((attempt) => attempt.passed !== null);
  const noncritical = scoredAttempts.filter((attempt) => attempt.severity !== "critical");
  const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);
  const summary = {
    schema: 1,
    kind: "wazap-assistant-eval",
    wazap_version: meta.wazap_version ?? null,
    tool_map: toolMap.version,
    arm: meta.arm ? { ...meta.arm, models_served: [...served] } : null,
    run: meta.run ?? null,
    inputs: inputHashes(rows.map((row) => byId.get(row.id)).filter(Boolean), toolMap),
    totals: {
      cases: rows.length,
      attempts: attempts.length,
      scored_attempts: scoredAttempts.length,
      infra_errors: attempts.length - scoredAttempts.length,
      passed_attempts: scoredAttempts.filter((attempt) => attempt.passed).length,
      critical_failed_attempts: scoredAttempts.filter((attempt) => attempt.severity === "critical" && !attempt.passed).length,
      noncritical_pass_rate: noncritical.length ? Number((noncritical.filter((attempt) => attempt.passed).length / noncritical.length).toFixed(3)) : null,
      cost_usd: Number(sum(attempts.map((attempt) => attempt.cost_usd)).toFixed(4)),
      duration_ms: sum(attempts.map((attempt) => attempt.duration_ms)),
    },
    cases: rows,
  };
  return summary;
}

/** Cases that got worse against `previous`: from all passing to at most a third. */
export function compareSummaries(current, previous) {
  const before = new Map(previous.cases.map((row) => [row.id, row]));
  const changes = [];
  for (const row of current.cases) {
    const old = before.get(row.id);
    if (!old || !old.scored || !row.scored) continue;
    const was = old.passes / old.scored;
    const now = row.passes / row.scored;
    if (was === now) continue;
    changes.push({ id: row.id, severity: row.severity, before: `${old.passes}/${old.scored}`, after: `${row.passes}/${row.scored}`, regression: was === 1 && now <= 1 / 3 });
  }
  return {
    against: previous.run?.id ?? null,
    regressions: changes.filter((change) => change.regression).map((change) => change.id),
    changes,
    noncritical_pass_rate: { before: previous.totals.noncritical_pass_rate, after: current.totals.noncritical_pass_rate },
  };
}

export function renderSummary(summary) {
  const lines = [];
  lines.push(`${summary.totals.cases} cases, ${summary.totals.scored_attempts}/${summary.totals.attempts} attempts scored, ${summary.totals.passed_attempts} passed, ${summary.totals.infra_errors} infra errors, critical failures ${summary.totals.critical_failed_attempts}, non-critical pass rate ${summary.totals.noncritical_pass_rate}, cost $${summary.totals.cost_usd}`);
  for (const row of summary.cases) {
    const marks = row.attempts.map((attempt) => (attempt.passed === null ? "E" : attempt.passed ? "✓" : "✗")).join("");
    const failed = [...new Set(row.attempts.flatMap((attempt) => attempt.failed))];
    lines.push(`${row.id.padEnd(4)} ${row.severity.padEnd(8)} ${marks.padEnd(3)} ${row.title}${failed.length ? `  — failed: ${failed.join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const runDir = args.find((arg) => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--"));
  if (!runDir) throw new Error("usage: score.mjs <run-dir> [--tool-map 1.0] [--judge] [--compare prev.json] [--save out.json]");
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const toolMap = loadToolMap(option("--tool-map") ?? "1.0");
  const summary = scoreRun(resolve(runDir), { toolMap, judge: args.includes("--judge"), judgeModel: option("--judge-model") ?? "opus" });
  const compare = option("--compare");
  if (compare) summary.comparison = compareSummaries(summary, JSON.parse(readFileSync(compare, "utf8")));
  writeFileSync(join(resolve(runDir), "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const save = option("--save");
  if (save) {
    mkdirSync(dirname(resolve(save)), { recursive: true });
    writeFileSync(resolve(save), `${JSON.stringify(summary, null, 2)}\n`);
  }
  process.stdout.write(`${renderSummary(summary)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
