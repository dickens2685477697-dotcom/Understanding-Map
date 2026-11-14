import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  entryPoints: [resolve(root, "panel.mjs")],
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  plugins: [{
    name: "mock-map-host",
    setup(builder) {
      builder.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({
        path: "app", namespace: "map-host",
      }));
      builder.onLoad({ filter: /.*/, namespace: "map-host" }, () => ({
        contents: `export class App {
          addEventListener(type, listener) { window.mapHost.listener = listener; }
          connect() { return window.mapHost.connect(); }
          callServerTool(request) { return window.mapHost.call(request); }
        }`,
      }));
    },
  }],
});

function opened(session = "old-session", threadId = "chat-a") {
  return { content: [], _meta: { understandingMap: { session, threadId } } };
}

function failed(code, message) {
  return { isError: true, content: [{ type: "text", text: message }], _meta: { error: { code } } };
}

function fixture(context, call, connect = async () => {}) {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  context.after(() => dom.window.close());
  const calls = [];
  dom.window.Response = Response;
  dom.window.mapHost = {
    connect,
    async call(request) {
      calls.push(request);
      return call(request);
    },
  };
  dom.window.eval(bundle.outputFiles[0].text);
  return { window: dom.window, calls, emit: result => dom.window.mapHost.listener(result) };
}

test("opening errors preserve the Python diagnosis and error code", async context => {
  const page = fixture(context);
  const message = "未找到可用的 Python 3.9+，请安装后重启 Codex。";
  const rejected = assert.rejects(page.window.understandingMapReady, error => {
    assert.equal(error.message, message);
    assert.equal(error.code, "python_missing");
    return true;
  });
  page.emit(failed("python_missing", message));
  await rejected;
  assert.equal(page.calls.length, 0);
});

test("closed host connections explain how to restart Codex without replaying requests", async context => {
  const page = fixture(context, async () => { throw new Error("MCP error: Transport closed"); });
  page.emit(opened());
  await assert.rejects(page.window.understandingMapFetch("map-view.json"), error => {
    assert.equal(error.code, "map_host_disconnected");
    assert.match(error.message, /完整退出并重新打开 Codex/);
    return true;
  });
  assert.equal(page.calls.length, 1);
});

test("an initial host connection failure rejects readiness with restart guidance", async context => {
  const page = fixture(context, undefined, async () => { throw new Error("Not connected"); });
  await assert.rejects(page.window.understandingMapReady, error => {
    assert.equal(error.code, "map_host_disconnected");
    assert.match(error.message, /完整退出并重新打开 Codex/);
    return true;
  });
});

test("backend failures retain their diagnosis and do not replay navigation", async context => {
  const message = "地图后台进程已退出，请重试。";
  const page = fixture(context, async () => failed("map_worker_exited", message));
  page.emit(opened());
  await assert.rejects(page.window.understandingMapFetch("navigate", {
    body: JSON.stringify({ node_id: "node-a" }),
  }), error => {
    assert.equal(error.code, "map_worker_exited");
    assert.equal(error.message, message);
    return true;
  });
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].arguments.node_id, "node-a");
});

test("an expired session reconnects and retries against the same chat", async context => {
  const page = fixture(context, async request => {
    if (request.name === "understanding_map_open") return opened("new-session");
    if (request.arguments.session === "old-session") {
      return failed("map_session_expired", "地图连接已失效");
    }
    return { content: [], _meta: { response: { status: 200, body: { marker: "saved-map" } } } };
  });
  page.emit(opened());
  const response = await page.window.understandingMapFetch("map-view.json");
  assert.deepEqual(await response.json(), { marker: "saved-map" });
  assert.deepEqual(page.calls.map(request => request.name), [
    "understanding_map_request", "understanding_map_open", "understanding_map_request",
  ]);
  assert.equal(page.calls[2].arguments.session, "new-session");
  assert.equal(page.window.understandingMapBinding.threadId, "chat-a");
});

test("session recovery rejects a binding to another chat before retrying", async context => {
  const page = fixture(context, async request => request.name === "understanding_map_open"
    ? opened("other-session", "chat-b")
    : failed("map_session_expired", "地图连接已失效"));
  page.emit(opened());
  await assert.rejects(page.window.understandingMapFetch("map-view.json"), /当前聊天与地图不一致/);
  assert.equal(page.calls.length, 2);
  assert.equal(page.window.understandingMapBinding.threadId, "chat-a");
});

test("a host disconnect during session recovery keeps the restart guidance", async context => {
  const page = fixture(context, async request => {
    if (request.name === "understanding_map_open") throw new Error("Transport closed");
    return failed("map_session_expired", "地图连接已失效");
  });
  page.emit(opened());
  await assert.rejects(page.window.understandingMapFetch("map-view.json"), error => {
    assert.equal(error.code, "map_host_disconnected");
    assert.match(error.message, /完整退出并重新打开 Codex/);
    return true;
  });
  assert.equal(page.calls.length, 2);
});

test("invalid backend responses have a displayable error code", async context => {
  const page = fixture(context, async () => ({ content: [] }));
  page.emit(opened());
  await assert.rejects(page.window.understandingMapFetch("map-view.json"), error => {
    assert.equal(error.code, "map_invalid_response");
    assert.match(error.message, /无效响应/);
    return true;
  });
});
