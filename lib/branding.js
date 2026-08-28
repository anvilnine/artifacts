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
import { escapeHtml } from './social.js';

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

// ---------------------------------------------------------------------------
// Shell slots
// ---------------------------------------------------------------------------
//
// Every color literal the shells used to carry lives below. A shell holds `{{SLOT}}` and gets
// its own former value back when nothing is configured, so the default page is byte for byte
// what it was. One configured accentColor takes over every accent role in every shell,
// including the two translucent washes, which color-mix() derives from the same value rather
// than making the operator pick a second color.
//
// The error reds are deliberately not accent roles. They say "this failed", and a white-label
// instance that turns its brand blue should not get a blue error message.

const FALLBACK_PRODUCT_NAME = 'Artifact';
const FALLBACK_PRODUCT_NOUN = 'artifact';

// The built-in 404 mark, kept here rather than in the shell so a logo can take its place.
const BUILTIN_MARK = `<svg class="mark" viewBox="0 0 76 76" aria-hidden="true">
      <path d="M14 20h44v8H40v6c8 1 14 4 14 9v3H22v-3c0-5 6-8 14-9v-6H24c-6 0-10-4-10-8z"></path>
      <rect x="26" y="48" width="24" height="6"></rect>
      <rect x="20" y="56" width="36" height="6"></rect>
    </svg>`;

// A slot that renders nothing until it is configured starts with a newline, so the shell can
// park it at the end of an existing line and keep the untouched page free of blank lines.
function color(branding, fallback) {
  return branding.accentColor || fallback;
}

function wash(branding, fallback, percent) {
  return branding.accentColor
    ? `color-mix(in srgb, ${branding.accentColor} ${percent}%, transparent)`
    : fallback;
}

function faviconTag(branding) {
  return branding.faviconUrl ? `\n<link rel="icon" href="${escapeHtml(branding.faviconUrl)}">` : '';
}

function styleBlock(rules) {
  return rules.length ? `\n${rules.join('\n')}` : '';
}

export function frameBrandSlots(branding) {
  const logo = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="">`
    : '';
  const name = branding.productName
    ? `<span>${escapeHtml(branding.productName)}</span>`
    : '';
  const brand = logo || name ? `<span id="brand">${logo}${name}</span>` : '';
  return {
    FAVICON: faviconTag(branding),
    BRAND: brand,
    BRAND_STYLE: styleBlock(brand ? [
      '  #brand { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;',
      '    font-size: 13px; font-weight: 600; color: var(--bar-fg); }',
      '  #brand img { height: 20px; width: auto; display: block; }',
    ] : []),
  };
}

export function passwordBrandSlots(branding) {
  const logo = branding.logoUrl
    ? `\n    <img class="brandmark" src="${escapeHtml(branding.logoUrl)}" alt="">`
    : '';
  const footer = branding.footerText
    ? `\n    <p class="brandfooter">${escapeHtml(branding.footerText)}</p>`
    : '';
  const rules = [];
  if (logo) rules.push('  .brandmark { height: 28px; width: auto; display: block; margin-bottom: 16px; }');
  if (footer) rules.push('  .brandfooter { margin: 14px 0 0; font-size: 12px; color: var(--muted); text-align: center; }');
  return {
    FAVICON: faviconTag(branding),
    PRODUCT_NOUN: escapeHtml(branding.productName || FALLBACK_PRODUCT_NOUN),
    LOGO: logo,
    FOOTER: footer,
    BRAND_STYLE: styleBlock(rules),
    ACCENT: color(branding, '#c73d1d'),
    ACCENT_DARK: color(branding, '#ff7550'),
    ERROR: '#c4573e',
    ERROR_DARK: '#e08a72',
    GLOW: wash(branding, 'rgba(240, 80, 42, .08)', 8),
    BTN_BG: color(branding, '#f0502a'),
    BTN_HOVER: color(branding, '#ff7550'),
    BTN_SHADOW: wash(branding, 'rgba(240, 80, 42, .35)', 35),
  };
}

export function notFoundBrandSlots(branding) {
  const mark = branding.logoUrl
    ? `<img class="mark" src="${escapeHtml(branding.logoUrl)}" alt="">`
    : BUILTIN_MARK;
  const footer = branding.footerText
    ? `\n    <p class="brandfooter">${escapeHtml(branding.footerText)}</p>`
    : '';
  const rules = [];
  if (branding.logoUrl) rules.push('  img.mark { height: 36px; width: auto; }');
  if (footer) rules.push('  .brandfooter { margin: 20px 0 0; font-size: 12px; color: var(--muted); }');
  return {
    FAVICON: faviconTag(branding),
    PRODUCT_NAME: escapeHtml(branding.productName || FALLBACK_PRODUCT_NAME),
    MARK: mark,
    FOOTER: footer,
    BRAND_STYLE: styleBlock(rules),
    ACCENT: color(branding, '#c73d1d'),
    ACCENT_DARK: color(branding, '#f0502a'),
    GLOW: wash(branding, 'rgba(240, 80, 42, .08)', 8),
  };
}

export function mdBrandSlots(branding) {
  return {
    FAVICON: faviconTag(branding),
    LINK: color(branding, '#c73d1d'),
    LINK_DARK: color(branding, '#ff7550'),
    CODE: color(branding, '#7c2413'),
    CODE_DARK: color(branding, '#ff9d80'),
    QUOTE_BORDER: color(branding, '#2ba3cc'),
  };
}

export function jsxBrandSlots(branding) {
  return {
    FAVICON: faviconTag(branding),
    ERROR: '#c4573e',
  };
}
