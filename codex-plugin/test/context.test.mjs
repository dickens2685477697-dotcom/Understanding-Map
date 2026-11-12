import assert from "node:assert/strict";
import test from "node:test";
import { currentThread } from "../context.mjs";

test("accepts desktop thread metadata in object or serialized form", () => {
  assert.equal(currentThread({ "x-codex-turn-metadata": { thread_id: "chat-1" } }), "chat-1");
  assert.equal(currentThread({ "x-codex-turn-metadata": '{"thread_id":"chat-1"}' }), "chat-1");
  assert.equal(currentThread({ "openai/threadId": "chat-1", thread: { id: "chat-1" } }), "chat-1");
  assert.equal(currentThread({ threadId: "chat-1", thread_id: "chat-1" }), "chat-1");
});

test("rejects missing, conflicting and invalid chat identifiers", () => {
  assert.throws(() => currentThread({}));
  assert.throws(() => currentThread({ threadId: "../chat" }));
  assert.throws(() => currentThread({ threadId: "chat-1", "openai/threadId": "chat-2" }));
});
