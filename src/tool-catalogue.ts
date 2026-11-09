/** Advertise current tools only; the SDK still validates hidden compatibility calls. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef } from "./tool-runtime.js";

/** What a remote session's tools that name host files add to their description: what to use instead. */
export const REMOTE_FILES_NOTE =
  "\nThis remote session cannot use file_path or save_to. Use a public HTTP(S) url, data_base64 for a file up to 5 MB (send_message), a forward of an existing message, or get_media without save_to.";

/**
 * What tools/list answers for these definitions: the zod schemas turned into
 * JSON Schema, legacy names left out. Pure, so one answer serves every session
 * with the same tools (tool-runtime.ts keeps it per permission key).
 */
export function buildToolCatalogue(defs: readonly ToolDef[], allowLocalFiles: boolean): readonly Tool[] {
  return defs.filter((def) => !def.legacyRead).map((def) => ({
    name: def.name, title: def.title,
    description: def.description + (allowLocalFiles === false && (def.schema.file_path || def.schema.save_to)
      ? REMOTE_FILES_NOTE : ""),
    inputSchema: toJsonSchemaCompat(z.object(def.schema), { strictUnions: true, pipeStrategy: "input" }) as Tool["inputSchema"],
    ...(def.outputSchema === undefined ? {} : { outputSchema: toJsonSchemaCompat(
      def.outputSchema instanceof z.ZodType ? def.outputSchema : z.object(def.outputSchema),
      { strictUnions: true, pipeStrategy: "output" }) as Tool["outputSchema"] }),
    annotations: def.hints,
  }));
}

export function publishToolCatalogue(server: McpServer, tools: readonly Tool[]): void {
  // Small test doubles only collect handlers; a real MCP server always has this public API.
  if (server.server === undefined) return;
  // Replace only tools/list after registration. tools/call stays SDK-owned: parsing,
  // output validation, permissions and limits also apply to unlisted legacy names.
  // The array is shared between sessions and only ever serialized, never changed.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools as Tool[] }));
}
