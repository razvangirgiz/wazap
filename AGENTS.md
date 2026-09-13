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

## The gate and the hook

`npm run check` covers what CI runs (`npm ci` then `typecheck` then `npm test`)
plus lint. The one CI step you cannot run in place is `npm ci`, because it
wipes `node_modules`; `check` assumes a working install and CI proves the
clean-install path.

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

## Commit style

`<Area>: <what changed>` as a sentence, from `git log`:
`Webhook: make message_sent and connection opt-in`, `Docs: the new webhook
events are opt-in`, `CI: test on every PR`. Releases are `Release X.Y.Z:`.
Small commits per logical step.

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
