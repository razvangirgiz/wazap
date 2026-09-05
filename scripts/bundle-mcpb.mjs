#!/usr/bin/env node
/**
 * Builds the Claude Desktop bundle. Claude Desktop runs the bundle's own
 * `node dist/index.js` with no npm on the far side, so the archive has to carry
 * production node_modules: the staging tree is package.json plus the lockfile
 * plus a fresh `npm install --omit=dev`, never this checkout's node_modules,
 * which holds TypeScript and the test tooling.
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist-bundle");
const stage = join(outDir, "stage");
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { version } = metadata;
const publicDocs = metadata.files.filter(name => name.startsWith("docs/"));
const bundle = join(outDir, `wazap-${version}.mcpb`);

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

run("npm", ["run", "build"], root);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// `skills` is here because the server reads it at runtime to serve the
// workflows as MCP prompts, which is the only way they reach Claude Desktop.
for (const name of ["manifest.json", "icon.png", "package.json", "npm-shrinkwrap.json", "README.md", "AGENT.md", "LICENSE", "dist", "skills", ...publicDocs]) {
  mkdirSync(join(stage, name, ".."), { recursive: true });
  cpSync(join(root, name), join(stage, name), { recursive: true });
}

run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
// The lockfile npm just rewrote describes a tree without devDependencies, and
// shipping it would tell anyone reading the bundle the wrong thing.
rmSync(join(stage, "npm-shrinkwrap.json"), { force: true });

run("npx", ["-y", "@anthropic-ai/mcpb@2", "validate", join(stage, "manifest.json")], root);
run("npx", ["-y", "@anthropic-ai/mcpb@2", "pack", stage, bundle], root);

const listing = execFileSync("unzip", ["-Z1", bundle], { encoding: "utf8" }).split("\n");
const required = ["manifest.json", "dist/index.js", "icon.png", "skills/whatsapp-inbox/SKILL.md"];
const missing = required.filter((name) => !listing.includes(name));
if (missing.length > 0) {
  console.error(`${bundle} is missing ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`${bundle}: ${listing.length} entries, ${required.join(", ")} present`);
