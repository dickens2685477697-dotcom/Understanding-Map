import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MapWorker } from "../worker.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.exitCode = null;
  child.killed = false;
  child.finish = (code = 0) => {
    child.exitCode = code;
    child.stdout.end();
    child.emit("close", code, null);
  };
  child.kill = () => {
    if (!child.killed) {
      child.killed = true;
      queueMicrotask(() => child.finish(null));
    }
    return true;
  };
  return child;
}

function probeResult(version = [3, 11, 0], executable = "tested-python") {
  const child = fakeChild();
  queueMicrotask(() => {
    child.stdout.write(JSON.stringify({ version, executable }));
    child.finish();
  });
  return child;
}

function echoBackend(onRequest = () => {}) {
  const child = fakeChild();
  child.stdin.on("data", data => {
    const request = JSON.parse(data.toString());
    onRequest(request);
    child.stdout.write(JSON.stringify({ id: request.id, result: request.value }) + "\n");
  });
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("Windows probes launchers and versions before using the actual Python executable", async () => {
  const calls = [];
  const worker = new MapWorker("fixture", {
    platform: "win32", env: {},
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      if (command === "py") {
        const child = fakeChild();
        queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
        return child;
      }
      if (command === "python") return probeResult([3, 8, 10]);
      if (command === "python3") return probeResult([3, 11, 1], "C:\\Python311\\python.exe");
      assert.equal(command, "C:\\Python311\\python.exe");
      return echoBackend();
    },
  });
  try {
    assert.equal(await worker.call("echo", { value: "中文😀" }), "中文😀");
    assert.deepEqual(calls.map(call => call.command), ["py", "python", "python3", "C:\\Python311\\python.exe"]);
    assert.deepEqual(calls[0].args.slice(0, 2), ["-3", "-u"]);
    for (const { options } of calls) {
      assert.equal(options.env.PYTHONUTF8, "1");
      assert.equal(options.env.PYTHONIOENCODING, "utf-8");
      assert.equal(options.windowsHide, true);
    }
  } finally { worker.close(); }
});

test("concurrent calls share one probe and one backend startup", async () => {
  let probes = 0;
  let backends = 0;
  const worker = new MapWorker("fixture", {
    platform: "win32", env: {},
    spawnProcess(command, args) {
      if (args.includes("-c")) { probes++; return probeResult(); }
      backends++;
      return echoBackend();
    },
  });
  try {
    assert.deepEqual(await Promise.all([1, 2, 3].map(value => worker.call("echo", { value }))), [1, 2, 3]);
    assert.equal(probes, 1);
    assert.equal(backends, 1);
    assert.equal(worker.pending.size, 0);
  } finally { worker.close(); }
});

test("missing and unsupported Python produce distinct errors without launching a backend", async () => {
  for (const unsupported of [false, true]) {
    let count = 0;
    const worker = new MapWorker("fixture", {
      platform: "win32", env: {},
      spawnProcess(command, args) {
        count++;
        assert.ok(args.includes("-c"));
        if (unsupported) return probeResult([3, 8, 0]);
        throw new Error("private startup diagnostics");
      },
    });
    await assert.rejects(worker.call("open", {}), error => {
      assert.equal(error.code, unsupported ? "python_version_unsupported" : "python_missing");
      assert.ok(!error.message.includes("private startup diagnostics"));
      return true;
    });
    assert.equal(count, 3);
    assert.equal(worker.starting, null);
    assert.equal(worker.process, null);
    worker.close();
  }
});

test("an explicitly configured Python is checked without silently switching interpreters", async () => {
  const configured = "C:\\Private User\\missing-python.exe";
  const calls = [];
  const worker = new MapWorker("fixture", {
    platform: "win32", env: { UNDERSTANDING_MAP_PYTHON: configured },
    spawnProcess(command) { calls.push(command); throw new Error("sensitive stderr"); },
  });
  await assert.rejects(worker.call("open", {}), error => {
    assert.equal(error.code, "python_config_invalid");
    assert.ok(!error.message.includes(configured));
    assert.ok(!error.message.includes("sensitive stderr"));
    return true;
  });
  assert.deepEqual(calls, [configured]);
  worker.close();
});

test("a backend startup failure can be retried by a later call", async () => {
  let attempts = 0;
  const worker = new MapWorker("fixture", {
    platform: "win32", env: {},
    spawnProcess(command, args) {
      if (args.includes("-c")) return probeResult();
      if (++attempts === 1) throw new Error("private executable path");
      return echoBackend();
    },
  });
  try {
    await assert.rejects(worker.call("echo", { value: "first" }), { code: "map_worker_start_failed" });
    assert.equal(await worker.call("echo", { value: "second" }), "second");
    assert.equal(attempts, 2);
  } finally { worker.close(); }
});

test("backend exit rejects pending calls and a later call starts fresh without replay", async () => {
  let backend;
  let attempts = 0;
  const received = [];
  const worker = new MapWorker("fixture", {
    platform: "win32", env: {},
    spawnProcess(command, args) {
      if (args.includes("-c")) return probeResult();
      attempts++;
      if (attempts > 1) return echoBackend(request => received.push(request.value));
      backend = fakeChild();
      backend.stdin.on("data", data => received.push(JSON.parse(data.toString()).value));
      queueMicrotask(() => backend.emit("spawn"));
      return backend;
    },
  });
  try {
    const requests = [worker.call("echo", { value: "first" }), worker.call("echo", { value: "second" })];
    const outcomes = Promise.allSettled(requests);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(received, ["first", "second"]);
    backend.finish(1);
    for (const result of await outcomes) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "map_worker_exited");
    }
    assert.equal(worker.pending.size, 0);
    assert.equal(await worker.call("echo", { value: "third" }), "third");
    assert.deepEqual(received, ["first", "second", "third"]);
    assert.equal(attempts, 2);
  } finally { worker.close(); }
});

test("closing during Python discovery cancels startup safely and permits a fresh call", async () => {
  let probe;
  let attempts = 0;
  const worker = new MapWorker("fixture", {
    platform: "win32", env: {},
    spawnProcess(command, args) {
      if (args.includes("-c")) {
        if (++attempts === 1) { probe = fakeChild(); return probe; }
        return probeResult();
      }
      return echoBackend();
    },
  });
  const pending = worker.call("open", {});
  const rejected = assert.rejects(pending, { code: "map_worker_closed" });
  worker.close();
  const reopened = worker.call("echo", { value: "reopened" });
  await rejected;
  assert.equal(probe.killed, true);
  assert.equal(await reopened, "reopened");
  worker.close();
});

test("a broken backend input clears pending work and allows a fresh request", async () => {
  let attempts = 0;
  const worker = new MapWorker("fixture", {
    platform: "win32", env: {},
    spawnProcess(command, args) {
      if (args.includes("-c")) return probeResult();
      if (++attempts > 1) return echoBackend();
      const child = fakeChild();
      child.stdin.on("data", () => child.stdin.emit("error", new Error("private pipe diagnostics")));
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  try {
    await assert.rejects(worker.call("echo", { value: "first" }), { code: "map_worker_write_failed" });
    assert.equal(worker.pending.size, 0);
    assert.equal(await worker.call("echo", { value: "second" }), "second");
    assert.equal(attempts, 2);
  } finally { worker.close(); }
});

test("a failed Windows taskkill falls back without an unhandled error", async () => {
  let backend;
  const worker = new MapWorker("fixture", {
    platform: "win32", env: {},
    spawnProcess(command, args) {
      if (command === "taskkill") {
        const child = fakeChild();
        queueMicrotask(() => child.emit("error", new Error("taskkill unavailable")));
        return child;
      }
      if (args.includes("-c")) return probeResult();
      backend = echoBackend();
      backend.pid = 42;
      return backend;
    },
  });
  assert.equal(await worker.call("echo", { value: true }), true);
  worker.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(backend.killed, true);
});

test("a real Python backend exchanges Chinese and emoji even when the inherited encoding is ASCII", async () => {
  const root = await mkdtemp(join(tmpdir(), "understanding-map-worker-"));
  await writeFile(join(root, "backend.py"), [
    "import json,sys",
    "for line in sys.stdin:",
    "    request=json.loads(line)",
    "    print(json.dumps({'id':request['id'],'result':request['value']},ensure_ascii=False),flush=True)",
    "",
  ].join("\n"));
  const worker = new MapWorker(root, {
    env: { ...process.env, PYTHONUTF8: "0", PYTHONIOENCODING: "ascii" },
  });
  try {
    assert.equal(await worker.call("echo", { value: "中文与 emoji 😀" }), "中文与 emoji 😀");
  } finally {
    worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a response timeout stops the stalled backend so a later call can start fresh", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let backend;
  let attempts = 0;
  const worker = new MapWorker("fixture", {
    platform: "win32", env: {},
    spawnProcess(command, args) {
      if (args.includes("-c")) return probeResult();
      if (++attempts > 1) return echoBackend();
      backend = fakeChild();
      queueMicrotask(() => backend.emit("spawn"));
      return backend;
    },
  });
  try {
    const pending = worker.call("open", {});
    const rejected = assert.rejects(pending, { code: "map_worker_timeout" });
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(90_000);
    await rejected;
    assert.equal(backend.killed, true);
    assert.equal(worker.pending.size, 0);
    assert.equal(await worker.call("echo", { value: "recovered" }), "recovered");
  } finally { worker.close(); }
});
