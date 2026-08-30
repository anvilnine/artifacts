// T2.1.19: a PUT that leaves `type` out rewrites the artifact as html and deletes the files the
// old type owned. Z's call was to keep the behaviour and make every doc surface say so, because
// making `type` sticky would change what callers already depend on.
//
// These checks pin the warning to the four places a caller reads before sending a PUT: the REST
// reference, the CLI reference, the MCP reference, and the `update_artifact` tool description the
// agent itself sees. A doc rewrite that drops the warning fails here instead of shipping quiet.
// Whitespace collapses first, so a reflowed paragraph still matches. To change the wording, change
// the phrase here in the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raw = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const flat = (rel) => raw(rel).replace(/\s+/g, ' ');

// One helper so a failure names the phrase that went missing rather than printing the whole file.
function says(file, phrases) {
  const text = flat(file);
  for (const phrase of phrases) {
    assert.ok(text.includes(phrase), `${file} no longer says: ${phrase}`);
  }
}

test('docs/api.md says an omitted type converts the artifact and drops its source', () => {
  says('docs/api.md', [
    '`type` is required on a `PUT`',
    'deletes the files the old type owned',
  ]);
});

test('docs/api.md names the two types that refuse the call instead of converting', () => {
  says('docs/api.md', [
    '`PUT` on a pdf must name `type`',
    '`PUT` (inline content) is refused on zip sites',
  ]);
});

test('docs/cli.md shows --type on update and says the CLI always sends one', () => {
  const usage = raw('docs/cli.md')
    .split('\n')
    .find((line) => line.startsWith('artifacts update <slug> <file>'));
  assert.ok(usage, 'docs/cli.md has no `artifacts update` usage line');
  assert.ok(usage.includes('--type'), `the update usage line is missing --type: ${usage}`);
  says('docs/cli.md', ['always sends a type']);
});

test('docs/mcp.md tells an agent to pass type on every non-html update', () => {
  says('docs/mcp.md', [
    'Pass it on every update of a `jsx`, `tsx`, `md`, `pdf` or `redirect` artifact',
  ]);
});

test('the update_artifact tool description carries the same warning', () => {
  says('server.js', [
    'pass it on every update of a jsx, tsx, md, pdf or redirect artifact',
  ]);
});
