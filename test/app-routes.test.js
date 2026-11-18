// App builds over HTTP: upload, the install page, the token that lets iOS's install daemon and
// Android download managers fetch a gated build with no cookie, and the doors that keep a build
// from being lost to a JSON publish.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePlist } from '../lib/plist.js';
import { startServer } from './helpers/server.js';
import { fixture, makeIpa } from './helpers/app-builds.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

// The server's BASE_URL is https so the Install button renders, while the test talks to it over
// plain http on localhost. Links it hands out are mapped back onto the real address.
function local(srv, url) {
  return url.replace('https://dk.test', srv.base);
}

test('app builds: upload, page, private install flow, replace and refusals', async (t) => {
  const srv = await startServer({ BASE_URL: 'https://dk.test' });
  t.after(() => srv.stop());
  // startServer polls BASE_URL-independent /healthz, so srv.base is the real address.

  // ---- upload ----
  const apk = await srv.api('POST', '/api/artifacts/app?slug=kiln-apk&visibility=public', fixture('sample.apk'));
  assert.equal(apk.status, 201);
  const apkOut = await apk.json();
  assert.equal(apkOut.type, 'apk');
  assert.equal(apkOut.app.version, '2.3.1');

  // The JSON publish path refuses an app type rather than taking base64 it was never built for.
  const json = await srv.api('POST', '/api/artifacts', { type: 'ipa', content: 'eA==' });
  assert.equal(json.status, 400);
  assert.match((await json.json()).error, /POST \/api\/artifacts\/app/);

  // A file that is not a build is a 400 with a reason.
  const junk = await srv.api('POST', '/api/artifacts/app', Buffer.from('hello'));
  assert.equal(junk.status, 400);
  assert.match((await junk.json()).error, /zip archives/);

  // ---- public APK: page and download ----
  const page = await fetch(`${srv.base}/a/kiln-apk`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Kiln Demo/);
  assert.match(html, /href="\/a\/kiln-apk\/Kiln-Demo-2\.3\.1\.apk" download/);
  // Never framed, even though frames default on.
  assert.doesNotMatch(html, /\?raw=1/);
  const dl = await fetch(`${srv.base}/a/kiln-apk/Kiln-Demo-2.3.1.apk`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="Kiln-Demo-2.3.1.apk"');
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), fixture('sample.apk'));
  assert.equal((await fetch(`${srv.base}/a/kiln-apk/app.apk`)).status, 200);
  assert.equal((await fetch(`${srv.base}/a/kiln-apk/manifest.plist`)).status, 404);
  assert.equal((await fetch(`${srv.base}/a/kiln-apk/other.bin`)).status, 404);

  // ---- private IPA: the install daemon's path, with no cookie anywhere ----
  const ipaBytes = makeIpa();
  const ipa = await srv.api('POST', '/api/artifacts/app?slug=kiln-ipa&visibility=private', ipaBytes);
  assert.equal(ipa.status, 201);
  const { url } = await ipa.json();

  const exchange = await fetch(local(srv, url), { redirect: 'manual' });
  assert.equal(exchange.status, 302);
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  const ipaPage = await (await fetch(`${srv.base}/a/kiln-ipa`, { headers: { Cookie: cookie, 'User-Agent': IPHONE } })).text();
  assert.match(ipaPage, /<body class="p-ios /);
  const itms = ipaPage.match(/href="(itms-services:[^"]+)"/)[1].replace(/&amp;/g, '&');
  const manifestUrl = decodeURIComponent(itms.split('url=')[1]);
  assert.match(manifestUrl, /^https:\/\/dk\.test\/a\/kiln-ipa\/manifest\.plist\?t=/);

  const manifestRes = await fetch(local(srv, manifestUrl));
  assert.equal(manifestRes.status, 200);
  const manifest = parsePlist(Buffer.from(await manifestRes.arrayBuffer()));
  assert.equal(manifest.items[0].metadata['bundle-identifier'], 'com.example.kiln');
  const ipaUrl = manifest.items[0].assets[0].url;
  assert.match(ipaUrl, /^https:\/\/dk\.test\/a\/kiln-ipa\/Kiln-Demo-2\.3\.1\.ipa\?t=/);
  const ipaRes = await fetch(local(srv, ipaUrl));
  assert.equal(ipaRes.status, 200);
  assert.equal(ipaRes.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await ipaRes.arrayBuffer()), ipaBytes);

  // Without a token or a cookie, a gated build answers like a missing slug.
  assert.equal((await fetch(`${srv.base}/a/kiln-ipa/app.ipa`)).status, 404);
  assert.equal((await fetch(`${srv.base}/a/kiln-ipa/app.ipa?t=forged.token`)).status, 404);
  // The install token opens the build's files and nothing else: not the page, not /source.
  const token = new URL(ipaUrl).searchParams.get('t');
  assert.equal((await fetch(`${srv.base}/a/kiln-ipa?t=${encodeURIComponent(token)}`)).status, 404);
  assert.equal((await fetch(`${srv.base}/a/kiln-ipa/source?t=${encodeURIComponent(token)}`)).status, 404);
  // A token for one slug does not open another.
  assert.equal((await fetch(`${srv.base}/a/kiln-apk/app.apk?t=${encodeURIComponent(token)}`)).status, 200); // public anyway
  const other = await srv.api('POST', '/api/artifacts/app?slug=kiln-ipa-2&visibility=private', makeIpa());
  assert.equal(other.status, 201);
  assert.equal((await fetch(`${srv.base}/a/kiln-ipa-2/app.ipa?t=${encodeURIComponent(token)}`)).status, 404);

  // Rotate link revokes install tokens with everything else.
  const rot = await srv.api('PATCH', '/api/artifacts/kiln-ipa', { rotateToken: true });
  assert.equal(rot.status, 200);
  assert.equal((await fetch(local(srv, ipaUrl))).status, 404);

  // ---- replace the build, keep the link ----
  const before = await (await srv.api('GET', '/api/artifacts')).json();
  const epochLink = (await (await srv.api('GET', '/api/artifacts/kiln-ipa/link')).json()).url;
  const rep = await srv.api('PUT', '/api/artifacts/kiln-ipa/app', fixture('sample.apk'));
  assert.equal(rep.status, 200);
  const after = await (await srv.api('GET', '/api/artifacts')).json();
  const row = after.find((a) => a.slug === 'kiln-ipa');
  assert.equal(row.type, 'apk');
  assert.equal(row.visibility, 'private');
  assert.equal(row.createdAt, before.find((a) => a.slug === 'kiln-ipa').createdAt);
  // The link handed out before the swap still opens the page.
  assert.equal((await fetch(local(srv, epochLink), { redirect: 'manual' })).status, 302);

  // A JSON replace with no type would turn the build into html; it is refused instead.
  const lossy = await srv.api('PUT', '/api/artifacts/kiln-ipa', { content: '<p>x</p>' });
  assert.equal(lossy.status, 400);
  assert.match((await lossy.json()).error, /PUT \/api\/artifacts\/kiln-ipa\/app/);

  // A build cannot replace a page.
  assert.equal((await srv.api('POST', '/api/artifacts', { slug: 'a-page', content: '<p>x</p>' })).status, 201);
  const overPage = await srv.api('PUT', '/api/artifacts/a-page/app', fixture('sample.apk'));
  assert.equal(overPage.status, 400);
  assert.equal((await srv.api('PUT', '/api/artifacts/nope-nope/app', fixture('sample.apk'))).status, 404);

  // A copy brings the build and what was read from it.
  const dup = await srv.api('POST', '/api/artifacts/kiln-apk/duplicate', { slug: 'kiln-apk-copy' });
  assert.equal(dup.status, 201);
  const copy = (await (await srv.api('GET', '/api/artifacts')).json()).find((a) => a.slug === 'kiln-apk-copy');
  assert.equal(copy.app.id, 'com.example.kiln');
  assert.equal((await fetch(`${srv.base}/a/kiln-apk-copy/app.apk`)).status, 200);
});

test('app builds: an IPA on a plain-http server says iOS needs HTTPS', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  assert.equal((await srv.api('POST', '/api/artifacts/app?slug=http-ipa&visibility=public', makeIpa())).status, 201);
  const html = await (await fetch(`${srv.base}/a/http-ipa`, { headers: { 'User-Agent': IPHONE } })).text();
  assert.doesNotMatch(html, /itms-services/);
  assert.match(html, /only over HTTPS/);
});

test('app builds: APP_MAX_MB caps the body with a 413 that names the limit', async (t) => {
  const srv = await startServer({ APP_MAX_MB: '1' });
  t.after(() => srv.stop());
  const res = await srv.api('POST', '/api/artifacts/app', Buffer.alloc(2 * 1024 * 1024, 1));
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /limit on this request is 1 mb/i);
});
