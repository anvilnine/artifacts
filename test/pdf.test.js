// PDF artifacts: what the publish path accepts as a body, and what the viewer shell is told
// to do with it.
//
// This lives outside server.js for the reason lib/redirect.js does: no test boots the server,
// so the rules a caller actually hits (the base64 decode, the magic-number check, the size cap)
// are only provable when they sit in a module a test can import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePdfContent,
  parsePdfSettings,
  pdfSettings,
  pdfSettingsForMeta,
  pdfViewerFlags,
  PDF_DEFAULTS,
  PDF_MAX_BYTES,
  PDF_MODES,
} from '../lib/pdf.js';

// A real one-page PDF, small enough to inline. Built by hand with correct xref offsets, so
// a browser opens it rather than falling back to its own repair pass.
const TINY_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMjAwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQxPj5zdHJlYW0KQlQgL0YxIDI0IFRmIDMwIDEwMCBUZCAoc21va2UgcGRmKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU0IDAwMDAwIG4gCjAwMDAwMDAxMDUgMDAwMDAgbiAKMDAwMDAwMDIxNyAwMDAwMCBuIAowMDAwMDAwMzA0IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMzY3CiUlRU9GCg==';

test('a base64 body decodes to the exact bytes that were sent', () => {
  const buf = parsePdfContent(TINY_PDF_B64);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('base64'), TINY_PDF_B64);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('a data: URL wrapper and wrapped lines both decode', () => {
  const wanted = parsePdfContent(TINY_PDF_B64);
  assert.deepEqual(parsePdfContent(`data:application/pdf;base64,${TINY_PDF_B64}`), wanted);
  // A base64 file written by `base64 file.pdf` comes back with newlines every 76 characters.
  const wrapped = TINY_PDF_B64.match(/.{1,76}/g).join('\n');
  assert.deepEqual(parsePdfContent(wrapped), wanted);
  assert.deepEqual(parsePdfContent(`  ${TINY_PDF_B64}  `), wanted);
});

test('bytes that are not a PDF are refused', () => {
  // The decode is lenient (Node drops characters that are not base64), so the magic number is
  // what actually decides. Anything that is not a PDF lands here, whatever it decoded from.
  for (const bad of [
    Buffer.from('<h1>hello</h1>').toString('base64'),
    Buffer.from('PK a zip, not a pdf').toString('base64'),
    'not base64 at all',
  ]) {
    assert.throws(() => parsePdfContent(bad), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /%PDF-/);
      return true;
    }, `${bad.slice(0, 20)} should be refused`);
  }
});

test('an empty or non-string body is refused', () => {
  for (const bad of ['', '    ', undefined, null, 42, {}]) {
    assert.throws(() => parsePdfContent(bad), (err) => {
      assert.equal(err.status, 400);
      return true;
    }, `${String(bad)} should be refused`);
  }
});

test('a truncated or corrupted upload is refused', () => {
  // The magic number only proves the first five bytes. Half an upload still starts with
  // %PDF-, stores, and then renders nothing, with nothing anywhere saying why. Every PDF ends
  // with %%EOF, so a tail with no marker in it is the signal that bytes are missing.
  const whole = Buffer.from(TINY_PDF_B64, 'base64');
  const halfway = whole.subarray(0, Math.floor(whole.length / 2));
  // Base64 cut short: what a dropped chunk of an upload decodes to.
  const cutShort = TINY_PDF_B64.slice(0, 60);
  // One character dropped from the middle, which shifts every byte after it. Node's decoder
  // skips characters it cannot use instead of throwing, so nothing before this said a word.
  const shifted = TINY_PDF_B64.slice(0, 40) + TINY_PDF_B64.slice(41);
  for (const bad of [halfway.toString('base64'), cutShort, shifted]) {
    assert.throws(() => parsePdfContent(bad), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /truncated/);
      return true;
    }, `${bad.slice(0, 20)} should be refused`);
  }
});

test('the size cap is measured on the decoded bytes, not the base64', () => {
  // Base64 is 4 bytes per 3, so a body one byte over the cap is well under the JSON body
  // limit that would otherwise catch it. Measuring the encoded string instead would refuse
  // PDFs a quarter smaller than the documented cap.
  const head = Buffer.from('%PDF-1.4\n');
  const tail = Buffer.from('\n%%EOF\n'); // else the truncation check answers first
  const pad = Buffer.alloc(PDF_MAX_BYTES + 1 - head.length - tail.length, 0x20);
  const tooBig = Buffer.concat([head, pad, tail]);
  assert.equal(tooBig.length, PDF_MAX_BYTES + 1);
  assert.throws(() => parsePdfContent(tooBig.toString('base64')), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /too large/);
    // The cap in MB as well as in bytes: the express body limit answers first for anything
    // much bigger than this, and its message names neither, so this one has to be readable.
    assert.match(err.message, /7 MB/);
    return true;
  });

  const justUnder = Buffer.concat([tooBig.subarray(0, PDF_MAX_BYTES - tail.length), tail]);
  assert.equal(justUnder.length, PDF_MAX_BYTES);
  assert.equal(parsePdfContent(justUnder.toString('base64')).length, PDF_MAX_BYTES);
});

// --- viewer controls (T2.2.2) -------------------------------------------------

test('an artifact with nothing stored reads as the standard viewer', () => {
  assert.deepEqual(pdfSettings(undefined), { mode: 'standard', download: true });
  assert.deepEqual(pdfSettings({ slug: 's', type: 'pdf' }), { mode: 'standard', download: true });
  assert.deepEqual(pdfSettings({ pdf: PDF_DEFAULTS }), { mode: 'standard', download: true });
});

test('a stored value that makes no sense falls back to the default for that field alone', () => {
  // meta.json can be hand-edited and can come from an older build, so reading it is tolerant:
  // a bad mode does not take the download setting down with it.
  assert.deepEqual(pdfSettings({ pdf: { mode: 'slideshow', download: false } }), {
    mode: 'standard',
    download: false,
  });
  assert.deepEqual(pdfSettings({ pdf: { mode: 'minimal', download: 'yes' } }), {
    mode: 'minimal',
    download: true,
  });
  assert.deepEqual(pdfSettings({ pdf: 'minimal' }), { mode: 'standard', download: true });
});

test('a patch merges over what is already stored', () => {
  const current = { mode: 'presentation', download: false };
  assert.deepEqual(parsePdfSettings({ mode: 'minimal' }, current), {
    mode: 'minimal',
    download: false,
  });
  assert.deepEqual(parsePdfSettings({ download: true }, current), {
    mode: 'presentation',
    download: true,
  });
  // null is the reset, the way PATCH {"frame": null} hands an artifact back to the default.
  assert.deepEqual(parsePdfSettings(null, current), PDF_DEFAULTS);
  assert.deepEqual(parsePdfSettings({}, current), current);
});

test('every mode the docs name is accepted and nothing else is', () => {
  assert.deepEqual(PDF_MODES, ['standard', 'presentation', 'minimal']);
  for (const mode of PDF_MODES) {
    assert.equal(parsePdfSettings({ mode }, PDF_DEFAULTS).mode, mode);
  }
  for (const bad of ['slides', 'Standard', '', 1, null, undefined]) {
    assert.throws(() => parsePdfSettings({ mode: bad }, PDF_DEFAULTS), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /pdf.mode/);
      return true;
    }, `mode ${String(bad)} should be refused`);
  }
});

test('a bad shape or an unknown key is a 400 rather than a silent drop', () => {
  for (const bad of ['minimal', 42, [], true]) {
    assert.throws(() => parsePdfSettings(bad, PDF_DEFAULTS), (err) => {
      assert.equal(err.status, 400);
      return true;
    }, `${String(bad)} should be refused`);
  }
  assert.throws(() => parsePdfSettings({ download: 'no' }, PDF_DEFAULTS), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /pdf.download/);
    return true;
  });
  assert.throws(() => parsePdfSettings({ toolbar: false }, PDF_DEFAULTS), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /toolbar/);
    return true;
  });
});

test('the default settings are stored as nothing at all', () => {
  assert.equal(pdfSettingsForMeta({ mode: 'standard', download: true }), undefined);
  assert.deepEqual(pdfSettingsForMeta({ mode: 'minimal', download: true }), {
    mode: 'minimal',
    download: true,
  });
  assert.deepEqual(pdfSettingsForMeta({ mode: 'standard', download: false }), {
    mode: 'standard',
    download: false,
  });
});

test('what the viewer is told, per mode', () => {
  // The standard view leaves the browser's own PDF toolbar alone; the other two ask for it to
  // go, and presentation asks for a whole page at a time instead of a fitted width.
  const standard = pdfViewerFlags({ mode: 'standard', download: true });
  assert.equal(standard.bar, true);
  assert.equal(standard.download, true);
  assert.ok(!standard.hash.includes('toolbar=0'));
  assert.ok(standard.hash.includes('view=FitH'));

  // minimal drops our toolbar, and with downloads on the browser's own is the only way left
  // to reach the file, so it stays. Taking both away made "PDF download: on" a claim the page
  // could not keep.
  const minimal = pdfViewerFlags({ mode: 'minimal', download: true });
  assert.equal(minimal.bar, false); // no toolbar of ours
  assert.ok(!minimal.hash.includes('toolbar=0'));
  assert.ok(!minimal.hash.includes('navpanes=0'));

  const presentation = pdfViewerFlags({ mode: 'presentation', download: true });
  assert.equal(presentation.bar, true); // kept, because it holds the full-screen button
  assert.equal(presentation.fullscreen, true);
  assert.ok(presentation.hash.includes('view=Fit'));
  // T2.2.5: the browser's toolbar stays, because it carries the only page counter and the only
  // prev/next a reader of a multi-page deck gets. The side panel still goes.
  assert.ok(!presentation.hash.includes('toolbar=0'));
  assert.ok(presentation.hash.includes('navpanes=0'));
});

// An <object> holding a PDF is not a document this page can drive: there is no API for the
// current page, and reassigning the object's data to jump to #page=N blanks the viewer in
// Chromium rather than moving it (checked in a browser). So the browser's own toolbar is the
// only page navigation there is, and presentation mode has to leave it alone to have any.
test('presentation mode leaves the reader a way to move page to page', () => {
  const presentation = pdfViewerFlags({ mode: 'presentation', download: true });
  assert.ok(!presentation.hash.includes('toolbar=0'), 'the page counter and prev/next live there');
});

// The one case that cannot have both: downloads off works by taking that toolbar away, since it
// carries a download button and a print button. The setting wins, and the docs say so.
test('downloads off still beats page navigation in presentation mode', () => {
  const locked = pdfViewerFlags({ mode: 'presentation', download: false });
  assert.ok(locked.hash.includes('toolbar=0'));
  assert.ok(locked.hash.includes('navpanes=0'));
});

test('downloads off take the browser toolbar with them, in every mode', () => {
  // Viewer-level only: /a/<slug>/file.pdf still answers with the bytes. What this removes is
  // every button on the page that leads to them, which is what the toggle claims to do.
  for (const mode of PDF_MODES) {
    const flags = pdfViewerFlags({ mode, download: false });
    assert.equal(flags.download, false, mode);
    assert.ok(flags.hash.includes('toolbar=0'), `${mode} keeps the browser toolbar`);
  }
});

// ---------------------------------------------------------------------------
// T2.2.6: the default framed view stacked three toolbars
// ---------------------------------------------------------------------------
//
// Measured in a browser at 1200px, standard mode inside the viewer frame: the frame's own bar
// (44px), our pdf bar (44px) and the browser's pdf toolbar (56px), about 144px before the
// document starts. The middle one is the one that earns least. Framed, its title is already
// blanked because the frame bar above says the same words, which leaves Open and Download, and
// the browser's toolbar underneath already has download and print.
//
// So framed standard mode drops our bar. presentation keeps it, because the full-screen button
// lives nowhere else. minimal never had one.

test('framed standard mode gives up our bar, the other modes keep theirs', () => {
  assert.equal(pdfViewerFlags({ mode: 'standard', download: true }).hideBarInFrame, true);
  assert.equal(pdfViewerFlags({ mode: 'presentation', download: true }).hideBarInFrame, false);
  assert.equal(pdfViewerFlags({ mode: 'minimal', download: true }).hideBarInFrame, false);
});

// Standard with downloads off already renders no bar at all, server side: there are no buttons
// left to put in one. Nothing to hide, and the browser's toolbar is gone too, so saying "hide"
// there would read as a second rule doing the same thing.
test('a mode that already draws no bar is not asked to hide one', () => {
  const locked = pdfViewerFlags({ mode: 'standard', download: false });
  assert.equal(locked.bar, true); // the shell is told standard has a bar
  assert.equal(locked.hideBarInFrame, false);
});

// Unframed is untouched. With no frame bar above it, our bar is the only thing naming the
// artifact and the only Open and Download on the page.
test('our bar is never dropped outside the frame', () => {
  for (const mode of PDF_MODES) {
    const flags = pdfViewerFlags({ mode, download: true });
    if (flags.hideBarInFrame) {
      assert.equal(mode, 'standard', 'only standard gives its bar up, and only inside the frame');
    }
  }
});
