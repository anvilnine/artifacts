// Minimal git smart-HTTP server used only by CI (the smoke-git job) to exercise the git
// storage backend against a real remote. Wraps `git http-backend` (CGI) with push enabled.
// Not for production use.
//
// Usage: node git-http-server.mjs <port> <project-root>

import http from 'node:http';
import { spawn } from 'node:child_process';

const GIT_HTTP_BACKEND = process.env.GIT_HTTP_BACKEND || '/usr/lib/git-core/git-http-backend';

const port = Number(process.argv[2] || 4600);
const projectRoot = process.argv[3];
if (!projectRoot) {
  console.error('usage: node git-http-server.mjs <port> <project-root>');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cgi = spawn(GIT_HTTP_BACKEND, [], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_HTTP_ALLOW_RECEIVE_PACK: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ''),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] || '',
        REMOTE_USER: 'ci',
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(cgi.stdin);

    let buf = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on('data', (chunk) => {
      if (headersDone) return void res.write(chunk);
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const rawHeaders = buf.subarray(0, sep).toString('utf8');
      const rest = buf.subarray(sep + 4);
      let status = 200;
      const headers = {};
      for (const line of rawHeaders.split('\r\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200;
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      if (rest.length) res.write(rest);
      headersDone = true;
    });
    cgi.stdout.on('end', () => res.end());
    cgi.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  })
  .listen(port, () => console.log(`git http server on :${port} root ${projectRoot}`));
