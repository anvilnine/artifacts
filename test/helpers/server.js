// Starts a real server.js on a free local port with its own temporary data directory, for tests
// that need to hit routes. Lives outside the test/*.test.js glob so `npm test` does not run it as
// a test file of its own.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export const TEST_KEY = 'test-bootstrap-key-0123456789';

export async function startServer(env = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'artifacts-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DATA_DIR: dataDir,
      STORAGE_BACKEND: 'local',
      ARTIFACTS_API_KEY: TEST_KEY,
      BASE_URL: base,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server did not start:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const api = (method, route, body, headers = {}) =>
    fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${TEST_KEY}`,
        ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });

  return {
    base,
    dataDir,
    api,
    output: () => output,
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
