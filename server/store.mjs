import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const digest = (text) => createHash("sha256").update(text).digest("hex");
export const commandFingerprint = ({ key, text, mode }) =>
  digest(JSON.stringify([key, text, mode]));
const TERMINAL = new Set(["sent", "failed", "cancelled"]);
export const COMMAND_HISTORY_LIMIT = 100;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.data = { commands: [], reviewed: {}, trash: {}, sessionConfigs: {} };
    this.chain = Promise.resolve();
  }
  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.data = JSON.parse(
        await readFile(join(this.dir, "state.json"), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    this.data.trash ||= {};
    this.data.sessionConfigs ||= {};
    for (const c of this.data.commands)
      if (c.state === "sending") {
        c.state = "uncertain";
        c.error = "服务在发送期间退出；请核对会话，禁止自动重发";
      }
    await this.save();
  }
  save() {
    this.chain = this.chain
      .catch(() => {})
      .then(async () => {
        const terminal = this.data.commands.filter((c) =>
          TERMINAL.has(c.state),
        );
        const retired = terminal.slice(
          0,
          Math.max(0, terminal.length - COMMAND_HISTORY_LIMIT),
        );
        if (retired.length) {
          const dir = join(this.dir, "command-receipts");
          await mkdir(dir, { recursive: true, mode: 0o700 });
          // Commit receipts before removing bodies. A crash may leave both
          // records, but must never forget an already executed request ID.
          for (const c of retired) {
            const { id, key, mode, state, createdAt, sentAt, turnId } = c;
            await writeFile(
              join(dir, digest(id) + ".json"),
              JSON.stringify({
                id,
                key,
                mode,
                state,
                createdAt,
                sentAt,
                turnId,
                fingerprint: commandFingerprint(c),
                retained: true,
              }),
              { mode: 0o600 },
            );
          }
          const removed = new Set(retired);
          this.data.commands = this.data.commands.filter(
            (c) => !removed.has(c),
          );
        }
        const data = JSON.stringify(this.data, null, 2);
        const temp = join(this.dir, "state.json.tmp");
        await writeFile(temp, data, { mode: 0o600 });
        await rename(temp, join(this.dir, "state.json"));
      });
    return this.chain;
  }
  async retiredCommand(id) {
    // Wait for any in-progress compaction before looking outside state.json.
    await this.chain;
    try {
      return JSON.parse(
        await readFile(
          join(this.dir, "command-receipts", digest(id) + ".json"),
          "utf8",
        ),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return null;
    }
  }
}
