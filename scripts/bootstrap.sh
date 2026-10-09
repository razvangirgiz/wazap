#!/usr/bin/env bash
# From a fresh clone to a working search by meaning on fictional sample data,
# with no WhatsApp account and no API keys:
#
#   ./scripts/bootstrap.sh            (or: npm run bootstrap -- <flags>)
#
# Each step prints ✓ or ✗ with the fix, and the whole script is safe to run
# again: it resumes, keeping what is already in place. Nothing touches
# ~/.wazap unless --no-demo asks for a real install there.
#
# Flags:
#   --data-dir <dir>   where the demo lives (default ./.wazap-demo)
#   --model <alias>    embeddinggemma-300m (default) or e5-base-multilingual
#   --no-demo          real install only: recall on, llama.cpp and the model, no sample data
#   --with-voice       also set up local voice transcription (whisper.cpp, ffmpeg, a 574 MB model)
#   --yes, -y          answer yes to every download instead of asking
#   --offline-stub     CI: no downloads at all; embed with the evaluation's stub server
#   --no-build         use the existing dist/ (CI, right after `npm run build`)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DATA_DIR=""
MODEL=""
DEMO=1
VOICE=0
YES=0
STUB=0
BUILD=1
QUERY="invitație la petrecere pe strada Lalelelor"
EXPECT="Lalelelor"
NODE_LINE=22

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:?--data-dir needs a directory}"; shift 2 ;;
    --data-dir=*) DATA_DIR="${1#*=}"; shift ;;
    --model) MODEL="${2:?--model needs an alias}"; shift 2 ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --no-demo) DEMO=0; shift ;;
    --with-voice) VOICE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --offline-stub) STUB=1; shift ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ Unknown flag $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$MODEL" in
  ""|embeddinggemma-300m|e5-base-multilingual) ;;
  *) echo "✗ Unknown --model $MODEL" >&2; echo "  → use embeddinggemma-300m or e5-base-multilingual" >&2; exit 2 ;;
esac

ok() { printf '✓ %s\n' "$*" >&2; }
step() { printf '\n— %s\n' "$*" >&2; }
die() {
  printf '✗ %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '  → %s\n' "$2" >&2
  exit 1
}

if [ -z "$DATA_DIR" ]; then
  if [ "$DEMO" = 1 ]; then DATA_DIR="$ROOT/.wazap-demo"; else DATA_DIR="${WAZAP_DATA_DIR:-$HOME/.wazap}"; fi
fi
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

# 1. Node ---------------------------------------------------------------------

node_fits() {
  "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit((major === 22 && minor >= 16) || major >= 24 ? 0 : 1);
  ' >/dev/null 2>&1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

step "Node"
NODE_DIR="$ROOT/.tools/node"
if command -v node >/dev/null 2>&1 && node_fits node; then
  ok "node $(node -p process.versions.node)"
elif [ -x "$NODE_DIR/bin/node" ] && node_fits "$NODE_DIR/bin/node"; then
  export PATH="$NODE_DIR/bin:$PATH"
  ok "node $(node -p process.versions.node) from .tools/node"
else
  [ "$STUB" = 1 ] && die "Node ^22.16 or >=24 is required and --offline-stub downloads nothing." "Install Node 22 (see .nvmrc), e.g. \`nvm install\`"
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) PLATFORM=linux-x64 ;;
    Linux-aarch64|Linux-arm64) PLATFORM=linux-arm64 ;;
    Darwin-arm64) PLATFORM=darwin-arm64 ;;
    Darwin-x86_64) PLATFORM=darwin-x64 ;;
    *) die "No Node $NODE_LINE build for $(uname -s) $(uname -m)." "Install Node 22 yourself, then run this again" ;;
  esac
  printf '  node is %s; fetching Node %s LTS into .tools/node\n' "$(command -v node >/dev/null 2>&1 && node -v || echo missing)" "$NODE_LINE" >&2
  BASE="https://nodejs.org/dist/latest-v$NODE_LINE.x"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt" || die "Could not reach nodejs.org." "Check the network, or install Node 22 yourself"
  FILE="$(grep -oE "node-v$NODE_LINE\.[0-9]+\.[0-9]+-$PLATFORM\.tar\.gz" "$WORK/SHASUMS256.txt" | head -1)"
  [ -n "$FILE" ] || die "nodejs.org lists no $PLATFORM tarball for Node $NODE_LINE."
  WANT="$(grep " $FILE\$" "$WORK/SHASUMS256.txt" | cut -d' ' -f1)"
  curl -fSL --progress-bar "$BASE/$FILE" -o "$WORK/$FILE" || die "Could not download $FILE."
  [ "$(sha256_of "$WORK/$FILE")" = "$WANT" ] || die "$FILE does not match its sha256 in SHASUMS256.txt; nothing was installed."
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$WORK/$FILE" -C "$NODE_DIR" --strip-components=1
  export PATH="$NODE_DIR/bin:$PATH"
  node_fits node || die "The downloaded Node does not run here."
  ok "node $(node -p process.versions.node) in .tools/node (sha256 verified)"
fi

# 2. Install and build --------------------------------------------------------

step "Install and build"
if [ "$BUILD" = 1 ]; then
  if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    npm ci --no-audit --no-fund >&2 || die "npm ci failed." "Read the npm error above, then run this again"
  fi
  ok "dependencies"
  npm run --silent build >&2 || die "The build failed." "Run \`npm run build\` to see the TypeScript errors"
  ok "built dist/"
else
  [ -f dist/index.js ] || die "dist/ is missing and --no-build was given." "Run \`npm run build\` first"
  ok "using the existing dist/"
fi

export WAZAP_NO_UPDATE_CHECK=1
wazap() { node "$ROOT/dist/index.js" "$@" --data-dir "$DATA_DIR"; }

# 3 and 4. Recall: llama.cpp and the model --------------------------------------

step "Search by meaning"
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true; }
trap 'cleanup; rm -rf "${WORK:-}"' EXIT
wazap config recall local >/dev/null 2>&1 || die "Could not turn recall on in $DATA_DIR/.env."
ok "recall: local, in $DATA_DIR/.env"
[ -n "$MODEL" ] && export WAZAP_EMBED_MODEL="$MODEL"

if [ "$STUB" = 1 ]; then
  URL_FILE="$(mktemp)"
  node "$ROOT/scripts/eval/embed-stub.mjs" >"$URL_FILE" &
  STUB_PID=$!
  for _ in $(seq 1 50); do [ -s "$URL_FILE" ] && break; sleep 0.1; done
  WAZAP_EMBED_URL="$(head -1 "$URL_FILE")"
  rm -f "$URL_FILE"
  [ -n "$WAZAP_EMBED_URL" ] || die "The embedding stub did not start."
  # The stub's crude vectors are priced on their own scale.
  export WAZAP_EMBED_URL WAZAP_RECALL_MIN_SIMILARITY=0.3
  ok "embedding with the evaluation's stub at $WAZAP_EMBED_URL (no downloads)"
else
  DL_FLAGS=()
  [ "$YES" = 1 ] && DL_FLAGS+=(--yes)
  [ -n "$MODEL" ] && DL_FLAGS+=(--model "$MODEL")
  REPORT="$(wazap embed download --json "${DL_FLAGS[@]}")" && READY=1 || READY=0
  if [ "$READY" = 0 ] && [ -z "$MODEL" ]; then
    # An installed llama.cpp too old for gemma: fall back to e5, which it runs.
    BUILD_NO="$(printf '%s' "$REPORT" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).llama_server.build??""))}catch{}})')"
    if [ -n "$BUILD_NO" ] && [ "$BUILD_NO" -lt 6800 ]; then
      printf '  llama.cpp build %s cannot run embeddinggemma; using e5-base-multilingual\n' "$BUILD_NO" >&2
      export WAZAP_EMBED_MODEL=e5-base-multilingual
      printf 'WAZAP_EMBED_MODEL=e5-base-multilingual\n' >>"$DATA_DIR/.env"
      REPORT="$(wazap embed download --json --model e5-base-multilingual "${DL_FLAGS[@]}")" && READY=1 || READY=0
    fi
  fi
  [ "$READY" = 1 ] || die "llama-server is still missing, so nothing can be embedded." "Run again with --yes to fetch the pinned llama.cpp build, or install llama.cpp (macOS: brew install llama.cpp)"
  ok "llama-server and the embedding model are ready"
fi

if [ "$VOICE" = 1 ]; then
  step "Voice (optional)"
  if [ "$STUB" = 1 ]; then
    ok "skipped with --offline-stub"
  else
    wazap config transcribe local >/dev/null
    if wazap transcribe download $([ "$YES" = 1 ] && echo --yes); then ok "voice transcription: local"
    else printf '✗ voice transcription is not ready; search works without it\n  → macOS: brew install whisper-cpp ffmpeg; Linux: build whisper.cpp (cmake) and install ffmpeg, then `wazap transcribe download`\n' >&2; fi
  fi
fi

if [ "$DEMO" = 0 ]; then
  step "Done"
  ok "recall is set up in $DATA_DIR"
  cat >&2 <<EOF
  Next:
    wazap setup        link your WhatsApp, connect your client and its skills
  Not needed for search, so skipped: expose (tailscale/cloudflared), HTTP tokens, OAuth, webhooks.
EOF
  exit 0
fi

# 5. Sample data ----------------------------------------------------------------

step "Sample data"
wazap demo seed >&2 || die "Could not seed $DATA_DIR." "Pass --data-dir with an empty directory"

# 6. The index ------------------------------------------------------------------

step "Index"
wazap embed index --wait >&2 || die "The index did not finish." "Run \`node dist/index.js embed index --wait --data-dir $DATA_DIR\` to see why"

# 7. A test search --------------------------------------------------------------

step "Test search"
RESULT="$(wazap search "$QUERY" --json --limit 5)" || die "The test search failed."
printf '%s' "$RESULT" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const answer = JSON.parse(s);
    const hit = answer.hits.find((h) => h.text.includes(process.argv[1]) && (h.matched === "meaning" || h.matched === "both"));
    if (!hit) {
      process.stderr.write(`✗ no hit containing "${process.argv[1]}" matched by meaning (mode ${answer.mode})\n`);
      process.exit(1);
    }
    process.stderr.write(`✓ "${answer.query}" → ${hit.from}: ${hit.text}  [${hit.matched}, similarity ${hit.similarity?.toFixed(2)}]\n`);
  });
' "$EXPECT" || die "Search by meaning did not find the expected message." "Run \`node dist/index.js status --data-dir $DATA_DIR\` and fix what it marks ✗"

# 8. Next steps -----------------------------------------------------------------

step "Done"
cat >&2 <<EOF
  Try it yourself:
    node dist/index.js search "<anything>" --data-dir $DATA_DIR
  Next:
    node dist/index.js login              link your real WhatsApp account (into ~/.wazap)
    node dist/index.js setup              connect your MCP client and its skills
    ./scripts/bootstrap.sh --no-demo      recall for the real install, without the sample data
    ./scripts/bootstrap.sh --with-voice   add local voice transcription (574 MB model)
  The demo is fictional and self-contained; delete it with: rm -rf $DATA_DIR
EOF
