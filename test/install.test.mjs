/**
 * scripts/install.sh, the one line a person pastes. Driven against a local
 * mirror of nodejs.org/dist holding a stand-in Node (a script that runs this
 * Node), whose sha256 the test passes in the way a mirror would; the package
 * is this built clone (`--from .`). Nothing here reaches the network.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { childEnv } from "./helpers.mjs";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "install.sh");
const NODE_VERSION = /^NODE_VERSION=(\S+)$/m.exec(readFileSync(SCRIPT, "utf8"))[1];
const PLATFORM = { "linux-x64": "linux-x64", "linux-arm64": "linux-arm64", "darwin-x64": "darwin-x64", "darwin-arm64": "darwin-arm64" }[
  `${process.platform}-${process.arch}`
];
const skip = process.platform === "win32" || PLATFORM === undefined ? "no POSIX sh build for this platform" : false;

/** A nodejs.org/dist layout with one tarball: a `node` that is this Node. */
async function mirror(dir) {
  const name = `node-v${NODE_VERSION}-${PLATFORM}`;
  const pkg = join(dir, "pkg", name, "bin");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(join(pkg, "node"), 0o755);
  const out = join(dir, "mirror", `v${NODE_VERSION}`);
  mkdirSync(out, { recursive: true });
  const tarball = join(out, `${name}.tar.gz`);
  await run("tar", ["-czf", tarball, "-C", join(dir, "pkg"), name]);
  return { url: `file://${join(dir, "mirror")}`, sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex") };
}

function box() {
  const dir = mkdtempSync(join(tmpdir(), "wazap-install-"));
  const home = join(dir, "home");
  mkdirSync(home);
  return { dir, home };
}

function install(home, args, extraEnv = {}) {
  return run("sh", [SCRIPT, ...args], {
    // A PATH without ~/.local/bin, as on a fresh machine; WAZAP_* never leaks in.
    env: childEnv({ HOME: home, SHELL: "/bin/bash", XDG_DATA_HOME: "", PATH: "/usr/local/bin:/usr/bin:/bin", ...extraEnv }),
    timeout: 120_000,
  });
}

test("a fresh install verifies Node, links the package, writes the launcher and PATH once; a re-run downloads nothing", { skip }, async () => {
  const { dir, home } = box();
  const { url, sha256 } = await mirror(dir);
  const args = ["--from", root, "--node-mirror", url, "--node-sha256", sha256];
  const first = await install(home, args);
  assert.match(first.stderr, /Node .* \(sha256 verified\)/);

  const prefix = join(home, ".local", "share", "wazap");
  assert.equal(readlinkSync(join(prefix, "node", "current")), `node-v${NODE_VERSION}-${PLATFORM}`);
  const launcher = join(home, ".local", "bin", "wazap");
  const text = readFileSync(launcher, "utf8");
  assert.match(text, /^# Written by the wazap installer/m);
  assert.ok(text.includes(join(prefix, "node", "current", "bin", "node")), "the launcher runs the pinned Node, not PATH's");
  const { stdout } = await run(launcher, ["--version", "--json"], { env: childEnv({ PATH: "/usr/bin:/bin" }) });
  assert.equal(JSON.parse(stdout).version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  // Run through the launcher, wazap knows it is the installer's, though its package is a link to this clone.
  const status = await run(launcher, ["status", "--json", "--data-dir", join(dir, "data")], { env: childEnv({ PATH: "/usr/bin:/bin" }) });
  const script = join(prefix, "npm", "lib", "node_modules", "wazap-mcp", "dist", "index.js");
  assert.deepEqual(JSON.parse(status.stdout).install, { kind: "global", script, installer: true });

  const bashrc = readFileSync(join(home, ".bashrc"), "utf8");
  assert.equal(bashrc.split(`export PATH="${join(home, ".local", "bin")}:$PATH"`).length - 1, 1);

  // The mirror is gone: a re-run must not need it, and must not add PATH twice.
  const again = await install(home, ["--from", root, "--node-mirror", "file:///nonexistent", "--node-sha256", sha256]);
  assert.match(again.stderr, /already installed/);
  assert.equal(readFileSync(join(home, ".bashrc"), "utf8"), bashrc);
});

test("a download that does not match its sha256 installs nothing", { skip }, async () => {
  const { dir, home } = box();
  const { url } = await mirror(dir);
  await assert.rejects(install(home, ["--from", root, "--node-mirror", url, "--node-sha256", "0".repeat(64)]), (err) => {
    assert.match(err.stderr, /does not match its pinned sha256 \([0-9a-f]{64}\); nothing was installed/);
    return true;
  });
  assert.equal(existsSync(join(home, ".local", "bin", "wazap")), false);
  assert.equal(existsSync(join(home, ".local", "share", "wazap", "node", "current")), false);
  assert.equal(existsSync(join(home, ".local", "share", "wazap", ".install-lock")), false, "the lock goes with the run");
});

test("a `wazap` the installer did not write is never replaced without --force", { skip }, async () => {
  const { dir, home } = box();
  const { url, sha256 } = await mirror(dir);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "wazap"), "#!/bin/sh\necho mine\n");
  await assert.rejects(install(home, ["--from", root, "--node-mirror", url, "--node-sha256", sha256]), (err) => {
    assert.match(err.stderr, /was not written by this installer/);
    return true;
  });
  assert.equal(readFileSync(join(home, ".local", "bin", "wazap"), "utf8"), "#!/bin/sh\necho mine\n");
});

test("--no-modify-path leaves every profile alone and prints the line instead", { skip }, async () => {
  const { dir, home } = box();
  const { url, sha256 } = await mirror(dir);
  const { stderr } = await install(home, ["--from", root, "--node-mirror", url, "--node-sha256", sha256, "--no-modify-path"]);
  assert.match(stderr, /Add .*\.local\/bin to your PATH/);
  assert.equal(existsSync(join(home, ".bashrc")), false);
  assert.equal(existsSync(join(home, ".profile")), false);
});

test("a version that is not one, and an unknown option, are refused before anything is fetched", { skip }, async () => {
  const { home } = box();
  await assert.rejects(install(home, ["--version", "latest; rm -rf /"]), /is not a version/);
  await assert.rejects(install(home, ["--frobnicate"]), /Unknown option/);
  assert.equal(existsSync(join(home, ".local")), false);
});

test("the pinned Node is the one scripts/bootstrap.sh pins, with the same digests", () => {
  const bootstrap = readFileSync(join(root, "scripts", "bootstrap.sh"), "utf8");
  const script = readFileSync(SCRIPT, "utf8");
  assert.equal(/^NODE_VERSION=(\S+)$/m.exec(bootstrap)[1], NODE_VERSION);
  for (const platform of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]) {
    const digest = (text) => new RegExp(`${platform}\\) echo ([0-9a-f]{64})`).exec(text)?.[1];
    assert.ok(digest(script), platform);
    assert.equal(digest(script), digest(bootstrap), platform);
  }
});

test("a download of the script cut off midway runs nothing: all of it is one function, called on the last line", { skip }, async () => {
  const { dir, home } = box();
  const text = readFileSync(SCRIPT, "utf8");
  assert.match(text.trimEnd(), /\nmain "\$@"$/);
  const half = join(dir, "half.sh");
  writeFileSync(half, text.slice(0, Math.floor(text.length * 0.6)));
  await run("sh", [half], { env: childEnv({ HOME: home }) }).catch(() => {});
  assert.equal(existsSync(join(home, ".local")), false);
});

test("an install path that would break out of the launcher's quotes is refused", { skip }, async () => {
  const { dir, home } = box();
  const { url, sha256 } = await mirror(dir);
  await assert.rejects(
    install(home, ["--from", root, "--node-mirror", url, "--node-sha256", sha256, "--prefix", join(dir, 'a"$(touch pwned)')]),
    /contain a quote/
  );
  assert.equal(existsSync(join(home, ".local", "bin", "wazap")), false);
  assert.equal(existsSync("pwned"), false);
});

test("an installer install is a stable one, upgraded by the installer and never by npm -g", async () => {
  const { whereInstalled, installerPrefix } = await import("../dist/connect.js");
  const { planUpdate } = await import("../dist/update.js");
  const prefix = "/home/p/.local/share/wazap";
  const script = `${prefix}/npm/lib/node_modules/wazap-mcp/dist/index.js`;
  const exists = (p) => p === `${prefix}/node/current/bin/node` || p === "/home/p/.local/bin/wazap";
  assert.equal(installerPrefix(script, exists), prefix);
  assert.equal(installerPrefix("/srv/wazap/dist/index.js", exists), null);
  assert.equal(installerPrefix(script, () => false), null, "without its Node beside it, it is not the installer's");
  assert.equal(installerPrefix(`/Users/p/Library/Application Support/wazap/npm/lib/node_modules/wazap-mcp/dist/index.js`, (p) => p.startsWith("/Users/p/Library/Application Support/wazap/node/current/")), "/Users/p/Library/Application Support/wazap");
  assert.equal(installerPrefix(`/Users/p/.npm-global/lib/node_modules/wazap-mcp/dist/index.js`, () => true), null, "npm's own prefix is not the installer's");
  const install = whereInstalled(script, "/home/p/.local/bin", exists);
  assert.deepEqual(install, { kind: "global", script, installer: true });
  // Every client, GUI or not, runs the launcher's Node by its `current` link: a Node upgrade relinks it and deletes the build behind it.
  const { mcpEntry, findClient } = await import("../dist/connect.js");
  const { defaultDataDir } = await import("../dist/config.js");
  for (const client of ["claude-desktop", "claude-code"]) {
    const entry = mcpEntry({ dataDir: defaultDataDir(), readOnly: false }, findClient(client), install);
    assert.deepEqual(entry, { command: `${prefix}/node/current/bin/node`, args: [script] }, client);
  }
  const plan = planUpdate({ install, service: null, targets: [] }, "99.0.0");
  assert.equal(plan.steps.some((step) => step.kind === "npm"), false);
  assert.match(plan.steps.find((step) => step.kind === "note").text, /install\.sh \| sh/);
});
