// The branding block of the server config: the product name, logo, favicon, accent color and
// footer line the viewer-facing shells render.
//
// Validation lives here rather than in config.js because every one of these values is spliced
// into HTML a viewer loads, and one of them lands inside a <style> block. A `}` in a color would
// close the rule and open whatever the caller wrote next, so the color rule is an allowlist of
// shapes rather than a scan for bad characters. The shells escape on output as well; this is the
// first of the two gates, not the only one.
//
// Empty string is the neutral value for every field. It means "render what the shells rendered
// before anyone touched this", which is what keeps an upgrade invisible to an existing self-host.

import { ApiError } from './errors.js';

export const MAX_PRODUCT_NAME_LEN = 40;
export const MAX_FOOTER_TEXT_LEN = 160;
export const MAX_BRAND_URL_LEN = 2048;

export const BRANDING_FIELDS = ['productName', 'logoUrl', 'faviconUrl', 'accentColor', 'footerText'];

// A hex color, or one of the four color functions with nothing but numbers and separators
// inside the parentheses. Named colors are refused: accepting bare words means accepting
// typos as valid, and the message below says what to write instead.
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FN_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%/ +-]+\s*\)$/;

// Characters that end an HTML attribute or a CSS url() early. A path holding one of these is
// refused rather than escaped, because a logo path has no reason to carry any of them.
const UNSAFE_URL_CHARS = /["'<>\\\s`]/;

function text(field, value, max) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, `branding.${field} must be a string`);
  }
  const out = value.replace(/\s+/g, ' ').trim();
  if (/[<>]/.test(out)) {
    throw new ApiError(400, `branding.${field} cannot contain HTML`);
  }
  if (out.length > max) {
    throw new ApiError(400, `branding.${field} is too long (${out.length} > ${max} chars)`);
  }
  return out;
}

// The name the shells use for a published item and for the site in link previews. Plain text:
// the shells escape it, and markup in a product name is a mistake worth naming at the door.
export function parseProductName(value) {
  return text('productName', value, MAX_PRODUCT_NAME_LEN);
}

// A single line under the chrome pages. Newlines collapse because it renders on one line.
export function parseFooterText(value) {
  return text('footerText', value, MAX_FOOTER_TEXT_LEN);
}

// A logo or favicon the viewer's browser loads from our page. Absolute http(s) so a CDN works,
// or a root-relative path so a self-host can serve the file itself. A protocol-relative `//host`
// is refused because it reads as a path and resolves to a third party.
export function parseBrandUrl(field, value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, `branding.${field} must be a string`);
  }
  const raw = value.trim();
  if (!raw) return '';
  if (raw.length > MAX_BRAND_URL_LEN) {
    throw new ApiError(
      400,
      `branding.${field} is too long (${raw.length} > ${MAX_BRAND_URL_LEN} chars)`,
    );
  }
  if (UNSAFE_URL_CHARS.test(raw)) {
    throw new ApiError(400, `branding.${field} cannot contain quotes, angle brackets or spaces`);
  }
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) {
      throw new ApiError(
        400,
        `branding.${field} must be an absolute http:// or https:// URL, or a path starting with a single /`,
      );
    }
    return raw;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(
      400,
      `branding.${field} must be an absolute http:// or https:// URL, or a path starting with /`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(
      400,
      `branding.${field} must be an absolute http:// or https:// URL, or a path starting with /`,
    );
  }
  if (url.username || url.password) {
    throw new ApiError(400, `branding.${field} cannot carry a username or password`);
  }
  return url.href;
}

export function parseAccentColor(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'branding.accentColor must be a string');
  }
  const raw = value.trim();
  if (!raw) return '';
  if (!HEX_RE.test(raw) && !COLOR_FN_RE.test(raw)) {
    throw new ApiError(
      400,
      'branding.accentColor must be a hex color (#rgb, #rrggbb, #rrggbbaa) or an rgb(), rgba(), hsl() or hsla() color',
    );
  }
  return raw;
}

const PARSERS = {
  productName: parseProductName,
  logoUrl: (v) => parseBrandUrl('logoUrl', v),
  faviconUrl: (v) => parseBrandUrl('faviconUrl', v),
  accentColor: parseAccentColor,
  footerText: parseFooterText,
};

// Env supplies the values while no config has been saved, the same way FRAME_ENABLED does.
// A value this build refuses is dropped rather than fatal: a typo in one env var should not
// stop the server from booting.
function brandEnv(name, field) {
  const raw = process.env[name];
  if (raw === undefined) return '';
  try {
    return PARSERS[field](raw);
  } catch {
    console.warn(`${name}=${JSON.stringify(raw)} is not a valid branding.${field}. Ignoring it.`);
    return '';
  }
}

// Matches createStorage: env is read when the store is built, not at import.
export function defaultBranding() {
  return {
    productName: brandEnv('BRAND_PRODUCT_NAME', 'productName'),
    logoUrl: brandEnv('BRAND_LOGO_URL', 'logoUrl'),
    faviconUrl: brandEnv('BRAND_FAVICON_URL', 'faviconUrl'),
    accentColor: brandEnv('BRAND_ACCENT_COLOR', 'accentColor'),
    footerText: brandEnv('BRAND_FOOTER_TEXT', 'footerText'),
  };
}

// Reading a stored (or hand-edited) config: a field this build refuses falls back to the
// default, field by field, the same rule the md block follows.
export function normalizeBranding(raw, defaults) {
  const stored = raw || {};
  const out = {};
  for (const field of BRANDING_FIELDS) {
    try {
      out[field] = stored[field] === undefined ? defaults[field] : PARSERS[field](stored[field]);
    } catch {
      out[field] = defaults[field];
    }
  }
  return out;
}

// A PUT: every field the caller sent is validated and applied, the rest stay as they are.
// A refused field throws, so a bad value never lands half-applied.
export function updateBranding(patch, current) {
  const sent = patch || {};
  const out = { ...current };
  for (const field of BRANDING_FIELDS) {
    if (sent[field] !== undefined) out[field] = PARSERS[field](sent[field]);
  }
  return out;
}
