import { readdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir, userInfo } from "node:os";

export const profiles = ["", "1", "2"].map((s) => ({
  id: `codex${s}`,
  home: join(homedir(), `.codex${s}`),
}));
const byHome = (home) => profiles.find((p) => p.home === home)?.id;

export async function discover() {
  const uid = userInfo().uid;
  const unix = new Map(
    (await readFile("/proc/net/unix", "utf8"))
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((a) => a.length > 7 && a[3] === "00010000")
      .map((a) => [a[6], a[7]]),
  );
  const all = new Map();
  await Promise.all(
    (await readdir("/proc"))
      .filter((x) => /^\d+$/.test(x))
      .map(async (pid) => {
        const root = `/proc/${pid}`;
        try {
          const status = await readFile(`${root}/status`, "utf8");
          if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== uid) return;
          const comm = status.match(/^Name:\s+(.+)/m)?.[1];
          const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
          all.set(Number(pid), {
            pid: Number(pid),
            ppid,
            comm,
            rssKb: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0),
          });
        } catch {}
      }),
  );
  const endpoints = [];
  for (const row of all.values()) {
    if (!row.comm?.startsWith("codex")) continue;
    try {
      const root = `/proc/${row.pid}`;
      const exe = await readlink(`${root}/exe`);
      if (!basename(exe).startsWith("codex")) continue;
      const args = (await readFile(`${root}/cmdline`, "utf8")).split("\0");
      const env = (await readFile(`${root}/environ`, "utf8")).split("\0");
      const home =
        env.find((x) => x.startsWith("CODEX_HOME="))?.slice(11) ||
        profiles[0].home;
      const profile = byHome(home);
      if (!profile) continue;
      Object.assign(row, {
        profile,
        home,
        exe,
        cwd: await readlink(`${root}/cwd`),
        kind: args.includes("proxy")
          ? "proxy"
          : args.includes("daemon")
            ? "daemon"
            : args.includes("app-server")
              ? "app-server"
              : basename(exe) === "codex"
                ? "terminal"
                : "helper",
        sessions: [],
        sockets: [],
      });
      for (const fd of await readdir(`${root}/fd`)) {
        try {
          const target = await readlink(`${root}/fd/${fd}`);
          if (/\/rollout-[^/]+\.jsonl$/.test(target)) row.sessions.push(target);
          const inode = target.match(/^socket:\[(\d+)\]$/)?.[1];
          if (row.kind === "app-server" && unix.has(inode))
            row.sockets.push(unix.get(inode));
        } catch {}
      }
      row.sessions = [...new Set(row.sessions)];
      for (const socket of row.sockets)
        endpoints.push({
          socket,
          profile,
          home,
          pid: row.pid,
          executable: exe,
        });
    } catch {}
  }
  // Helpers and tool subprocesses inherit the nearest Codex ancestor, but no
  // command lines or environment values are returned to the browser.
  const related = new Map([...all].filter(([, v]) => v.profile));
  for (let pass = 0; pass < 30; pass++) {
    let added = false;
    for (const [pid, row] of all) {
      if (related.has(pid) || !related.has(row.ppid)) continue;
      const parent = related.get(row.ppid);
      related.set(pid, {
        ...row,
        profile: parent.profile,
        kind: "tool",
        sessions: [],
      });
      added = true;
    }
    if (!added) break;
  }
  return {
    processes: [...related.values()].sort((a, b) => a.pid - b.pid),
    endpoints,
  };
}
