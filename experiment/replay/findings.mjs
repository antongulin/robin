const severity = {rotating_light:'high', warning:'medium', large_blue_circle:'low', bulb:'suggestion'};
export function parseFindings(review) {
  if (!review) return null;
  const results = [];
  for (const c of review.comments || []) {
    const m = /^\*\*Robin\*\* — :(rotating_light|warning|large_blue_circle|bulb): [A-Z]+(?: · confidence: ([^\n]+))?\n\n([\s\S]*)$/.exec(c.body || '');
    if (!m) continue;
    const [description, recommendation] = m[3].split(/\n\n\*\*Recommendation:\*\* /, 2);
    results.push({severity:severity[m[1]],confidence:m[2] || null,file:c.path || null,line:c.line ?? null,description:description.split('\n\n```')[0],recommendation:recommendation?.split('\n\n```')[0] || null});
  }
  const body = (review.body || '').split('### :page_facing_up: Findings Not Posted Inline')[1] || '';
  const pattern = /:(rotating_light|warning|large_blue_circle|bulb): \*\*\d+(?: \(`([^`]+)`\))?\*\* — ([\s\S]*?)(?=\n\n:(?:rotating_light|warning|large_blue_circle|bulb): \*\*\d+|$)/g;
  for (const m of body.matchAll(pattern)) {
    const location = /^(.*?):(\d+)$/.exec(m[2] || '');
    const [description, recommendation] = m[3].trim().split(/\n> /, 2);
    results.push({severity:severity[m[1]],confidence:null,file:location?.[1] || m[2] || null,line:location ? Number(location[2]) : null,description,recommendation:recommendation || null});
  }
  return results;
}
