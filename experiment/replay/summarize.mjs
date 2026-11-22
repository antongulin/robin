import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Comparison metrics use only eligible runs (not excluded, exit 0, no timeout). Failures,
// timeouts and exclusions are counted separately; spend covers every run that reported usage.
const root = process.argv[2];
if (!root) throw Error('Missing output directory');

async function collect(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.name === 'result.json') files.push(JSON.parse(await readFile(path, 'utf8')));
  }
  return files;
}

const runs = await collect(root);
const groups = new Map();
for (const run of runs) {
  for (const key of [run.arm, `${run.arm} / ${run.case.id}`]) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
}

const eligible = run => !run.excluded && run.exit_code === 0 && !run.timed_out;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
};
// A sum is reported only when every run in the set has the value; otherwise null (unknown).
const sumAll = (set, pick) => {
  const values = set.map(pick).filter(Number.isFinite);
  return set.length && values.length === set.length ? values.reduce((a, b) => a + b, 0) : null;
};

const stats = Object.fromEntries([...groups].map(([key, all]) => {
  const ok = all.filter(eligible);
  const durations = ok.map(r => r.wall_duration_seconds).filter(Number.isFinite);
  return [key, {
    runs: all.length,
    eligible: ok.length,
    failures: all.filter(r => !r.excluded && (r.exit_code !== 0 || r.timed_out)).length,
    timeouts: all.filter(r => r.timed_out).length,
    excluded: all.filter(r => r.excluded).length,
    median_seconds: median(durations),
    mean_seconds: mean(durations),
    mean_turns: mean(ok.map(r => r.turns).filter(Number.isFinite)),
    mean_tool_calls: mean(ok.map(r => r.tool_calls).filter(Number.isFinite)),
    repeats: sumAll(ok, r => r.exact_repeats),
    limit_hits: ok.filter(r => r.stop_reason).length,
    structured_retries: ok.filter(r => r.structured_retry).length,
    final_repairs: ok.filter(r => r.final_repair_calls > 0).length,
    fallbacks: ok.filter(r => r.diff_only_fallback).length,
    findings_per_review: Object.fromEntries(['high', 'medium', 'low', 'suggestion'].map(s => [s, mean(ok.map(r => r.counts_by_severity?.[s]).filter(Number.isFinite))])),
    prompt_tokens: sumAll(ok, r => r.usage?.prompt),
    cached_tokens: sumAll(ok, r => r.usage?.cached_input),
    completion_tokens: sumAll(ok, r => r.usage?.completion),
    reasoning_tokens: sumAll(ok, r => r.usage?.reasoning),
    spend_usd_all_runs: sumAll(all.filter(r => Number.isFinite(r.cost_usd)), r => r.cost_usd),
    runs_without_cost: all.filter(r => !Number.isFinite(r.cost_usd)).length,
  }];
}));

const costs = runs.map(r => r.cost_usd).filter(Number.isFinite);
const total = { runs: runs.length, spend_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null, runs_without_cost: runs.length - costs.length };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ groups: stats, total }, null, 2));
} else {
  const f = (value, digits = 1) => value === null || value === undefined ? '—' : typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(digits) : String(value);
  console.log('Metrics use eligible runs only (not excluded, exit 0, no timeout).\n');
  console.log('| Arm / case | Runs / eligible | Failures / timeouts / excluded | Median / mean s | Mean turns / tools | Repeats | Limits / retries / repairs / fallbacks | Findings per review H/M/L/S | Tokens prompt/cached/completion/reasoning | Spend USD |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [key, s] of Object.entries(stats)) {
    console.log(`| ${key} | ${s.runs}/${s.eligible} | ${s.failures}/${s.timeouts}/${s.excluded} | ${f(s.median_seconds)}/${f(s.mean_seconds)} | ${f(s.mean_turns)}/${f(s.mean_tool_calls)} | ${f(s.repeats)} | ${s.limit_hits}/${s.structured_retries}/${s.final_repairs}/${s.fallbacks} | ${Object.values(s.findings_per_review).map(v => f(v, 2)).join('/')} | ${[s.prompt_tokens, s.cached_tokens, s.completion_tokens, s.reasoning_tokens].map(v => f(v)).join('/')} | ${f(s.spend_usd_all_runs, 4)} |`);
  }
  console.log(`\nTotal spend: ${f(total.spend_usd, 4)} USD over ${total.runs} runs (${total.runs_without_cost} without cost data).`);
}
