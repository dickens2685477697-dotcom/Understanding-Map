import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { currentThread } from "./context.mjs";
import { MapWorker } from "./worker.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const panelHtml = await readFile(join(root, "dist/panel.html"), "utf8");
const panelRevision = createHash("sha256").update(panelHtml).digest("hex").slice(0, 12);
const resourceUri = `ui://understanding-map/panel-${panelRevision}.html`;
const worker = new MapWorker(root);
const server = new McpServer({ name: "understanding-map", title: "Understanding Map", version: "0.4.4" });

function toolError(error) {
  return { content: [{ type: "text", text: error.message }], isError: true,
    _meta: { error: { code: error.code || "map_request_failed", message: error.message } } };
}

registerAppResource(server, "理解地图", resourceUri, {}, async () => ({
  contents: [{
    uri: resourceUri, mimeType: RESOURCE_MIME_TYPE,
    text: panelHtml,
    _meta: {
      ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] },
    },
  }],
}));

registerAppTool(server, "understanding_map_open", {
  title: "理解地图",
  description: "打开当前聊天的理解地图。支持按层级、按时间查看，刷新更新与点击原文定位。",
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: {
    ui: { resourceUri, visibility: ["app", "model"] },
    "openai/ui": { entrypoints: [{ type: "thread" }] },
  },
}, async (_args, context) => {
  try {
    const threadId = currentThread(context.mcpReq._meta);
    const result = await worker.call("open", { thread_id: threadId });
    return { content: [], _meta: { understandingMap: { session: result.session, threadId } } };
  } catch (error) {
    return toolError(error);
  }
});

registerAppTool(server, "understanding_map_request", {
  title: "理解地图面板操作",
  description: "供理解地图面板读取、更新及定位当前绑定的聊天。",
  inputSchema: z.object({
    session: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    resource: z.enum(["map-view.json", "node-source", "native-navigation", "navigate", "refresh", "refresh-status"]),
    node_id: z.string().min(1).max(256).optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri, visibility: ["app"] } },
}, async (args, context) => {
  try {
    const threadId = currentThread(context.mcpReq._meta);
    const result = await worker.call("request", { thread_id: threadId, session: args.session,
      resource: args.resource, node_id: args.node_id });
    return { content: [], _meta: { response: result } };
  } catch (error) {
    return toolError(error);
  }
});

process.stdin.on("end", () => worker.close());
process.once("exit", () => worker.close());
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { worker.close(); process.exit(0); });
}
await server.connect(new StdioServerTransport());
