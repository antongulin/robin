import { ROBIN_SIGNATURE } from "./github-reviewer";

export interface AgentProgress {
  turn: number;
  maxTurns: number;
  toolCalls: number;
  compactions: number;
  /** "model" while waiting on the LLM, "tool" while running a tool, "compacting" while summarizing. */
  phase: "model" | "tool" | "compacting";
  activity: string;
}

export interface StatusReporterOptions {
  model: string;
  mode: string;
  /** Shown in every status comment, e.g. "v2.8.0 · yoeven/robin@main (9e6bb3d)". */
  version: () => string;
  minIntervalMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * Owns the in-progress status comment. Updates are coalesced (at most one edit per interval,
 * with a trailing edit so the latest state always lands) and a heartbeat keeps elapsed times
 * moving during long model calls. `close()` must run before a final status is written so a
 * late progress edit cannot overwrite it.
 */
export class StatusReporter {
  private readonly write: (body: string) => Promise<void>;
  private readonly options: Required<Omit<StatusReporterOptions, "mode">>;
  private readonly startedAt: number;
  private mode: string;
  private step?: string;
  private provider?: { detail: string; since: number };
  private agent?: AgentProgress & { since: number };
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private inFlight?: Promise<void>;
  private pending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(write: (body: string) => Promise<void>, options: StatusReporterOptions) {
    this.write = write;
    this.options = {
      model: options.model,
      version: options.version,
      minIntervalMs: options.minIntervalMs ?? 3_000,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      now: options.now ?? Date.now,
    };
    this.mode = options.mode;
    this.startedAt = this.options.now();
  }

  setMode(mode: string): void {
    this.mode = mode;
    this.schedule();
  }

  /** A one-off step outside the agent loop (snapshot download, fallback notice, JSON retry). */
  setStep(detail: string): void {
    this.step = detail;
    this.agent = undefined;
    this.provider = undefined;
    this.schedule();
  }

  /** Progress reported by the LLM client for the request in flight. */
  setProvider(detail: string): void {
    this.provider = { detail, since: this.options.now() };
    this.schedule();
  }

  setAgentProgress(progress: AgentProgress): void {
    const activityChanged = this.agent?.activity !== progress.activity || this.agent?.phase !== progress.phase;
    const since = activityChanged ? this.options.now() : this.agent!.since;
    this.agent = { ...progress, since };
    this.step = undefined;
    if (progress.phase !== "model") this.provider = undefined;
    this.schedule();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = undefined;
    this.heartbeat = undefined;
    await this.inFlight;
  }

  render(): string {
    const now = this.options.now();
    const lines = [
      "## " + ROBIN_SIGNATURE,
      "",
      `:hourglass_flowing_sand: Still working on this pull request · ${formatDuration(now - this.startedAt)} elapsed`,
      "",
    ];

    if (this.agent) {
      const agent = this.agent;
      const compactions = agent.compactions
        ? ` · ${agent.compactions} compaction${agent.compactions === 1 ? "" : "s"}`
        : "";
      lines.push(
        `**Agent:** turn ${agent.turn} of ${agent.maxTurns} · ${agent.toolCalls} tool call${agent.toolCalls === 1 ? "" : "s"}${compactions}`,
        `**Now:** ${agent.activity} (${formatDuration(now - agent.since)})`
      );
    } else if (this.step) {
      lines.push(`**Now:** ${this.step}`);
    }
    if (this.provider) {
      lines.push(`**Provider:** ${this.provider.detail} (${formatDuration(now - this.provider.since)})`);
    }

    lines.push("", `Mode: ${this.mode}`, `Model: ${this.options.model}`, `Robin: ${this.options.version()}`);
    return lines.join("\n");
  }

  private schedule(): void {
    if (this.closed) return;
    this.startHeartbeat();
    if (this.inFlight || this.timer) {
      this.pending = true;
      return;
    }
    const wait = this.lastWriteAt + this.options.minIntervalMs - this.options.now();
    if (wait > 0) {
      this.pending = true;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, wait);
      this.timer.unref?.();
      return;
    }
    this.flush();
  }

  private flush(): void {
    if (this.closed) return;
    this.pending = false;
    this.lastWriteAt = this.options.now();
    this.inFlight = this.write(this.render())
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = undefined;
        if (this.pending) this.schedule();
      });
  }

  private startHeartbeat(): void {
    if (this.heartbeat || this.closed) return;
    this.heartbeat = setInterval(() => this.schedule(), this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
