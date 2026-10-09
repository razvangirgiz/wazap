#!/bin/sh
# Install wazap with a Node of its own, for one user, without sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/razvangirgiz/wazap/main/scripts/install.sh | sh
#
# It fetches a pinned Node build (sha256-checked against the table below) into
# a directory wazap owns, installs the wazap-mcp package next to it, and puts a
# `wazap` launcher in ~/.local/bin that always runs that Node. Whatever Node the
# machine has, or does not have, is left alone. Running it again upgrades both,
# and restarts the background service when there is one.
#
# Options (after `sh -s --` when piped):
#   --version <v>     the wazap-mcp version to install (default: latest)
#   --prefix <dir>    where Node and the package live (default ~/.local/share/wazap)
#   --bin-dir <dir>   where the `wazap` launcher goes (default ~/.local/bin)
#   --no-modify-path  never touch a shell profile; print the PATH line instead
#   --from <path>     install this package instead of the npm one: a directory
#                     (a built clone, linked as is) or an `npm pack` tarball
#   --force           replace a `wazap` in the bin dir that this script did not write
#   --node-mirror <url>  fetch Node from this mirror of nodejs.org/dist (same layout)
#   --node-sha256 <hex>  accept this sha256 instead of the pinned one; only for a
#                        mirror that repackages Node, and for the tests
set -eu

NODE_VERSION=22.23.3
# From https://nodejs.org/dist/v22.23.3/SHASUMS256.txt; the same pins as scripts/bootstrap.sh.
node_sha256() {
  case "$1" in
    linux-x64) echo 1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af ;;
    linux-arm64) echo 5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2 ;;
    darwin-arm64) echo 23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 ;;
    darwin-x64) echo 8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8 ;;
    *) echo "" ;;
  esac
}

VERSION=latest
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/wazap"
BIN_DIR="$HOME/.local/bin"
MODIFY_PATH=1
FROM=""
FORCE=0
NODE_MIRROR="https://nodejs.org/dist"
NODE_SHA_OVERRIDE=""
MARKER="# Written by the wazap installer (scripts/install.sh)."

say() { printf '%s\n' "$*" >&2; }
ok() { printf '✓ %s\n' "$*" >&2; }
die() {
  printf '✗ %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '  → %s\n' "$2" >&2
  exit 1
}

need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value." "Run with --help to see the options"; }

# Everything happens inside main, called on the last line: when `curl | sh` is
# cut off midway, sh has read no call yet and runs nothing.
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) need_arg "$@"; VERSION="$2"; shift 2 ;;
      --prefix) need_arg "$@"; PREFIX="$2"; shift 2 ;;
      --bin-dir) need_arg "$@"; BIN_DIR="$2"; shift 2 ;;
      --no-modify-path) MODIFY_PATH=0; shift ;;
      --from) need_arg "$@"; FROM="$2"; shift 2 ;;
      --force) FORCE=1; shift ;;
      --node-mirror) need_arg "$@"; NODE_MIRROR="${2%/}"; shift 2 ;;
      --node-sha256) need_arg "$@"; NODE_SHA_OVERRIDE="$2"; shift 2 ;;
      -h|--help) sed -n '2,25p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' >&2 || true; exit 0 ;;
      *) die "Unknown option $1." "Run with --help to see the options" ;;
    esac
  done

  case "$VERSION" in
    latest|[0-9]*.[0-9]*.[0-9]*) ;;
    *) die "--version $VERSION is not a version." "Pass a version like 1.3.0, or leave it out for the latest" ;;
  esac

  # sudo would install into root's home and leave files the person cannot change.
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    die "This installer needs no sudo, and under sudo it would install for root, not for $SUDO_USER." \
      "Run it again without sudo"
  fi
  [ -n "${HOME:-}" ] || die "HOME is not set, so there is nowhere to install to." "Set HOME, then run this again"

  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64) PLATFORM=linux-x64 ;;
    Linux-aarch64|Linux-arm64) PLATFORM=linux-arm64 ;;
    Darwin-arm64) PLATFORM=darwin-arm64 ;;
    Darwin-x86_64) PLATFORM=darwin-x64 ;;
    *) die "There is no Node build for $(uname -s) $(uname -m) to install." \
      "Install Node 22.16+ yourself, then run \`npm i -g wazap-mcp\`" ;;
  esac
  # nodejs.org builds against glibc; on musl (Alpine) they do not start.
  if [ "${PLATFORM#linux}" != "$PLATFORM" ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
    die "This Linux uses musl (Alpine); the official Node builds need glibc." \
      "Run \`apk add nodejs npm\` (Node 22.16+), then \`npm i -g wazap-mcp\`; or use a Debian or Ubuntu image"
  fi

  command -v tar >/dev/null 2>&1 || die "tar is missing." "Install tar, then run this again"
  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q -O "$2" "$1"; }
  else
    die "Neither curl nor wget is installed." "Install curl, then run this again"
  fi
  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | cut -d' ' -f1
    else die "No sha256 tool (sha256sum, shasum or openssl) to check the download with." "Install coreutils, then run this again"
    fi
  }

  mkdir -p "$PREFIX/node" "$BIN_DIR"
  PREFIX="$(cd "$PREFIX" && pwd -P)"
  BIN_DIR="$(cd "$BIN_DIR" && pwd -P)"
  # Both are written into the launcher and a shell profile inside double quotes.
  case "$PREFIX$BIN_DIR" in
    *'"'* | *'$'* | *'`'* | *'\'*) die "The install paths contain a quote, \$, \` or a backslash." "Pass --prefix and --bin-dir without them" ;;
  esac
  LAUNCHER="$BIN_DIR/wazap"

  # One installer at a time: two would swap the same directories under each other.
  LOCK="$PREFIX/.install-lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    die "Another wazap install is running (or one was killed midway)." \
      "Wait for it to finish; if none is running, remove $LOCK and run this again"
  fi
  WORK=""
  cleanup() {
    [ -n "$WORK" ] && rm -rf "$WORK"
    rmdir "$LOCK" 2>/dev/null || true
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  # Scratch space inside the prefix, so every move below is a rename on one filesystem.
  WORK="$(mktemp -d "$PREFIX/.work.XXXXXX")"

  # A `wazap` this script did not write is someone else's: never replace it silently.
  if [ -e "$LAUNCHER" ] && ! grep -q "^$MARKER\$" "$LAUNCHER" 2>/dev/null && [ "$FORCE" != 1 ]; then
    die "$LAUNCHER already exists and was not written by this installer." \
      "Remove it (or pass --bin-dir <another dir>, or --force to replace it), then run this again"
  fi

  # 1. Node ----------------------------------------------------------------------

  NODE_NAME="node-v$NODE_VERSION-$PLATFORM"
  NODE_HOME="$PREFIX/node/$NODE_NAME"
  if [ -x "$NODE_HOME/bin/node" ] && [ -f "$NODE_HOME/.wazap-verified" ]; then
    ok "Node $NODE_VERSION (already installed)"
  else
    WANT="${NODE_SHA_OVERRIDE:-$(node_sha256 "$PLATFORM")}"
    [ -n "$WANT" ] || die "No pinned sha256 for $PLATFORM."
    say "Downloading Node $NODE_VERSION for $PLATFORM…"
    fetch "$NODE_MIRROR/v$NODE_VERSION/$NODE_NAME.tar.gz" "$WORK/node.tar.gz" ||
      die "Could not download Node $NODE_VERSION." "Check the network connection, then run this again; nothing was changed"
    GOT="$(sha256_of "$WORK/node.tar.gz")"
    [ "$GOT" = "$WANT" ] || die "The Node download does not match its pinned sha256 ($GOT); nothing was installed." \
      "Run this again; if it keeps failing, the download is being tampered with or corrupted on the way"
    mkdir "$WORK/node"
    tar -xzf "$WORK/node.tar.gz" -C "$WORK/node" ||
      die "Could not unpack the Node download." "Check free disk space, then run this again"
    [ -x "$WORK/node/$NODE_NAME/bin/node" ] || die "The Node download has no bin/node."
    "$WORK/node/$NODE_NAME/bin/node" -e "" 2>/dev/null ||
      die "The downloaded Node does not run on this machine." "Install Node 22.16+ yourself, then run \`npm i -g wazap-mcp\`"
    : >"$WORK/node/$NODE_NAME/.wazap-verified"
    rm -rf "$NODE_HOME"
    mv "$WORK/node/$NODE_NAME" "$NODE_HOME"
    ok "Node $NODE_VERSION (sha256 verified)"
  fi
  # `current` is what the launcher and the service run, so an upgrade is one rename.
  # -n replaces the old link itself instead of following it into the directory.
  ln -sfn "$NODE_NAME" "$PREFIX/node/current"
  NODE="$PREFIX/node/current/bin/node"

  # 2. wazap ---------------------------------------------------------------------

  # Built in a staging prefix and swapped in whole: a failed install leaves the
  # working one in place.
  STAGE="$WORK/npm"
  mkdir -p "$STAGE/lib/node_modules"
  if [ -n "$FROM" ] && [ -d "$FROM" ]; then
    FROM="$(cd "$FROM" && pwd -P)"
    [ -f "$FROM/dist/index.js" ] || die "$FROM has no dist/index.js." "Run \`npm ci && npm run build\` in it first"
    ln -s "$FROM" "$STAGE/lib/node_modules/wazap-mcp"
    SPEC="$FROM"
  else
    if [ -n "$FROM" ]; then
      [ -f "$FROM" ] || die "--from $FROM is neither a directory nor a file."
      SPEC="$(cd "$(dirname "$FROM")" && pwd -P)/$(basename "$FROM")"
    else
      SPEC="wazap-mcp@$VERSION"
    fi
    say "Installing $SPEC…"
    # npm's own lifecycle scripts look for `node` on PATH: make it ours.
    PATH="$PREFIX/node/current/bin:$PATH" "$NODE" "$PREFIX/node/current/lib/node_modules/npm/bin/npm-cli.js" \
      install --global --prefix "$STAGE" --no-audit --no-fund --loglevel=error "$SPEC" >&2 ||
      die "npm could not install $SPEC; the previous install, if any, is untouched." \
        "Read the npm error above, then run this again"
  fi
  [ -f "$STAGE/lib/node_modules/wazap-mcp/dist/index.js" ] || die "The installed package has no dist/index.js."
  INSTALLED="$("$NODE" "$STAGE/lib/node_modules/wazap-mcp/dist/index.js" --version 2>&1)" ||
    die "The installed wazap does not start: $INSTALLED"

  rm -rf "$PREFIX/npm.old"
  [ -d "$PREFIX/npm" ] && mv "$PREFIX/npm" "$PREFIX/npm.old"
  mv "$STAGE" "$PREFIX/npm"
  rm -rf "$PREFIX/npm.old"
  ok "wazap $INSTALLED"

  # The launcher and the service run node/current, so no other Node build is used now.
  for dir in "$PREFIX/node"/node-v*; do
    if [ -d "$dir" ] && [ "$dir" != "$NODE_HOME" ]; then rm -rf "$dir"; fi
  done

  # 3. The launcher --------------------------------------------------------------

  cat >"$WORK/wazap" <<EOF
#!/bin/sh
$MARKER
# It runs wazap with the Node the installer pinned, whatever node is on PATH.
exec "$PREFIX/node/current/bin/node" "$PREFIX/npm/lib/node_modules/wazap-mcp/dist/index.js" "\$@"
EOF
  chmod 755 "$WORK/wazap"
  mv -f "$WORK/wazap" "$LAUNCHER"
  ok "$LAUNCHER"

  # 4. PATH ----------------------------------------------------------------------

  PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
  on_path() { case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; esac; return 1; }
  if on_path; then
    :
  elif [ "$MODIFY_PATH" = 1 ]; then
    case "${SHELL:-}" in
      */zsh) PROFILES="$HOME/.zshrc $HOME/.profile" ;;
      */bash) PROFILES="$HOME/.bashrc $HOME/.profile" ;;
      *) PROFILES="$HOME/.profile" ;;
    esac
    for profile in $PROFILES; do
      if ! grep -qF "$PATH_LINE" "$profile" 2>/dev/null; then
        printf '\n%s\n%s\n' "$MARKER" "$PATH_LINE" >>"$profile"
        ok "Added $BIN_DIR to PATH in $profile"
      fi
    done
    say "Open a new terminal, or run this once, for \`wazap\` to be found here:"
    say "  $PATH_LINE"
  else
    say "Add $BIN_DIR to your PATH:"
    say "  $PATH_LINE"
  fi
  # Something earlier on PATH would shadow the launcher; say which, never remove it.
  FOUND="$(PATH="$BIN_DIR:$PATH" command -v wazap 2>/dev/null || true)"
  OTHER="$(command -v wazap 2>/dev/null || true)"
  if on_path && [ -n "$OTHER" ] && [ "$OTHER" != "$LAUNCHER" ]; then
    say "! $OTHER comes before $LAUNCHER on your PATH; remove it (\`npm rm -g wazap-mcp\`) or call $LAUNCHER."
  elif [ "$FOUND" != "$LAUNCHER" ]; then
    say "! \`wazap\` resolves to $FOUND, not $LAUNCHER."
  fi

  # 5. A running service follows the upgrade -------------------------------------

  DATA_DIR="${WAZAP_DATA_DIR:-$HOME/.wazap}"
  if [ -f "$DATA_DIR/service.json" ]; then
    say "Restarting the background service on the new version…"
    "$LAUNCHER" service install >&2 || say "! The service did not restart; run \`wazap service install\`."
  fi

  say ""
  ok "Done. Next: wazap setup"
  say "  An AI agent setting this up on its own machine runs \`wazap setup --agent\` and follows it."
}

main "$@"
