import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

export class MapWorker {
  constructor(root) {
    this.root = root;
    this.sequence = 0;
    this.pending = new Map();
    this.process = null;
  }

  start() {
    if (this.process) return;
    const python = process.env.UNDERSTANDING_MAP_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const child = spawn(python, ["-u", join(this.root, "backend.py")], {
      cwd: this.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.process = child;
    // The worker emits protocol responses only. Keep diagnostic output off MCP stdout.
    child.stderr.on("data", data => process.stderr.write(data));
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
    const fail = () => {
      if (this.process !== child) return;
      this.process = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("地图服务已退出，请重新打开插件。请确认已安装 Python 3.9+。"));
      }
      this.pending.clear();
    };
    child.on("error", fail);
    child.on("exit", fail);
    child.stdin.on("error", fail);
  }

  call(action, params) {
    this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("地图服务响应超时，请重试。"));
      }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, action, ...params }) + "\n");
    });
  }

  close() {
    const child = this.process;
    if (!child) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
    }
  }
}
