# Semantic recall

With recall on, `search` matches what was meant and the words at once: a
paraphrase still hits through its meaning, a short question through its words,
and the two rankings are fused. With the default model a question in another
language than the chat seldom finds it; `WAZAP_EMBED_MODEL=bge-m3` does (see
below). A match counts on its similarity alone; age only orders.
It reaches every message the account keeps. For an exact string — an id, a
phone number, a URL — pass `match: "words"`. When meaning search cannot run —
recall off, the embedding server failing or refusing the query, or the sidecar
still starting after 8 s — `search` matches the words only and says so
(`mode: "keyword_fallback"`, with `recall_unavailable` naming the cause and, for
recall off, the command that turns it on).

Off by default, and fully local: a `llama-server` sidecar bound to loopback
does the embedding, so nothing leaves the machine and no API key is needed. It
needs llama.cpp, the pinned model and persisted history
(`WAZAP_PERSIST_HISTORY`, on by default). `wazap setup` asks about it
("Search messages by meaning?", or `--recall local|off`); by hand it is:

```bash
wazap config recall local      # then restart the service
wazap embed download --yes     # llama.cpp where it is missing, then the model (~318 MB, sha256-verified)
```

`wazap status` runs the three checks — `recall`, `llama-server`, `embed
model` — and `get_status` reports the index as `off`, `indexing`, `ready` or
`degraded`.

## Try it in five minutes

No account and no API key: [`scripts/bootstrap.sh`](../scripts/bootstrap.sh)
takes a fresh clone to a search by meaning over fictional sample chats.

```bash
git clone https://github.com/razvangirgiz/wazap && cd wazap && ./scripts/bootstrap.sh --yes
```

It checks Node (and fetches Node 22.23.3 into `./.tools/node`, pinned by
version and sha256 in the script, when yours is too old), runs `npm ci` and the
build, installs llama.cpp and the model, seeds `./.wazap-demo` with
`wazap demo seed`, builds the index with `wazap embed index --wait`, and ends
with a test `wazap search`. Each step prints ✓ or ✗ with its fix, and running
it again resumes. Nothing touches `~/.wazap`; `rm -rf .wazap-demo` removes the
demo. Its flags: `--data-dir <dir>`, `--model embeddinggemma-300m|e5-base-multilingual`,
`--no-demo` (recall for the real install, no sample data), `--with-voice`
(adds [local transcription](voice.md), a 574 MB model), `--yes`, and
`--offline-stub` (CI: no downloads, the evaluation's stub embeds instead).
`npm run bootstrap -- <flags>` is the same script. Tunnels, tokens, OAuth and
webhooks are not needed for search, so it skips them.

The test search is `wazap search "adresa trimisă de Ana" --match meaning`: it
shares no word with the message it must find ("Vă aștept la mine, pe strada
Lalelelor 7…"), and passes only when that message is matched by meaning alone.

On a CPU-only Linux box the real model embeds the ~150 sample messages in
about 20 seconds; Apple Silicon is faster. embeddinggemma-300m is a small
model: it ranks a near paraphrase well, but it embeds only the message's own
words, never who sent it, so a question whose meaning lives in the sender
("the address Ana sent" against a bare "Vă aștept pe Lalelelor 7") can still
miss, which is why `search` fuses meaning with words.

## llama.cpp

`wazap embed download` finds `llama-server` through `WAZAP_EMBED_BIN` or
`PATH`; when it is missing, it offers `brew install llama.cpp` on a Mac with
Homebrew, and otherwise fetches the pinned llama.cpp release build
(`b11516`, CPU, for Linux x64, Linux arm64 and Apple Silicon; tag and sha256
in `src/recall/llama.ts`) into `<data-dir>/bin/llama/` and points
`WAZAP_EMBED_BIN` at it in `<data-dir>/.env`. That download is only taken
with `--yes` or a yes typed at a terminal. If `llama-server` is still missing
afterwards, the model is kept, the command says so with the fix and exits 1
(`--json` reports `"ready": false`). Anywhere else, build llama.cpp
(`cmake -B build && cmake --build build --target llama-server`) and put
`llama-server` on `PATH`.

embeddinggemma needs llama.cpp build 6800 or newer. `embed download` reads
the build from `llama-server --version` and refuses an older one with the
way out: upgrade, or use `e5-base-multilingual`, which older builds run
(`wazap embed download --model e5-base-multilingual` and
`WAZAP_EMBED_MODEL=e5-base-multilingual` in the data dir's `.env`). The
bootstrap switches to it and writes that line itself; with `--no-demo`, where
it is your real install, it says so in a warning that cannot be missed.

With Docker, `docker build --build-arg WITH_RECALL=1 -t wazap .` builds the
image on Debian with the pinned llama.cpp in it and recall on; run
`wazap embed download` once into the `/data` volume for the model.

## From the shell

```bash
wazap embed index                    # where each account's index stands
wazap embed index --wait             # embed what is queued, with progress; exit 0 once ready
wazap search "the address Ana sent"  # --match hybrid|meaning|words, --limit, --account, --json
```

Both open the account database without WhatsApp and refuse while a server
holds the data dir — that server indexes on its own, and its MCP `search` is
the same search, with two differences, since no server keeps llama-server
warm between two shell searches: `wazap search` waits for it to start (up to
90 s) instead of answering by words after 8 s, and the age of a message does
not weigh its rank. It is read-only: it embeds the query, never the messages,
and falls back to words (`"mode": "keyword_fallback"`) as the tool does when
meaning search cannot run; `--match meaning` fails instead. With `--json`, a
failure is one object on stdout too, `{"error": {"code", "message", "fix"}}`,
with exit code 1.

## What the tools write

You set one thing, `WAZAP_RECALL=local` (`wazap config recall local`), plus
`WAZAP_DATA_DIR` or `--data-dir` when the data is not in `~/.wazap`. The
installer may add `WAZAP_EMBED_BIN` (the `llama-server` it installed) and
the bootstrap `WAZAP_EMBED_MODEL` (e5, for an old llama.cpp) to
`<data-dir>/.env`; they are not settings to tune. Voice is separate:
`WAZAP_TRANSCRIBE`, and `WAZAP_TRANSCRIBE_API_KEY` for an API, in
[voice.md](voice.md).

## How it ranks

`chat_id`, `since`, `until` and `from` narrow a search by meaning exactly as
they narrow one by words. Hits rank by a fused score (reciprocal rank fusion of the
word and meaning rankings), and a hit found only by meaning must clear the
similarity floor, so a question with no answer comes back empty. A match found
by meaning weighs a little less with age — 85% a month on, never under 70%, for
its rank and for the floor — so the fresher of two close matches comes first
while a clearly closer old one still does, and a word hit whose meaning falls
under the floor ranks by its words alone. One chat takes at most three leading
places before other chats' hits, and a near-duplicate trails the list. The vectors
live in the account database next to their messages, are made in the
background for every message that has none, and leave with their message when
it is deleted, revoked or expires; an edit makes its vector again. A message
wazap holds only as text — carried over from the recall index an older wazap
built — is marked `from_index`: `get_message` returns its text, but
`get_media` has nothing to open and it cannot be replied to or forwarded.

Embedding requests refuse redirects, cap replies at 4 MiB and validate vector
shape and finite values. Provider bodies and decoder stderr are not copied into
errors.

`wazap config recall local|off` sets `WAZAP_RECALL`, and every kept message is
indexed. The model is embeddinggemma-300m (~318 MB). For a history written in
more than one language, set `WAZAP_EMBED_MODEL=bge-m3` in the data dir's `.env`
and run `wazap embed download --model bge-m3` (~635 MB): it finds an answer
asked in another language (an English question for a Romanian message) where
gemma does not, at twice the size and embed time. Changing the model indexes
everything again in the background; until it is done, meaning reaches only the
messages indexed so far.
