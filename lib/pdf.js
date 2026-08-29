// PDF artifacts: turning a JSON body into bytes on the way in.
//
// A PDF is the first artifact type that is not text. Every other single-file type stores the
// string it was sent; this one stores a decoded Buffer, so the decode and the checks around it
// live here rather than inline in the publish path, and a test can run them with no server and
// no storage backend.
//
// Base64 in the JSON body rather than a raw-body endpoint of its own: `content` is a string on
// POST, PUT and the MCP tools, and the whole publish path (slug chaining, visibility, tags,
// expiry, type-change cleanup) already runs off that one field. A second binary endpoint would
// have to repeat all of it, the way the zip endpoint does.

import { ApiError } from './errors.js';

// Largest PDF we accept, measured on the decoded bytes. The publish body parser stops at
// 10 MB of JSON (jsonPublish in server.js) and base64 costs 4 bytes for every 3, so 7 MB of
// PDF is about 9.33 MB of body: the last size that still leaves room for the rest of the
// request. A PDF over this gets a 400 that names the cap instead of the parser's bare 413.
export const PDF_MAX_BYTES = 7 * 1024 * 1024;

// Every PDF starts with this. It is the file-type check: Buffer.from(s, 'base64') drops
// characters that are not base64 instead of throwing, so a body of prose decodes to something
// rather than failing, and the magic number is what actually turns it away.
const PDF_MAGIC = '%PDF-';

// And every PDF ends with this, within a few bytes of the last one. The magic number only
// proves the first five bytes, so half an upload passed it, stored, and then rendered nothing
// with no signal anywhere that bytes were missing. A 1 KB tail leaves room for the trailing
// newline and whitespace writers add after the marker.
const PDF_EOF = '%%EOF';
const PDF_EOF_WINDOW = 1024;

// A `data:` prefix a browser's FileReader.readAsDataURL leaves on the front.
const DATA_URL_PREFIX = /^data:application\/pdf(;[^,]*)?,/i;

// The bytes of a PDF artifact, decoded from the base64 `content` field. Throws a 400 on
// anything that is not a PDF the server is willing to store.
export function parsePdfContent(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, 'content (base64-encoded PDF bytes) is required for a pdf artifact');
  }
  // Whitespace goes first: `base64 file.pdf` wraps at 76 columns, and those newlines survive
  // a JSON round trip.
  const encoded = value.trim().replace(DATA_URL_PREFIX, '').replace(/\s+/g, '');
  const buf = Buffer.from(encoded, 'base64');
  if (buf.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
    throw new ApiError(
      400,
      `content must be base64-encoded PDF bytes: the decoded body does not start with ${PDF_MAGIC}`,
    );
  }
  // Measured on the decoded bytes so the cap means what the docs say it means. Checking the
  // base64 string instead would turn a 7 MB limit into a 5.25 MB one. The cap is named in MB
  // as well as in bytes because this is the message a person reads after a failed upload.
  if (buf.length > PDF_MAX_BYTES) {
    throw new ApiError(
      400,
      `pdf too large (${buf.length} > ${PDF_MAX_BYTES} bytes once decoded, the ${PDF_MAX_BYTES / (1024 * 1024)} MB cap)`,
    );
  }
  const tail = buf.subarray(Math.max(0, buf.length - PDF_EOF_WINDOW)).toString('latin1');
  if (!tail.includes(PDF_EOF)) {
    throw new ApiError(
      400,
      `the pdf looks truncated: no ${PDF_EOF} marker in the last ${PDF_EOF_WINDOW} bytes of the decoded body`,
    );
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Viewer controls (T2.2.2)
// ---------------------------------------------------------------------------

// How the viewer page presents the document.
//
// - standard: our toolbar, and the browser's own PDF controls left alone.
// - presentation: one whole page at a time on a dark backdrop, with a full-screen button.
// - minimal: the document and nothing else, edge to edge.
export const PDF_MODES = ['standard', 'presentation', 'minimal'];

// What an artifact with no stored settings behaves as.
export const PDF_DEFAULTS = { mode: 'standard', download: true };

// Read the settings off a stored record. Tolerant on purpose: meta.json can be hand-edited and
// can come from a build that wrote something else, and a value nobody can parse must not cost the
// artifact its viewer page. Each field falls back on its own, so one bad key does not reset the
// other.
export function pdfSettings(meta) {
  const stored = meta && typeof meta.pdf === 'object' && meta.pdf !== null ? meta.pdf : {};
  return {
    mode: PDF_MODES.includes(stored.mode) ? stored.mode : PDF_DEFAULTS.mode,
    download: typeof stored.download === 'boolean' ? stored.download : PDF_DEFAULTS.download,
  };
}

// Read a `pdf` field off a request and merge it over what the artifact already has. A patch
// naming one key leaves the other alone, and `null` hands the artifact back to the defaults, the
// way PATCH {"frame": null} does. Strict where the read above is tolerant: a caller who sends a
// value the server does not understand gets told, rather than watching it vanish.
export function parsePdfSettings(value, current = PDF_DEFAULTS) {
  if (value === null) return { ...PDF_DEFAULTS };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'pdf must be an object of viewer settings, or null to reset them');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'mode' && key !== 'download') {
      throw new ApiError(400, `unknown pdf setting "${key}": pdf takes mode and download`);
    }
  }
  const next = { ...current };
  if (Object.hasOwn(value, 'mode')) {
    if (!PDF_MODES.includes(value.mode)) {
      throw new ApiError(400, `pdf.mode must be one of: ${PDF_MODES.join(', ')}`);
    }
    next.mode = value.mode;
  }
  if (Object.hasOwn(value, 'download')) {
    if (typeof value.download !== 'boolean') {
      throw new ApiError(400, 'pdf.download must be a boolean');
    }
    next.download = value.download;
  }
  return next;
}

// What to write into meta.json. The defaults are stored as nothing at all, the way public
// visibility is the omitted default, so an artifact nobody has configured carries no extra key
// and a later change to the defaults reaches it.
export function pdfSettingsForMeta(settings) {
  const same = settings.mode === PDF_DEFAULTS.mode && settings.download === PDF_DEFAULTS.download;
  return same ? undefined : { ...settings };
}

// What the viewer shell is told, from one set of settings.
//
// `hash` is the fragment on the embedded file's URL. Those are the old Acrobat open parameters,
// which Chrome's built-in viewer still reads; Firefox and Safari ignore them, so the browser
// toolbar is only really gone in Chrome. That is why turning downloads off also takes away every
// button on our own page: the parameters alone are a request, not a rule.
//
// `bar` is whether our toolbar renders at all, `download` whether it offers the file, and
// `fullscreen` whether it offers the full-screen button presentation mode needs.
export function pdfViewerFlags(settings) {
  const { mode, download } = settings;
  const params = [];
  // A page at a time for presentation, a fitted width for reading.
  params.push(mode === 'presentation' ? 'view=Fit' : 'view=FitH');
  // Downloads off takes the browser's toolbar with it, in every mode. That toolbar carries a
  // download button and a print button, so leaving it up would make "PDF download: off" a label
  // the page disagrees with. minimal drops our own toolbar too, so with downloads on the
  // browser's is the only way left to reach the file and it stays.
  if (!download) {
    params.push('toolbar=0', 'navpanes=0');
  } else if (mode === 'presentation') {
    // The side panel goes; the toolbar stays. It holds the page counter of a multi-page deck
    // (Chromium draws a typeable page field and the total, no prev/next buttons), and there is
    // no way to build our own: an <object> holding a PDF exposes
    // no current page, and reassigning its data to jump to #page=N blanks the viewer in
    // Chromium instead of moving it. What makes the mode is still here, one whole page at a
    // time, the dark backdrop and the full-screen button, and Chrome hides that toolbar in
    // full screen, which is where a deck is actually read.
    //
    // The cost lands on presentation with downloads off: no toolbar means no page counter
    // either. Taking the toolbar away is the only lever that hides the file, so the download
    // setting wins. docs/formats.md says so.
    params.push('navpanes=0');
  }
  return {
    mode,
    download,
    bar: mode !== 'minimal',
    fullscreen: mode === 'presentation',
    // Inside the viewer frame, standard mode's bar holds nothing the two bars around it do not.
    // Its title is already blanked there, because the frame's bar above says the same words,
    // which leaves Open and Download, and the browser's own pdf toolbar underneath carries
    // download and print. Three stacked bars is about 144px before the document starts, so this
    // one goes. presentation keeps its bar, since the full-screen button lives nowhere else, and
    // minimal has no bar to give up. Standard with downloads off already draws no bar at all,
    // so there is nothing there to hide either.
    hideBarInFrame: mode === 'standard' && download,
    hash: `#${params.join('&')}`,
  };
}
