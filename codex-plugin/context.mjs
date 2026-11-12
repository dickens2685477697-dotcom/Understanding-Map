const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function currentThread(metadata = {}) {
  let turn = metadata["x-codex-turn-metadata"];
  if (typeof turn === "string") {
    try { turn = JSON.parse(turn); } catch { turn = null; }
  }
  const candidates = [
    metadata["openai/threadId"], metadata["openai/thread_id"],
    metadata.codexThreadId, metadata.codex_thread_id,
    metadata.threadId, metadata.thread_id, metadata.thread?.id,
    turn?.thread_id,
  ].filter(value => value !== undefined && value !== null);
  if (!candidates.length) throw new Error("插件未收到当前聊天标识，请从 Codex 当前聊天的侧边工具中打开理解地图。");
  if (candidates.some(value => typeof value !== "string" || !SESSION_ID.test(value))) {
    throw new Error("当前聊天标识格式无效。");
  }
  if (new Set(candidates).size !== 1) throw new Error("当前聊天标识不一致，请重新打开地图。");
  return candidates[0];
}
