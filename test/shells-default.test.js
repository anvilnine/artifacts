// The byte-identity promise, checked against the real thing.
//
// test/brand-shells.test.js checks each slot VALUE against the literal the shell used to carry.
// That guards the values and nothing else: move `{{LOGO}}` onto its own line, or put a blank line
// around `{{BRAND_STYLE}}`, and every value assertion still passes while the page a viewer loads
// has changed. So this fills each current shell with the all-empty branding slots and compares
// the whole file against the render origin/main served, kept under test/fixtures/shells-default.
//
// Refresh a fixture only when the untouched page is meant to change, by re-rendering the shell
// with nothing branded and writing that out:
//   node -e "…fillShell(readFileSync('shells/<file>'), <name>BrandSlots(NONE))…"
// Then read the diff. It should show your change and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fillShell } from '../lib/shells.js';
import {
  frameBrandSlots,
  jsxBrandSlots,
  mdBrandSlots,
  notFoundBrandSlots,
  passwordBrandSlots,
} from '../lib/branding.js';
import { NOT_FOUND_COPY } from '../lib/status-page.js';

const here = dirname(fileURLToPath(import.meta.url));
const shell = (name) => readFileSync(join(here, '..', 'shells', `${name}.html`), 'utf8');
const fixture = (name) => readFileSync(join(here, 'fixtures', 'shells-default', `${name}.html`), 'utf8');

const NONE = { productName: '', logoUrl: '', faviconUrl: '', accentColor: '', footerText: '' };

// not-found.html carries the card's words in slots too, so the 404 render needs the 404 copy
// alongside the branding slots. The bytes that come out are the same bytes as before; the copy
// only moved from the template into lib/status-page.js so the 410 card can reuse the shell.
const SHELLS = [
  ['frame', frameBrandSlots, {}],
  ['password', passwordBrandSlots, {}],
  ['not-found', notFoundBrandSlots, NOT_FOUND_COPY],
  ['md', mdBrandSlots, {}],
  ['jsx', jsxBrandSlots, {}],
];

for (const [name, slots, copy] of SHELLS) {
  test(`${name}.html with nothing branded is byte for byte what origin/main served`, () => {
    assert.equal(fillShell(shell(name), { ...slots(NONE), ...copy }), fixture(name));
  });
}
