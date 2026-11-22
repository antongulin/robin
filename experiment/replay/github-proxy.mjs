import http from 'node:http';
import { appendFile } from 'node:fs/promises';

// The real credential is confined to this process and never included in records.
export async function startProxy({ testCase, directory, token, upstream = 'https://api.github.com' }) {
  let id = 900000;
  const root = `/repos/${testCase.owner}/${testCase.repo}/`;
  const pr = `${root}pulls/${testCase.pr}`;
  const compare = `${root}compare/${testCase.base_sha}...${testCase.head_sha}`;
  const state = { diffUnavailable: false };
  const log = (name, row) => appendFile(`${directory}/${name}`, `${JSON.stringify(row)}\n`);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method;
    let rewrite = null, status = null, upstreamStatus = null, blocked = false;
    try {
      if (!['GET', 'HEAD'].includes(method)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch { body = raw || null; }
        await log('writes.jsonl', { method, path: req.url, body });
        blocked = true;
        let data = {};
        status = 200;
        if (path === '/graphql') data = { data: null, errors: [{ message: 'blocked by replay proxy' }] };
        else if (method === 'POST' && (path.endsWith('/comments') || path.endsWith('/reactions'))) { status = 201; data = { id: id++ }; }
        else if (method === 'PATCH' && path.includes('/issues/comments/')) data = { id: Number(path.split('/').pop()) };
        else if (method === 'POST' && path.endsWith('/reviews')) data = { id: id++, state: 'COMMENTED' };
        res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
      } else if (!path.startsWith(root) || (path.startsWith(`${root}tarball/`) && decodeURIComponent(path.slice(`${root}tarball/`.length)) !== testCase.head_sha)) {
        blocked = true; status = 403; res.writeHead(status); res.end();
      } else {
        let target = path + url.search;
        let transform = null;
        const diff = path === pr && (req.headers.accept || '').includes('diff');
        if (diff) { rewrite = 'diff'; target = compare; }
        else if (path === pr) { rewrite = 'pull'; transform = 'pull'; }
        else if (path === `${pr}/files` || path === `${pr}/commits`) {
          rewrite = path.endsWith('/files') ? 'files' : 'commits';
          if (Number(url.searchParams.get('page') || '1') > 1) {
            status = 200; res.writeHead(status, { 'content-type': 'application/json' }); res.end('[]');
            await log('proxy.jsonl', { method, path: req.url, rewrite, upstream_status: null, blocked }); return;
          }
          target = compare; transform = rewrite;
        } else if ([`${pr}/reviews`, `${pr}/comments`, `${root}issues/${testCase.pr}/comments`].includes(path)) { rewrite = 'cutoff'; transform = 'cutoff'; }
        const headers = { accept: req.headers.accept || 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'robin-replay' };
        const response = await fetch(new URL(target, upstream), { method, headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
        status = response.status; upstreamStatus = response.status;
        if (diff && !response.ok) {
          state.diffUnavailable = true; status = 502;
          res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'replay proxy: compare diff unavailable' }));
        } else {
          const outgoing = {};
          for (const key of ['content-type', 'location', 'link']) {
            let value = response.headers.get(key);
            if (key === 'link' && value) value = value.replaceAll(new URL(upstream).origin, `http://127.0.0.1:${server.address().port}`);
            if (value) outgoing[key] = value;
          }
          let body = Buffer.from(await response.arrayBuffer());
          if (transform && response.ok && method !== 'HEAD') {
            let data = JSON.parse(body.toString());
            if (transform === 'pull') { data.head.sha = testCase.head_sha; data.base.sha = testCase.base_sha; }
            else if (transform === 'cutoff') data = data.filter(item => !((item.submitted_at || item.created_at) >= testCase.cutoff));
            else data = data[transform] || [];
            body = Buffer.from(JSON.stringify(data));
          }
          res.writeHead(status, outgoing); res.end(body);
        }
      }
    } catch {
      if (rewrite === 'diff') state.diffUnavailable = true;
      status = 502;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: rewrite === 'diff' ? 'replay proxy: compare diff unavailable' : 'replay proxy: upstream unavailable' }));
    }
    await log('proxy.jsonl', { method, path: req.url, rewrite, upstream_status: upstreamStatus, response_status: status, blocked });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
