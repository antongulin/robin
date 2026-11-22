import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { startProxy } from './github-proxy.mjs';
import { parseFindings } from './findings.mjs';

const argv = process.argv.slice(2), opt = {}, envOverrides = {}, inputOverrides = {}, selected = [];
for (let i = 0; i < argv.length; i++) {
  const key = argv[i]; if (!key.startsWith('--') || i + 1 === argv.length) throw Error(`Invalid option ${key}`);
  const value = argv[++i];
  if (key === '--env' || key === '--input') { const at = value.indexOf('='); if (at < 1) throw Error(`Invalid ${key}`); const name=value.slice(0,at); (key === '--env' ? envOverrides : inputOverrides)[key==='--input'?name.toLowerCase():name] = value.slice(at + 1); }
  else if (key === '--case') selected.push(value);
  else opt[key.slice(2)] = value;
}
for (const key of ['REPLAY_GITHUB_TOKEN','REPLAY_LLM_API_KEY','REPLAY_LLM_BASE_URL','REPLAY_LLM_MODEL']) if (!process.env[key]) throw Error(`Missing ${key}`);
for (const key of ['cases','arm','build','out']) if (!opt[key]) throw Error(`Missing --${key}`);
const safeName = x => /^[a-zA-Z0-9_.-]+$/.test(x) && x !== '.' && x !== '..';
if (!safeName(opt.arm)) throw Error('Invalid arm');
const reps = Number(opt.reps || 2), concurrency = Number(opt.concurrency || 2);
if (![reps,concurrency].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid repetitions or concurrency');
const cases = (await readFile(opt.cases,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(c => !selected.length || selected.includes(c.id));
for (const c of cases) if (!safeName(c.id) || !safeName(c.owner) || !safeName(c.repo) || !Number.isSafeInteger(c.pr) || c.pr<1 || !/^[a-f\d]{40}$/i.test(c.head_sha) || !/^[a-f\d]{40}$/i.test(c.base_sha) || !Number.isFinite(Date.parse(c.cutoff))) throw Error('Invalid case');
const build = resolve(opt.build), out = resolve(opt.out), tasks = cases.flatMap(c => Array.from({length:reps},(_,i)=>[c,i+1]));
const secretValues = [process.env.REPLAY_GITHUB_TOKEN, process.env.REPLAY_LLM_API_KEY].filter(Boolean);
const redact = s => secretValues.reduce((v,secret)=>v.split(secret).join('***'),s);
async function run(c, rep) {
 const dir = join(out,opt.arm,c.id,`rep${rep}`); await mkdir(join(dir,'tmp'),{recursive:true});
 const proxy = await startProxy({testCase:c,directory:dir,token:process.env.REPLAY_GITHUB_TOKEN,upstream:process.env.REPLAY_GITHUB_UPSTREAM});
 try {
  const event = {action:'opened',number:c.pr,pull_request:{number:c.pr,head:{sha:c.head_sha,ref:c.head_ref},base:{sha:c.base_sha,ref:c.base_ref},user:{login:c.author_login || 'replay-author',type:'User'}},repository:{owner:{login:c.owner},name:c.repo,full_name:`${c.owner}/${c.repo}`}};
  const eventPath = join(dir,'event.json'), outputPath = join(dir,'output.txt'), summaryPath = join(dir,'summary.md');
  await Promise.all([writeFile(eventPath,JSON.stringify(event)),writeFile(outputPath,''),writeFile(summaryPath,''),writeFile(join(dir,'proxy.jsonl'),''),writeFile(join(dir,'writes.jsonl'),'')]);
  const inputs = {'github-token':'replay-dummy-token','llm-api-key':process.env.REPLAY_LLM_API_KEY,'llm-base-url':process.env.REPLAY_LLM_BASE_URL,model:process.env.REPLAY_LLM_MODEL,'fail-on-high':'false','max-comments':'15','llm-timeout-ms':'600000','llm-temperature':'0.1','min-command-permission':'write','review-instructions-file':'.github/code-reviewer.md','review-on-synchronize':'false','config-file':'.github/robin.yml',...inputOverrides};
  if (inputs['github-token'] !== 'replay-dummy-token') throw Error('github-token override is forbidden');
  const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  for (const [k,v] of Object.entries(envOverrides)) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /^(?:GITHUB_|INPUT_|REPLAY_|NODE_|PATH$|HOME$|TMPDIR$|RUNNER_)/i.test(k)) throw Error(`Unsafe environment override: ${k}`); env[k]=v; }
  Object.assign(env,{GITHUB_EVENT_NAME:'pull_request',GITHUB_EVENT_PATH:eventPath,GITHUB_REPOSITORY:`${c.owner}/${c.repo}`,GITHUB_API_URL:proxy.url,GITHUB_GRAPHQL_URL:`${proxy.url}/graphql`,GITHUB_SERVER_URL:'http://127.0.0.1:9',GITHUB_RUN_ID:`replay-${opt.arm}-${c.id}-${rep}`,GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:outputPath,GITHUB_STEP_SUMMARY:summaryPath,RUNNER_TEMP:join(dir,'tmp')});
  for (const [k,v] of Object.entries(inputs)) env[`INPUT_${k.replaceAll(' ','_').toUpperCase()}`]=v;
  const start = Date.now(); let timedOut = false;
  const child = spawn(process.execPath,[join(build,'dist/index.js')],{cwd:dir,env,detached:true,stdio:['ignore','pipe','pipe']});
  const lines = {stdout:[],stderr:[]};
  for (const name of ['stdout','stderr']) { let pending=''; child[name].setEncoding('utf8'); child[name].on('data',chunk=>{pending+=chunk; const parts=pending.split('\n'); pending=parts.pop(); for(const line of parts) lines[name].push(`${new Date().toISOString()} ${redact(line)}\n`);}); child[name].on('end',()=>{if(pending) lines[name].push(`${new Date().toISOString()} ${redact(pending)}\n`);}); }
  const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},45*60*1000);
  const exitCode=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',res);}); clearTimeout(timer);
  const text=lines.stdout.join('')+lines.stderr.join(''); await Promise.all(['stdout','stderr'].map(n=>writeFile(join(dir,`${n}.log`),lines[n].join(''))));
  let ledger=null; const output=await readFile(outputPath,'utf8'); const path=/^usage-report-path<<[^\n]+\n([^\n]+)/m.exec(output)?.[1] || /^usage-report-path=(.*)$/m.exec(output)?.[1];
  if(path) { try { ledger=JSON.parse(await readFile(path,'utf8')); await copyFile(path,join(dir,'usage-report.json')); } catch {} }
  const writes=(await readFile(join(dir,'writes.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const audit=(await readFile(join(dir,'proxy.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const review=writes.find(w=>w.method==='POST' && w.path.split('?')[0]===`/repos/${c.owner}/${c.repo}/pulls/${c.pr}/reviews`)?.body;
  const findings=parseFindings(review), calls=[...text.matchAll(/Agent tool: ([^\n]+)/g)].map(m=>m[1].trim()), unique=new Set(); let repeats=0; for(const call of calls) {if(unique.has(call)) repeats++; unique.add(call);}
  const metrics=ledger?.metrics, val=n=>metrics?.[n]?.observed_sum ?? null;
  const prompt=val('prompt_tokens'),cached=val('cached_input_tokens'),completion=val('completion_tokens'),reasoning=val('reasoning_tokens');
  const prices=['price-input','price-cached','price-output'].map(k=>opt[k]===undefined?null:Number(opt[k]));
  const cost=prices.every(Number.isFinite)&&[prompt,cached,completion].every(Number.isFinite)?((prompt-cached)*prices[0]+cached*prices[1]+completion*prices[2])/1e6:null;
  const result={case:c,arm:opt.arm,rep,exit_code:exitCode,timed_out:timedOut,excluded:proxy.state.diffUnavailable?'diff-unavailable':null,native_git_attempted:/NATIVE_DIFF|git fetch/i.test(text),wall_duration_seconds:(Date.now()-start)/1000,turns:ledger?.agent_activity?.turns??null,tool_calls:ledger?.agent_activity?.tool_calls??null,compactions:ledger?.agent_activity?.compactions??null,stop_reason:/reached the (?:\d+-turn|time) limit/.exec(text)?.[0]??null,structured_retry:ledger ? (ledger.ledger.some(a=>a.phase==='structured-retry') || (ledger.ledger.filter(a=>a.phase==='forced-final' && a.trigger==='initial').length > (/reached the (?:\d+-turn|time) limit/.test(text) ? 1 : 0))) : null,diff_only_fallback:ledger ? ledger.ledger.some(a=>a.phase==='diff-only-fallback') : null,experiment_switch_log:text.split('\n').find(l=>/ROBIN_EXPERIMENT|experiment switch/i.test(l))??null,tool_call_descriptions:calls,exact_repeats:repeats,turn_timestamps:[...text.matchAll(/^(\S+) .*Agent turn (\d+)\//gm)].map(m=>({timestamp:m[1],turn:Number(m[2])})),findings,counts_by_severity:findings?Object.fromEntries(['high','medium','low','suggestion'].map(s=>[s,findings.filter(f=>f.severity===s).length])):null,usage:{prompt,completion,cached_input:cached,reasoning,attempts:ledger?.attempts??null},attempt_rows:ledger?.ledger.map(a=>({phase:a.phase,agent_turn:a.agent_turn,prompt:a.usage.prompt_tokens.value,cached:a.usage.cached_input_tokens.value,completion:a.usage.completion_tokens.value,reasoning:a.usage.reasoning_tokens.value,finish_reason:a.finish_reason}))??null,cost_usd:cost,blocked_writes:writes.length,unexpected_proxy_requests:audit.filter(a=>a.blocked&&a.response_status===403)};
  await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');
 } finally { await proxy.close(); }
}
let next=0; await Promise.all(Array.from({length:Math.min(concurrency,tasks.length)},async()=>{while(next<tasks.length){const [c,rep]=tasks[next++];await run(c,rep);}}));
