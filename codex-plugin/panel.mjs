import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "Understanding Map", version: "0.4.3" }, {}, { autoResize: true });
let resolveBinding;
let rejectBinding;
let reconnecting = null;
window.understandingMapReady = new Promise((resolve, reject) => {
  resolveBinding = resolve;
  rejectBinding = reject;
});

app.addEventListener("toolresult", result => {
  const binding = result._meta?.understandingMap;
  if (binding?.session && binding?.threadId) {
    window.understandingMapBinding = binding;
    resolveBinding(binding);
  } else if (result.isError) {
    rejectBinding(new Error(result.content?.find(item => item.type === "text")?.text || "地图打开失败。"));
  }
});

function toolResult(result) {
  if (!result.isError) return result;
  const error = new Error(result.content?.find(item => item.type === "text")?.text || "地图操作失败。");
  error.code = result._meta?.error?.code;
  throw error;
}

async function reconnect(binding) {
  if (!reconnecting) {
    reconnecting = app.callServerTool({ name: "understanding_map_open", arguments: {} }).then(result => {
      const replacement = toolResult(result)._meta?.understandingMap;
      if (!replacement?.session || replacement.threadId !== binding.threadId) {
        throw new Error("当前聊天与地图不一致，请从当前聊天重新打开理解地图。");
      }
      window.understandingMapBinding = replacement;
      return replacement;
    }).finally(() => { reconnecting = null; });
  }
  return reconnecting;
}

window.understandingMapFetch = async (input, options = {}) => {
  await window.understandingMapReady;
  const binding = window.understandingMapBinding;
  const url = new URL(input, "https://understanding-map.invalid/");
  const resource = url.pathname.slice(1);
  const nodeId = url.searchParams.get("id") || (options.body ? JSON.parse(options.body).node_id : undefined);
  const request = current => app.callServerTool({
    name: "understanding_map_request",
    arguments: { session: current.session, resource, ...(nodeId ? { node_id: nodeId } : {}) },
  });
  let result;
  try {
    result = toolResult(await request(binding));
  } catch (error) {
    // Older desktop hosts turn isError results into rejected JSON-RPC calls.
    const expired = error.code === "map_session_expired" || error.message?.includes("地图连接已失效");
    if (!expired) throw error;
    const replacement = window.understandingMapBinding !== binding ? window.understandingMapBinding : await reconnect(binding);
    result = toolResult(await request(replacement));
  }
  const response = result._meta?.response;
  if (!response) throw new Error("地图服务返回了无效响应。");
  return new Response(JSON.stringify(response.body), {
    status: response.status, headers: { "Content-Type": "application/json" },
  });
};

app.connect().catch(rejectBinding);
