import { CodexRpc } from "../server/rpc.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, readlink } from "node:fs/promises";

const sockets = new Map();
const unix = new Map(
  (await readFile("/proc/net/unix", "utf8"))
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((a) => a.length > 7 && a[3] === "00010000")
    .map((a) => [a[6], a[7]]),
);
for (const pid of (await readdir("/proc")).filter((x) => /^\d+$/.test(x))) {
  try {
    const root = `/proc/${pid}`;
    const args = (await readFile(`${root}/cmdline`, "utf8")).split("\0");
    if (!args.includes("app-server") || args.includes("proxy")) continue;
    const env = (await readFile(`${root}/environ`, "utf8")).split("\0");
    const home =
      env.find((x) => x.startsWith("CODEX_HOME="))?.slice(11) ||
      join(homedir(), ".codex");
    for (const f of await readdir(`${root}/fd`)) {
      try {
        const inode = (await readlink(`${root}/fd/${f}`)).match(
          /^socket:\[(\d+)\]$/,
        )?.[1];
        if (unix.has(inode)) sockets.set(unix.get(inode), { home, pid });
      } catch {}
    }
  } catch {}
}
for (const [socket, info] of sockets) {
  const rpc = new CodexRpc({ socket, home: info.home });
  try {
    await rpc.connect();
    const loaded = await rpc.request("thread/loaded/list", { limit: 100 });
    const threads = [];
    for (const id of loaded.data) {
      const { thread } = await rpc.request("thread/read", {
        threadId: id,
        includeTurns: false,
      });
      threads.push({
        id,
        status: thread.status,
        cwd: thread.cwd,
        name: thread.name,
        source: thread.source,
      });
    }
    console.log(JSON.stringify({ ...info, socket, threads }));
  } catch (e) {
    console.log(JSON.stringify({ ...info, socket, error: e.message }));
  } finally {
    rpc.close();
  }
}
