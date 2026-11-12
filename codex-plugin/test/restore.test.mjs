import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function connect(dataRoot) {
  const client = new Client({ name: "map-restore-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(root, "dist/server.mjs")], cwd: tmpdir(),
    env: { PATH: process.env.PATH, UNDERSTANDING_MAP_HOME: dataRoot }, stderr: "pipe",
  }));
  return client;
}

test("a restored panel connection works in a new MCP process and remains scoped to its chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "understanding-map-restore-test-"));
  const folder = join(directory, "sessions", "fixture-chat");
  const session = "A".repeat(43);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "tracking.json"), JSON.stringify({
    version: 1, session_id: "fixture-chat", interval: 5,
    state_file: join(folder, "state.json"), view_file: join(folder, "map-view.json"),
    view_access_token: session,
  }));
  await writeFile(join(folder, "map-view.json"), JSON.stringify({ nodes: [], marker: "saved-map" }));
  const request = (client, threadId, token = session) => client.callTool({
    name: "understanding_map_request", arguments: { session: token, resource: "map-view.json" },
    _meta: { threadId, thread_id: threadId },
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await connect(directory);
      try {
        const result = await request(client, "fixture-chat");
        assert.equal(result.isError, undefined);
        assert.equal(result._meta.response.body.marker, "saved-map");
        const wrongChat = await request(client, "other-chat");
        assert.equal(wrongChat.isError, true);
        const legacy = await request(client, "fixture-chat", "00000000-0000-4000-8000-000000000001");
        assert.equal(legacy.isError, true);
        assert.equal(legacy._meta.error.code, "map_session_expired");
      } finally {
        await client.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
