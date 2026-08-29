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
// Big enough for a small inline PNG, because an inline image is one of the two shapes a brand
// asset can take until T2.6.10 lands a real upload.
export const MAX_BRAND_URL_LEN = 8192;

export const BRANDING_FIELDS = ['productName', 'logoUrl', 'faviconUrl', 'accentColor', 'footerText'];

// A hex color, or one of the four color functions. The function form is taken apart rather than
// pattern-matched: an allowlist of the characters inside the parentheses let `rgb(--)`,
// `rgba(1,2)` and `hsl(1/2/3/4/5)` through, and a color the browser cannot parse does not fail
// alone. It voids the whole declaration it sits in, so `rgb(--)` took the page's dot grid down
// with it and left the unlock button the UA grey.
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FN_RE = /^(rgba?|hsla?)\(([^()]*)\)$/;
const NUM = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const NUMBER_RE = new RegExp(`^${NUM}$`);
const PERCENT_RE = new RegExp(`^${NUM}%$`);
const ANGLE_RE = new RegExp(`^${NUM}(?:deg|grad|rad|turn)?$`);

// Characters that end an HTML attribute or a CSS url() early. A path holding one of these is
// refused rather than escaped, because a logo path has no reason to carry any of them.
const UNSAFE_URL_CHARS = /["'<>\\\s`]/;

// The only inline images we serve to a viewer. SVG is refused on purpose: an SVG runs script,
// it would come from our own origin, and nothing here sanitizes one. T2.2.3 and T2.6.10 both
// name that as the stored-XSS case.
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

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

// A logo or favicon the viewer's browser loads from our page. Same-origin path or inline image,
// nothing remote. Two reasons, and they agree: the chrome pages carry `img-src 'self' data:`, so
// a remote URL is refused by the viewer's own browser (on the 404 that means no mark at all,
// because the logo replaces the built-in one), and T2.6.10 rules out hotlinking anyway, since a
// hotlinked logo is a third-party request from every page a viewer opens.
//
// Where a self-host puts the file until T2.6.10 adds an upload: publish it as a public artifact
// and point at `/a/<slug>/logo.png`, serve the path from whatever sits in front of this server,
// or inline it as a data: URI. There is no static file route here.
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
        `branding.${field} must be a path starting with a single /, or a data: image URI`,
      );
    }
    return raw;
  }
  if (raw.toLowerCase().startsWith('data:')) {
    if (/^data:image\/svg/i.test(raw)) {
      throw new ApiError(
        400,
        `branding.${field} cannot be an SVG: an SVG runs script and nothing here sanitizes one. Use png, jpeg, webp or gif.`,
      );
    }
    if (!DATA_IMAGE_RE.test(raw)) {
      throw new ApiError(
        400,
        `branding.${field} must be a base64 data: URI for a png, jpeg, webp or gif image`,
      );
    }
    return raw;
  }
  throw new ApiError(
    400,
    `branding.${field} must be same-origin or inline: a path starting with /, or a data: image URI. A remote URL is blocked by the viewer page's own CSP.`,
  );
}

// Both argument forms CSS writes: `rgb(1, 2, 3)` and `rgb(1, 2, 3, .5)` with commas, and
// `rgb(1 2 3)` and `rgb(1 2 3 / 50%)` with spaces. Returns the three channels plus the alpha
// when one was written, or null for anything that is not exactly that.
function splitColorArgs(inner) {
  const halves = inner.split('/');
  if (halves.length > 2) return null;
  const head = halves[0].trim();
  if (!head) return null;
  let parts;
  if (head.includes(',')) {
    if (halves.length === 2) return null; // commas plus a slash alpha is not a form CSS has
    parts = head.split(',').map((part) => part.trim());
  } else {
    parts = head.split(/\s+/);
  }
  if (halves.length === 2) parts.push(halves[1].trim());
  if (parts.length < 3 || parts.length > 4) return null;
  if (parts.some((part) => part === '')) return null;
  return parts;
}

// 0-255 written as a number, or 0-100% written as a percentage.
function rgbChannel(part) {
  if (PERCENT_RE.test(part)) return (parseFloat(part) / 100) * 255;
  if (NUMBER_RE.test(part)) return parseFloat(part);
  return null;
}

// Saturation, lightness and alpha: a percentage, or the same value written as a plain number.
function fraction(part, scale) {
  if (PERCENT_RE.test(part)) return parseFloat(part) / 100;
  if (NUMBER_RE.test(part)) return parseFloat(part) / scale;
  return null;
}

function angleDegrees(part) {
  if (!ANGLE_RE.test(part)) return null;
  const n = parseFloat(part);
  if (part.endsWith('turn')) return n * 360;
  if (part.endsWith('grad')) return n * 0.9;
  if (part.endsWith('rad')) return (n * 180) / Math.PI;
  return n;
}

function hslToRgb(hue, sat, light) {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = Math.min(Math.max(sat, 0), 1);
  const l = Math.min(Math.max(light, 0), 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const face = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
  return { r: (face[0] + m) * 255, g: (face[1] + m) * 255, b: (face[2] + m) * 255 };
}

function hexRgb(raw) {
  const h = raw.slice(1);
  if (h.length <= 4) {
    const pair = (c) => parseInt(c + c, 16);
    return {
      r: pair(h[0]),
      g: pair(h[1]),
      b: pair(h[2]),
      a: h.length === 4 ? pair(h[3]) / 255 : 1,
    };
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

// The accent as plain rgb plus its alpha, or null when it is not a color this build takes. Two
// callers: the validator needs to know the shape is real, and the unlock button needs to know
// how dark the color is before it picks a label that reads on it.
function accentRgb(raw) {
  if (HEX_RE.test(raw)) return hexRgb(raw);
  const match = COLOR_FN_RE.exec(raw);
  if (!match) return null;
  const parts = splitColorArgs(match[2]);
  if (!parts) return null;
  const alpha = parts.length === 4 ? fraction(parts[3], 1) : 1;
  if (alpha === null) return null;
  if (match[1].startsWith('hsl')) {
    const hue = angleDegrees(parts[0]);
    const sat = fraction(parts[1], 100);
    const light = fraction(parts[2], 100);
    if (hue === null || sat === null || light === null) return null;
    return { ...hslToRgb(hue, sat, light), a: alpha };
  }
  const r = rgbChannel(parts[0]);
  const g = rgbChannel(parts[1]);
  const b = rgbChannel(parts[2]);
  if (r === null || g === null || b === null) return null;
  return { r, g, b, a: alpha };
}

function relativeLuminance({ r, g, b }) {
  const lin = (c) => {
    const v = Math.min(Math.max(c, 0), 255) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(one, other) {
  return one > other ? (one + 0.05) / (other + 0.05) : (other + 0.05) / (one + 0.05);
}

// Where an accent has to stay visible. One value serves every accent role in every shell, and
// those roles sit on two very different grounds: the console and the dark half of the viewer
// pages draw on #0b0d0f, the light half draws on a white card. The console also fills its
// primary button with the raw accent and paints the brand mark in it, and the shells do the
// same on their own grounds, so an accent that disappears into either one takes the button, the
// mark and the links with it. Measured on the shipped pages: #050505 gives a 1.05:1 button fill
// and a 1.05:1 brand mark on the console, and #fafafa gives a 1.04:1 status line, brand mark and
// unlock button on the white card.
//
// 3:1 is the WCAG line for a graphical object or a component boundary, which is what these are.
// Checking both grounds with one number covers the console and both halves of every shell. It
// leaves a band of mid-tone colors: the built-in #f0502a reads 5.46:1 on the console and 3.57:1
// on the card. It also refuses colors an operator may think of as ordinary, #1d4ed8 among them
// at 2.90:1 on the console, so the message says which way to move.
const ACCENT_DARK_SURFACE = { r: 11, g: 13, b: 15 };
const ACCENT_LIGHT_SURFACE = { r: 255, g: 255, b: 255 };
const MIN_ACCENT_CONTRAST = 3;

export function parseAccentColor(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'branding.accentColor must be a string');
  }
  const raw = value.trim();
  if (!raw) return '';
  const rgb = accentRgb(raw);
  if (!rgb) {
    throw new ApiError(
      400,
      'branding.accentColor must be a hex color (#rgb, #rgba, #rrggbb, #rrggbbaa) or an rgb(), rgba(), hsl() or hsla() color',
    );
  }
  // A see-through accent renders as nothing: every link, inline code span and blockquote rule
  // that takes it disappears, and color-mix multiplies the accent's own alpha, so the 8% glow
  // off a 0.3 accent lands at 0.024 opacity.
  if (rgb.a < 1) {
    throw new ApiError(400, 'branding.accentColor must be fully opaque. A partly transparent accent renders as nothing on the surfaces that use it.');
  }
  const accent = relativeLuminance(rgb);
  const onDark = contrast(accent, relativeLuminance(ACCENT_DARK_SURFACE));
  const onLight = contrast(accent, relativeLuminance(ACCENT_LIGHT_SURFACE));
  if (onDark < MIN_ACCENT_CONTRAST || onLight < MIN_ACCENT_CONTRAST) {
    // Only one of the two can fail: the product of the two ratios is a constant 19.47, so a
    // color under 3:1 on one ground is over 6:1 on the other. Whichever failed says the way out.
    const way = onDark < onLight ? 'lighter' : 'darker';
    throw new ApiError(
      400,
      `branding.accentColor reads ${onDark.toFixed(2)}:1 on the dark console and `
        + `${onLight.toFixed(2)}:1 on the light card, and it has to reach ${MIN_ACCENT_CONTRAST}:1 on both. `
        + `Buttons, links and the brand mark all draw in it. Try a ${way} shade of the same hue.`,
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

// The CLI's five branding flags and the field each one sets. `none` clears a field, which is how
// every other verb spells unset (`expire <slug> never`, `tag <slug> none`). A flag nobody passed
// stays out of the patch, so saving one field leaves the other four alone.
export const BRANDING_FLAGS = {
  'brand-name': 'productName',
  'brand-logo': 'logoUrl',
  'brand-favicon': 'faviconUrl',
  'brand-accent': 'accentColor',
  'brand-footer': 'footerText',
};

export function brandingPatchFromFlags(opts) {
  const flags = opts || {};
  const patch = {};
  for (const [flag, field] of Object.entries(BRANDING_FLAGS)) {
    const value = flags[flag];
    if (value === undefined) continue;
    patch[field] = value === 'none' ? '' : String(value);
  }
  return patch;
}

// Every refusal above opens with `branding.<field>`, which is the only thing a form has to go on
// when it wants to show the server's message beside the input that caused it. This reads the
// field back out. A message that names none of the five belongs to the form as a whole.
export function brandingErrorField(message) {
  const match = /^branding\.([A-Za-z]+)\b/.exec(String(message || ''));
  return match && BRANDING_FIELDS.includes(match[1]) ? match[1] : null;
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

// The dark half of a light/dark pair. Every shell carries a pair because a pair is needed:
// #1d4ed8 reads 6.70:1 on white and 2.90:1 on the #0b0d0f dark card, so one value cannot serve
// both slots. Lightening the accent toward white is what the shipped pairs already did by hand
// (#c73d1d light, #ff7550 dark), so the derived value keeps the operator's hue and lands where
// the built-in pair landed.
function colorDark(branding, fallback) {
  return branding.accentColor
    ? `color-mix(in srgb, ${branding.accentColor} 70%, white)`
    : fallback;
}

const BTN_LABEL_DARK = '#0b0d0f';
const BTN_LABEL_LIGHT = '#ffffff';
const DARK_LABEL_LUMINANCE = relativeLuminance({ r: 11, g: 13, b: 15 });

// The unlock button's label, picked here because no CSS every browser we serve supports will
// pick it. The button used to hardcode the dark label, which reads 5.46:1 on the built-in
// #f0502a but 2.90:1 on #1d4ed8 and 1.00:1 on #0b0d0f itself, an invisible label on a perfectly
// valid accent. A mid-tone accent still fails both labels; this picks the better of the two.
function buttonLabel(branding) {
  if (!branding.accentColor) return BTN_LABEL_DARK;
  const rgb = accentRgb(branding.accentColor);
  if (!rgb) return BTN_LABEL_DARK;
  const accent = relativeLuminance(rgb);
  return contrast(accent, DARK_LABEL_LUMINANCE) >= contrast(accent, 1)
    ? BTN_LABEL_DARK
    : BTN_LABEL_LIGHT;
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
  // A logo and a wordmark side by side is the brand said twice, at the same size and weight, in
  // the bar that also has to hold the artifact's own title. The logo wins when there is one.
  const name = branding.productName && !logo
    ? `<span>${escapeHtml(branding.productName)}</span>`
    : '';
  const brand = logo || name ? `<span id="brand">${logo}${name}</span>` : '';
  const rules = brand
    ? [
      '  #brand { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;',
      '    font-size: 13px; font-weight: 600; color: var(--bar-fg); }',
      // Capped, because width:auto on a 600x60 wordmark is 200px of bar at a 20px height, and
      // at a 390px viewport that pushes the frame's own buttons off screen.
      '  #brand img { height: 20px; width: auto; max-width: 120px; object-fit: contain; display: block; }',
    ]
    : [];
  // Narrow enough and the bar cannot hold the brand and the document's own title. The title is
  // the viewer's, so the brand is what goes.
  if (name) rules.push('  @media (max-width: 560px) { #brand > span { display: none; } }');
  return {
    FAVICON: faviconTag(branding),
    BRAND: brand,
    BRAND_STYLE: styleBlock(rules),
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
  if (logo) rules.push('  .brandmark { height: 28px; width: auto; max-width: 100%; object-fit: contain; display: block; margin-bottom: 16px; }');
  if (footer) rules.push('  .brandfooter { margin: 14px 0 0; font-size: 12px; color: var(--muted); }');
  return {
    FAVICON: faviconTag(branding),
    LOGO: logo,
    FOOTER: footer,
    BRAND_STYLE: styleBlock(rules),
    ACCENT: color(branding, '#c73d1d'),
    ACCENT_DARK: colorDark(branding, '#ff7550'),
    ERROR: '#c4573e',
    ERROR_DARK: '#e08a72',
    GLOW: wash(branding, 'rgba(240, 80, 42, .08)', 8),
    BTN_BG: color(branding, '#f0502a'),
    BTN_FG: buttonLabel(branding),
    // The shell shipped a visibly lighter hover. Handing the accent to both slots left
    // button:hover with nothing but a shadow to change.
    BTN_HOVER: branding.accentColor
      ? `color-mix(in srgb, ${branding.accentColor} 80%, white)`
      : '#ff7550',
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
  if (branding.logoUrl) rules.push('  img.mark { height: 36px; width: auto; max-width: 100%; object-fit: contain; }');
  if (footer) {
    // The description paragraph is styled by the shell's `p:last-child`. Appending the footer
    // after it takes that rule away: 14px becomes 16px, muted becomes full foreground, the
    // margin comes back and the copy rewraps. Restating the rule against the description keeps
    // the page the operator sees the page everyone else sees. It cannot be a class on the
    // paragraph itself, because that would change the untouched page's bytes.
    rules.push('  main > p:not(.status):not(.brandfooter) { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }');
    rules.push('  .brandfooter { margin: 20px 0 0; font-size: 12px; color: var(--muted); }');
  }
  return {
    FAVICON: faviconTag(branding),
    MARK: mark,
    FOOTER: footer,
    BRAND_STYLE: styleBlock(rules),
    ACCENT: color(branding, '#c73d1d'),
    ACCENT_DARK: colorDark(branding, '#f0502a'),
    GLOW: wash(branding, 'rgba(240, 80, 42, .08)', 8),
  };
}

export function mdBrandSlots(branding) {
  return {
    FAVICON: faviconTag(branding),
    LINK: color(branding, '#c73d1d'),
    LINK_DARK: colorDark(branding, '#ff7550'),
    CODE: color(branding, '#7c2413'),
    CODE_DARK: colorDark(branding, '#ff9d80'),
    QUOTE_BORDER: color(branding, '#2ba3cc'),
  };
}

export function jsxBrandSlots(branding) {
  return {
    FAVICON: faviconTag(branding),
    // This one lands inside a script, so it is JSON-quoted rather than HTML-escaped: an
    // &amp; would show up as literal text in the error readout. The built-in label keeps the
    // single quotes the shell used to write, so an unbranded page stays byte for byte the same.
    ERROR_LABEL: branding.productName
      ? JSON.stringify(`${branding.productName} error: `)
      : `'${FALLBACK_PRODUCT_NAME} error: '`,
    ERROR: '#c4573e',
  };
}

// What an unfurler sees: the site name, and the brand logo as the preview image for an artifact
// that sets none. og:image has to be a URL an unfurler can fetch, so a path is resolved against
// the base URL the server builds its links from, and an inline logo supplies no preview image at
// all: a data: URI in og:image is a tag no unfurler reads.
// The dashboard. Same block, same rules, one difference: this page is the operator's own console
// rather than something a viewer lands on, so the product name sits beside the logo instead of
// being replaced by it. That is the layout the console already has (anvil glyph, then the word),
// and keeping both keeps the header the same shape whether or not anything is branded.
//
// The console is dark only, so its accent pair runs the other way from the light/dark shells:
// --molten is the fill, --rose is the lifted interactive tint, --molten-deep the darker edge.
const DASHBOARD_MARK = `<svg class="mark" viewBox="0 0 76 76" aria-hidden="true">
{I}  <path d="M14 20h44v8H40v6c8 1 14 4 14 9v3H22v-3c0-5 6-8 14-9v-6H24c-6 0-10-4-10-8z"></path>
{I}  <rect x="26" y="48" width="24" height="6"></rect>
{I}  <rect x="20" y="56" width="36" height="6"></rect>
{I}</svg>`;

// The two marks sit at different depths in the page, so each gets the built-in glyph at its own
// indentation and the untouched page keeps the whitespace it shipped with.
function dashboardMark(branding, indent) {
  if (branding.logoUrl) return `<img class="mark" src="${escapeHtml(branding.logoUrl)}" alt="">`;
  return DASHBOARD_MARK.replaceAll('{I}', indent);
}

export function dashboardBrandSlots(branding) {
  const rules = [];
  if (branding.logoUrl) {
    // .mark carries a square width and height for the glyph. A logo is rarely square, so it
    // keeps the height and takes whatever width that leaves it.
    rules.push('  img.mark { width: auto; max-width: 132px; object-fit: contain; }');
  }
  if (branding.accentColor) {
    const accent = branding.accentColor;
    rules.push('  :root {');
    rules.push(`    --molten: ${accent};`);
    rules.push(`    --molten-deep: color-mix(in srgb, ${accent} 80%, black);`);
    rules.push(`    --rose: ${colorDark(branding, '#ff7550')};`);
    rules.push(`    --rose-tint: ${wash(branding, 'rgba(240, 80, 42, .14)', 14)};`);
    rules.push('  }');
    // Both of these draw in --espresso on a --molten fill, which is a fixed near-black on a
    // color the operator now chooses. Same call the unlock button makes.
    rules.push(`  button { color: ${buttonLabel(branding)}; }`);
    rules.push(`  input[type=checkbox]:checked::after { border-color: ${buttonLabel(branding)}; }`);
  }
  return {
    DOC_TITLE: branding.productName ? escapeHtml(branding.productName) : 'artifacts',
    PRODUCT: branding.productName ? escapeHtml(branding.productName) : 'artifacts',
    FAVICON: faviconTag(branding),
    LOCK_MARK: dashboardMark(branding, '    '),
    HEADER_MARK: dashboardMark(branding, '      '),
    BRAND_STYLE: styleBlock(rules),
  };
}

// What GET /favicon.ico should answer. The dashboard's head carries a <link rel="icon"> when one
// is set, and a browser reading the page prefers that, so this is for everything that asks for
// the well-known path without reading the page first.
//
// A path is handed back as a redirect. parseBrandUrl already refused anything that is not a
// single-leading-slash path or an inline image, so the redirect cannot leave this origin. An
// inline image is decoded here rather than redirected, because a data: URI is not a location.
// A value this build would not have accepted answers empty, the way the route always did.
export function dashboardFavicon(branding) {
  const url = branding.faviconUrl || '';
  if (url.startsWith('/') && !url.startsWith('//')) return { redirect: url };
  const match = DATA_IMAGE_RE.exec(url);
  if (!match) return null;
  const comma = url.indexOf(',');
  return {
    contentType: url.slice('data:'.length, url.indexOf(';')),
    body: Buffer.from(url.slice(comma + 1), 'base64'),
  };
}

export function socialBranding(branding, baseUrl) {
  return {
    siteName: branding.productName,
    image: branding.logoUrl.startsWith('/') ? `${baseUrl}${branding.logoUrl}` : '',
  };
}
