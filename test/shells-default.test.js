// The byte-identity promise, checked against the real thing.
//
// test/brand-shells.test.js checks each slot VALUE against the literal the shell used to carry.
// That guards the values and nothing else: move `{{LOGO}}` onto its own line, or put a blank line
// around `{{BRAND_STYLE}}`, and every value assertion still passes while the page a viewer loads
// has changed. So this fills each current shell with the all-empty branding slots and compares
// the whole file against the render origin/main served, kept under test/fixtures/shells-default.
//
// Refresh a fixture only when the untouched page is meant to change:
//   git show origin/main:shells/<file> > test/fixtures/shells-default/<file>

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

const here = dirname(fileURLToPath(import.meta.url));
const shell = (name) => readFileSync(join(here, '..', 'shells', `${name}.html`), 'utf8');
const fixture = (name) => readFileSync(join(here, 'fixtures', 'shells-default', `${name}.html`), 'utf8');

const NONE = { productName: '', logoUrl: '', faviconUrl: '', accentColor: '', footerText: '' };

const SHELLS = [
  ['frame', frameBrandSlots],
  ['password', passwordBrandSlots],
  ['not-found', notFoundBrandSlots],
  ['md', mdBrandSlots],
  ['jsx', jsxBrandSlots],
];

for (const [name, slots] of SHELLS) {
  test(`${name}.html with nothing branded is byte for byte what origin/main served`, () => {
    assert.equal(fillShell(shell(name), slots(NONE)), fixture(name));
  });
}
