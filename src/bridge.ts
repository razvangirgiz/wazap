import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WAZAP_VERSION } from "./config.js";
import { readDaemon, type DaemonInfo } from "./daemon.js";
import { log } from "./logger.js";

const HEARTBEAT_MS = 1_000;

/**
 * Serve this client from the session another process already owns: an MCP server
 * on our stdio, every tool call forwarded to the daemon's loopback endpoint and
 * its answer returned untouched.
 *
 * `daemonFile` is here because the heartbeat re-reads the sidecar, and DaemonInfo
 * carries no path.
 */
export async function runBridge(
  daemon: DaemonInfo,
  daemonFile: string,
  readOnly = false,
  accountIds?: string[],
): Promise<void> {
  let left = false;
  /** Exit 1 so the client restarts us, and the restart becomes the new daemon. */
  const leave = (reason: string): void => {
    if (left) return;
    left = true;
    log(`${reason}, exiting so the next start can own the session`);
    process.exit(1);
  };

  const client = new Client({ name: "wazap-bridge", version: WAZAP_VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${daemon.port}/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${daemon.token}`,
            "x-wazap-read-only": readOnly ? "1" : "0",
            ...(accountIds ? { "x-wazap-accounts": accountIds.join(",") } : {}),
          },
        },
      },
    ),
  );

  const caps = client.getServerCapabilities() ?? {};
  const server = new Server(
    client.getServerVersion() ?? { name: "wazap", version: daemon.version },
    {
      // Only what we forward: the daemon has no resources, and we have no handler
      // for them. The SDK refuses a handler for a capability we did not declare,
      // so the prompts pair is registered under the same condition.
      capabilities: {
        tools: caps.tools ?? {},
        ...(caps.prompts ? { prompts: caps.prompts } : {}),
      },
      instructions: client.getInstructions(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, (req) =>
    client.request(
      { method: "tools/list", params: req.params },
      ListToolsResultSchema,
    ),
  );
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    client.request(
      { method: "tools/call", params: req.params },
      CallToolResultSchema,
    ),
  );
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (req) =>
      client.request(
        { method: "prompts/list", params: req.params },
        ListPromptsResultSchema,
      ),
    );
    server.setRequestHandler(GetPromptRequestSchema, (req) =>
      client.request(
        { method: "prompts/get", params: req.params },
        GetPromptResultSchema,
      ),
    );
  }

  client.onclose = () =>
    leave(`the session holder (pid ${daemon.pid}) closed the connection`);
  client.onerror = () =>
    leave(`lost the connection to the session holder (pid ${daemon.pid})`);
  // A dead daemon does not close the client: the transport retries its stream and
  // reports nothing, measured. So the liveness of the pid is ours to watch.
  const heartbeat = setInterval(() => {
    if (readDaemon(daemonFile)?.pid !== daemon.pid) {
      leave(`the session holder (pid ${daemon.pid}) gave up the session`);
      return;
    }
    try {
      process.kill(daemon.pid, 0);
    } catch {
      leave(`the session holder (pid ${daemon.pid}) is gone`);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  await server.connect(new StdioServerTransport());
  log(`sharing the WhatsApp session held by pid ${daemon.pid}`);

  // Our own client leaving is not a failure. The upstream stream holds the event
  // loop open, so without this the bridge outlives the client it was started for.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
