# Contributor notes

wazap is the `wazap-mcp` npm package; the command it installs is `wazap`. This
file is for people changing the code. `AGENT.md` (singular) is a different
document — it ships in the package and drives a first-time setup for an agent's
user.

## Layout

- `src/*.ts` — all runtime code, ESM, TypeScript strict. `npm run build` emits
  `dist/`; `dist/` is gitignored and is what actually runs.
- `test/*.test.mjs` — plain JS tests on `node:test`. They import the **built**
  `dist/` and spawn `dist/index.js` against throwaway data dirs, so a source
  edit is not tested until `npm run build` runs. `npm test` builds first.
  `test/helpers.mjs` has the shared plumbing (`childEnv` scrubs `WAZAP_*` so a
  developer shell cannot leak into a child).
- `scripts/*.mjs` — repo utilities (bundle, icon, context build), also plain JS.
- `dist-bundle/`, `node_modules/` — generated, never edit, never lint.

## Commands

- `npm run build` — `tsc` to `dist/`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — builds, then runs the suite.
- `npm run lint` — ESLint flat config (`eslint.config.mjs`) over `src/`,
  `test/`, `scripts/`; Prettier-compatible via `eslint-config-prettier`.
- `npm run check` — the local gate: lint → typecheck → test (which builds).
  Green from a clean tree before you push.
- `npm run hooks:install` — installs the pre-push hook; once per clone.
- `npm run bench:db` — builds, then times the account database (`src/db/`) on
  synthetic data: 100k messages, vector and hybrid search at 13k and 100k.
  `--messages 1000000 --vectors 1000000` is the local 1M run; `--check` fails on
  generous budgets. Not part of the gate.
- `npm run fold:table` — regenerates `src/db/fold-table.ts` from the bundled
  SQLite when a test says the trigram index folds differently.
- `node scripts/import-legacy.mjs --data-dir <copy>` — after `npm run build`,
  imports one account's legacy files (`store.json`,
  `history/`, `retention.json`, `notes.json`, `recall/`, the beta
  `archive.sqlite`) into a separate account database beside the data dir and
  verifies it against the legacy service's view. Point it at a copy, never the
  live data dir. Prints counts and keys only, numbers masked. Not part of the gate.

## The gate and the hook

`npm run check` covers what CI runs on each Node (`npm ci`, then lint,
typecheck and `npm test`, on Node 22 and 24). The one CI step you cannot run in
place is `npm ci`, because it wipes `node_modules`; `check` assumes a working
install and CI proves the clean-install path. CI also runs
`npm audit --omit=dev --audit-level=high` as its own job, and a weekly
`Baileys canary` workflow runs typecheck and the suite against the newest
Baileys on npm; a red canary blocks nothing, it says the pin has a problem
coming.

A pre-push hook (`scripts/git-hooks/pre-push`) runs the fast part of the gate:
lint, typecheck, test. `npm run hooks:install` points `core.hooksPath` at that
directory — run it once per clone.

Skip it consciously when you must: `git push --no-verify` or
`SKIP_GATE=1 git push`. Skipping to move faster on a broken tree just moves the
red to CI.

Recall quality has its own check: `node scripts/recall-eval.mjs <cases.json>`
scores a fixed case set against the running daemon, so prompt, model and
floor changes are measured, not eyeballed. The real cases are private data
and are not committed; `scripts/recall-eval.example.json` shows the shape.

How well assistants use the tools has its own harness, `scripts/eval/`. An
evaluation server (`scripts/eval/server.mjs`) serves the real MCP endpoint over
a fictional two-account world (`eval/fixtures/world.json`) on fake sockets: it
refuses `~/.wazap` and the live ports, can never open WhatsApp, and records a
trace of every tool call and every write that would have reached WhatsApp. The
cases (`eval/cases/*.json`) assert on capabilities, which `eval/tool-map/`
maps to tool names per version.

- `node scripts/eval/run-claude.mjs --cases baseline-0.23 --model sonnet` runs
  headless Claude Code, isolated to the evaluation server, and scores the run.
  Transcripts go to `~/.wazap-eval/runs/`; `--save
  eval/results/<version>/<date>-<model>-<mode>.summary.json` keeps the summary.
  Costs real subscription usage: `--max-budget-usd` per attempt, `--stop-at-usd`
  for the run. Never Fable.
- `node scripts/eval/score.mjs <run-dir> [--compare <summary.json>] [--judge]`
  rescores a run; the LLM judge is off by default and informative only.
- `eval/chatgpt-protocol.md` with `scripts/eval/manual.mjs` is the manual
  ChatGPT arm.

`test/eval-harness.test.mjs` keeps the harness in the gate without a model: a
scripted oracle passes representative cases and an agent that does nothing
fails them. The sandbox socket it shares with the server is `test/sandbox.mjs`.

## Commit style

`<Area>: <what changed>` as a sentence, from `git log`:
`Webhook: make message_sent and connection opt-in`, `Docs: the new webhook
events are opt-in`, `CI: test on every PR`. Releases are `Release X.Y.Z:`.
Small commits per logical step.

## Releases

A release is one commit and one tag; CI does the publishing.

1. Bump the version in `package.json`, `package-lock.json` (both root
   entries), `server.json` (top level and the npm package), `manifest.json`,
   `gemini-extension.json` and `.claude-plugin/plugin.json`.
   `test/distribution.test.mjs` fails when `server.json`, `manifest.json` or
   `gemini-extension.json` drift from `package.json`.
2. Add a `## X.Y.Z` section at the top of `CHANGELOG.md`. It becomes the
   GitHub Release notes, and publishing refuses a version without one.
3. Commit as `Release X.Y.Z: <what is in it>`, tag `vX.Y.Z`, push the commit
   and the tag.

The tag runs `.github/workflows/publish.yml`. The `publish` job checks the tag
against `package.json` and the CHANGELOG section, lints, typechecks, runs
`npm publish --provenance` (whose `prepublishOnly` builds and tests), waits
for the version on npm and publishes `server.json` to the MCP Registry through
GitHub OIDC. The `release` job then builds `wazap-X.Y.Z.mcpb` and creates the
GitHub Release with it attached. Run by hand, the workflow refuses anything
but a tag.

When a step fails after `npm publish`, do not re-run the whole workflow: npm
refuses the same version twice. `scripts/release-registry.sh` is the manual
fallback for the registry step. A failed `release` job alone can be re-run
from the Actions page, since that re-runs only the failed job.

## Rules that must never break

- **stdout is the MCP protocol.** In `serve` over stdio, every byte on stdout
  is protocol. Human-readable lines go to stderr (see `src/logger.ts`). A
  stray `console.log` corrupts sessions silently.
- **One process owns a data dir.** `server.lock` in the data dir enforces it;
  two servers on one dir must refuse to start, never share.
- **No secrets, ever.** `.env`, `accounts.json`, tokens and pairing codes stay
  out of the tree. `.env.example` is the reference for every `WAZAP_*` knob —
  a new setting is documented there, not invented elsewhere.
- **Secrets in errors are redacted.** The webhook secret and tokens never
  appear in error strings or logs; keep it that way.
- **Hygiene is not behavior.** Lint, format and docs commits must not change
  what the binary does.

## Lint ignores, and why

- `dist/`, `dist-bundle/`, `node_modules/` — generated output.
- `*.test.mjs` and `scripts/*.mjs` are linted as plain JS: they intentionally
  do not go through the TypeScript rules, since `tsc` does not check them.
