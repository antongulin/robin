import { randomUUID } from "node:crypto";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { buildRobinHeader } from "./brand";
import type { LlmProvider } from "./llm-provider";

const METRICS = ["prompt_tokens", "completion_tokens", "total_tokens", "cached_input_tokens", "reasoning_tokens"] as const;
type Metric = typeof METRICS[number];
export type UsageCounts = Partial<Record<Metric, number>>;
const PHASES = ["single-shot-initial", "agent", "forced-final", "compaction", "diff-only-fallback", "structured-retry", "summary"] as const;
export interface UsageContext {
  phase: typeof PHASES[number];
  agentTurn?: number;
  compactionIndex?: number;
  compactionAttempt?: number;
  recovery?: boolean;
}
type Outcome = "accepted" | "empty" | "length" | "error";
export type CompatibilityAdjustment = "reasoning" | "temperature" | "output-limit" | "response-format";
export type AttemptTrigger = "initial" | "outer-empty-retry" | "outer-error-retry" | "compatibility-retry";
interface MetricObservation { value: number | null; final: boolean; conflict: boolean }
export interface UsageAttempt {
  id: number;
  logical_call: number;
  phase: UsageContext["phase"];
  agent_turn: number | null;
  compaction_index: number | null;
  compaction_attempt: number | null;
  recovery: boolean;
  outer_attempt: number;
  compatibility_attempt: number;
  trigger: AttemptTrigger;
  compatibility_adjustment: CompatibilityAdjustment | null;
  stream: boolean;
  sent_model: string | null;
  sent_effort: { state: string; field: string | null; value: string | null };
  sent_output_limit: { field: string | null; value: number | null };
  reported_model: string | null;
  model_conflict: boolean;
  finish_reason: string | null;
  outcome: Outcome;
  finished: boolean;
  usage: Record<Metric, MetricObservation>;
}
interface MetricAggregate {
  observed_sum: number | null;
  observed_attempts: number;
  final_attempts: number;
  unknown_attempts: number;
  nonfinal_attempts: number;
  complete: boolean;
  overflow: boolean;
}
interface InvocationMetadata {
  repository: string | null;
  pr_number: number | null;
  head_sha: string | null;
  head_provenance: "event" | "observed" | null;
  command: "review" | "summary" | null;
  run_id: string | null;
  run_attempt: string | null;
  requested_model: string | null;
  requested_effort: { state: "configured" | "off" | "unset"; value: string | null };
  provider: LlmProvider | null;
}

export function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Only these numeric fields cross the provider boundary. Never retain the source object. */
export function normalizeUsage(value: unknown): UsageCounts {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const prompt = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  const completion = raw.completion_tokens_details as Record<string, unknown> | undefined;
  const candidates = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens, prompt?.cached_tokens, completion?.reasoning_tokens];
  const result: UsageCounts = {};
  METRICS.forEach((key, index) => {
    const count = safeCount(candidates[index]);
    if (count !== null) result[key] = count;
  });
  return result;
}

export class UsageLedger {
  private readonly invocationId = randomUUID();
  private readonly attempts: UsageAttempt[] = [];
  private logicalCalls = 0;
  private coverageLost = false;
  private agentActivity: { turns: number | null; tool_calls: number | null; compactions: number | null } | null = null;
  private readonly secrets: string[];
  private metadata: InvocationMetadata = {
    repository: null, pr_number: null, head_sha: null, head_provenance: null, command: null,
    run_id: null, run_attempt: null, requested_model: null,
    requested_effort: { state: "unset", value: null }, provider: null,
  };
  state: "skipped" | "completed" | "failed" = "skipped";

  constructor(secrets: string[] = []) { this.secrets = secrets.filter(Boolean); }

  /** Fixed failure handling also contains hostile provider getters/normalization errors. */
  private observe<T>(fn: () => T): T | undefined {
    try { return fn(); } catch { this.coverageLost = true; return undefined; }
  }

  private identifier(value: unknown): string | null {
    return typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
      !this.secrets.some(secret => value.includes(secret)) ? value : null;
  }

  configure(metadata: Partial<InvocationMetadata>): void {
    this.observe(() => {
      // Explicit copies, even for local metadata: no arbitrary object serialization.
      if (metadata.repository !== undefined) this.metadata.repository = this.identifier(metadata.repository);
      if (metadata.pr_number !== undefined) this.metadata.pr_number = safeCount(metadata.pr_number);
      if (metadata.head_sha !== undefined) {
        this.metadata.head_sha = typeof metadata.head_sha === "string" && /^[a-f0-9]{40,64}$/i.test(metadata.head_sha)
          ? this.identifier(metadata.head_sha) : null;
        this.metadata.head_provenance = this.metadata.head_sha && (metadata.head_provenance === "event" || metadata.head_provenance === "observed")
          ? metadata.head_provenance : null;
      }
      if (metadata.command === "review" || metadata.command === "summary") this.metadata.command = metadata.command;
      if (metadata.run_id !== undefined) this.metadata.run_id = this.identifier(metadata.run_id);
      if (metadata.run_attempt !== undefined) this.metadata.run_attempt = this.identifier(metadata.run_attempt);
      if (metadata.requested_model !== undefined) this.metadata.requested_model = this.identifier(metadata.requested_model);
      if (metadata.requested_effort) this.metadata.requested_effort = {
        state: metadata.requested_effort.state === "configured" ? "configured" : metadata.requested_effort.state === "off" ? "off" : "unset",
        value: this.identifier(metadata.requested_effort.value),
      };
      if (["openai", "anthropic", "openrouter", "other"].includes(metadata.provider || "")) this.metadata.provider = metadata.provider!;
    });
  }

  recordAgentActivity(turns: number, toolCalls: number, compactions: number): void {
    this.observe(() => { this.agentActivity = { turns: safeCount(turns), tool_calls: safeCount(toolCalls), compactions: safeCount(compactions) }; });
  }

  startCall(): number { return ++this.logicalCalls; }

  begin(context: UsageContext | undefined, call: number, outer: number, compatibility: number, trigger: AttemptTrigger,
    sent: { model: string; stream: boolean; effort?: string; effortField?: string; effortRemoved: boolean; output?: number; outputField?: string }): UsageAttempt | undefined {
    return this.observe(() => {
      const record: UsageAttempt = {
        id: this.attempts.length + 1, logical_call: call,
        phase: context && PHASES.includes(context.phase) ? context.phase : "single-shot-initial",
        agent_turn: safeCount(context?.agentTurn), compaction_index: safeCount(context?.compactionIndex),
        compaction_attempt: safeCount(context?.compactionAttempt), recovery: context?.recovery === true,
        outer_attempt: outer, compatibility_attempt: compatibility, trigger, compatibility_adjustment: null,
        stream: sent.stream, sent_model: this.identifier(sent.model),
        sent_effort: { state: sent.effort !== undefined ? "sent" : sent.effortRemoved ? "removed-by-compatibility" :
          this.metadata.requested_effort.state === "configured" ? "not-sent" : this.metadata.requested_effort.state,
          field: sent.effortField === "reasoning_effort" || sent.effortField === "reasoning" ? sent.effortField : null,
          value: this.identifier(sent.effort) },
        sent_output_limit: { field: sent.outputField === "max_tokens" || sent.outputField === "max_completion_tokens" ? sent.outputField : null,
          value: safeCount(sent.output) },
        reported_model: null, model_conflict: false, finish_reason: null, outcome: "error", finished: false,
        usage: Object.fromEntries(METRICS.map(key => [key, { value: null, final: false, conflict: false }])) as UsageAttempt["usage"],
      };
      this.attempts.push(record);
      return record;
    });
  }

  capture(record: UsageAttempt | undefined, response: unknown): void {
    this.observe(() => {
      if (!record || !response || typeof response !== "object") return;
      const raw = response as { usage?: unknown; model?: unknown; choices?: { finish_reason?: unknown }[] };
      const model = this.identifier(raw.model);
      if (model) {
        if (record.reported_model && record.reported_model !== model) record.model_conflict = true;
        record.reported_model = model;
      }
      const reason = raw.choices?.[0]?.finish_reason;
      if (typeof reason === "string" && ["stop", "length", "tool_calls", "function_call", "content_filter"].includes(reason)) record.finish_reason = reason;
      if (raw.usage === undefined || raw.usage === null) return;
      const counts = normalizeUsage(raw.usage);
      for (const key of METRICS) {
        const metric = record.usage[key];
        metric.final = counts[key] !== undefined;
        if (counts[key] !== undefined) {
          if (metric.value !== null && counts[key]! < metric.value) metric.conflict = true;
          metric.value = counts[key]!;
        }
      }
    });
  }

  captureError(record: UsageAttempt | undefined, error: unknown): void {
    this.observe(() => {
      // SDK-preserved envelope only. Do not inspect or serialize arbitrary error/body fields.
      const envelope = (error as { error?: { usage?: unknown } } | null)?.error;
      if (envelope?.usage !== undefined) this.capture(record, { usage: envelope.usage });
    });
  }

  received(record: UsageAttempt | undefined): void {
    this.observe(() => { if (record) record.finished = true; });
  }

  finish(record: UsageAttempt | undefined, outcome: Outcome, adjustment: CompatibilityAdjustment | null = null): void {
    this.observe(() => {
      if (!record) return;
      record.outcome = record.finish_reason === "length" ? "length" : outcome;
      record.compatibility_adjustment = adjustment;
      for (const key of METRICS) record.usage[key].final &&= record.finished && !record.usage[key].conflict;
    });
  }

  private aggregate(attempts: UsageAttempt[]) {
    const metrics = Object.fromEntries(METRICS.map(key => {
      let sum = 0, observed = 0, final = 0, overflow = false;
      for (const attempt of attempts) {
        const metric = attempt.usage[key];
        if (metric.value !== null) {
          observed++;
          if (sum > Number.MAX_SAFE_INTEGER - metric.value) overflow = true;
          else sum += metric.value;
        }
        if (metric.final && attempt.finished && !metric.conflict) final++;
      }
      const aggregate: MetricAggregate = { observed_sum: observed && !overflow ? sum : null,
        observed_attempts: observed, final_attempts: final, unknown_attempts: attempts.length - observed,
        nonfinal_attempts: observed - final, complete: final === attempts.length && !overflow && !this.coverageLost, overflow };
      return [key, aggregate];
    })) as Record<Metric, MetricAggregate>;
    return { attempts: attempts.length, metrics,
      outcomes: Object.fromEntries((["accepted", "empty", "length", "error"] as const).map(outcome => [outcome, attempts.filter(a => a.outcome === outcome).length])),
      triggers: Object.fromEntries((["initial", "outer-empty-retry", "outer-error-retry", "compatibility-retry"] as const).map(trigger => [trigger, attempts.filter(a => a.trigger === trigger).length])) };
  }

  report() {
    const groups = new Map<string, { sent_model: string | null; reported_model: string | null; model_conflict: boolean; attempts: number }>();
    for (const attempt of this.attempts) {
      const key = JSON.stringify([attempt.sent_model, attempt.reported_model, attempt.model_conflict]);
      const group = groups.get(key) ?? { sent_model: attempt.sent_model, reported_model: attempt.reported_model, model_conflict: attempt.model_conflict, attempts: 0 };
      group.attempts++; groups.set(key, group);
    }
    const aggregate = { schema_version: 1, invocation_id: this.invocationId, ...this.metadata, state: this.state,
      collector_incomplete: this.coverageLost, agent_activity: this.agentActivity, logical_calls: this.logicalCalls, ...this.aggregate(this.attempts),
      phases: Object.fromEntries(PHASES.filter(phase => this.attempts.some(a => a.phase === phase)).map(phase => [phase, this.aggregate(this.attempts.filter(a => a.phase === phase))])),
      model_groups: [...groups.values()], model_groups_omitted: 0 };
    const full = { ...aggregate, ledger: this.attempts.map(attempt => ({ ...attempt,
      usage: Object.fromEntries(METRICS.map(key => [key, { ...attempt.usage[key],
        final: attempt.usage[key].final && attempt.finished && !attempt.usage[key].conflict }])) as UsageAttempt["usage"],
    })) };
    if (Buffer.byteLength(JSON.stringify(aggregate), "utf8") > 64 * 1024) {
      aggregate.model_groups_omitted = aggregate.model_groups.length;
      aggregate.model_groups = [];
    }
    return { full, compact: aggregate };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Each sink has its own failure boundary; warnings never include exceptions or paths. */
export async function publishUsageReport(ledger: UsageLedger): Promise<void> {
  const warn = (code: string) => { try { core.warning(`Robin usage report: ${code} (non-fatal).`); } catch { /* no reporting failure escapes */ } };
  let reports: ReturnType<UsageLedger["report"]>;
  let compact: string;
  try { reports = ledger.report(); compact = JSON.stringify(reports.compact); }
  catch { warn("serialization unavailable"); return; }
  let path: string | undefined;
  try {
    const directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "robin-usage-"));
    path = join(directory, "usage-report.json");
    const pending = join(directory, "pending.json");
    await writeFile(pending, JSON.stringify(reports.full), { encoding: "utf8", mode: 0o600 });
    await rename(pending, path);
  } catch { path = undefined; warn("local file unavailable"); }
  try { core.setOutput("usage-report", compact); } catch { warn("aggregate output unavailable"); }
  if (path) { try { core.setOutput("usage-report-path", path); } catch { warn("local path output unavailable"); } }
  try {
    const r = reports.compact;
    const counts = METRICS.map(key => {
      const m = r.metrics[key];
      return `${key}: ${m.observed_sum ?? "unknown"} (${m.unknown_attempts} missing, ${m.nonfinal_attempts} nonfinal${m.overflow ? ", overflow" : ""})`;
    }).join("; ");
    const reportedModels = r.model_groups.slice(0, 6).map(group => group.reported_model ?? "unknown").join(", ") || "unknown";
    const phases = Object.entries(r.phases).map(([phase, aggregate]) => `${phase}: ${aggregate.attempts}`).join("; ") || "none";
    const outcomes = Object.entries(r.outcomes).map(([outcome, count]) => `${outcome}: ${count}`).join("; ");
    const activity = r.agent_activity ? ` Agent: ${r.agent_activity.turns ?? "unknown"} turns, ${r.agent_activity.tool_calls ?? "unknown"} tool executions, ${r.agent_activity.compactions ?? "unknown"} compactions.` : "";
    const summary = [buildRobinHeader(" · LLM usage"), "",
      `${r.repository ?? "unknown repository"} PR #${r.pr_number ?? "unknown"}; head ${r.head_sha ?? "unknown"} (${r.head_provenance ?? "unknown"}).`,
      `Run ${r.run_id ?? "unknown"}, attempt ${r.run_attempt ?? "unknown"}; ${r.state}.`,
      `Requested model: ${r.requested_model ?? "unknown"}; effort: ${r.requested_effort.state} (${r.requested_effort.value ?? "unknown"}).`,
      `Reported models (up to 6 groups): ${reportedModels}${r.model_groups_omitted ? "; model details omitted from compact report" : ""}.`,
      `${r.attempts} physical requests; ${r.logical_calls} logical calls.${activity} ${counts}.`,
      `Phases: ${phases}. Outcomes: ${outcomes}.`,
      "Provider-reported tokens; cached/reasoning are breakdowns, not added to parent counts. Not dollars or plan usage.",
      "<details><summary>Aggregate usage JSON</summary><pre>" + escapeHtml(compact) + "</pre></details>", ""].join("\n\n");
    await core.summary.addRaw(summary).write();
  } catch { warn("Actions summary unavailable"); }
}
