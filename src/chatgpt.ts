import type { Config } from "./config.js";

/** Read-only guidance: never publishes a tunnel, changes credentials or claims a live connection. */
export function chatgptConnectionGuide(config: Config) {
  let endpoint: string | null = null;
  if (config.publicUrl) {
    try {
      const url = new URL(config.publicUrl);
      if (url.protocol === "https:" && !url.username && !url.password &&
          url.pathname === "/" && !url.search && !url.hash) endpoint = `${url.origin}/mcp`;
    } catch { /* Invalid configuration is reported without echoing a possible secret. */ }
  }
  const configured = endpoint !== null && Boolean(config.oauthPassword) && config.transport === "http";
  return {
    state: configured ? "configured" : "setup_required",
    connection_verified: false,
    endpoint,
    steps: [
      ...(!configured ? ["Configure WAZAP_TRANSPORT=http, WAZAP_PUBLIC_URL as your HTTPS origin and WAZAP_OAUTH_PASSWORD in the installation .env. Use a unique strong password; do not paste it into chat."] : []),
      "Start or restart the Wazap service on the host that holds your WhatsApp accounts. Keep it running while using ChatGPT.",
      "Make the HTTPS endpoint reachable and test it with MCP Inspector. For private development, Secure MCP Tunnel is an alternative; follow the OpenAI guide for its separate setup.",
      "In ChatGPT, enable Developer mode if your account/workspace permits it. Open Plugins, add an MCP connection and enter the MCP URL (or select your configured tunnel).",
      "Authenticate on Wazap's page. Select only the accounts you want to share; begin with read access. Passwords and bearer tokens belong in authentication, never in a conversation.",
      "If connected but no actions appear, refresh the plugin in ChatGPT settings. Start a new chat, enable the connection and ask: List my WhatsApp accounts. Then ask for recent messages from one account by name.",
      "If authorization expires or is revoked, reconnect in ChatGPT. To authorize additional accounts or writes, repeat consent; never change the sending account to work around an access error.",
    ],
    docs: "https://developers.openai.com/plugins/deploy/connect-chatgpt",
  };
}

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { paths } from "./config.js";
import { ask } from "./cli.js";
import { say } from "./logger.js";
import { setEnvSetting } from "./settings.js";
import { installService, pickSupervisor, INSTALL_WAIT_MS, readService } from "./service.js";
import { runExpose } from "./expose.js";
import type { Install } from "./connect.js";
import type { Wizard } from "./wizard.js";

/** A service installed by Wazap uses --http even when an interactive CLI defaults to stdio. */
export function effectiveChatgptConfig(config: Config, reload = false): Config {
  const root = config.rootDataDir ?? config.dataDir;
  let saved: Record<string, string> = {};
  try { saved = dotenv.parse(readFileSync(paths(root).envFile)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const service = readService(root);
  return {
    ...config,
    publicUrl: reload && "WAZAP_PUBLIC_URL" in saved ? saved.WAZAP_PUBLIC_URL || null : config.publicUrl,
    oauthPassword: reload && "WAZAP_OAUTH_PASSWORD" in saved ? saved.WAZAP_OAUTH_PASSWORD || null : config.oauthPassword,
    transport: service || saved.WAZAP_TRANSPORT === "http" ? "http" : config.transport,
  };
}

export async function checkChatgptEndpoint(config: Config, request: typeof fetch = fetch): Promise<{ ready: boolean; detail: string }> {
  const guide = chatgptConnectionGuide(config);
  if (!guide.endpoint || !config.oauthPassword)
    return { ready: false, detail: "HTTPS and sign-in are not configured yet." };
  const origin = new URL(guide.endpoint).origin;
  const isIssuer = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    try { return new URL(value).href === new URL(origin).href; } catch { return false; }
  };
  const signal = AbortSignal.timeout(8_000);
  try {
    const resourceResponse = await request(`${origin}/.well-known/oauth-protected-resource/mcp`, { signal, redirect: "error" });
    if (!resourceResponse.ok) return { ready: false, detail: "The HTTPS URL does not serve Wazap's sign-in discovery. Check the tunnel and restart the Wazap service." };
    const resource = await resourceResponse.json() as Record<string, unknown>;
    if (resource.resource !== guide.endpoint || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.some(isIssuer))
      return { ready: false, detail: "Sign-in discovery does not match this MCP URL. Check WAZAP_PUBLIC_URL and restart the service." };
    const authResponse = await request(`${origin}/.well-known/oauth-authorization-server`, { signal, redirect: "error" });
    const auth = authResponse.ok ? await authResponse.json() as Record<string, unknown> : {};
    if (!isIssuer(auth.issuer) || auth.authorization_endpoint !== `${origin}/authorize` || auth.token_endpoint !== `${origin}/token`)
      return { ready: false, detail: "The sign-in server is unavailable or advertises a different URL. Check WAZAP_PUBLIC_URL and restart the service." };
    const challenge = await request(guide.endpoint, {
      method: "POST", signal, redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wazap-setup-check", version: "1" } } }),
    });
    await challenge.body?.cancel();
    if (challenge.status !== 401 || !challenge.headers.get("www-authenticate")?.includes("resource_metadata"))
      return { ready: false, detail: "The MCP endpoint did not request sign-in as expected. Check its authentication configuration before connecting ChatGPT." };
    return { ready: true, detail: "HTTPS, sign-in discovery and the MCP authentication challenge are verified. The first read in ChatGPT is still pending." };
  } catch {
    return { ready: false, detail: "Could not verify the HTTPS endpoint within 8 seconds. Check that the service and tunnel are running, then run setup again. No account was disconnected." };
  }
}

export async function chatgptSetup(config: Config, opts: { install: Install; wizard: Wizard | null; remember?: (line: string) => void }): Promise<boolean> {
  if (config.dryRun) return false;
  const w = opts.wizard;
  const prompt = (text: string) => w ? w.prompt(text) : ask(text);
  const show = async (lines: string[]) => {
    if (w) await w.paint(lines, { reveal: false });
    else for (const line of lines) say(line);
  };
  if (config.keepRunning === "service") await installService(config, pickSupervisor(), INSTALL_WAIT_MS, opts.install);
  let effective = effectiveChatgptConfig(config);
  let guide = chatgptConnectionGuide(effective);
  if (!guide.endpoint) {
    await show([
      "ChatGPT needs access to this computer while Wazap is running.",
      "1. Set up HTTPS here (background service and a tunnel)",
      "2. Use an HTTPS address I already manage",
      "3. Later — keep the linked account and stop here",
    ]);
    const choice = config.keepRunning === "expose" ? "1"
      : !process.stdin.isTTY || config.assumeYes ? "3"
      : (await prompt("Choose [3]: ")).trim() || "3";
    if (choice === "1") {
      if (opts.install.kind === "npx") {
        await show(["A stable installation is needed for the background service.", "Install wazap-mcp globally, then run `wazap setup --client chatgpt` again."]);
        return false;
      }
      await installService(config, pickSupervisor(), INSTALL_WAIT_MS, opts.install);
      await runExpose({ ...config, args: [] });
      effective = effectiveChatgptConfig(config, true);
    } else if (choice === "2") {
      const address = (await prompt("HTTPS address (for example https://wazap.example.com): ")).trim();
      const candidate = { ...effective, publicUrl: address };
      if (!chatgptConnectionGuide(candidate).endpoint) {
        await show(["Use an HTTPS origin without a path, password or query string. No settings were changed.", "Run setup again to retry."]);
        return false;
      }
      const origin = new URL(address).origin;
      setEnvSetting(paths(config.rootDataDir ?? config.dataDir).envFile, "WAZAP_PUBLIC_URL", origin);
      effective = { ...candidate, publicUrl: origin };
    } else {
      await show([choice === "3" ? "ChatGPT connection saved for later. Your linked account is kept." : "No valid connection method selected. No settings were changed."]);
      return false;
    }
  }
  if (!effective.oauthPassword) {
    const password = randomBytes(24).toString("base64url");
    setEnvSetting(paths(config.rootDataDir ?? config.dataDir).envFile, "WAZAP_OAUTH_PASSWORD", password);
    effective = { ...effective, oauthPassword: password };
    await show(["Sign-in password created. Save it in your password manager.", password, "Enter it only on Wazap's sign-in page, never in a chat."]);
    if (process.stdin.isTTY && !config.assumeYes) await prompt("Press Enter when saved: ");
  }
  const root = config.rootDataDir ?? config.dataDir;
  if (effective.transport !== "http") setEnvSetting(paths(root).envFile, "WAZAP_TRANSPORT", "http");
  effective = { ...effective, transport: "http" };
  guide = chatgptConnectionGuide(effective);
  let checked = await checkChatgptEndpoint(effective);
  if (!checked.ready && process.stdin.isTTY && !config.assumeYes) {
    await show([checked.detail, "1. Start or restart the background service here", "2. Retry the connection check", "3. Finish later"]);
    const answer = (await prompt("Choose [3]: ")).trim() || "3";
    if (answer === "1") {
      await installService(effective, pickSupervisor(), INSTALL_WAIT_MS, opts.install);
      checked = await checkChatgptEndpoint(effective);
    } else if (answer === "2") checked = await checkChatgptEndpoint(effective);
  }
  opts.remember?.(checked.detail);
  const steps = [
    checked.detail,
    `MCP URL: ${guide.endpoint}`,
    "In ChatGPT, enable Developer mode if available for your account, then add Wazap in Plugins using this URL.",
    "Sign in on the Wazap page and select the accounts to share. Begin with read access.",
    'If no actions appear, refresh Wazap in ChatGPT settings. Start a new chat, enable Wazap and ask: "List my WhatsApp accounts."',
  ];
  if (!checked.ready) steps.push("Start or restart the background service after changing sign-in settings. Run `wazap setup --client chatgpt` again to recheck.");
  await show(steps);
  // Also keep connection instructions after the full-screen wizard exits.
  if (w && process.stdin.isTTY && !config.assumeYes) await prompt("Press Enter to continue; the first read in ChatGPT is still pending: ");
  return checked.ready;
}
