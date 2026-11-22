import { pathToFileURL } from 'node:url';
import { parseCallerInputs } from './caller-inputs.mjs';
export async function prepareCase({owner, repo, pr, round=1, token, upstream='https://api.github.com'}) {
 const root=`/repos/${owner}/${repo}`, headers={authorization:`Bearer ${token}`,'user-agent':'robin-replay',accept:'application/vnd.github+json'};
 async function get(path, accept) { const response=await fetch(new URL(path,upstream),{headers:{...headers,...(accept?{accept}:{})}}); if(!response.ok) throw Error(`GitHub read failed: ${response.status}`); return accept ? response.text() : response.json(); }
 const pull=await get(`${root}/pulls/${pr}`); let all=[];
 for(let page=1;;page++){const reviews=await get(`${root}/pulls/${pr}/reviews?per_page=100&page=${page}`); all.push(...reviews);if(reviews.length<100)break;}
 const review=all.filter(r=>r.body?.includes(':bow_and_arrow: Robin') && r.submitted_at && r.commit_id).sort((a,b)=>a.submitted_at.localeCompare(b.submitted_at))[round-1];
 if(!review)throw Error('Robin review round not found');
 let base=pull.base.ref, method='base ref';
 if(pull.merged_at){if(!pull.merge_commit_sha)throw Error('Merged PR lacks merge commit');const merge=await get(`${root}/commits/${pull.merge_commit_sha}`);base=merge.parents?.[0]?.sha;if(!base)throw Error('Merge commit lacks first parent');method='merge commit first parent';}
 const path=`${root}/compare/${encodeURIComponent(base)}...${review.commit_id}`;
 const compare=await get(path), baseSha=compare.merge_base_commit?.sha;
 if(!baseSha)throw Error('Compare lacks merge base');
 const diff=await get(`${root}/compare/${baseSha}...${review.commit_id}`,'application/vnd.github.v3.diff');
 const kept=diff.split(/^diff --git /m).filter(Boolean).filter(part=>{const path=/a\/(.+?) b\/(.+)$/.exec(part.split('\n')[0])?.[2]||'';return !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|poetry\.lock)$|\.min\.(js|css)$|(^|\/)(dist|node_modules)\//.test(path);}).map(s=>`diff --git ${s}`).join('');
 // The caller's `with:` inputs at the replayed base, so the replay uses the review's own settings.
 let caller=null;
 try {
  const listing=await get(`${root}/contents/.github/workflows?ref=${baseSha}`);
  for(const entry of Array.isArray(listing)?listing:[]){
   if(!/\.ya?ml$/.test(entry.name))continue;
   const file=await get(`${root}/contents/.github/workflows/${encodeURIComponent(entry.name)}?ref=${baseSha}`);
   const parsed=parseCallerInputs(Buffer.from(file.content||'','base64').toString('utf8'));
   if(parsed){caller={file:`.github/workflows/${entry.name}`,...parsed};break;}
  }
 } catch { caller=null; }
 return {id:`${owner}-${repo}-${pr}-r${round}`,owner,repo,pr,head_sha:review.commit_id,base_sha:baseSha,base_ref:pull.base.ref,head_ref:pull.head.ref,cutoff:new Date(Date.parse(review.submitted_at)-1000).toISOString(),author_login:pull.user?.login,note:`Cutoff is review submission minus one second; merge base derived from ${method}.${caller?'':' No Robin caller found at the base commit.'}`,diff_chars:kept.length,caller_file:caller?.file??null,caller_ref:caller?.ref??null,inputs:caller?.inputs??{}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2), options={};for(let i=0;i<args.length;i+=2) options[args[i]]=args[i+1];
 if(!process.env.REPLAY_GITHUB_TOKEN)throw Error('Missing REPLAY_GITHUB_TOKEN');
 const [owner,repo,...rest]=(options['--repo']||'').split('/');const pr=Number(options['--pr']), round=Number(options['--round']||1);
 if(!owner||!repo||rest.length||!Number.isSafeInteger(pr)||pr<1||!Number.isSafeInteger(round)||round<1)throw Error('Invalid repo, PR, or round');
 console.log(JSON.stringify(await prepareCase({owner,repo,pr,round,token:process.env.REPLAY_GITHUB_TOKEN,upstream:process.env.REPLAY_GITHUB_UPSTREAM})));
}
