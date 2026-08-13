#!/usr/bin/env node
// Dashboard guard for the smoke suite.
//
// The dashboard is a single public/index.html: ~1150 lines of inline JS, no build step,
// no module graph, nothing else in CI ever looks at it. This runs the cheapest set of
// checks that still go red on a real dashboard break, and it needs no browser:
//
//   1. GET / serves the app shell, as HTML, from the running instance
//   2. the inline script still parses (a syntax error anywhere in it fails here)
//   3. every element the script grabs by id is still in the markup (a deleted or
//      renamed element makes the script throw on the first line that touches it)
//   4. GET /api/auth/session still answers with the fields the boot path branches on
//
// What this does not catch: runtime errors that only appear once the script executes,
// such as a bad API field name or a handler that throws on click. Catching those needs a
// real DOM. That means a headless Chromium install and launch in each of the six jobs that
// run this suite, plus a heavy dependency in a repo with no build step, against the 80ms
// this file costs. If the dashboard outgrows these checks, one browser job is the next
// step, and it should stay a job that nothing else depends on.
//
// Usage: node dashboard-check.mjs <base-url>

import vm from 'node:vm';

const base = process.argv[2];
if (!base) {
  console.error('usage: dashboard-check.mjs <base-url>');
  process.exit(2);
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// --- 1. the shell is served ---

const res = await fetch(`${base}/`);
if (res.status !== 200) fail(`dashboard GET / returned ${res.status}`);
const ctype = res.headers.get('content-type') || '';
if (!ctype.includes('text/html')) fail(`dashboard GET / content-type is '${ctype}', not HTML`);
const html = await res.text();

for (const marker of ['<div id="lock">', '<div id="app">', '<title>artifacts</title>']) {
  if (!html.includes(marker)) fail(`dashboard shell is missing ${marker}`);
}
// Every inline type the server publishes needs an option inside the compose type select, or
// that type can only be published through the API, the CLI or MCP. redirect shipped without
// one (T2.1.7). The list is imported rather than copied here, so a sixth type fails this check
// on the day it is added instead of shipping with no way to compose it. It reads SOURCE_EXT,
// which is what server.js builds TYPES from and what the type-change cleanup keys off, so all
// three cannot drift apart (T2.1.9).
const typeSelect = html.match(/<select id="type">([\s\S]*?)<\/select>/);
if (!typeSelect) fail('the compose form has no <select id="type">');
const { SOURCE_EXT } = await import(new URL('../../lib/artifact-files.js', import.meta.url));
const types = Object.keys(SOURCE_EXT);
if (types.length < 2) fail(`parsed only ${types.length} type(s) from SOURCE_EXT`);
for (const type of types) {
  if (!typeSelect[1].includes(`value="${type}"`)) {
    fail(`the compose type select has no option for ${type}`);
  }
}
console.log(`ok: the compose type select offers all ${types.length} publishable types`);
console.log('ok: dashboard shell served');

// --- 2. the inline script parses ---

// Attributes allowed, so a later `<script defer>` is still parsed instead of silently
// skipped. `src` scripts have no inline body to check and would fail the empty-body parse.
const SCRIPT_RE = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
const scripts = [...html.matchAll(SCRIPT_RE)];
if (scripts.length === 0) fail('dashboard has no inline script');

for (const match of scripts) {
  // Line numbers in a parse error should point at public/index.html, not at the fragment.
  const lineOffset = html.slice(0, match.index).split('\n').length - 1;
  try {
    new vm.Script(match[1], { filename: 'public/index.html', lineOffset });
  } catch (err) {
    // The first stack frames carry the file, the line and the offending source.
    console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    fail(`dashboard script does not parse: ${err.message}`);
  }
}
console.log(`ok: dashboard inline script parses (${scripts.length} block(s))`);

// --- 3. every id the script grabs still exists in the markup ---

const code = scripts.map((m) => m[1]).join('\n');
// Ids declared by the script itself (inside template strings) do not count: the point is
// that the static markup still carries what the script reaches for on load.
const markup = html.replace(SCRIPT_RE, '');
const declared = new Set([...markup.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]));
const grabbed = new Set([
  ...[...code.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ...[...code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
]);

// Staleness guard: if the dashboard ever stops using the $('id') helper this check would
// pass while testing nothing, so make that show up as a failure instead.
if (grabbed.size < 20) {
  fail(`only ${grabbed.size} id lookups found in the dashboard script; this check has gone stale`);
}

const missing = [...grabbed].filter((id) => !declared.has(id)).sort();
if (missing.length) {
  fail(`dashboard script grabs ${missing.length} id(s) with no element in the markup: ${missing.join(', ')}`);
}
console.log(`ok: all ${grabbed.size} ids the dashboard grabs exist in the markup`);

// --- 4. the endpoint the dashboard calls first still answers ---

const sessionRes = await fetch(`${base}/api/auth/session`);
if (sessionRes.status !== 200) fail(`GET /api/auth/session returned ${sessionRes.status}`);
const session = await sessionRes.json().catch(() => null);
if (!session || typeof session.authenticated !== 'boolean' || typeof session.needsSetup !== 'boolean') {
  fail(`GET /api/auth/session did not return authenticated/needsSetup booleans: ${JSON.stringify(session)}`);
}
console.log('ok: /api/auth/session drives the dashboard boot path');
