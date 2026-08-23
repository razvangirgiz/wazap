import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

const pkg = read("package.json");
const server = read("server.json");
const manifest = read("manifest.json");

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

test("the bundle manifest carries every field mcpb requires", () => {
  for (const field of ["name", "version", "description", "author", "server"]) {
    assert.ok(manifest[field] !== undefined, `manifest.json: ${field}`);
  }
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.version, pkg.version);
  assert.equal(typeof manifest.author, "object");
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.entry_point, "dist/index.js");
  assert.deepEqual(manifest.server.mcp_config.args, ["${__dirname}/dist/index.js"]);
});

/**
 * The bundle has no way to leave an argument out, so both settings travel as
 * environment variables the server already understands.
 */
test("the bundle's user_config reaches the server through its own settings", () => {
  assert.deepEqual(Object.keys(manifest.user_config), ["read_only", "data_dir"]);
  assert.equal(manifest.user_config.read_only.type, "boolean");
  assert.equal(manifest.user_config.read_only.default, true, "a bundle that could message people by default is the wrong default");
  assert.equal(manifest.user_config.data_dir.type, "directory");
  assert.equal(manifest.user_config.data_dir.default, undefined);
  assert.deepEqual(manifest.server.mcp_config.env, {
    WAZAP_READ_ONLY: "${user_config.read_only}",
    WAZAP_DATA_DIR: "${user_config.data_dir}",
  });
  for (const option of Object.values(manifest.user_config)) {
    for (const field of ["type", "title", "description"]) assert.ok(option[field], `user_config: ${field}`);
  }
});

/** What Claude Desktop hands the server when someone leaves the directory picker empty. */
async function statusUnder(env) {
  const home = mkdtempSync(join(tmpdir(), "wazap-bundle-"));
  const { stdout } = await run(process.execPath, [join(root, "dist", "index.js"), "status", "--json"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, WAZAP_NO_UPDATE_CHECK: "1", ...env },
  });
  return { home, report: JSON.parse(stdout) };
}

test("an unfilled bundle setting is not mistaken for a data directory", async () => {
  const { home, report } = await statusUnder({ WAZAP_DATA_DIR: "${user_config.data_dir}" });
  assert.equal(report.data_dir, join(home, ".wazap"));
});

test("a data directory the user did fill in still arrives", async () => {
  const chosen = mkdtempSync(join(tmpdir(), "wazap-chosen-"));
  const { report } = await statusUnder({ WAZAP_DATA_DIR: chosen });
  assert.equal(report.data_dir, chosen);
});

test("the icon is a PNG the bundle can point at", () => {
  assert.equal(manifest.icon, "icon.png");
  const png = readFileSync(join(root, "icon.png"));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
});
