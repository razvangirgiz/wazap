import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

const pkg = read("package.json");
const server = read("server.json");

test("server.json publishes this version of this npm package", () => {
  assert.equal(server.version, pkg.version);
  const [npmPackage] = server.packages;
  assert.equal(npmPackage.registryType, "npm");
  assert.equal(npmPackage.identifier, "wazap-mcp");
  assert.equal(npmPackage.identifier, pkg.name);
  assert.equal(npmPackage.version, pkg.version);
  assert.deepEqual(npmPackage.transport, { type: "stdio" });
});

test("mcpName proves npm ownership of the registry name", () => {
  assert.equal(pkg.mcpName, server.name);
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
});

test("the description fits the registry's 100-character limit", () => {
  assert.ok(server.description.length <= 100, `${server.description.length} characters`);
});

test("server.json names a dated registry schema", () => {
  assert.match(server.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
});
