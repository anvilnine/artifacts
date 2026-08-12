// Filling a shell template. The cases that matter are the ones a chain of `.replace()` calls got
// wrong: a value that carries another slot's name, and a value that carries `$` patterns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillShell } from '../lib/shells.js';

test('every slot is filled from the table, including a repeated one', () => {
  const out = fillShell('<title>{{TITLE}}</title><h1>{{TITLE}}</h1>{{BODY}}', {
    TITLE: 'hello',
    BODY: '<p>hi</p>',
  });
  assert.equal(out, '<title>hello</title><h1>hello</h1><p>hi</p>');
});

test('a value naming another slot does not steal it', () => {
  // The bug this replaced: SOCIAL was filled first, so a description of "{{CONTENT}}" became the
  // target of the CONTENT substitution, which put the unescaped body inside a meta attribute and
  // left the real content slot in the page as literal text.
  const out = fillShell('<meta content="{{SOCIAL}}">{{CONTENT}}', {
    SOCIAL: 'desc={{CONTENT}}',
    CONTENT: '<h1>body</h1>',
  });
  assert.equal(out, '<meta content="desc={{CONTENT}}"><h1>body</h1>');
});

test('a value naming its own slot is not filled again', () => {
  const out = fillShell('{{TITLE}}', { TITLE: '{{TITLE}}' });
  assert.equal(out, '{{TITLE}}');
});

test('$ patterns in a value are inserted verbatim', () => {
  for (const value of ['$&', '$`', "$'", '$$', '$1']) {
    assert.equal(fillShell('[{{V}}]', { V: value }), `[${value}]`, `mangled ${value}`);
  }
});

test('a slot with no value is left alone', () => {
  assert.equal(fillShell('{{A}}/{{B}}', { A: 'x' }), 'x/{{B}}');
  // Including one whose name collides with an inherited object property.
  assert.equal(fillShell('{{CONSTRUCTOR}}', {}), '{{CONSTRUCTOR}}');
});
