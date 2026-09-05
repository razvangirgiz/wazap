#!/usr/bin/env bash
#
# Publishes server.json to the official MCP Registry. A human runs this, once
# per release, after `npm publish` — the registry reads `mcpName` off the exact
# published version, so a version that is not on npm yet cannot be published
# here.
#
# Docs: https://modelcontextprotocol.io/registry/quickstart
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
if [[ "$version" == *-* ]]; then
  echo "Prereleases are distributed through npm beta and GitHub prereleases, not the stable MCP Registry." >&2
  exit 1
fi
server_version=$(node -p "require('./server.json').version")
mcp_name=$(node -p "require('./package.json').mcpName")

if [ "$version" != "$server_version" ]; then
  echo "package.json is $version but server.json says $server_version." >&2
  exit 1
fi

if ! command -v mcp-publisher >/dev/null 2>&1; then
  cat >&2 <<'END'
mcp-publisher is not on PATH. Install it with one of:

  brew install mcp-publisher

  curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
    | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
END
  exit 1
fi

node scripts/validate-server-json.mjs

published=$(node -e "
fetch('https://registry.npmjs.org/wazap-mcp/$version')
  .then((r) => (r.ok ? r.json() : null))
  .then((meta) => console.log(meta === null ? 'absent' : (meta.mcpName ?? 'no-mcpName')))
")
if [ "$published" != "$mcp_name" ]; then
  echo "npm's wazap-mcp@$version reports \"$published\", not \"$mcp_name\"." >&2
  echo "Run npm publish first; mcpName cannot be added to a version already on npm." >&2
  exit 1
fi

mcp-publisher login github
mcp-publisher publish
