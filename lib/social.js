// Link-preview metadata: the description and image an artifact carries, and the tags the
// server renders into the pages it builds itself.
//
// This lives outside server.js for the reason lib/redirect.js does: the validation and the tag
// rendering are testable without a running instance, and the tag rendering in particular is
// awkward to check over HTTP, where an assertion has to fish one line out of a whole document.

import { ApiError } from './errors.js';

// Longest description an artifact may store. 300 chars is roughly what Slack, Discord and X
// show before they cut it off, and the cap keeps meta.json from growing a second copy of the
// artifact.
export const MAX_DESCRIPTION_LEN = 300;

// Longest preview image URL, measured on the normalized href for the reason
// MAX_REDIRECT_TARGET_LEN is: measuring the input lets a multi-byte URL pass the check and then
// store something longer.
export const MAX_OG_IMAGE_LEN = 2048;

// Returns a trimmed description, or '' to clear it. null and '' both mean clear. Newlines
// collapse to spaces because every preview renders on one line whatever is stored.
export function parseDescription(value) {
  if (value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'description must be a string');
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_DESCRIPTION_LEN) {
    throw new ApiError(
      400,
      `description is too long (${text.length} > ${MAX_DESCRIPTION_LEN} chars)`,
    );
  }
  return text;
}

// Returns a normalized absolute URL, or '' to clear it. null and '' both mean clear.
//
// Absolute http(s) only: the chat app fetches og:image itself, from its own base, so a relative
// path resolves against the wrong host. Credentials are refused for the reason a redirect target
// refuses them: the URL is handed to a third party that logs it.
export function parseOgImage(value) {
  if (value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'ogImage must be a string');
  }
  const raw = value.trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, 'ogImage must be an absolute http:// or https:// URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'ogImage must be an absolute http:// or https:// URL');
  }
  if (url.username || url.password) {
    throw new ApiError(400, 'ogImage cannot carry a username or password');
  }
  if (url.href.length > MAX_OG_IMAGE_LEN) {
    throw new ApiError(
      400,
      `ogImage is too long (${url.href.length} > ${MAX_OG_IMAGE_LEN} chars)`,
    );
  }
  return url.href;
}

// Run a stored value through its parser and drop it when this build refuses it, for copying meta
// an older build wrote. Only reachable that way: both parsers above are stable on their own output
// (parse(parse(x)) === parse(x)), so nothing the API has stored can fail on the way back out.
export function dropIfRefused(parse, value) {
  if (value === undefined) return undefined;
  try {
    return parse(value);
  } catch {
    return '';
  }
}

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The tags themselves, for the two pages the server renders: the md view and the viewer frame.
// An html or jsx artifact asked for with ?raw=1 carries whatever its author wrote, so nothing is
// spliced into stored bytes (docs/formats.md: "Served as-is on its own page. No processing.").
//
// `canonical` is the permanent /a/<slug> link, never a capability link: an unfurl outlives the
// paste it came from, and a ?k= token expires and can be revoked. Passing it in keeps BASE_URL
// out of this file.
//
// Rendering these for a locked artifact costs nothing, because every serve path checks the
// visibility gate before any page is built: an unfurler holding no token gets the 404.
//
// `brand` is the server's branding block, already resolved for this context: `siteName` is the
// product name and `image` is the brand logo as an absolute URL. Both are empty until an
// operator sets them, and empty means the tags render exactly as they did before branding
// existed. The logo is a fallback only: an artifact that carries its own ogImage keeps it.
export function socialTags(meta, canonical, brand = { siteName: '', image: '' }) {
  const image = meta.ogImage || brand.image;
  const tags = [];
  if (meta.description) {
    tags.push(`<meta name="description" content="${escapeHtml(meta.description)}">`);
  }
  tags.push(`<meta property="og:title" content="${escapeHtml(meta.title || meta.slug)}">`);
  if (brand.siteName) {
    tags.push(`<meta property="og:site_name" content="${escapeHtml(brand.siteName)}">`);
  }
  tags.push(`<meta property="og:url" content="${escapeHtml(canonical)}">`);
  tags.push('<meta property="og:type" content="website">');
  if (meta.description) {
    tags.push(`<meta property="og:description" content="${escapeHtml(meta.description)}">`);
  }
  if (image) {
    tags.push(`<meta property="og:image" content="${escapeHtml(image)}">`);
  }
  // The large card with no image renders as an empty box, so the plain summary is the honest
  // default until someone sets one.
  tags.push(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);
  return tags.join('\n');
}

// Where a link preview actually shows.
//
// socialTags() above renders into a head the server builds, and the server builds one for a
// markdown page and for the pdf viewer whatever the frame is set to. For html, jsx, tsx and zip
// it builds one only when the frame wraps the artifact; with the frame off those serve the bytes
// their author published, untouched, and there is nowhere to put a tag. A redirect answers with
// a 301 and has no page at all.
//
// Splicing tags into a stored document at publish time, or injecting them on the way out, was
// weighed and turned down: the stored bytes stay the author's. So every surface that sets a
// preview says when it will not show, rather than accepting the value and quietly dropping it.
const SELF_RENDERED_TYPES = new Set(['md', 'pdf']);

// `framed` is what this artifact actually gets, master switch and per-item setting combined.
// `frameEnabled` is the master switch on its own, which only changes the wording: with the
// switch off, telling the operator to turn the frame on for an artifact whose frame is already
// on sends them to a control that will not help.
export function previewReach({ type, framed, frameEnabled = true }) {
  if (type === 'redirect') {
    return {
      shows: false,
      why: 'A redirect answers with a 301 and has no page, so a link preview never shows for it.',
    };
  }
  if (SELF_RENDERED_TYPES.has(type) || framed) return { shows: true, why: '' };
  if (!frameEnabled) {
    return {
      shows: false,
      why: 'Frames are off for the whole server, so this artifact serves its file untouched and '
        + 'the preview tags have nowhere to go. Turn frames on in settings to make the preview show.',
    };
  }
  return {
    shows: false,
    why: 'The frame is off for this artifact, so it serves its file untouched and the preview '
      + 'tags have nowhere to go. Turn the frame on to make the preview show.',
  };
}
