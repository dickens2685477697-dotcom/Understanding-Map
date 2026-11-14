import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

const pythonProbe = 'import json,sys;print(json.dumps({"version":list(sys.version_info[:3]),"executable":sys.executable}))';

function workerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function closedError() {
  return workerError("map_worker_closed", "地图服务已关闭，请重新打开理解地图。");
}

export class MapWorker {
  constructor(root, { platform = process.platform, env = process.env, spawnProcess = spawn } = {}) {
    this.root = root;
    this.platform = platform;
    this.env = { ...env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
    this.spawnProcess = spawnProcess;
    this.sequence = 0;
    this.pending = new Map();
    this.process = null;
    this.starting = null;
  }

  async probePython(candidate, startup) {
    return new Promise(resolve => {
      let child;
      let output = "";
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (startup.child === child) startup.child = null;
        resolve(result);
      };
      const timer = setTimeout(() => { finish(null); this.stopProcess(child); }, 5000);
      try {
        child = this.spawnProcess(candidate.command, [...candidate.args, "-u", "-c", pythonProbe], {
          cwd: this.root, env: this.env, stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true, detached: this.platform !== "win32", signal: startup.controller.signal,
        });
        startup.child = child;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", data => { output = (output + data).slice(0, 8192); });
        child.once("error", () => finish(null));
        child.once("close", code => {
          if (code !== 0) return finish(null);
          try {
            const result = JSON.parse(output);
            const valid = Array.isArray(result.version) && result.version.length >= 2
              && result.version.slice(0, 2).every(Number.isInteger)
              && typeof result.executable === "string" && result.executable.length > 0;
            finish(valid ? result : null);
          } catch { finish(null); }
        });
      } catch { finish(null); }
    });
  }

  async selectPython(startup) {
    const configured = this.env.UNDERSTANDING_MAP_PYTHON;
    const candidates = configured ? [{ command: configured, args: [] }]
      : this.platform === "win32"
        ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] }]
        : [{ command: "python3", args: [] }];
    let unsupported = false;
    for (const candidate of candidates) {
      if (startup.controller.signal.aborted) throw closedError();
      const result = await this.probePython(candidate, startup);
      if (startup.controller.signal.aborted) throw closedError();
      if (!result) continue;
      const [major, minor] = result.version;
      if (major > 3 || (major === 3 && minor >= 9)) return result.executable;
      unsupported = true;
    }
    if (unsupported) {
      throw workerError("python_version_unsupported", "地图需要 Python 3.9+，检测到的 Python 版本过低，请更新后重新打开 Codex。");
    }
    if (configured) {
      throw workerError("python_config_invalid", "指定的 Python 无法使用，请检查 UNDERSTANDING_MAP_PYTHON 是否指向 Python 3.9+ 可执行文件。");
    }
    throw workerError("python_missing", "未找到可用的 Python 3.9+，请安装 Python 后完全退出并重新打开 Codex。");
  }

  startBackend(python, startup) {
    if (startup.controller.signal.aborted) throw closedError();
    return new Promise((resolve, reject) => {
      let child;
      let spawned = false;
      const fail = error => {
        reject(startup.controller.signal.aborted ? closedError() : error);
        if (this.process !== child) return;
        this.process = null;
        this.rejectPending(error);
        this.stopProcess(child);
      };
      try {
        child = this.spawnProcess(python, ["-u", join(this.root, "backend.py")], {
          cwd: this.root, env: this.env, stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true, detached: this.platform !== "win32", signal: startup.controller.signal,
        });
        startup.child = child;
        child.stderr.on("data", data => process.stderr.write(data));
        child.once("spawn", () => {
          if (startup.controller.signal.aborted) { this.stopProcess(child); reject(closedError()); return; }
          spawned = true;
          this.process = child;
          resolve(child);
        });
        child.on("error", () => fail(workerError(spawned ? "map_worker_exited" : "map_worker_start_failed",
          spawned ? "地图后台进程已退出，请重新打开理解地图。" : "Python 已找到，但地图后台进程未能启动，请重试。")));
        child.once("close", () => fail(workerError(spawned ? "map_worker_exited" : "map_worker_start_failed",
          spawned ? "地图后台进程已退出，请重新打开理解地图。" : "地图后台进程启动后立即退出，请检查 Python 和插件安装是否完整。")));
        child.stdin.on("error", () => fail(workerError("map_worker_write_failed", "地图后台连接已中断，请重新打开理解地图。")));
        createInterface({ input: child.stdout }).on("line", line => {
          let response;
          try { response = JSON.parse(line); } catch { return; }
          const request = this.pending.get(response.id);
          if (!request) return;
          this.pending.delete(response.id);
          clearTimeout(request.timer);
          if (response.error) {
            const error = new Error(response.error);
            error.code = response.error_code;
            request.reject(error);
          } else request.resolve(response.result);
        });
      } catch {
        reject(workerError("map_worker_start_failed", "Python 已找到，但地图后台进程未能启动，请重试。"));
      }
    });
  }

  start() {
    if (this.process) return Promise.resolve(this.process);
    if (this.starting) return this.starting.promise;
    const startup = { controller: new AbortController(), child: null };
    this.starting = startup;
    startup.promise = this.selectPython(startup).then(python => this.startBackend(python, startup))
      .finally(() => { if (this.starting === startup) this.starting = null; });
    return startup.promise;
  }

  async call(action, params) {
    const child = await this.start();
    if (this.process !== child || child.killed || child.exitCode !== null) {
      throw workerError("map_worker_exited", "地图后台进程已退出，请重新打开理解地图。");
    }
    const id = ++this.sequence;
    const payload = JSON.stringify({ id, action, ...params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.process = null;
        this.rejectPending(workerError("map_worker_timeout", "地图服务响应超时，请重试。"));
        this.stopProcess(child);
      }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(payload); }
      catch {
        this.process = null;
        this.rejectPending(workerError("map_worker_write_failed", "地图后台连接已中断，请重新打开理解地图。"));
        this.stopProcess(child);
      }
    });
  }

  rejectPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  stopProcess(child) {
    if (!child) return;
    const kill = () => { try { child.kill(); } catch {} };
    if (!Number.isInteger(child.pid) || child.pid <= 0) { kill(); return; }
    if (this.platform === "win32") {
      try {
        const killer = this.spawnProcess("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", kill);
        killer.once("exit", code => { if (code) kill(); });
      } catch { kill(); }
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { kill(); }
    }
  }

  close() {
    const startup = this.starting;
    const children = new Set([this.process, startup?.child]);
    this.process = null;
    this.starting = null;
    this.rejectPending(closedError());
    startup?.controller.abort();
    for (const child of children) this.stopProcess(child);
  }
}
