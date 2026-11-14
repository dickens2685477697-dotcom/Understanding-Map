import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the installed MCP configuration starts the sidebar tool from its plugin directory", async () => {
  const config = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8")).mcpServers.understanding_map;
  assert.equal(config.cwd, ".");
  assert.ok(config.args.every(argument => !argument.includes("${")));
  const client = new Client({ name: "understanding-map-installation-test", version: "1" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: resolve(root, config.cwd),
    env: { PATH: process.env.PATH },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const entry = tools.find(tool => tool.name === "understanding_map_open");
    assert.equal(entry?.title, "理解地图");
    assert.deepEqual(entry._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
    const resource = await client.readResource({ uri: entry._meta.ui.resourceUri });
    const revision = createHash("sha256").update(resource.contents[0].text).digest("hex").slice(0, 12);
    assert.equal(entry._meta.ui.resourceUri, `ui://understanding-map/panel-${revision}.html`, "UI changes receive a new resource cache key");
    assert.match(resource.contents[0].text, /<title>Understanding Map<\/title>/);
    assert.match(resource.contents[0].text, /updateStatus\.textContent=error\.code\?error\.message/);
    assert.doesNotMatch(resource.contents[0].text, /新消息由 Skill 整理后显示/);
  } finally {
    await client.close();
  }
});
