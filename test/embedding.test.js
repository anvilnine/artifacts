// T2.5.2, the half that needs no product decision: the embed snippet and the page that explains
// it. The server already lets any site frame an artifact (ARTIFACT_CSP carries no
// frame-ancestors), so nothing here changes what a viewer's browser is allowed to do. What
// shipped is the snippet in the dashboard row menu and docs/embedding.md.
//
// These checks pin the three claims a person acts on: the snippet loads `?raw=1` rather than the
// toolbar page, it is built from the server's own BASE_URL rather than the origin the operator
// happens to have the dashboard open on, and the docs say why a private or password artifact
// shows nothing inside someone else's frame. The live header contract is in
// .github/workflows/smoke.sh, under "an artifact can be embedded on another site".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const flat = (rel) => read(rel).replace(/\s+/g, ' ');

function says(file, phrases) {
  const text = flat(file);
  for (const phrase of phrases) {
    assert.ok(text.includes(phrase), `${file} no longer says: ${phrase}`);
  }
}

test('the dashboard row menu offers an embed snippet', () => {
  says('public/index.html', ['Embed…', 'function openEmbed(']);
});

test('the snippet loads the bare artifact from the server base URL', () => {
  const page = read('public/index.html');
  const build = page.slice(page.indexOf('function openEmbed('), page.indexOf('const collapsed'));
  assert.ok(build.includes('serverBaseUrl'), 'the snippet is not built from the server base URL');
  assert.ok(build.includes('?raw=1'), 'the snippet does not load the artifact without the toolbar');
  assert.ok(build.includes('<iframe'), 'the snippet is not an iframe tag');
});

test('docs/embedding.md explains the URL, the size and the visibility rule', () => {
  says('docs/embedding.md', [
    '/a/<slug>?raw=1',
    'Only a public artifact can be embedded',
  ]);
});

test('the README points at the embedding page', () => {
  says('README.md', ['docs/embedding.md']);
});
