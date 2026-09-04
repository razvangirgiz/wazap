import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { greetNext, leftoverFix, leftoverRefusal, parseLinkChoice } from "../dist/cli.js";
import { runSmoke } from "./smoke-stdio.mjs";

const run = promisify(execFile);
const binary = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

/** The CLI writes to stderr, because stdout belongs to the MCP protocol. */
function wazap(...args) {
  return run(process.execPath, [binary, ...args], { env: { ...process.env, WAZAP_NO_UPDATE_CHECK: "1" } });
}

test("--help explains every command and exits 0", async () => {
  const { stderr } = await wazap("--help");
  for (const fragment of ["wazap login", "wazap status", "wazap logout", "--data-dir", "--read-only"]) {
    assert.ok(stderr.includes(fragment), `--help must mention ${fragment}`);
  }
});

test("--version prints the package version and exits 0", async () => {
  const { stderr } = await wazap("--version");
  const { version } = JSON.parse(
    await import("node:fs").then((fs) => fs.readFileSync(join(dirname(binary), "..", "package.json"), "utf8")),
  );
  assert.equal(stderr.trim(), version);
});

test("status on an empty data dir reports nothing linked, without touching WhatsApp", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-status-"));
  const { stderr } = await wazap("status", "--data-dir", dataDir);
  assert.match(stderr, /linked: no/);
  assert.match(stderr, new RegExp(`data dir: ${dataDir}`));
  assert.match(stderr, /server: not running/);
});

test("an unknown command fails with a pointer to --help", async () => {
  await assert.rejects(wazap("frobnicate"), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /--help/);
    return true;
  });
});

test("the built server answers MCP over stdio with no WhatsApp session", async () => {
  const { toolNames, status } = await runSmoke();
  assert.equal(toolNames.length, 29);
  assert.equal(status.status, "not_linked");
});

test("`contacts resync` on an unlinked data dir stops at NOT_LINKED, and frees the lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-contacts-"));
  await assert.rejects(wazap("contacts", "resync", "--data-dir", dataDir), (err) => {
    assert.match(err.stderr, /No WhatsApp account is linked/);
    return true;
  });
  assert.equal(existsSync(join(dataDir, "server.lock")), false, "a refused command must not leave the session held");
});

test("`contacts` with no verb, or the wrong one, points at the one that exists", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-contacts-"));
  for (const args of [["contacts"], ["contacts", "refresh"]]) {
    await assert.rejects(wazap(...args, "--data-dir", dataDir), (err) => {
      assert.match(err.stderr, /wazap contacts resync/);
      assert.ok(!err.stderr.includes("--help"), `${args.join(" ")} dumped the user into --help`);
      return true;
    });
  }
});

test("greetNext on an unlinked install points at setup, not login", () => {
  const lines = greetNext({ linked: false, credentials_readable: true, server_pid: null }).join("\n");
  assert.match(lines, /wazap setup/);
  assert.ok(!lines.includes("wazap login"), lines);
});

test("greetNext on an unlinked leftover still points at setup, and names kill", () => {
  const lines = greetNext({ linked: false, credentials_readable: true, server_pid: 85007 }).join("\n");
  assert.match(lines, /A server is already running \(pid 85007\)/);
  assert.match(lines, /stop it first: kill 85007/);
  assert.match(lines, /wazap setup/);
});

test("greetNext on a linked leftover does not send the user back through setup", () => {
  const lines = greetNext({ linked: true, credentials_readable: true, server_pid: 9 }).join("\n");
  assert.match(lines, /A server is already running \(pid 9\)/);
  assert.ok(!lines.includes("wazap setup"), lines);
  assert.ok(!lines.includes("kill 9"), lines);
});

test("leftoverFix is the one line login and logout print", () => {
  assert.equal(leftoverFix(85007), "stop it first: kill 85007");
});

test("leftoverRefusal names a client leftover and ignores a free lock", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-leftover-"));
  assert.equal(leftoverRefusal({ dataDir }), null);
  writeFileSync(join(dataDir, "server.lock"), `${process.pid}\n`, { mode: 0o600 });
  const err = leftoverRefusal({ dataDir });
  assert.equal(err?.code, "WHATSAPP_ERROR");
  assert.equal(err?.message, `wazap is running (pid ${process.pid}).`);
  assert.equal(err?.fix, leftoverFix(process.pid));
});

test("setup on a leftover refuses before the wizard opens", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-setup-lock-"));
  writeFileSync(join(dataDir, "server.lock"), `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(wazap("setup", "--yes", "--no-writes", "--data-dir", dataDir), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, new RegExp(`stop it first: kill ${process.pid}`));
    return true;
  });
});

test("a leftover that is not a service tells login the kill command", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-login-lock-"));
  writeFileSync(join(dataDir, "server.lock"), `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(wazap("login", "--yes", "--no-writes", "--data-dir", dataDir), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, new RegExp(`wazap is running \\(pid ${process.pid}\\)`));
    assert.match(err.stderr, new RegExp(`stop it first: kill ${process.pid}`));
    return true;
  });
});

test("a command with no arguments names its own usage, not --help", async () => {
  const cases = [
    { args: ["connect"], usage: /Pick one of: claude-code/ },
    { args: ["skills"], usage: /wazap skills install/ },
    { args: ["service"], usage: /wazap service install\|status/ },
    { args: ["transcribe"], usage: /wazap transcribe download/ },
    { args: ["contacts"], usage: /wazap contacts resync/ },
    { args: ["config", "writes"], usage: /wazap config writes on\|off/ },
  ];
  for (const { args, usage } of cases) {
    await assert.rejects(wazap(...args), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, new RegExp(`Wrong arguments for \`wazap ${args[0]}\``));
      assert.match(err.stderr, usage);
      assert.ok(!err.stderr.includes("Run `wazap --help`"), `${args.join(" ")} dumped the user into --help`);
      return true;
    });
  }
});

test("parseLinkChoice treats enter and 1 as QR, 2 as a code, anything else as another try", () => {
  assert.equal(parseLinkChoice(""), "qr");
  assert.equal(parseLinkChoice("1"), "qr");
  assert.equal(parseLinkChoice("  1  "), "qr");
  assert.equal(parseLinkChoice("2"), "code");
  assert.equal(parseLinkChoice("x"), "retry");
});

test("`contacts resync` refuses while a server owns the session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wazap-contacts-"));
  writeFileSync(join(dataDir, "server.lock"), String(process.pid), { mode: 0o600 });
  await assert.rejects(wazap("contacts", "resync", "--data-dir", dataDir), (err) => {
    assert.match(err.stderr, new RegExp(`wazap is running \\(pid ${process.pid}\\)`));
    assert.match(err.stderr, /sync_contacts/);
    return true;
  });
});
