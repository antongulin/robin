import { formatDuration, StatusReporter } from "./status-reporter";

describe("StatusReporter", () => {
  let clock: number;
  let writes: string[];

  const makeReporter = (overrides: { minIntervalMs?: number; heartbeatMs?: number } = {}) =>
    new StatusReporter(
      async (body) => {
        writes.push(body);
      },
      {
        model: "gpt-6-astra",
        mode: "code review",
        version: () => "v2.8.0 · yoeven/robin@main (9e6bb3d)",
        minIntervalMs: overrides.minIntervalMs ?? 3000,
        heartbeatMs: overrides.heartbeatMs ?? 30000,
        now: () => clock,
      }
    );

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 0;
    writes = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders agent turn, tool count, current activity, provider state, and version", () => {
    const reporter = makeReporter();
    reporter.setMode("code review (agent)");
    reporter.setAgentProgress({
      turn: 3,
      maxTurns: 40,
      toolCalls: 7,
      compactions: 1,
      phase: "model",
      activity: "Thinking about the next step",
    });
    clock = 45_000;
    reporter.setProvider("Waiting for provider (attempt 1/3)…");
    clock = 134_000;

    const body = reporter.render();
    expect(body).toContain("Still working on this pull request · 2m 14s elapsed");
    expect(body).toContain("**Agent:** turn 3 of 40 · 7 tool calls · 1 compaction");
    expect(body).toContain("**Now:** Thinking about the next step (2m 14s)");
    expect(body).toContain("**Provider:** Waiting for provider (attempt 1/3)… (1m 29s)");
    expect(body).toContain("Mode: code review (agent)");
    expect(body).toContain("Model: gpt-6-astra");
    expect(body).toContain("Robin: v2.8.0 · yoeven/robin@main (9e6bb3d)");
    void reporter.close();
  });

  it("drops the provider line while a tool runs", () => {
    const reporter = makeReporter();
    reporter.setProvider("Waiting for provider (attempt 1/3)…");
    reporter.setAgentProgress({
      turn: 1,
      maxTurns: 40,
      toolCalls: 1,
      compactions: 0,
      phase: "tool",
      activity: "Reading `src/a.ts`",
    });

    const body = reporter.render();
    expect(body).toContain("**Now:** Reading `src/a.ts` (0s)");
    expect(body).not.toContain("**Provider:**");
    void reporter.close();
  });

  it("coalesces rapid updates and still delivers the latest one", async () => {
    const reporter = makeReporter();
    reporter.setStep("first");
    await Promise.resolve();
    reporter.setStep("second");
    reporter.setStep("third");
    await jest.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("**Now:** first");

    clock = 3000;
    await jest.advanceTimersByTimeAsync(3000);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("**Now:** third");
    await reporter.close();
  });

  it("heartbeats so elapsed time keeps moving during a long model call", async () => {
    const reporter = makeReporter({ heartbeatMs: 30_000 });
    reporter.setStep("Waiting on the model");
    await jest.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);

    clock = 30_000;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("30s elapsed");
    await reporter.close();
  });

  it("writes nothing after close, so it can't overwrite the final status", async () => {
    const reporter = makeReporter();
    reporter.setStep("first");
    reporter.setStep("queued");
    await reporter.close();
    clock = 60_000;
    await jest.advanceTimersByTimeAsync(60_000);
    reporter.setStep("late");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveLength(1);
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_900)).toBe("59s");
    expect(formatDuration(61_000)).toBe("1m 01s");
    expect(formatDuration(-5)).toBe("0s");
  });
});
