// The deadline the s3 backend puts on a streamed read. It covers the wait for the response
// headers and nothing after them, so a stalled endpoint fails the request while a slow download
// runs to the end. Driven against a local HTTP server: no bucket is involved, because the helper
// takes the fetch as a function.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// aws4fetch is an optional dependency, and storage/s3.js imports it at the top.
const s3 = await import('../storage/s3.js').catch(() => null);
const skip = s3 ? false : 'aws4fetch is not installed';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a read whose headers never arrive is failed at the deadline', { skip }, async () => {
  const upstream = await serve(() => {}); // accepts the request and never answers
  try {
    const started = Date.now();
    await assert.rejects(
      () => s3.headersWithin(50, (signal) => fetch(upstream.url, { signal })),
      { name: 'TimeoutError' },
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    await upstream.close();
  }
});

test('a body that outlasts the deadline still streams to the end', { skip }, async () => {
  const upstream = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('first ');
    setTimeout(() => res.end('second'), 200);
  });
  try {
    const res = await s3.headersWithin(50, (signal) => fetch(upstream.url, { signal }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'first second');
  } finally {
    await upstream.close();
  }
});

test('a failure that is not a timeout keeps its own error', { skip }, async () => {
  await assert.rejects(
    () => s3.headersWithin(50, () => Promise.reject(new Error('connection refused'))),
    { message: 'connection refused' },
  );
});
