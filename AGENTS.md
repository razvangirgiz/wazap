# AGENTS.md — wazap

WhatsApp MCP server over Baileys. Node ≥ 20.

```
npm ci
npm run typecheck
npm test
```

`npm test` does not need a WhatsApp session. Do not run `login`, `setup`, or `serve` in a Cloud Agent unless the operator asked to pair this VM. Pairing binds a phone; the VM is ephemeral.

## Cursor Cloud

`.cursor/install.sh` runs `npm ci`. There is no start script and no default terminal. Do not put WhatsApp credentials, bearer tokens, or `~/.wazap` in environment.json or the repo.
