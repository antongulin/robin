// Real process topology and control files; no network or inherited credentials.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const [role, directory, serialized] = process.argv.slice(2);
const options = JSON.parse(serialized || '{}');
const file = name => path.join(directory, name);
fs.writeFileSync(file(`${role}.pid`), String(process.pid));
process.on('SIGTERM', () => {});
const keepAlive = setInterval(() => {}, 1000);
function until(name, next) {
  if (fs.existsSync(file(name))) return next();
  setTimeout(() => until(name, next), 5);
}
if (role === 'leaf') {
  fs.writeFileSync(file('leaf.ready'), 'ready');
} else if (role === 'branch') {
  spawn(process.execPath, [__filename, 'leaf', directory, serialized], {
    stdio: options.closed ? 'ignore' : ['ignore', 'inherit', 'inherit'],
  });
  until('leaf.ready', () => fs.writeFileSync(file('branch.ready'), 'ready'));
} else {
  if (options.descendants !== false) {
    spawn(process.execPath, [__filename, 'branch', directory, serialized], {
      stdio: options.closed ? 'ignore' : ['ignore', 'inherit', 'inherit'],
    });
  } else fs.writeFileSync(file('branch.ready'), 'ready');
  until('branch.ready', () => {
    fs.writeFileSync(file('ready'), 'ready');
    until('go', async () => {
      if (options.report) {
        const env = process.env;
        fs.writeFileSync(file(options.report), JSON.stringify({
          argv: process.argv.slice(5),
          inherited: ['GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CONFIG_PARAMETERS', 'GIT_EXTERNAL_DIFF',
            'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'HOME', 'SSH_ASKPASS'].filter(key => env[key] !== undefined),
          auth: env.GIT_CONFIG_VALUE_0 || null, configCount: env.GIT_CONFIG_COUNT,
        }));
      }
      const write = (stream, bytes) => new Promise(resolve => stream.write(bytes, resolve));
      if (options.chunks) {
        for (let i = 0; i < options.chunks.length; i++) {
          await write(process[options.stream], Buffer.from(options.chunks[i], 'base64'));
          await new Promise(resolve => until(`next-${i}`, resolve));
        }
      }
      if (options.stdout) await write(process.stdout, Buffer.from(options.stdout, 'base64'));
      if (options.stderr) await write(process.stderr, Buffer.from(options.stderr, 'base64'));
      if (options.flood) {
        const stream = process[options.flood];
        const chunk = Buffer.alloc(65536, 120);
        for (let remaining = options.bytes; remaining > 0; remaining -= chunk.length) {
          await write(stream, chunk.subarray(0, Math.min(remaining, chunk.length)));
        }
      }
      if (options.exit !== undefined) {
        clearInterval(keepAlive);
        process.exit(options.exit);
      }
    });
  });
}
