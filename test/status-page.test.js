// The two pages a viewer lands on when there is nothing to show: the 404 card and the 410
// card. Both come out of shells/not-found.html, so the copy lives in one place and the
// branding slots fill the same way for each.
//
// The Accept split is the other half: a person following a link gets the card, a script or a
// sub-resource read keeps the one-line body it has always had.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fillShell } from '../lib/shells.js';
import { notFoundBrandSlots } from '../lib/branding.js';
import { wantsHtmlPage, NOT_FOUND_COPY, EXPIRED_COPY } from '../lib/status-page.js';

const here = dirname(fileURLToPath(import.meta.url));
const SHELL = readFileSync(join(here, '..', 'shells', 'not-found.html'), 'utf8');
const NONE = { productName: '', logoUrl: '', faviconUrl: '', accentColor: '', footerText: '' };

const render = (copy) => fillShell(SHELL, { ...notFoundBrandSlots(NONE), ...copy });

test('a browser navigation asks for the card', () => {
  const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8';
  assert.equal(wantsHtmlPage(browser), true);
  assert.equal(wantsHtmlPage('text/html'), true);
});

test('curl, fetch and a sub-resource read keep the plain body', () => {
  assert.equal(wantsHtmlPage('*/*'), false);
  assert.equal(wantsHtmlPage('image/avif,image/webp,*/*'), false);
  assert.equal(wantsHtmlPage('application/json'), false);
  assert.equal(wantsHtmlPage(undefined), false);
  assert.equal(wantsHtmlPage(''), false);
});

test('the expired card says 410 and names expiry', () => {
  const html = render(EXPIRED_COPY);
  assert.match(html, /<p class="status">410<\/p>/);
  assert.match(html, /<h1>Artifact expired<\/h1>/);
  assert.match(html, /<title>Artifact expired<\/title>/);
  assert.match(html, /expire/);
});

test('the missing card keeps the 404 copy it has always had', () => {
  const html = render(NOT_FOUND_COPY);
  assert.match(html, /<p class="status">404<\/p>/);
  assert.match(html, /<h1>Artifact unavailable<\/h1>/);
  assert.match(html, /<title>Artifact unavailable<\/title>/);
});

test('neither card ships an unfilled slot', () => {
  for (const copy of [NOT_FOUND_COPY, EXPIRED_COPY]) {
    assert.doesNotMatch(render(copy), /\{\{[A-Z_]+\}\}/);
  }
});

test('both cards tell a crawler to stay away', () => {
  for (const copy of [NOT_FOUND_COPY, EXPIRED_COPY]) {
    assert.match(render(copy), /name="robots" content="noindex, nofollow"/);
  }
});
