# wazap — first-time setup audit (2026-10-09, main @ 0b3d900, v1.2.0)

## Verdict
A fresh clone + the documented install does **NOT** install or build semantic search.
Recall (embeddings) is **off by default** (`WAZAP_RECALL` unset/off, `.env.example` says off),
`wazap setup` never asks about it (it only asks about transcription; `provisionRecall` only acts
if recall was already switched on), and there is **no data to index** until a real WhatsApp
account is linked and history syncs. A new user gets keyword-only search
(`mode: "keyword_fallback"`) and nothing to search in, vs the maintainer's install with recall + local whisper and a full index.

## Reference install (maintainer's machine)
macOS, Homebrew llama.cpp 0.4.0 + whisper.cpp 1.8.4 + ffmpeg, both models downloaded, WAZAP_RECALL=local and WAZAP_TRANSCRIBE=local in <data-dir>/.env, running as the launchd service. A new user should reach the same search quality.

## What happened on a fresh Linux box (Ubuntu x86_64, 8 vCPU, no GPU)
| Step | Result |
| --- | --- |
| `git clone` + `npm ci` on system Node 20.19 | installs with `EBADENGINE` warning only; `wazap status` → `✗ node: 20.19.2 is too old`. Nothing installs a suitable Node. |
| Node 22.23.3 tarball, `npm ci && npm run build` | OK, ~9 s |
| `wazap status` | `recall: off`, `transcribe: off`, no account |
| `wazap config recall local` | OK, writes `<data-dir>/.env` |
| `wazap embed download` (non-TTY, no brew) | model downloaded + sha256 verified (318 MiB, ~5 s), **but silently skipped llama-server** — no warning; exit 0 |
| `wazap status` | `✗ llama-server not found — Build llama.cpp …` (docs only give `brew install`; no Linux path) |
| llama.cpp prebuilt `llama-b11516-bin-ubuntu-x64.tar.gz` (17 MB) | works (`LD_LIBRARY_PATH` to the extracted dir needed). Not mentioned anywhere in the repo. |
| Embedding speed, CPU-only box | ~0.9–1.0 s per message (60 msgs ≈ 55 s). Apple Silicon is much faster. |
| Search with no account | nothing: no CLI `search`, only the MCP tool, and no data |
| `node scripts/eval/server.mjs` (fixture world, **stub embedder**) | works: MCP `search` returns hybrid hits (e.g. "the address Ana sent" → "Vă aștept pe Lalelelor 7…"). Proves the pipeline but is dev-only, uses a fake embedder and fake sockets. |
| `npm test` | see bottom of this file |

## Missing pieces (concrete)
1. **Node version bootstrap.** Requires `^22.16 || >=24`; many machines (incl. Ubuntu/Debian system Node 20) fail. No `.nvmrc` / `.node-version` / `engines-strict`, no installer fallback.
2. **Recall is opt-in and invisible in setup.** `wazap setup` has no recall question/flag (`--recall local|off` missing); `.env.example` defaults it off.
3. **llama-server install is Homebrew-only.** `src/deps.ts` only offers `brew install llama.cpp`. No Linux path (prebuilt GitHub release download, apt, or build). Dockerfile (node:22-alpine) ships no llama.cpp → recall can never work in Docker.
4. **`wazap embed download` exits 0 with llama-server missing** and no warning when brew is unavailable / non-TTY. Should warn + print the platform-specific fix (and non-zero / clear status in `--json`).
5. **No pinned llama.cpp version for gemma embeddings.** `models.ts` comment says gemma needs llama.cpp b6800+, but nothing checks the installed build; old llama.cpp → needs e5 fallback, not detected automatically.
6. **whisper.cpp + ffmpeg for voice:** brew-only as well; no Linux path (whisper.cpp has no official Linux prebuilt → build with cmake, or skip/openai). Model 574 MB — too big for a 5-minute first run; should be optional.
7. **No demo / sample dataset for users.** `eval/fixtures/world.json` (fictional, ~60 messages, 2 accounts) exists but is only loadable through `scripts/eval/server.mjs`, which forces a **stub** embedder (`WAZAP_EMBED_URL` override) and fake sockets. No `wazap demo` / `--seed` path that ingests a small dataset into a throwaway data dir with the **real** model.
8. **No explicit index build / backfill / wait command.** Vectors are made only by the background feed of a running server; there is no `wazap embed index [--wait]` / progress, and no CLI to know "index ready" except MCP `get_status`.
9. **No CLI search.** Only the MCP `search` tool; a smoke test needs an MCP client. A `wazap search "<query>" [--json]` (read-only, opens the account DB, uses the sidecar) is missing.
10. **No one-command bootstrap script** (`scripts/setup.sh` / `npm run bootstrap`) that does node check → install → build → deps → model → seed → index → test query.
11. **Env vars needed for the full experience are undocumented in one place for a newcomer:** `WAZAP_DATA_DIR`, `WAZAP_RECALL=local`, `WAZAP_EMBED_BIN` (path to llama-server when not on PATH), `WAZAP_EMBED_MODEL`, `WAZAP_RECALL_MIN_SIMILARITY`, `WAZAP_PERSIST_HISTORY=1` (default on), `WAZAP_TRANSCRIBE` (+`WAZAP_TRANSCRIBE_API_KEY` for openai). No API keys are required for local recall.
12. **Optional, not needed for search:** tailscale/cloudflared (only `expose`), OAuth/tokens (only HTTP/hosted agents), webhook vars. Should be explicitly skipped by the bootstrap.
13. **Migrations:** no manual step needed — DB schema migrates on open (`src/db`), `migrateLayout` runs automatically. Fine as is.

## Spec: one-command setup (`scripts/bootstrap.sh`, also `npm run bootstrap`)
Goal: from `git clone` to a working **semantic** search on bundled sample data in ≤ 5 min on a
laptop (macOS arm64 / Linux x64 / Linux arm64), no WhatsApp account, no API keys, nothing
touching `~/.wazap` unless asked.

```
git clone https://github.com/razvangirgiz/wazap && cd wazap && ./scripts/bootstrap.sh
```

Flags: `--data-dir <dir>` (default `./.wazap-demo`), `--model embeddinggemma-300m|e5-base-multilingual`,
`--no-demo` (real install only), `--with-voice` (whisper+ffmpeg+model), `--yes`, `--offline-stub`
(CI: use the eval embed stub, no downloads).

Steps (each prints ✓/✗ and a fix; idempotent; re-run resumes):
1. **Node**: if `node` satisfies `^22.16 || >=24` use it; else download the official Node 22 LTS
   tarball for the platform into `./.tools/node` (sha256 from SHASUMS256.txt) and use it for the rest.
   Add `.nvmrc` (`22`) to the repo.
2. `npm ci && npm run build`.
3. **llama-server**: if on PATH or `WAZAP_EMBED_BIN` set → use it (check `--version` build ≥ 6800 for
   gemma, else pick e5). Else macOS+brew → `brew install llama.cpp`; else download the pinned
   llama.cpp release CPU build (`llama-<tag>-bin-ubuntu-x64.tar.gz` / `-ubuntu-arm64` /
   `-macos-arm64`), pin tag + sha256 in a table in `src/deps.ts` (or `scripts/llama-pin.json`),
   extract into `<data-dir>/bin/llama/`, write `WAZAP_EMBED_BIN=<abs path>` into `<data-dir>/.env`.
   Handle the shared libs (wrapper script setting `LD_LIBRARY_PATH`, or rpath).
4. `wazap config recall local` + `wazap embed download` (pinned sha256, resumable).
5. **Seed demo data**: new `wazap demo seed [--fixture eval/fixtures/world.json]` (or reuse
   `scripts/eval/fixture.mjs` without forcing the stub) that ingests the bundled fictional world
   through the real ingestion path into `<data-dir>` with fake sockets — never a real WhatsApp socket,
   refuses `~/.wazap`. Ship the fixture in the npm package (`files`) so `npx` users get it too.
6. **Build index**: new `wazap embed index [--wait] [--account <id>]` that runs the same embed feed
   to completion with a progress line, then exits 0 when `index: ready`.
7. **Test search**: new `wazap search "<query>" [--account] [--limit] [--json] [--match words|meaning]`
   (read-only). Bootstrap runs e.g. `wazap search "adresa trimisă de Ana"` and asserts a hit containing
   "Lalelelor" with `matched` including `meaning`; prints the result.
8. Print next steps: `wazap login` (real account), `wazap setup` (clients/skills), optional
   `--with-voice`, and how to delete the demo dir.

Code changes this needs:
- `src/deps.ts`: Linux/no-brew install path for llama.cpp (pinned prebuilt download), used by `ensureDeps`.
- `src/cli.ts runEmbed`: add `index` verb; `download` must warn (and `status --json` flag) when llama-server is still missing.
- `src/index.ts` usage + new `search` and `demo` commands.
- `src/setup.ts`: ask "Search by meaning (local, ~318 MB)?" + `--recall local|off` flag; call `provisionRecall` after it.
- Dockerfile: optional `WITH_RECALL=1` build arg that adds llama.cpp (debian-slim base, or the pinned prebuilt).
- Docs: `docs/recall.md` + README "Try it in 5 minutes" section; Linux instructions.
- Tests: bootstrap in CI with `--offline-stub` (no downloads); unit tests for the pin table, the
  missing-llama warning, `search` and `embed index` CLI.
- Keep all existing invariants (CLAUDE.md): nothing sends to WhatsApp, demo data dir never `~/.wazap`,
  sha256-verified downloads, no network beyond Node/llama.cpp/Hugging Face downloads.

Acceptance: on a clean Ubuntu 22.04 x64 container with only `git`, `curl`, `tar` and no Node,
`./scripts/bootstrap.sh --yes` finishes in ≤ 5 min (network permitting) and the final
`wazap search` returns the Lalelelor hit via meaning; `--offline-stub` variant passes in CI.

## `npm test` on fresh clone (Linux, Node 22.23.3)
2056 tests, 2050 pass, 0 fail, 5 skipped, 1 todo — ~96 s. Suite is healthy; the gaps above are setup/UX, not broken code.
