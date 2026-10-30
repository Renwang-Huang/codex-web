// Coalesce notifications without turning token deltas into history reads.
export class ChangeBatch {
  constructor() {
    this.snapshot = false;
    this.allDetails = false;
    this.keys = new Set();
    this.streams = new Map();
  }
  add(change) {
    if (!change) {
      this.snapshot = true;
      this.allDetails = true;
      return;
    }
    this.snapshot ||= !!change.snapshot;
    this.allDetails ||= !!change.allDetails;
    if (change.delta) {
      const id = JSON.stringify([change.key, change.delta.itemId]);
      const stream = this.streams.get(id) || {
        key: change.key,
        itemId: change.delta.itemId,
        delta: "",
      };
      stream.delta = (stream.delta + change.delta.text).slice(-80000);
      stream.end = change.delta.offset + change.delta.text.length;
      stream.start = stream.end - stream.delta.length;
      this.streams.set(id, stream);
    } else if (change.key) this.keys.add(change.key);
  }
  take() {
    return {
      snapshot: this.snapshot,
      allDetails: this.allDetails,
      keys: [...this.keys],
      streams: [...this.streams.values()],
    };
  }
}

// Scan timestamps and RSS fluctuate while the list's meaning stays the same.
// Reconcile those values on browser wake/reconnect and the 30-second fallback.
export function overviewSignature(snapshot) {
  return JSON.stringify({
    errors: snapshot.errors,
    profiles: snapshot.profiles,
    processes: snapshot.processes.map(({ rssKb, ...p }) => p),
    sessions: snapshot.sessions
      .map(({ updatedAt, ...s }) => s)
      .sort((a, b) => a.key.localeCompare(b.key)),
  });
}
