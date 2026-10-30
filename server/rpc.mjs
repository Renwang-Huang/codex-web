import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import net from "node:net";

export class RpcError extends Error {
  constructor(message, code = "RPC_ERROR", uncertain = false) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}

// A single connection never retries a business request. A lost response to a
// write means its outcome is unknown, even if reconnecting later succeeds.
export class CodexRpc extends EventEmitter {
  constructor({
    socket,
    home,
    executable = "codex",
    spawnImpl = spawn,
    experimentalApi = false,
  }) {
    super();
    Object.assign(this, {
      socket,
      home,
      executable,
      spawnImpl,
      experimentalApi,
    });
    this.seq = 0;
    this.pending = new Map();
    this.ready = false;
  }
  async connect() {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
  async open() {
    const receive = (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method) {
        this.emit(msg.id === undefined ? "notification" : "request", msg);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.message, msg.error.code));
      else p.resolve(msg.result);
    };
    if (!this.socket)
      this.child = this.spawnImpl(this.executable, ["app-server", "--stdio"], {
        env: { ...process.env, CODEX_HOME: this.home },
        stdio: ["pipe", "pipe", "pipe"],
      });
    const fail = () => {
      this.ready = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(
          new RpcError(
            "Codex 连接已断开；写操作的执行结果需要核对",
            "DISCONNECTED",
            p.write,
          ),
        );
        this.pending.delete(id);
      }
      this.emit("disconnect");
    };
    if (this.socket) {
      this.ws = new WebSocket("ws://localhost/", {
        createConnection: () => net.connect(this.socket),
        handshakeTimeout: 5000,
        maxPayload: 32 * 1024 * 1024,
      });
      this.ws.on("message", receive);
      this.ws.on("close", fail);
      this.ws.on("error", fail);
      await new Promise((resolve, reject) => {
        this.ws.once("open", resolve);
        this.ws.once("error", reject);
      });
    } else {
      this.child.stderr.on("data", () => {}); // May contain provider/private data.
      this.child.on("error", fail);
      this.child.on("exit", fail);
      createInterface({ input: this.child.stdout }).on("line", receive);
    }
    try {
      await this.request(
        "initialize",
        {
          clientInfo: {
            name: "codex_web",
            title: "Codex Web",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: this.experimentalApi,
            requestAttestation: false,
          },
        },
        { timeout: 8000 },
      );
      this.notify("initialized", {});
      this.ready = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  send(msg) {
    const data = JSON.stringify(msg);
    if (this.socket) {
      if (this.ws?.readyState !== WebSocket.OPEN)
        throw new RpcError("Codex 未连接", "DISCONNECTED");
      this.ws.send(data);
    } else {
      if (
        !this.child ||
        this.child.exitCode !== null ||
        this.child.stdin.destroyed
      )
        throw new RpcError("Codex 未连接", "DISCONNECTED");
      this.child.stdin.write(data + "\n");
    }
  }
  notify(method, params) {
    this.send({ method, params });
  }
  request(method, params = {}, { write = false, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RpcError(
            "Codex 响应超时；请先核对会话再决定是否重发",
            "TIMEOUT",
            write,
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, write });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  respond(id, result) {
    this.send({ id, result });
  }
  close() {
    this.ready = false;
    this.ws?.terminate();
    this.child?.kill("SIGTERM");
  }
}
