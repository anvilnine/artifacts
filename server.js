import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';
import express from 'express';
import { marked } from 'marked';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createStorage, UnsafeKeyError } from './storage/index.js';
import { createRateLimiter } from './ratelimit.js';
import {
  createAuthStore,
  AdminSeedError,
  AuthFileError,
  SCOPES,
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  hashKey,
  signSession,
  verifySession,
  readCookie,
  hasScope,
  publicKey,
  validatePassword,
  validateCredentials,
  parseKeyInput,
} from './lib/auth.js';
import { SOURCE_EXT, dropOrphanObjects, dropStaleObjects } from './lib/artifact-files.js';
import { createConfigStore } from './lib/config.js';
import { ApiError, clientFacingError } from './lib/errors.js';
import { createWriteQueue, WRITE_CEILING_MS } from './lib/write-queue.js';
import { artifactExpired } from './lib/expiry.js';
import { qrPng, qrSvg } from './lib/qr.js';
import {
  parsePdfContent,
  parsePdfSettings,
  pdfSettings,
  pdfSettingsForMeta,
  pdfViewerFlags,
} from './lib/pdf.js';
import {
  parseRedirectTarget,
  resolveRedirectTarget,
  pointsAtOwnSlug,
  storedTargetPointsAtSlug,
  countRedirectsByKey,
} from './lib/redirect.js';
import { fillShell } from './lib/shells.js';
import {
  wantsHtmlPage,
  NOT_FOUND_COPY,
  EXPIRED_COPY,
  NOT_FOUND_TEXT,
  EXPIRED_TEXT,
} from './lib/status-page.js';
import {
  dashboardBrandSlots, dashboardFavicon,
  frameBrandSlots, jsxBrandSlots, mdBrandSlots, notFoundBrandSlots, passwordBrandSlots,
  socialBranding,
} from './lib/branding.js';
import {
  dropIfRefused, escapeHtml, parseDescription, parseOgImage, socialTags,
} from './lib/social.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// package.json is the single source of truth for the version we report over MCP.
// The old hardcoded '1.0.0' sat here while package.json was already at 1.3.1.
const VERSION = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8')).version;

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const API_KEY = process.env.ARTIFACTS_API_KEY;
const TRUST_PROXY = (process.env.TRUST_PROXY || 'none').toLowerCase(); // none | cloudflare | xff

if (!API_KEY) {
  console.error('ARTIFACTS_API_KEY env var is required');
  process.exit(1);
}

// The pluggable storage backend (default `local`). Instantiated once at boot; every
// artifact read/write flows through it. Fail-fast here, like the API-key check above.
const storage = await createStorage();

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

// Global frame settings and markdown render defaults. See lib/config.js.
const config = await createConfigStore(storage);

// The single admin account, the managed API keys, and the two HMAC secrets. See
// lib/auth.js. Every name below is used by the auth routes, the key routes, and the
// serve-path visibility gate further down this file.
const {
  auth,
  DECOY_ADMIN,
  update,
  ensureSessionSecret,
  issueSession,
  sessionPrincipal,
  identify,
  requireApiKey,
  requireAuth,
  requireSession,
  requireAdmin,
  signCapToken,
  verifyCapToken,
} = await createAuthStore(storage, { apiKey: API_KEY, baseUrl: BASE_URL }).catch((err) => {
  // An unreadable auth.json or a rejected admin seed is an operator problem with a recovery
  // path, so print the line and stop. Everything else (a storage backend that is down, a bug)
  // keeps its stack.
  if (!(err instanceof AuthFileError) && !(err instanceof AdminSeedError)) throw err;
  console.error(err.message);
  process.exit(1);
});

// Rate-limit bucket for this request. Under cloudflared every request arrives from
// loopback, so the real client is only in CF-Connecting-IP; trusting that header is
// safe ONLY while the tunnel is the sole ingress (origin has no open ports). Default
// 'none' uses the socket address — correct when nothing proxies, wrong behind a proxy.
function clientIp(req) {
  let ip;
  if (TRUST_PROXY === 'cloudflare') ip = req.headers['cf-connecting-ip'];
  else if (TRUST_PROXY === 'xff') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) ip = xff.split(',').pop().trim();
  }
  ip = (ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ipBucket(ip);
}

function ipBucket(ip) {
  if (!ip.includes(':')) return ip; // IPv4 — one address, one bucket
  // IPv6: bucket by the /64 network prefix (an attacker owning a /64 has ~1.8e19
  // addresses; per-address limiting would be free to defeat). Expand :: first.
  const clean = ip.split('%')[0].replace(/^\[|\]$/g, '');
  const [head, tail = ''] = clean.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => x || '0').join(':') + '::/64';
}

// Auth failures were logged nowhere. One JSON line per failed/limited attempt —
// greppable, no dependency, no PII beyond the client IP the operator already sees.
function logAuth(event, fields) {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

// Whether the viewer frame is shown for this artifact: global master switch
// AND (per-item override, or the global default when the item has no override).
function frameActive(meta) {
  const { frame } = config.current;
  return frame.enabled && (typeof meta.frame === 'boolean' ? meta.frame : frame.default);
}

const JSX_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'jsx.html'), 'utf8');
const MD_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'md.html'), 'utf8');
const FRAME_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'frame.html'), 'utf8');
const PDF_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'pdf.html'), 'utf8');
const PASSWORD_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'password.html'), 'utf8');
const NOT_FOUND_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'not-found.html'), 'utf8');
// The console is a shell like any other now: read once, branding filled per request.
const DASHBOARD_SHELL = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');

// Per-artifact visibility. Absent meta.visibility === 'public' (today's behavior:
// anyone with the unguessable link views). 'private' and 'password' are gated at
// the serve routes by an unlock cookie (below).
const VISIBILITIES = ['public', 'private', 'password'];
const UNLOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Visibility of a newly published artifact when the caller specifies none. Ships 'private'
// (opt in to public). 'password' is nonsensical as a default (no password to set), so only
// 'public' overrides; anything else falls back to 'private'.
const DEFAULT_VISIBILITY = process.env.DEFAULT_VISIBILITY === 'public' ? 'public' : 'private';

// Unlock cookie: HMAC({typ:'unlock', slug, epoch, exp}) signed with the session
// secret, HttpOnly and scoped to Path=/a/<slug> so it never rides to another artifact.
// Set by the ?k= capability-link exchange, or by a correct password ('password' mode).
function unlockCookieName(slug) {
  return `au_${slug}`;
}

// Non-secret per-artifact revocation counter. Bumping it (rotate) invalidates every
// live token AND unlock cookie for the slug, since both bind the epoch they were minted at.
function metaEpoch(meta) {
  return typeof meta.tokenEpoch === 'number' ? meta.tokenEpoch : 0;
}

// The URL to hand out: public is the bare link; private/password carry a token so the
// private default costs the operator nothing — what they copy is immediately viewable.
// The permanent URL of an artifact: no token, and the trailing slash a zip site needs so its
// relative assets resolve. Both the share link and the QR code start here, so the slash rule
// lives in one place.
function canonicalUrl(meta) {
  return `${BASE_URL}/a/${meta.slug}${meta.type === 'zip' ? '/' : ''}`;
}

function tokenedUrl(meta) {
  const base = canonicalUrl(meta);
  if (meta.visibility !== 'private' && meta.visibility !== 'password') return base;
  return `${base}?k=${signCapToken(meta.slug, metaEpoch(meta))}`;
}

// A cookie lives at most UNLOCK_TTL_MS, and never past the token that minted it.
async function issueUnlock(res, meta, capExp) {
  const secret = await ensureSessionSecret();
  const ttl = capExp ? Math.max(0, Math.min(UNLOCK_TTL_MS, capExp - Date.now())) : UNLOCK_TTL_MS;
  const token = signSession(
    { typ: 'unlock', slug: meta.slug, epoch: metaEpoch(meta), exp: Date.now() + ttl },
    secret,
  );
  res.cookie(unlockCookieName(meta.slug), token, {
    httpOnly: true,
    secure: BASE_URL.startsWith('https'),
    sameSite: 'lax',
    maxAge: ttl,
    path: `/a/${meta.slug}`,
  });
}

function unlockValid(req, meta) {
  const p = verifySession(readCookie(req, unlockCookieName(meta.slug)), auth.sessionSecret);
  if (!p || p.typ !== 'unlock' || p.slug !== meta.slug || p.epoch !== metaEpoch(meta)) return false;
  // Same rule as verifyCapToken: issueUnlock always writes a real number here, so a cookie
  // without one is refused rather than read as "no expiry set". Number.isFinite because
  // Infinity is a number and is never in the past.
  return Number.isFinite(p.exp) && p.exp > Date.now();
}

// May this request view the artifact body? Public: always. private/password: a valid
// unlock cookie only. No admin-session bypass: on the mandated split-origin deploy the
// dashboard session cookie never reaches the artifact origin, so it never applied — the
// operator uses a capability link like anyone else.
function artifactUnlocked(req, meta) {
  if (meta.visibility !== 'private' && meta.visibility !== 'password') return true;
  return unlockValid(req, meta);
}

// Read off the same table lib/artifact-files.js cleans up from, so a sixth type cannot become
// publishable here and stay invisible to the type-change cleanup there.
const TYPES = Object.keys(SOURCE_EXT);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TAGS = 10;
// A project is a single grouping label (one per artifact). Friendlier than a
// slug — Unicode letters/digits, spaces, and - _ . — but bounded, and must
// start with a letter or digit. Internal whitespace is collapsed on input.
const PROJECT_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]{0,63}$/u;

// Pinned versions shared with the jsx shell. `external=react` keeps packages on
// the shell's React instance — separate copies cause "Invalid hook call".
const BASE_IMPORT_MAP = {
  react: 'https://esm.sh/react@18.3.1',
  'react/jsx-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
  'react-dom': 'https://esm.sh/react-dom@18.3.1',
  'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
  recharts: 'https://esm.sh/recharts@2.15.0?external=react,react-dom',
  'lucide-react': 'https://esm.sh/lucide-react@0.462.0?external=react',
};

function buildJsxHtml(source, title) {
  const imports = { ...BASE_IMPORT_MAP };
  const importRe = /^\s*import\s+(?:[\w${},*\s]+from\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(importRe)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('/') || imports[spec]) continue;
    imports[spec] = `https://esm.sh/${spec}?external=react,react-dom`;
  }

  if (!/export\s+default\s/.test(source)) {
    throw new ApiError(400, 'jsx/tsx artifact must have a default export');
  }
  const rewritten = source
    .replace(/export\s+default\s+/, 'const __ArtifactDefault = ')
    .replaceAll('</script', '<\\/script');

  // One pass, so no value can land in the text a later substitution searches: a title of
  // "{{SOURCE}}" used to steal the source slot. fillShell also keeps `$`-substitution out
  // ($&, $`, $$, …), which a title or a source must carry verbatim.
  return fillShell(JSX_SHELL, {
    ...jsxBrandSlots(config.current.branding),
    TITLE: escapeHtml(title),
    IMPORT_MAP: JSON.stringify({ imports }, null, 2),
    SOURCE: rewritten,
  });
}

const MD_FONT_STACKS = {
  system: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif:  'Georgia, Charter, "Times New Roman", serif',
  mono:   '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};
const MD_WIDTH_PX = { narrow: '640px', normal: '760px', wide: '900px' };
const MD_SIZE_PX  = { small: '15px', normal: '16px', large: '18px' };

function buildMdHtml(source, meta, mdCfg = config.current.md, branding = config.current.branding) {
  return fillShell(MD_SHELL, {
    ...mdBrandSlots(branding),
    TITLE: escapeHtml(meta.title || meta.slug),
    SOCIAL: socialTags(meta, canonicalUrl(meta), socialBranding(branding, BASE_URL)),
    FONT: MD_FONT_STACKS[mdCfg.font],
    MAXWIDTH: MD_WIDTH_PX[mdCfg.width],
    FONTSIZE: MD_SIZE_PX[mdCfg.size],
    THEME: mdCfg.theme,
    CONTENT: marked.parse(source),
  });
}

// The two URLs a pdf artifact's viewer points at. Absolute paths, not relative ones: inside
// the viewer frame the shell is loaded from /a/<slug>?raw=1, where a relative "file.pdf"
// would resolve to /a/file.pdf.
function pdfFileUrl(slug) {
  return `/a/${slug}/file.pdf`;
}

// The filename a download lands on. The slug is re-checked rather than trusted, the way the
// SOURCE_EXT lookup on the /source route is: every slug the server writes matches SLUG_RE, but
// meta.json can be hand-edited, and this value lands inside a quoted header where a slug
// carrying a quote picks the reader's filename and extension.
function pdfDownloadName(meta) {
  return SLUG_RE.test(meta.slug) ? `${meta.slug}.pdf` : 'download.pdf';
}

// Whether `?download=` on the file route is asking for an attachment. Only a truthy value is:
// the docs name `?download=1`, and reading a bare `?download=0` as a yes was the surprising
// direction. A repeated parameter arrives as an array and is not a yes either.
function wantsPdfDownload(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

// A viewer page for a pdf artifact, built per request the way the markdown one is. The bytes
// themselves never pass through here: the page is a shell around an <object> that fetches
// them, so a 7 MB PDF is streamed by serveObject and not held in a string.
//
// The per-artifact controls (mode, download) decide which pieces of the page exist at all
// rather than hiding them with CSS: a Download button that is only display:none is still a URL
// in the markup, and the toggle would read as weaker than it is.
function buildPdfHtml(meta) {
  const title = escapeHtml(meta.title || meta.slug);
  const fileUrl = pdfFileUrl(meta.slug);
  const downloadUrl = `${fileUrl}?download=1`;
  const flags = pdfViewerFlags(pdfSettings(meta));

  // aria-label as well as title on each one: under 480px the CSS drops the .label span to
  // display:none, which takes the text out of the accessible name, and a touch screen has no
  // hover for the tooltip to appear on. Without it a screen reader reads out the glyph.
  const openBtn = `<a class="act" id="open" href="${fileUrl}" target="_blank" rel="noopener" title="Open the PDF in a new tab" aria-label="Open the PDF in a new tab">&#8599;&nbsp;<span class="label">Open</span></a>`;
  const downloadBtn = `<a class="act" id="download" href="${downloadUrl}" download title="Download the PDF" aria-label="Download the PDF">&#8681;&nbsp;<span class="label">Download</span></a>`;
  const fullscreenBtn = `<button class="act" id="fullscreen" type="button" title="Show the document full screen" aria-label="Show the document full screen">&#9974;&nbsp;<span class="label">Full screen</span></button>`;

  const actions = [];
  if (flags.fullscreen) actions.push(fullscreenBtn);
  if (flags.download) actions.push(openBtn, downloadBtn);
  // A bar with no buttons is 44px of white strip and a border: inside the viewer frame the
  // shell blanks the title too, so standard mode with downloads off drew an empty box that
  // read as a rendering fault. Nothing to hold means nothing to draw.
  const bar = flags.bar && actions.length
    ? `<div id="bar">\n    <span id="title">${title}</span>\n    ${actions.join('\n    ')}\n  </div>`
    : '';

  return fillShell(PDF_SHELL, {
    TITLE: title,
    SOCIAL: socialTags(meta, canonicalUrl(meta)),
    MODE: flags.mode,
    BAR: bar,
    // '1' or ''. The shell reads it as a boolean, and only after it knows it is framed.
    HIDE_BAR_IN_FRAME: flags.hideBarInFrame ? '1' : '',
    // Escaped because the open parameters are joined with "&", which is a bare ampersand
    // inside an attribute otherwise.
    EMBED_URL: escapeHtml(fileUrl + flags.hash),
    // The <object>'s fallback is what a browser that refuses application/pdf shows, and what
    // the shell's probe swaps in when a browser accepts the type and then paints nothing.
    // With downloads off there is nothing to offer there, and saying so beats a page that
    // looks broken.
    FALLBACK_TEXT: flags.download
      ? 'This browser will not show a PDF on the page. Open it in a new tab or save it instead.'
      : 'This browser will not show a PDF on the page, and downloads are off for this artifact.',
    FALLBACK_LINKS: flags.download
      ? `<a class="act" href="${fileUrl}" target="_blank" rel="noopener">Open the PDF</a>\n        <a class="act" href="${downloadUrl}" download>Download the PDF</a>`
      : '',
  });
}

// md artifacts render at serve time so a config change shows up on the next view. That
// parse is synchronous and scales with the document: 1 MB costs ~130ms of blocked event
// loop, 8 MB costs ~780ms. A public md artifact is readable by anyone holding the link,
// so without a cache any reader can stall the whole process once per request.
//
// Keyed on the md config and the branding as well as the artifact, so editing either set of
// global knobs still takes effect immediately. Writers drop their slug's entries (dropMdRender) rather than relying
// on updatedAt, which is only millisecond-precise. Bounded by rendered bytes, not entry
// count, because the entries worth caching are the large ones.
const MD_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const mdRenderCache = new Map();
let mdCacheBytes = 0;

// SLUG_RE allows no '|', so the separator can never appear in the slug half of the key, which
// is the half dropMdRender matches on. Branding values may hold one; everything after the first
// separator is opaque, so that costs nothing.
function mdCacheKey(slug, mdCfg, branding) {
  return `${slug}|${mdCfg.font}:${mdCfg.width}:${mdCfg.size}:${mdCfg.theme}|${JSON.stringify(branding)}`;
}

function renderMd(slug, meta, source, mdCfg = config.current.md, branding = config.current.branding) {
  const key = mdCacheKey(slug, mdCfg, branding);
  const hit = mdRenderCache.get(key);
  if (hit !== undefined) {
    mdRenderCache.delete(key); // re-insert so iteration order stays least-recent-first
    mdRenderCache.set(key, hit);
    return hit;
  }
  const html = buildMdHtml(source, meta, mdCfg, branding);
  mdRenderCache.set(key, html);
  mdCacheBytes += html.length;
  while (mdCacheBytes > MD_CACHE_MAX_BYTES && mdRenderCache.size > 1) {
    const oldest = mdRenderCache.keys().next().value;
    mdCacheBytes -= mdRenderCache.get(oldest).length;
    mdRenderCache.delete(oldest);
  }
  return html;
}

// Any write to a slug (replace, rename, duplicate target, delete) invalidates its renders.
function dropMdRender(slug) {
  for (const key of mdRenderCache.keys()) {
    if (key.slice(0, key.indexOf('|')) === slug) {
      mdCacheBytes -= mdRenderCache.get(key).length;
      mdRenderCache.delete(key);
    }
  }
}

// Parent "frame" page: a slim toolbar with the artifact loaded in an iframe.
function buildFrameHtml(meta, rawUrl) {
  return fillShell(FRAME_SHELL, {
    ...frameBrandSlots(config.current.branding),
    TITLE: escapeHtml(meta.title || meta.slug),
    SOCIAL: socialTags(meta, canonicalUrl(meta), socialBranding(config.current.branding, BASE_URL)),
    RAW_URL: escapeHtml(rawUrl),
    THEME_BTN: meta.type === 'md'
      ? '<button id="theme" type="button" title="Cycle theme (auto, light, dark)">Auto</button>'
      : '',
  });
}

// Unlock prompt for password-mode artifacts. Renders no title and no mode label so it
// discloses nothing about the artifact to someone who only holds the URL.
function buildPromptHtml(meta) {
  return fillShell(PASSWORD_SHELL, {
    ...passwordBrandSlots(config.current.branding),
    SLUG: escapeHtml(meta.slug),
  });
}

function buildNotFoundHtml() {
  return buildStatusHtml(NOT_FOUND_COPY);
}

// The 404 card and the 410 card are the same card with different words, so an operator's logo,
// accent and footer reach both and there is one set of styles to keep in step.
function buildStatusHtml(copy) {
  return fillShell(NOT_FOUND_SHELL, { ...notFoundBrandSlots(config.current.branding), ...copy });
}

async function readMeta(slug) {
  const buf = await storage.getBuffer(`${slug}/meta.json`);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

// One 404 shape for every serve-path miss (missing, disabled, locked-private, wrong slug)
// so an unauthenticated caller cannot distinguish them — no existence oracle.
function notFound(res) {
  return sendStatusCard(res, 404, NOT_FOUND_COPY);
}

// The expired page. 410 says the artifact was here and is gone on purpose, and the card says the
// same thing in words, so a reader stops hunting for a typo in the link. Callers gate this behind
// artifactUnlocked, so a locked artifact still answers the flat 404 and expiry stays off the
// existence oracle.
function expired(res) {
  return sendStatusCard(res, 410, EXPIRED_COPY);
}

function sendStatusCard(res, status, copy) {
  return res.status(status).set({
    'Content-Security-Policy': FRAME_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
    // These URLs answer two different bodies depending on Accept, so a shared cache has to key
    // on it. Without this, one visitor's card could be handed to the next caller's fetch().
    Vary: 'Accept',
  }).type('html').send(buildStatusHtml(copy));
}

// The one-line body for everything that is not a browser navigation. Same hardening as the card:
// a plain text 404 is still a response a cache can hold and a sniffer can guess a type for.
function sendStatusText(res, status, body) {
  return res.status(status).set({
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    Vary: 'Accept',
  }).type('text/plain').send(body);
}

// A miss. A person who followed a link gets the branded card; an <img>, a range read, curl and
// fetch() keep the one-line body, because an HTML page in place of an asset is noise to whatever
// asked for the asset.
function missing(req, res) {
  if (wantsHtmlPage(req.headers.accept)) return notFound(res);
  return sendStatusText(res, 404, NOT_FOUND_TEXT);
}

function expiredFor(req, res) {
  if (wantsHtmlPage(req.headers.accept)) return expired(res);
  return sendStatusText(res, 410, EXPIRED_TEXT);
}

// ---------------------------------------------------------------------------
// Zip sites
// ---------------------------------------------------------------------------

const ZIP_ALLOWED_EXT = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'xml', 'csv',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'pdf', 'wasm', 'map', 'webmanifest',
  // Flutter web build outputs: binary asset manifest, compiled shaders,
  // CanvasKit symbol maps.
  'bin', 'frag', 'symbols',
]);

// Files permitted by exact basename — covers extensionless/dotfile build
// artifacts (Flutter's `NOTICES` license bundle and `.last_build_id` marker).
const ZIP_ALLOWED_NAMES = new Set(['NOTICES', '.last_build_id']);
const ZIP_MAX_FILES = 2000;
const ZIP_MAX_UNCOMPRESSED = 100 * 1024 * 1024;

// Validates the archive is a hostable static site and returns {relPath, entry}
// pairs, with a single shared top-level folder stripped if present.
function extractSiteFiles(zip) {
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .filter((e) => {
      const name = e.entryName;
      const base = path.posix.basename(name);
      return !name.startsWith('__MACOSX/') && base !== '.DS_Store' && base !== 'Thumbs.db';
    });

  if (!entries.length) throw new ApiError(400, 'zip contains no files');
  if (entries.length > ZIP_MAX_FILES) {
    throw new ApiError(400, `zip has too many files (${entries.length} > ${ZIP_MAX_FILES})`);
  }

  let totalSize = 0;
  for (const e of entries) {
    const name = e.entryName;
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) {
      throw new ApiError(400, `unsafe path in zip: ${name}`);
    }
    if (((e.attr >>> 16) & 0xf000) === 0xa000) {
      throw new ApiError(400, `symlinks not allowed in zip: ${name}`);
    }
    totalSize += e.header.size;
  }
  if (totalSize > ZIP_MAX_UNCOMPRESSED) {
    throw new ApiError(400, 'zip uncompressed size exceeds 100 MB');
  }

  // If everything lives in one top-level folder (common when zipping a dir), strip it.
  const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
  const strip = tops.size === 1 && entries.every((e) => e.entryName.includes('/'))
    ? `${[...tops][0]}/`
    : '';
  const files = entries.map((e) => ({ relPath: e.entryName.slice(strip.length), entry: e }));

  const unsupported = files
    .map((f) => f.relPath)
    .filter((p) => {
      const ext = path.posix.extname(p).slice(1).toLowerCase();
      return !ZIP_ALLOWED_EXT.has(ext) && !ZIP_ALLOWED_NAMES.has(path.posix.basename(p));
    });
  if (unsupported.length) {
    throw new ApiError(
      400,
      `unsupported files for static hosting: ${unsupported.slice(0, 10).join(', ')}` +
        (unsupported.length > 10 ? ` (+${unsupported.length - 10} more)` : ''),
    );
  }

  if (!files.some((f) => f.relPath === 'index.html')) {
    throw new ApiError(400, 'zip must contain index.html at its root');
  }
  return files;
}

// Chained on the target slug like every other write: the 409 below is a read followed by a
// write, so a zip deploy and an inline publish naming one slug both used to answer 201 and the
// loser's bytes stayed on disk with nothing serving them.
async function saveZipArtifact(buffer, input) {
  const wanted = wantedSlug(input.slug);
  if (wanted !== undefined && !SLUG_RE.test(wanted)) {
    throw new ApiError(400, 'slug must match [a-z0-9][a-z0-9-]{2,63}');
  }
  const finalSlug = wanted || nanoid();
  return withMetaChain(finalSlug, () => storeZipArtifact(buffer, finalSlug, input));
}

async function storeZipArtifact(buffer, finalSlug, { title, description, ogImage, expiresAt, tags, project, visibility, password }) {
  const expiry = expiresAt !== undefined ? parseExpiresAt(expiresAt) : undefined;
  const tagList = tags !== undefined ? parseTags(tags) : undefined;
  const projectName = project !== undefined ? parseProject(project) : undefined;
  const summary = description !== undefined ? parseDescription(description) : undefined;
  const previewImage = ogImage !== undefined ? parseOgImage(ogImage) : undefined;
  // Zip artifacts are always new (no inline-replace path), so resolve the default here.
  const vis = visibility !== undefined ? visibility : DEFAULT_VISIBILITY;
  if (!VISIBILITIES.includes(vis)) {
    throw new ApiError(400, 'visibility must be public, private, or password');
  }
  if (vis === 'password' && (typeof password !== 'string' || !password)) {
    throw new ApiError(400, 'password is required when visibility is "password"');
  }

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ApiError(400, 'invalid zip file');
  }
  const files = extractSiteFiles(zip);

  if (await readMeta(finalSlug)) {
    throw new ApiError(409, `slug "${finalSlug}" already exists`);
  }

  for (const { relPath, entry } of files) {
    await storage.put(`${finalSlug}/site/${relPath}`, entry.getData());
  }
  const meta = {
    slug: finalSlug,
    type: 'zip',
    title: title || finalSlug,
    files: files.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (expiry !== undefined) meta.expiresAt = expiry;
  if (tagList?.length) meta.tags = tagList;
  if (projectName) meta.project = projectName;
  if (summary) meta.description = summary;
  if (previewImage) meta.ogImage = previewImage;
  if (vis === 'password') {
    meta.visibility = 'password';
    meta.password = await hashPassword(password);
  } else if (vis === 'private') {
    meta.visibility = 'private';
  }
  seedTokenEpoch(meta);
  // meta.json LAST: a crash mid-upload leaves the namespace invisible (404), not half-served.
  await storage.put(`${finalSlug}/meta.json`, JSON.stringify(meta, null, 2), {
    contentType: 'application/json',
  });
  await storage.flush?.();
  if (meta.tokenEpoch !== undefined) await ensureSessionSecret();
  return { slug: finalSlug, url: tokenedUrl(meta), files: files.length, visibility: meta.visibility || 'public' };
}

// Accepts an array of strings or a comma-separated string (JSON bodies, zip
// query params, and CLI flags all funnel through here). Returns a deduped,
// lowercased array; empty means "clear".
function parseTags(value) {
  if (value === null) return [];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!raw || raw.some((t) => typeof t !== 'string')) {
    throw new ApiError(400, 'tags must be an array of strings or a comma-separated string');
  }
  const tags = [...new Set(raw.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  for (const tag of tags) {
    if (!TAG_RE.test(tag)) {
      throw new ApiError(400, `invalid tag "${tag}" — tags must match [a-z0-9][a-z0-9-]{0,31}`);
    }
  }
  if (tags.length > MAX_TAGS) {
    throw new ApiError(400, `too many tags (${tags.length} > ${MAX_TAGS})`);
  }
  return tags;
}

// A whole-number query parameter inside a range. Rejects junk rather than silently falling
// back to the default, so a caller that asks for scale=huge learns it asked for nothing. The
// digits-only test is deliberate: Number() would take "0x10", "1e1", " 8" and (through the
// extended query parser) ["8"], none of which are the whole number the docs promise.
function intParam(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const bad = () => new ApiError(400, `${name} must be a whole number between ${min} and ${max}`);
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw bad();
  const n = Number(value);
  if (n < min || n > max) throw bad();
  return n;
}

// Returns a trimmed project name, or '' to clear it. null/'' both mean clear.
function parseProject(value) {
  if (value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'project must be a string');
  }
  const project = value.trim().replace(/\s+/g, ' '); // collapse internal whitespace
  if (!project) return '';
  if (!PROJECT_RE.test(project)) {
    throw new ApiError(
      400,
      'project must be 1–64 chars of letters, digits, spaces, and - _ . (starting with a letter or digit)',
    );
  }
  return project;
}

function parseExpiresAt(value) {
  if (value === null || value === '') return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, 'expiresAt must be an ISO 8601 date string or null');
  }
  return new Date(value).toISOString();
}

// The rule itself is in lib/expiry.js, where a unit test can reach the records a request
// cannot make. The five call sites below keep the short local name.
const isExpired = artifactExpired;

// Writes to one slug run one at a time, and one chained write gets WRITE_CEILING_MS to come
// back before the caller is told to retry. That is the whole-handler ceiling, not the per-call
// storage deadline the s3 backend uses; why they are two numbers is in lib/write-queue.js.
const { withMetaChain, withMetaChains } = createWriteQueue({ ceilingMs: WRITE_CEILING_MS });

// A slug arriving in a JSON body can be a number, and SLUG_RE coerces it on the way through.
// `123` and `"123"` name one directory and are two different chain keys, so two writers to that
// namespace both believed they were alone. Settle it to a string before anything keys on it.
// `null` means the caller left it out, which is how a JS client writes `slug: form.slug || null`;
// String() would have turned that into an artifact named "null" and 409'd every publish after it.
function wantedSlug(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ApiError(400, 'slug must be a string');
  }
  return String(value);
}

// Publish or replace. The slug is settled first so the write can be chained on it: a replace
// reads the stored record and writes it back carrying the new content, so a PATCH that landed
// between those two steps used to disappear.
// `opts.keyId` is the managed key that sent the request, or null for the bootstrap key and
// the dashboard session. A redirect stores it so GET /api/keys can say how many hops each key
// has minted; nothing else reads it.
async function saveArtifact(input, opts = {}) {
  const wanted = wantedSlug(input.slug);
  if (wanted !== undefined && !SLUG_RE.test(wanted)) {
    throw new ApiError(400, 'slug must match [a-z0-9][a-z0-9-]{2,63}');
  }
  const finalSlug = wanted || nanoid();
  return withMetaChain(finalSlug, () => storeArtifact(finalSlug, input, opts));
}

async function storeArtifact(finalSlug, input, { replace = false, keyId = null } = {}) {
  const { content, type = 'html', title, description, ogImage, expiresAt, frame, tags, project, visibility, password, pdf } = input;
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError(400, 'content (non-empty string) is required');
  }
  if (frame !== undefined && typeof frame !== 'boolean') {
    throw new ApiError(400, 'frame must be a boolean');
  }
  // Viewer settings for a pdf. Refused on any other type rather than stored and ignored: there
  // is no page here they could apply to, and a stored value nothing reads is a lie in the row.
  if (pdf !== undefined && type !== 'pdf') {
    throw new ApiError(400, 'pdf viewer settings only apply to a pdf artifact');
  }
  if (visibility !== undefined && !VISIBILITIES.includes(visibility)) {
    throw new ApiError(400, 'visibility must be public, private, or password');
  }
  if (visibility === 'password' && (typeof password !== 'string' || !password)) {
    throw new ApiError(400, 'password is required when visibility is "password"');
  }
  const expiry = expiresAt !== undefined ? parseExpiresAt(expiresAt) : undefined;
  const tagList = tags !== undefined ? parseTags(tags) : undefined;
  const projectName = project !== undefined ? parseProject(project) : undefined;
  const summary = description !== undefined ? parseDescription(description) : undefined;
  const previewImage = ogImage !== undefined ? parseOgImage(ogImage) : undefined;
  if (!TYPES.includes(type)) {
    throw new ApiError(400, `type must be one of: ${TYPES.join(', ')}`);
  }
  const existing = await readMeta(finalSlug);
  if (existing && !replace) {
    throw new ApiError(409, `slug "${finalSlug}" already exists`);
  }
  if (replace && !existing) {
    throw new ApiError(404, `slug "${finalSlug}" not found`);
  }
  if (existing?.type === 'zip') {
    throw new ApiError(400, 'cannot replace a zip site with inline content; delete and re-upload');
  }
  // A replace that names no type falls back to html, which deletes the files the old type
  // owned. For md, jsx and redirect the caller was holding the source anyway; for a pdf the
  // bytes are gone and nothing can put them back, so this one direction has to be asked for
  // out loud. T2.1.19 is the general item about that fallback; this only shuts the door where
  // the loss cannot be undone.
  if (existing?.type === 'pdf' && input.type === undefined) {
    throw new ApiError(
      400,
      'cannot replace a pdf without a type: pass type "pdf" to send new bytes, or another type to convert it and delete the file',
    );
  }

  // A PUT that omits the title keeps the one already stored, the way it keeps tags and project.
  // Falling back to the slug instead threw the title away on every content-only update: the CLI
  // `update` with no --title, MCP `update_artifact`, and repointing a redirect from the
  // dashboard all did it, and the row simply stopped showing the label.
  const finalTitle = title !== undefined ? (title || finalSlug) : (existing?.title || finalSlug);
  let html;
  if (type === 'html') html = content;
  else if (type === 'jsx' || type === 'tsx') html = buildJsxHtml(content, finalTitle);
  // md renders at serve time from source.md; nothing baked here.
  // redirect stores the normalized target and nothing else; the serve path reads it back.
  // pdf is the one type whose body is not text: `content` carries base64 and what gets stored
  // is the decoded Buffer, so the bytes a reader downloads are the bytes that were uploaded.
  let body = content;
  if (type === 'redirect') body = parseRedirectTarget(content, { publishing: true });
  else if (type === 'pdf') body = parsePdfContent(content);
  // A redirect that points at its own slug answers its own 301, so a visitor's browser hops
  // until it gives up. Refused here rather than at serve time: the link is dead either way,
  // and the publisher is the one who can fix it.
  if (type === 'redirect' && pointsAtOwnSlug(body, finalSlug, BASE_URL)) {
    throw new ApiError(
      400,
      `a redirect cannot point at its own slug: "${body}" is /a/${finalSlug} on this server`,
    );
  }

  if (html !== undefined) {
    await storage.put(`${finalSlug}/index.html`, html, { contentType: 'text/html; charset=utf-8' });
  }
  await storage.put(`${finalSlug}/source.${SOURCE_EXT[type]}`, body, {
    contentType: type === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8',
  });
  const meta = {
    ...existing,
    slug: finalSlug,
    type,
    title: finalTitle,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // The target lives in source.url, which the list API never reads, so a redirect also
  // carries it in meta for the dashboard row. Cleared on any other type, or an artifact
  // converted away from redirect would keep claiming a destination it no longer has.
  // keyId rides along for the same reason: GET /api/keys counts a key's redirects off the
  // stored records, so the count follows a replace as well as a first publish. A replace by a
  // principal with no key of its own leaves the existing attribution alone: a dashboard session
  // has no keyId at all and the bootstrap key sets it to null, so clearing it here meant that
  // repointing a leaked key's hop, which is the first thing an operator does on finding one,
  // erased the count that showed them the key was leaking.
  if (type === 'redirect') {
    meta.target = body;
    if (keyId) meta.keyId = keyId;
  } else {
    delete meta.target;
    delete meta.keyId;
  }
  if (expiresAt !== undefined) meta.expiresAt = expiry;
  if (frame !== undefined) meta.frame = frame;
  // A pdf keeps whatever it already had when the field is left out, the way tags and project
  // do; converting away from pdf drops the settings, since nothing would read them again.
  if (type !== 'pdf') delete meta.pdf;
  else if (pdf !== undefined) meta.pdf = pdfSettingsForMeta(parsePdfSettings(pdf, pdfSettings(existing)));
  if (tagList !== undefined) meta.tags = tagList.length ? tagList : undefined;
  if (projectName !== undefined) meta.project = projectName || undefined;
  // Both keep their stored value when the field is absent, the way tags and project do, so a
  // content-only PUT does not wipe a preview someone set from the dashboard.
  if (summary !== undefined) meta.description = summary || undefined;
  if (previewImage !== undefined) meta.ogImage = previewImage || undefined;
  // New artifacts with no explicit visibility take DEFAULT_VISIBILITY. Replacing an
  // existing artifact with no visibility arg preserves whatever it had (carried by the
  // `...existing` spread), so an overwrite never silently flips access.
  const effVisibility =
    visibility !== undefined ? visibility : existing ? undefined : DEFAULT_VISIBILITY;
  if (effVisibility === 'password') {
    meta.visibility = 'password';
    meta.password = await hashPassword(password);
  } else if (effVisibility === 'private') {
    meta.visibility = 'private';
    delete meta.password;
  } else if (effVisibility === 'public') {
    delete meta.visibility; // public is the omitted default
    delete meta.password;
  } else if (password !== undefined && meta.visibility === 'password') {
    if (typeof password !== 'string' || !password) {
      throw new ApiError(400, 'password must be a non-empty string');
    }
    meta.password = await hashPassword(password); // rotate on an existing password artifact
  }
  seedTokenEpoch(meta);
  // meta.json LAST as the commit marker (see storage/index.js write-ordering contract).
  await storage.put(`${finalSlug}/meta.json`, JSON.stringify(meta, null, 2), {
    contentType: 'application/json',
  });
  // The old type's objects are unreachable now that meta names the new one, so drop them. After
  // the meta write and before flush; the ordering and the swallowed failure are explained in
  // lib/artifact-files.js.
  await dropStaleObjects(storage, finalSlug, existing?.type, type);
  await storage.flush?.(); // durably commit the completed write (git); no-op elsewhere
  dropMdRender(finalSlug);
  // A non-public artifact needs the session secret resident to mint its capability token;
  // it is created lazily (at setup otherwise), so force it here (tokenEpoch ⇒ non-public).
  if (meta.tokenEpoch !== undefined) await ensureSessionSecret();
  const out = { slug: finalSlug, url: tokenedUrl(meta), visibility: meta.visibility || 'public' };
  // A redirect answers with the target it stored, which is not always the string that was sent:
  // the host case-folds, a bare host gains a slash, and everything else percent-encodes. Without
  // it a caller that wants to show the target has to guess or re-fetch the list.
  if (meta.target !== undefined) out.target = meta.target;
  return out;
}

// Copy an existing artifact into a new slug. Content bytes (source.* / index.html / site/*)
// are copied by the storage layer; a fresh meta.json is written last. Each meta field uses
// the request body when provided, else inherits the source's value, so a copy keeps all of
// the original's setup unless the caller overrides it. The view password cannot be inherited
// (stored hashed), so a password-visibility copy requires a new password in the body.
async function duplicateArtifact(sourceSlug, body = {}, { keyId = null } = {}) {
  if (!SLUG_RE.test(sourceSlug)) throw new ApiError(404, `slug "${sourceSlug}" not found`);
  // Validated after the fallback, the way it always was here: an empty or absent slug on a copy
  // means "pick one", where the same value on a publish is a 400.
  const targetSlug = wantedSlug(body.slug) || nanoid();
  if (!SLUG_RE.test(targetSlug)) {
    throw new ApiError(400, 'slug must match [a-z0-9][a-z0-9-]{2,63}');
  }
  // Both names: the target because the 409 below is a read-then-write, and the source because
  // copySlug walks its directory while a PATCH there may be renaming a scratch file into place.
  return withMetaChains([sourceSlug, targetSlug], () => copyArtifact(sourceSlug, targetSlug, body, keyId));
}

async function copyArtifact(sourceSlug, targetSlug, body, keyId) {
  const source = await readMeta(sourceSlug);
  if (!source) throw new ApiError(404, `slug "${sourceSlug}" not found`);
  if (await readMeta(targetSlug)) {
    throw new ApiError(409, `slug "${targetSlug}" already exists`);
  }

  const title = body.title !== undefined ? (body.title || targetSlug) : (source.title || targetSlug);
  const tagList = body.tags !== undefined ? parseTags(body.tags) : source.tags;
  const projectName = body.project !== undefined ? parseProject(body.project) : source.project;
  const expiry = body.expiresAt !== undefined ? parseExpiresAt(body.expiresAt) : source.expiresAt;
  // Inherited values go through the same parsers, for the reason the redirect block below gives:
  // a copy is a publish, and meta written by an older build (or by hand) has met no rule. A stored
  // value this build refuses is left off the copy rather than carried into it, and unlike a
  // refused redirect target it does not take the copy down: a preview that does not survive is
  // cosmetic, while a redirect that loses its target points nowhere.
  const summary = body.description !== undefined
    ? parseDescription(body.description)
    : dropIfRefused(parseDescription, source.description);
  const previewImage = body.ogImage !== undefined
    ? parseOgImage(body.ogImage)
    : dropIfRefused(parseOgImage, source.ogImage);

  let frame;
  if (body.frame !== undefined) {
    if (body.frame !== null && typeof body.frame !== 'boolean') {
      throw new ApiError(400, 'frame must be a boolean');
    }
    frame = body.frame === null ? undefined : body.frame; // null clears to inherit the global default
  } else {
    frame = source.frame;
  }

  const visibility = body.visibility !== undefined ? body.visibility : (source.visibility || 'public');
  if (!VISIBILITIES.includes(visibility)) {
    throw new ApiError(400, 'visibility must be public, private, or password');
  }
  if (visibility === 'password' && (typeof body.password !== 'string' || !body.password)) {
    throw new ApiError(400, 'password is required when visibility is "password"');
  }

  // A copy keeps the original's viewer settings, the way it keeps the frame, and takes an
  // override from the body the way every other setting on this endpoint does. The source is
  // read through the tolerant reader the serve path uses, so a hand-edited value does not
  // travel into a fresh record; the override goes through the strict parser, so a mode the
  // server does not understand is a 400 here the way it is on POST, PUT and PATCH. Settled
  // before copySlug so a refused value costs no bytes.
  let pdfMeta;
  if (source.type === 'pdf') {
    const current = pdfSettings(source);
    pdfMeta = pdfSettingsForMeta(
      body.pdf !== undefined ? parsePdfSettings(body.pdf, current) : current,
    );
  } else if (body.pdf !== undefined) {
    throw new ApiError(400, 'pdf viewer settings only apply to a pdf artifact');
  }

  // A copy is a publish, so it answers to the publish rules, and it answers to them here,
  // before anything is written. The target is read off the original, so a refusal leaves no
  // bytes to clean up.
  //
  // A copy points where the original points, which is what the original's meta says, so this
  // resolves the same way the serve path does rather than reading the stored bytes first.
  // Reading the bytes re-imported the drift the resolver exists to remove, and it promoted a
  // value nothing had validated into meta, where the list API hands it to every read-scoped
  // key: a target with credentials, published before that rule existed, would have leaked
  // through a duplicate.
  let copiedTarget;
  if (source.type === 'redirect') {
    const stored = await resolveRedirectTarget({ meta: source, readSource: () => storage.getBuffer(`${sourceSlug}/source.url`) });
    // Writing the target unvalidated was the one door where the publish rules did not apply.
    // Refusing beats copying anyway with the target left off: that produced a brand-new
    // artifact whose row said nothing while its 301 still handed credentials to the target
    // host. Repoint the original and the copy goes through.
    try {
      copiedTarget = parseRedirectTarget(stored, { publishing: true });
    } catch (err) {
      throw new ApiError(400, `cannot copy "${sourceSlug}": ${err.message}`);
    }
    // The copy lands on a different slug, so a target that was somebody else's problem on the
    // original is a loop here: duplicating a hop onto the very slug it points at built the
    // self-reference a direct publish refuses.
    if (pointsAtOwnSlug(copiedTarget, targetSlug, BASE_URL)) {
      throw new ApiError(
        400,
        `a redirect cannot point at its own slug: "${copiedTarget}" is /a/${targetSlug} on this server`,
      );
    }
  }

  // Copy content first; meta.json is written LAST as the commit marker (copySlug skips it).
  await storage.copySlug(sourceSlug, targetSlug);
  // copySlug carries every content object under the namespace and prunes nothing, so a source
  // that collected orphans before the type-change cleanup existed hands them to the copy. A
  // brand-new slug should not start life holding dead bytes, and the git backend would commit
  // them. Before the meta write, so the commit marker lands on a namespace that is already
  // clean, and before flush, so git makes one commit.
  await dropOrphanObjects(storage, targetSlug, source.type);

  const meta = {
    slug: targetSlug,
    type: source.type,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (source.type === 'zip' && typeof source.files === 'number') meta.files = source.files;
  if (source.type === 'redirect') {
    meta.target = copiedTarget;
    // The copy is a new hop and belongs to whoever made it, not to whoever published the
    // original. Leaving keyId off meant a key could duplicate its own redirect all day while
    // GET /api/keys still said one, which is the burst the count exists to show.
    if (keyId) meta.keyId = keyId;
  }
  if (expiry !== undefined) meta.expiresAt = expiry;
  if (tagList && tagList.length) meta.tags = tagList;
  if (projectName) meta.project = projectName;
  if (summary) meta.description = summary;
  if (previewImage) meta.ogImage = previewImage;
  if (frame !== undefined) meta.frame = frame;
  if (pdfMeta !== undefined) meta.pdf = pdfMeta;
  if (visibility === 'password') {
    meta.visibility = 'password';
    meta.password = await hashPassword(body.password);
  } else if (visibility === 'private') {
    meta.visibility = 'private';
  }
  seedTokenEpoch(meta);
  await storage.put(`${targetSlug}/meta.json`, JSON.stringify(meta, null, 2), {
    contentType: 'application/json',
  });
  await storage.flush?.();
  dropMdRender(targetSlug);
  if (meta.tokenEpoch !== undefined) await ensureSessionSecret();
  return { slug: targetSlug, url: tokenedUrl(meta), visibility: meta.visibility || 'public' };
}

// A non-public artifact carries a non-secret epoch so capability tokens can be minted and
// revoked; a public one carries none. Seed once; never reset a live epoch to 0 (that would
// silently un-revoke). Idempotent, so every write path can call it.
function seedTokenEpoch(meta) {
  if (meta.visibility === 'private' || meta.visibility === 'password') {
    if (meta.tokenEpoch === undefined) meta.tokenEpoch = 0;
  } else {
    delete meta.tokenEpoch;
  }
}

// Allowlist (not denylist) so a new meta field can never leak by omission. Returns only
// what the dashboard/API legitimately need; secrets (password) and internal state
// (tokenEpoch) are dropped, and hasPassword exposes state without the hash.
const PUBLIC_META_FIELDS = [
  'slug', 'type', 'title', 'files', 'target', 'description', 'ogImage', 'createdAt', 'updatedAt',
  'expiresAt', 'frame', 'tags', 'project', 'visibility', 'disabled', 'pdf',
];
function publicMeta(meta) {
  const out = {};
  for (const f of PUBLIC_META_FIELDS) if (meta[f] !== undefined) out[f] = meta[f];
  if (meta.password) out.hasPassword = true;
  return out;
}

// Every stored record, parsed, with nothing stripped. publicMeta() decides what a read-scoped
// caller sees; this is the raw shape, so anything that reads a field the list API does not
// hand out (GET /api/keys counting redirects per key) goes through here.
async function listArtifactMetas() {
  const metas = await storage.listMetas();
  return metas
    .map(({ buffer }) => {
      try {
        return JSON.parse(buffer.toString('utf8'));
      } catch {
        return null; // skip a corrupt meta rather than failing the whole list
      }
    })
    .filter(Boolean);
}

async function listArtifacts({ tag, project } = {}) {
  let items = (await listArtifactMetas())
    .map((m) => ({ ...publicMeta(m), tags: m.tags || [] }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (tag !== undefined) {
    const wanted = String(tag).trim().toLowerCase();
    items = items.filter((a) => a.tags.includes(wanted));
  }
  if (project !== undefined) {
    const wanted = String(project).trim();
    items = items.filter((a) => (a.project || '') === wanted);
  }
  return items;
}

// Chained per slug so the record this reads is the one the last write left, not the one the
// request found when it arrived. Two one-field PATCHes to one artifact, which the dashboard
// sends a lot of, used to end with only the second field set.
async function patchArtifact(slug, patch) {
  // Checked here rather than after the chain starts, so a caller-supplied path segment that is
  // not a slug never becomes a chain key.
  if (!SLUG_RE.test(slug)) throw new ApiError(404, `slug "${slug}" not found`);
  // A rename writes under the new name too. Holding only the old one let a publish claim the
  // destination between the collision check and the move, which answered 500 and, when the move
  // won instead, left a private artifact's bytes under the publish's public record.
  const newSlug = wantedSlug(patch?.slug);
  const renaming = newSlug !== undefined && newSlug !== slug;
  if (renaming && !SLUG_RE.test(newSlug)) {
    throw new ApiError(400, 'slug must match [a-z0-9][a-z0-9-]{2,63}');
  }
  return withMetaChains(renaming ? [slug, newSlug] : [slug], () => applyPatch(slug, patch, newSlug));
}

// Reads a patch and returns the values to write, or throws on the first one the server refuses.
// Nothing here writes or moves, so a refusal costs the artifact nothing. A key is present when
// the patch touches that field, so `undefined` (clear it) and "left out" stay different; `null`
// means delete the key outright.
async function parsePatch(patch, meta) {
  const changes = {};

  if (patch.disabled !== undefined) {
    if (typeof patch.disabled !== 'boolean') {
      throw new ApiError(400, 'disabled must be a boolean');
    }
    changes.disabled = patch.disabled || undefined;
  }

  if (patch.frame !== undefined) {
    if (patch.frame === null) {
      changes.frame = null; // reset to inherit the global default
    } else if (typeof patch.frame === 'boolean') {
      changes.frame = patch.frame;
    } else {
      throw new ApiError(400, 'frame must be a boolean or null');
    }
  }

  if (patch.pdf !== undefined) {
    if (meta.type !== 'pdf') {
      throw new ApiError(400, 'pdf viewer settings only apply to a pdf artifact');
    }
    changes.pdf = pdfSettingsForMeta(parsePdfSettings(patch.pdf, pdfSettings(meta)));
  }

  if (patch.expiresAt !== undefined) {
    changes.expiresAt = parseExpiresAt(patch.expiresAt);
  }

  if (patch.tags !== undefined) {
    const tags = parseTags(patch.tags);
    changes.tags = tags.length ? tags : undefined;
  }

  if (patch.project !== undefined) {
    changes.project = parseProject(patch.project) || undefined; // '' clears it
  }

  if (patch.description !== undefined) {
    changes.description = parseDescription(patch.description) || undefined; // '' clears it
  }

  if (patch.ogImage !== undefined) {
    changes.ogImage = parseOgImage(patch.ogImage) || undefined; // '' clears it
  }

  if (patch.visibility !== undefined || patch.password !== undefined) {
    if (patch.visibility !== undefined && !VISIBILITIES.includes(patch.visibility)) {
      throw new ApiError(400, 'visibility must be public, private, or password');
    }
    const target = patch.visibility !== undefined ? patch.visibility : meta.visibility || 'public';
    if (target === 'password') {
      if (typeof patch.password === 'string' && patch.password) {
        changes.password = await hashPassword(patch.password); // set or rotate
      } else if (!meta.password) {
        throw new ApiError(400, 'password is required for visibility "password"');
      }
      changes.visibility = 'password';
    } else if (target === 'private') {
      changes.visibility = 'private';
      changes.password = null;
    } else {
      changes.visibility = null; // public
      changes.password = null;
    }
  }

  // Rotating a link is a single epoch bump — it invalidates every issued token AND live
  // unlock cookie for the slug on the next request. Read against the visibility this same patch
  // is about to set, which is what the old in-place version saw by running after it.
  if (patch.rotateToken === true) {
    const after = 'visibility' in changes ? changes.visibility : meta.visibility;
    if (after !== 'private' && after !== 'password') {
      throw new ApiError(400, 'only private or password artifacts have a link to rotate');
    }
    changes.rotateToken = true;
  }

  return changes;
}

async function applyPatch(slug, patch, newSlug) {
  const meta = await readMeta(slug);
  if (!meta) {
    throw new ApiError(404, `slug "${slug}" not found`);
  }

  // Every field is parsed before the rename below, because the rename moves storage: a patch
  // carrying both a new slug and a value the server refuses used to move the artifact and then
  // throw, leaving a list row whose link is dead and a live URL that appears in no row.
  // The collision check is a read, so it can stay ahead of the parse the way it was before: a
  // patch that names a taken slug still answers 409 rather than 400, and a password in the same
  // patch does not pay for a scrypt hash the 409 throws away. Nothing else can claim the name in
  // between, since patchArtifact holds the chain for both slugs across all of this.
  const renaming = newSlug !== undefined && newSlug !== slug;
  if (renaming && (await readMeta(newSlug))) {
    throw new ApiError(409, `slug "${newSlug}" already exists`);
  }
  // A rename is the other way a redirect ends up pointing at itself: hop-a points at /a/hop-b,
  // hop-b is deleted, and renaming hop-a to hop-b closes the loop without any target changing.
  // The target is resolved rather than read off meta, because a redirect published before
  // meta.target existed keeps its target in source.url alone: new URL(undefined) then threw
  // inside the check, which answered false, and the rename went through.
  if (renaming && meta.type === 'redirect') {
    const looping = await storedTargetPointsAtSlug({
      meta,
      readSource: () => storage.getBuffer(`${slug}/source.url`),
      slug: newSlug,
      baseUrl: BASE_URL,
    });
    if (looping) {
      throw new ApiError(
        400,
        `renaming to "${newSlug}" would point this redirect at itself: it targets "${looping}"`,
      );
    }
  }

  const changes = await parsePatch(patch, meta);

  let activeSlug = slug;
  if (renaming) {
    await storage.move(slug, newSlug);
    meta.slug = newSlug;
    activeSlug = newSlug;
  }

  if ('disabled' in changes) meta.disabled = changes.disabled;
  if ('frame' in changes) {
    if (changes.frame === null) delete meta.frame;
    else meta.frame = changes.frame;
  }
  if ('pdf' in changes) meta.pdf = changes.pdf;
  if ('expiresAt' in changes) meta.expiresAt = changes.expiresAt;
  if ('tags' in changes) meta.tags = changes.tags;
  if ('project' in changes) meta.project = changes.project;
  if ('description' in changes) meta.description = changes.description;
  if ('ogImage' in changes) meta.ogImage = changes.ogImage;
  if ('visibility' in changes) {
    if (changes.visibility === null) delete meta.visibility;
    else meta.visibility = changes.visibility;
  }
  if ('password' in changes) {
    if (changes.password === null) delete meta.password;
    else meta.password = changes.password;
  }
  if (changes.rotateToken) meta.tokenEpoch = metaEpoch(meta) + 1;

  // Seed the epoch when an artifact enters private/password (covers a pre-existing public
  // artifact flipped to private); drop it when it becomes public.
  seedTokenEpoch(meta);

  meta.updatedAt = new Date().toISOString();
  await storage.put(`${activeSlug}/meta.json`, JSON.stringify(meta, null, 2), {
    contentType: 'application/json',
  });
  await storage.flush?.();
  dropMdRender(activeSlug); // both names: a rename moves the artifact off activeSlug
  dropMdRender(meta.slug);
  if (meta.tokenEpoch !== undefined) await ensureSessionSecret();
  return { slug: meta.slug, url: tokenedUrl(meta), visibility: meta.visibility || 'public' };
}

// Chained too. A delete running beside a patch emptied the namespace between the patch's read
// and its write, and the patch then recreated meta.json under the cleared directory. Both
// requests answered 200 and the list kept a row whose /a/<slug> serves a 404, with no content
// left to put back. Serialized, the delete either wins (the patch gets a clean 404) or it loses
// (the delete removes what the patch just wrote).
async function deleteArtifact(slug) {
  if (!SLUG_RE.test(slug)) throw new ApiError(404, `slug "${slug}" not found`);
  return withMetaChain(slug, () => removeArtifact(slug));
}

async function removeArtifact(slug) {
  if (!(await readMeta(slug))) {
    throw new ApiError(404, `slug "${slug}" not found`);
  }
  await storage.deleteSlug(slug);
  await storage.flush?.();
  dropMdRender(slug);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// Express matches a route path without regard to case by default, so `POST /API/artifacts`
// reached the publish handler while every middleware that reads `req.path` and compares it to
// a lowercase prefix skipped it. A real artifact was published that way, past the body-size
// gate below. One slug, one path, one case.
app.set('case sensitive routing', true);

// A publish body may be 10 MB, and body parsing runs before routing, so the server buffered one
// before requireAuth ever saw the request. Measured on a fresh process: 40 concurrent 9.33 MB
// bodies with no Authorization header took RSS from 42 MB to 551 MB, every one of them
// answering 401, and roughly 12 to 32 MB of RSS per request in flight. PDFs make a 9 to 10 MB
// body an ordinary request rather than an odd one.
//
// So a caller who cannot publish gets two things: a parser that will not buffer a publish-sized
// body for them at all, and a budget for the big bodies it does accept. Neither reaches a caller
// who may publish. Two earlier versions of this gate had holes worth naming, because both looked
// like they covered everything:
//
//   - Keyed on a path prefix, `/api/artifacts` only. That left `POST /mcp`, `POST /api/keys`,
//     `PATCH /api/keys/:id` and `PUT /api/config` buffering 10 MB apiece before auth, and 40
//     anonymous 9 MB bodies to /mcp took RSS from 39,824 KB to 474,384 KB.
//   - Keyed on the write methods (POST/PUT/PATCH/DELETE). body-parser has no method filter: it
//     reads a body from any request that carries one and matches the content type, `GET`
//     included. So the gate returned early on a `GET`, nothing marked the request, and the
//     parser pick fell through to the 10 MB one. Measured with no credential at all, 40
//     concurrent 9 MB bodies: `GET /healthz` 89,280 -> 580,960 KB, `GET /api/artifacts`
//     109,328 -> 592,256 KB, `GET /robots.txt` 107,728 -> 597,280 KB, `OPTIONS /api/artifacts`
//     109,984 -> 769,120 KB. An unauthenticated OOM of the whole install on the healthcheck.
//
// So it keys on what body-parser itself keys on: does the request carry a body. That still keeps
// identify() off the serve path, where a `GET /a/:slug` carries no body and no header to read.
//
// The budget is spent only by a caller who cannot publish. Spending it on everyone meant 20
// anonymous bodies from one address locked the operator out of publishing for a minute, and
// under cloudflared (docs/deploy.md) every client shares one address, so that is one visitor and
// the whole install. A caller who cannot publish cannot write anything here in the first place;
// the budget is about what the server does before it says so.
//
// This is one process, like the other two limiters. It pairs with a CDN or edge limit
// (docs/deploy.md); it does not replace one.
const BIG_BODY_BYTES = 256 * 1024;
const publishLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// The body's declared size. A chunked body does not declare one, and it is not counted here:
// counting it as big charged a client that streams a 36 byte body the full publish budget, and
// counting it as small would let the flood back in through one header. What bounds it instead
// is the parser below, which stops reading a capped body at BIG_BODY_BYTES whether or not
// a Content-Length said so. No length and no transfer-encoding means no body.
function declaredBodySize(req) {
  const len = Number(req.headers['content-length']);
  return Number.isFinite(len) ? len : 0;
}

// Does this request carry a body at all? This is the same question body-parser asks, and asking
// a different one is what left the flood open on `GET`: the method says nothing about whether
// there are bytes to buffer.
function hasBody(req) {
  return req.headers['content-length'] !== undefined ||
    req.headers['transfer-encoding'] !== undefined;
}

app.use((req, res, next) => {
  if (!hasBody(req)) return next();
  // Publish authority, not mere identity. A read key is the weakest credential an operator can
  // issue, and it exists to be handed to something they do not fully trust; extending it a 10 MB
  // buffer meant 40 concurrent 9 MB bodies under a read key took RSS from 109,792 KB to
  // 565,584 KB, every one of them answering 403 after the buffering was done. Nothing legitimate
  // needs a body over 256 kB below publish scope: every route that takes one is requireAuth
  // ('publish') or stricter, the credential routes have their own 16 kB parser, and the one
  // route a read key may reach with a body, POST /mcp, re-checks scope per tool below.
  //
  // Stashed for the parser pick below, which asks the same question one middleware later.
  const who = identify(req);
  req.smallBody = !who || !hasScope(who.scopes, 'publish');
  if (!req.smallBody) return next();
  if (declaredBodySize(req) < BIG_BODY_BYTES) return next();
  const key = clientIp(req);
  const gate = publishLimiter.check(key);
  if (gate.limited) {
    res.set('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'too many large publishes, try again later' });
  }
  publishLimiter.count(key);
  next();
});

// Body parsing runs before routing, so an unauthenticated caller could make the server
// parse 10 MB of JSON on /api/auth/login before the rate limiter ever looked at them.
// Credential routes take a username, a password, or a slug — 16 kB is generous — so they
// get their own small parser. Every other request from a caller who cannot publish gets the
// big-body line as its limit: no route here takes a big body below publish scope, so 256 kB is
// more than any of them needs, and body-parser stops reading at the cap rather than buffering to
// the end. A caller who may publish keeps the publish-sized limit.
//
// The credential test lowercases the path rather than reading it as sent. Case sensitive
// routing means `/API/auth/login` matches no route and 404s, but this comparison runs before
// routing, and a 404 that buffered 10 MB first is still the flood.
const jsonPublish = express.json({ limit: '10mb' });
const jsonCredential = express.json({ limit: '16kb' });
const jsonSmall = express.json({ limit: BIG_BODY_BYTES });
app.use((req, res, next) => {
  const path = req.path.toLowerCase();
  const credential = path.startsWith('/api/auth/') ||
    (path.startsWith('/a/') && path.endsWith('/unlock'));
  if (credential) return jsonCredential(req, res, next);
  return (req.smallBody ? jsonSmall : jsonPublish)(req, res, next);
});

// Whole domain is non-crawlable.
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// Google Fonts goes in default-src rather than a narrow style-src/font-src pair: adding an
// explicit style-src here would stop styles falling back to default-src and break artifacts
// that pull CSS from cdnjs / unpkg / jsdelivr. A stylesheet cannot execute script, so this
// does not widen the script surface. It does mean a viewer's IP reaches Google on any
// artifact that asks for a webfont, which is also true of the md shell.
const ARTIFACT_CSP = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  'https://esm.sh https://cdn.tailwindcss.com https://cdnjs.cloudflare.com',
  'https://unpkg.com https://cdn.jsdelivr.net',
  'https://fonts.googleapis.com https://fonts.gstatic.com;',
  "connect-src 'self' https://esm.sh;",
  "img-src * data: blob:",
].join(' ');

// Artifact hardening headers, set before any object body is streamed.
const ARTIFACT_HEADERS = {
  'Content-Security-Policy': ARTIFACT_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

// The dashboard is the one page that carries the admin session, so it gets its own policy:
// same-origin everything, Google Fonts (the only third party it loads), inline style/script
// because there is no build step, and no framing at all. X-Frame-Options repeats
// frame-ancestors for browsers that predate it.
const APP_CSP = [
  "default-src 'self';",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;",
  "font-src 'self' https://fonts.gstatic.com;",
  "script-src 'self' 'unsafe-inline';",
  "img-src 'self' data:;",
  "connect-src 'self';",
  "frame-src 'none';",
  "object-src 'none';",
  "base-uri 'none';",
  "form-action 'self';",
  "frame-ancestors 'none';",
].join(' ');

const APP_HEADERS = {
  'Content-Security-Policy': APP_CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// Strict extension -> MIME map covering every extension the zip validator allows
// (ZIP_ALLOWED_EXT) plus inline outputs. The app owns Content-Type — it is never sniffed
// nor taken from a backend's stored metadata. An unknown extension serves as
// application/octet-stream, never text/html, so an unexpected file can't be made to execute.
const EXT_MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8', csv: 'text/csv; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm',
  pdf: 'application/pdf', wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
};

function mimeForKey(key) {
  const ext = path.posix.extname(key).slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

// Parse a single HTTP byte-range against a known size. Returns { start, end }, or null when
// there is no Range header, or 'invalid' (=> 416). Range: is attacker-controlled on the
// unauthenticated read path, so bounds are validated and multi-range is refused.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, rawStart, rawEnd] = m;
  let start;
  let end;
  if (rawStart === '') {
    if (rawEnd === '') return 'invalid';
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'invalid';
  if (start < 0 || start > end || start >= size) return 'invalid';
  if (end >= size) end = size - 1;
  return { start, end };
}

// Pipe a storage stream with a hardened error contract: once the first byte is sent the
// status/headers are flushed and immutable, so an upstream error must ABORT the socket
// (res.destroy) — never res.end(), which would pass a truncated artifact off as complete.
function pipeStream(req, res, stream) {
  stream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    // A read that passed the stat can still miss when the open happens: local checks the file
    // and then opens it, so a write that landed in between took the object away. That is the
    // same "not there" the stat catches, and the rename path has always answered it as a 404,
    // so it answers 404 here too rather than the 500 a real read error gets.
    const gone = err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
    if (gone) return missing(req, res);
    res.status(500).type('text/plain').send('internal error');
  });
  stream.pipe(res);
}

// Serve one storage object as an artifact response. The route has already validated meta
// and set ARTIFACT_HEADERS. serveObject owns Content-Type (the app's strict map, or an
// absolute forceType override used by /source) and Range. It never throws — an unsafe key
// (only reachable via user-controlled zip sub-paths) or a missing object becomes a 404.
async function serveObject(req, res, key, { forceType } = {}) {
  const contentType = forceType || mimeForKey(key);
  try {
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const info = await storage.head(key);
      if (!info) return missing(req, res);
      const range = parseRange(rangeHeader, info.size);
      if (range === 'invalid') {
        return res.status(416).set('Content-Range', `bytes */${info.size}`).end();
      }
      if (range) {
        const got = await storage.get(key, { range });
        if (!got) return missing(req, res);
        res.status(206).set({
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
          'Content-Length': String(range.end - range.start + 1),
        });
        return pipeStream(req, res, got.stream);
      }
    }
    const got = await storage.get(key);
    if (!got) return missing(req, res);
    res.status(200).set({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    if (got.size != null) res.set('Content-Length', String(got.size));
    pipeStream(req, res, got.stream);
  } catch (err) {
    if (err instanceof UnsafeKeyError) {
      if (!res.headersSent) missing(req, res);
      return;
    }
    if (!res.headersSent) res.status(500).type('text/plain').send('internal error');
    else res.destroy();
  }
}

// A zip site may ship its own `404.html`; a miss anywhere under /a/:slug/ serves that page
// with a real 404 status, so a static-site build's not-found page works the way it does on
// every other host. No 404.html in the zip: the plain-text miss serveObject would have sent.
// The caller has already set ARTIFACT_HEADERS, so the page runs under the same CSP as the
// rest of the site.
async function serveSiteNotFound(req, res, slug) {
  const got = await storage.get(`${slug}/site/404.html`).catch(() => null);
  if (!got) return missing(req, res);
  res.status(404).set({ 'Content-Type': 'text/html; charset=utf-8' });
  if (got.size != null) res.set('Content-Length', String(got.size));
  pipeStream(req, res, got.stream);
}

// The frame wrapper is our own page: inline styles/script + a same-origin iframe.
// frame-ancestors 'none' is safe here even though artifacts are embeddable: an iframe load
// carries Sec-Fetch-Dest: iframe, which the /a/:slug handler serves raw, so an embedder
// never gets this wrapper. It does stop the password prompt (same CSP) from being framed
// and clickjacked. object-src/base-uri close the usual injected-tag escapes.
const FRAME_CSP = [
  "default-src 'self';",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;",
  "font-src 'self' https://fonts.gstatic.com;",
  "script-src 'self' 'unsafe-inline';",
  "img-src 'self' data:;",
  "frame-src 'self';",
  "object-src 'none';",
  "base-uri 'none';",
  "form-action 'self';",
  "frame-ancestors 'none';",
].join(' ');

// Capability-link exchange: a valid ?k=<token> sets the slug-scoped unlock cookie, then
// 302s to the same path with only `k` stripped (raw and the deep zip path preserved), so
// the token leaves the address bar after first load. Runs before the /a routes below,
// hence ahead of the zip trailing-slash redirect and the frame branch. Invalid/absent
// token: fall through and let the normal gate decide (a bad token never 200s or leaks).
app.use('/a/:slug', async (req, res, next) => {
  try {
    const token = typeof req.query.k === 'string' ? req.query.k : '';
    if (!token) return next();
    const { slug } = req.params;
    const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
    if (!meta || meta.disabled || isExpired(meta)) return next(); // don't leak; normal gate 404s
    if (meta.visibility !== 'private' && meta.visibility !== 'password') return next(); // public: k is meaningless
    if (!verifyCapToken(token, slug, metaEpoch(meta))) return next(); // bad token → gate handles it
    const p = verifySession(token, auth.sessionSecret);
    await issueUnlock(res, meta, typeof p.exp === 'number' ? p.exp : undefined);
    // Rebuild the URL without `k`, preserving everything else and the (zip) path.
    const url = new URL(req.originalUrl, BASE_URL);
    url.searchParams.delete('k');
    res.set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, url.pathname + url.search);
  } catch (err) {
    next(err);
  }
});

app.get('/a/:slug', async (req, res) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) return notFound(res);
  // Expiry is 410 only once the caller has proved access; otherwise a 404 like any other
  // miss, so expiry does not become an existence oracle for a locked artifact.
  if (isExpired(meta)) {
    // Same Accept split as every other dead end. This route sent plain text on origin/main and
    // was changed to always send the card, which put 3 kB of HTML in front of curl, fetch() and
    // every embed that had been reading one line.
    return artifactUnlocked(req, meta) ? expiredFor(req, res) : notFound(res);
  }
  // Visibility gate. password → the unlock prompt (401) until a valid unlock cookie is
  // present. private with no valid cookie → a flat 404 identical to a missing artifact
  // (no prompt, no existence leak). Runs before the frame/raw/zip branches so no view
  // path (?raw=1, zip index) leaks the body.
  if (!artifactUnlocked(req, meta)) {
    if (meta.visibility === 'password') {
      res.set({
        'Content-Security-Policy': FRAME_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
      });
      return res.status(401).type('html').send(buildPromptHtml(meta));
    }
    return notFound(res);
  }
  // A redirect artifact is the Location header, so it runs before the frame and raw
  // branches: there is no body to wrap in a toolbar and no bare version to link to.
  // 301 is the honest status for a slug that exists to point somewhere else. A browser
  // would normally pin a 301 for good, which would strand every visitor on the old target
  // after a PUT, so no-store is what keeps repointing the slug working. Crawlers do not
  // follow it either way: the whole domain answers X-Robots-Tag: noindex, nofollow.
  if (meta.type === 'redirect') {
    // meta decides where this goes, with source.url as the fallback for a redirect published
    // before meta carried a target. The value comes back parsed, so a scheme this build refuses
    // never reaches a Location header whatever is on disk. See lib/redirect.js.
    const target = await resolveRedirectTarget({ meta, readSource: () => storage.getBuffer(`${slug}/source.url`) });
    if (target === null) return notFound(res);
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    return res.redirect(301, target);
  }

  // Framed view: serve the wrapper page (toolbar + iframe → ?raw=1). `?raw=1`
  // is the escape hatch the iframe uses to load the bare artifact.
  // A sub-frame load (the toolbar iframe, and any navigation the user makes inside it) carries
  // Sec-Fetch-Dest: iframe. Treat those as raw so an in-artifact link back to the root does not
  // re-enter the frame branch and stack a second toolbar. Top-level visits still get the frame.
  const wantsRaw = req.query.raw !== undefined || req.get('sec-fetch-dest') === 'iframe';
  if (frameActive(meta) && !wantsRaw) {
    if (meta.type === 'zip' && !req.path.endsWith('/')) {
      return res.redirect(301, `/a/${slug}/`);
    }
    const rawUrl = meta.type === 'zip' ? `/a/${slug}/?raw=1` : `/a/${slug}?raw=1`;
    res.set({
      'Content-Security-Policy': FRAME_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
    return res.type('html').send(buildFrameHtml(meta, rawUrl));
  }

  res.set(ARTIFACT_HEADERS);
  if (meta.type === 'zip') {
    // Trailing slash so relative asset URLs resolve inside the site; keep ?raw=1
    // so a slash-less raw URL doesn't bounce back into the frame.
    if (!req.path.endsWith('/')) {
      return res.redirect(301, `/a/${slug}/${wantsRaw ? '?raw=1' : ''}`);
    }
    return serveObject(req, res, `${slug}/site/index.html`);
  }
  if (meta.type === 'md') {
    const buf = await storage.getBuffer(`${slug}/source.md`);
    if (!buf) return notFound(res);
    res.set('Cache-Control', 'no-cache'); // reflect global config changes on next view
    return res.type('html').send(renderMd(slug, meta, buf.toString('utf8'), config.current.md));
  }
  if (meta.type === 'pdf') {
    // The viewer page, not the file. The bytes live one path down at /a/<slug>/file.pdf,
    // which is what the shell's <object> loads and what a direct link points at.
    if (!(await storage.head(`${slug}/source.pdf`).catch(() => null))) return notFound(res);
    res.set('Cache-Control', 'no-cache'); // the page reflects a settings change on next view
    return res.type('html').send(buildPdfHtml(meta));
  }
  serveObject(req, res, `${slug}/index.html`);
});

app.get('/a/:slug/source', async (req, res, next) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) return notFound(res);
  // Unlock before expiry so a locked artifact yields the canonical 404, never a 410 that
  // would leak existence.
  if (!artifactUnlocked(req, meta)) return notFound(res);
  if (isExpired(meta)) return expiredFor(req, res);
  if (meta.type === 'zip') return next(); // zip sites serve /source as a site path
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  // A redirect's "source" is its target, and the docs say so, so it answers with the same value
  // the 301 uses rather than the stored bytes. Streaming the body here let /source name one
  // destination while the Location header sent visitors to another.
  if (meta.type === 'redirect') {
    const target = await resolveRedirectTarget({ meta, readSource: () => storage.getBuffer(`${slug}/source.url`) });
    if (target === null) return notFound(res);
    return res.type('text/plain; charset=utf-8').send(target);
  }
  // A pdf's source is the file that was uploaded, so it answers with the PDF itself rather
  // than the text/plain every other type gets. As an attachment: the point of /source is to
  // hand the bytes over, and Content-Disposition also keeps the response from being rendered
  // by a plugin on the artifact origin.
  if (meta.type === 'pdf') {
    // The full artifact headers, not the two set above: this is the one /source that is served
    // as its own type rather than forced to text/plain, so it gets the same policy the file
    // route gets. The two above are a subset of them.
    res.set(ARTIFACT_HEADERS);
    res.set('Content-Disposition', `attachment; filename="${pdfDownloadName(meta)}"`);
    return serveObject(req, res, `${slug}/source.pdf`);
  }
  // meta.type comes off disk unvalidated, and a bare SOURCE_EXT lookup walks the prototype, so a
  // hand-edited "constructor" built a key out of a function body. Same guard ownedKeys uses.
  if (!Object.hasOwn(SOURCE_EXT, meta.type)) return notFound(res);
  // forceType keeps source inert: an HTML/JSX source is served as text/plain, never executed.
  serveObject(req, res, `${slug}/source.${SOURCE_EXT[meta.type]}`, {
    forceType: 'text/plain; charset=utf-8',
  });
});

app.get('/a/:slug/*', async (req, res) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) return notFound(res);
  if (!artifactUnlocked(req, meta)) return notFound(res);
  if (isExpired(meta)) return expiredFor(req, res);
  // A pdf artifact owns one sub-path: the file its viewer loads. `?download=1` sends the same
  // bytes as an attachment, which is the direct-download link the viewer's Download button and
  // anything else that wants the file point at.
  if (meta.type === 'pdf') {
    if (req.params[0] !== 'file.pdf') return notFound(res);
    res.set(ARTIFACT_HEADERS);
    if (wantsPdfDownload(req.query.download)) {
      res.set('Content-Disposition', `attachment; filename="${pdfDownloadName(meta)}"`);
    }
    return serveObject(req, res, `${slug}/source.pdf`);
  }
  if (meta.type !== 'zip') return notFound(res);
  res.set(ARTIFACT_HEADERS);

  const rel = req.params[0];
  // Directory -> index.html: object stores have no directories, so try the path, then fall
  // back to <path>/index.html. The storage key guard (assertSafeKey) rejects any traversal.
  let key = `${slug}/site/${rel}`;
  if (rel === '' || rel.endsWith('/')) {
    key = `${slug}/site/${rel}index.html`;
    if (!(await storage.head(key).catch(() => null))) return serveSiteNotFound(req, res, slug);
  } else if (!(await storage.head(key).catch(() => null))) {
    const alt = `${slug}/site/${rel}/index.html`;
    if (await storage.head(alt).catch(() => null)) key = alt;
    else return serveSiteNotFound(req, res, slug);
  }
  serveObject(req, res, key);
});

// Verify the unlock password and set the per-slug unlock cookie. 'password' mode only —
// 'private' is viewed via a capability link (?k=), never a password. Rate-limited per
// IP+slug (10 failures/hour) so it is not an unthrottled brute-force channel.
app.post('/a/:slug/unlock', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const ip = clientIp(req);
    const rlKey = `${ip}:${slug}`;
    const gate = unlockLimiter.check(rlKey);
    if (gate.limited) {
      logAuth('unlock', { ip, slug, outcome: 'ratelimited' });
      res.set('Retry-After', String(gate.retryAfter));
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
    if (!meta || meta.disabled) return res.status(404).json({ error: 'not found' });
    const password = req.body?.password;
    if (meta.visibility !== 'password') {
      // private uses capability links, not passwords; public needs no unlock. Uniform 401
      // (not 400) so this route never distinguishes an artifact's mode to an attacker, and
      // the admin-credential brute-force channel is gone rather than merely throttled.
      unlockLimiter.fail(rlKey);
      logAuth('unlock', { ip, slug, outcome: 'reject' });
      return res.status(401).json({ error: 'incorrect password' });
    }
    const ok = await verifyPassword(password, meta.password);
    if (!ok) {
      unlockLimiter.fail(rlKey);
      logAuth('unlock', { ip, slug, outcome: 'fail' });
      return res.status(401).json({ error: 'incorrect password' });
    }
    // Expiry is checked here rather than above the visibility branch. The 404/401 pair over
    // this route is deliberately uniform (see the comment on that branch), and a 410 handed
    // out before the password is proven told an anonymous caller the slug exists. The two GET
    // paths already order it this way; this one did not.
    if (isExpired(meta)) return res.status(410).json({ error: 'expired' });
    await issueUnlock(res, meta);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/artifacts', requireAuth('publish'), async (req, res, next) => {
  try {
    res.status(201).json(await saveArtifact(req.body, { keyId: req.principal.keyId }));
  } catch (err) {
    next(err);
  }
});

const zipBody = express.raw({
  type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
  limit: '50mb',
});

app.post('/api/artifacts/zip', requireAuth('publish'), zipBody, async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      throw new ApiError(400, 'raw zip body required (Content-Type: application/zip)');
    }
    const { slug, title, description, ogImage, expiresAt, tags, project, visibility, password } = req.query;
    res.status(201).json(await saveZipArtifact(req.body, { slug, title, description, ogImage, expiresAt, tags, project, visibility, password }));
  } catch (err) {
    next(err);
  }
});

app.put('/api/artifacts/:slug', requireAuth('publish'), async (req, res, next) => {
  try {
    res.json(await saveArtifact({ ...req.body, slug: req.params.slug }, { replace: true, keyId: req.principal.keyId }));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/artifacts/:slug', requireAuth('publish'), async (req, res, next) => {
  try {
    res.json(await patchArtifact(req.params.slug, req.body));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/artifacts/:slug', requireAuth('full'), async (req, res, next) => {
  try {
    await deleteArtifact(req.params.slug);
    res.json({ deleted: req.params.slug });
  } catch (err) {
    next(err);
  }
});

// Mint a fresh shareable link without mutating the artifact. The dashboard calls this to
// copy a private/password link on demand, so tokens are never embedded in list rows (which
// would write them into logs on every dashboard load).
app.get('/api/artifacts/:slug/link', requireAuth('read'), async (req, res, next) => {
  try {
    const meta = SLUG_RE.test(req.params.slug) ? await readMeta(req.params.slug) : null;
    if (!meta) throw new ApiError(404, `slug "${req.params.slug}" not found`);
    // A lapsed artifact mints nothing. Every serve path answers 410 or 404 for it, so a token
    // handed out here is a link the operator believes works and the recipient cannot open.
    if (isExpired(meta)) throw new ApiError(410, 'artifact expired');
    if (meta.tokenEpoch !== undefined) await ensureSessionSecret();
    res.json({ url: tokenedUrl(meta), visibility: meta.visibility || 'public' });
  } catch (err) {
    next(err);
  }
});

// A QR code for the artifact's canonical URL. Canonical, not the share link: a capability
// token expires and can be revoked, and a printed code cannot be reissued, so a QR that
// carries one turns into a dead sticker. A non-public artifact still needs its link or its
// password after the scan; the QR only gets the visitor to the door.
app.get('/api/artifacts/:slug/qr', requireAuth('read'), async (req, res, next) => {
  try {
    const { slug } = req.params;
    const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
    if (!meta) throw new ApiError(404, `slug "${slug}" not found`);

    const raw = req.query.format;
    const format = raw === undefined || raw === '' ? 'svg' : raw;
    if (format !== 'svg' && format !== 'png') {
      throw new ApiError(400, 'format must be svg or png');
    }
    // Scale tops out at 16, not at whatever a caller asks for. Rasterizing and deflating a
    // PNG is the only synchronous CPU on a read-scope route, and it grows with the square of
    // the scale: at 40 with the widest margin one request blocks the loop for about 20ms,
    // which a burst turns into a stalled server. 16 covers print (a 41-module code lands at
    // roughly 900px) and costs a tenth of that.
    const scale = intParam(req.query.scale, 8, 1, 16, 'scale');
    const margin = intParam(req.query.margin, 4, 0, 8, 'margin');

    const url = canonicalUrl(meta);
    // This is the first /api route to answer with a document type a browser can execute, so
    // it says so: nothing to load, no scripts, no sniffing to another type.
    res.set({
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    if (format === 'png') {
      const png = qrPng(url, { scale, margin });
      res.set({ 'Content-Type': 'image/png', 'Content-Disposition': `inline; filename="${slug}.png"` });
      return res.send(png);
    }
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': `inline; filename="${slug}.svg"` });
    return res.send(qrSvg(url, { scale, margin }));
  } catch (err) {
    next(err);
  }
});

app.post('/api/artifacts/:slug/duplicate', requireAuth('publish'), async (req, res, next) => {
  try {
    res.status(201).json(await duplicateArtifact(req.params.slug, req.body, { keyId: req.principal.keyId }));
  } catch (err) {
    next(err);
  }
});

app.get('/api/artifacts', requireAuth('read'), async (req, res, next) => {
  try {
    const { tag, project } = req.query;
    const opts = {};
    if (typeof tag === 'string' && tag !== '') opts.tag = tag;
    if (typeof project === 'string' && project !== '') opts.project = project;
    res.json(await listArtifacts(opts));
  } catch (err) {
    next(err);
  }
});

// baseUrl rides along because the dashboard cannot derive it: the origin it was opened on is
// not always the BASE_URL artifact links are built from (a reverse proxy, an IP instead of the
// hostname). Reading it here keeps the QR dialog from calling /link, which would mint a
// capability token just to print a URL. It is not config: PUT ignores it.
app.get('/api/config', requireAuth('read'), (req, res) => {
  res.json({ ...config.current, baseUrl: BASE_URL });
});

app.put('/api/config', requireAuth('full'), async (req, res, next) => {
  try {
    const saved = await config.update(req.body);
    // The dashboard shell is cached with the branding already filled in, so a save has to drop
    // it or the console keeps serving the old name, logo and accent until a restart.
    dropDashboardCache();
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Auth — admin session (dashboard) + managed API keys (CLI / MCP)
// ---------------------------------------------------------------------------

// 10 failed logins / 15 min per client IP; 10 failed unlocks / hour per IP+slug.
// Failures only — a correct password never consumes budget. Edge (Cloudflare) is the
// primary limiter; this is defense-in-depth for the two unauthenticated scrypt routes.
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const unlockLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

// Drives the dashboard's first-run vs login screen. Unauthenticated by design.
app.get('/api/auth/session', (req, res) => {
  res.json({ authenticated: !!sessionPrincipal(req), needsSetup: !auth.admin });
});

// One-time admin creation: allowed only while no admin exists.
app.post('/api/auth/setup', async (req, res, next) => {
  try {
    if (auth.admin) throw new ApiError(409, 'admin account already exists');
    const { username, password } = req.body || {};
    validateCredentials(username, password);
    const admin = { username, ...(await hashPassword(password)) };
    await update((a) => {
      // Checked again against the stored record: hashing takes ~100ms, and on a fleet another
      // replica can be claimed inside that window.
      if (a.admin) throw new ApiError(409, 'admin account already exists');
      a.admin = admin;
    });
    await ensureSessionSecret();
    await issueSession(res, username);
    // Whoever reaches an instance with no admin yet claims it. Log it so a takeover during
    // that window is visible in the same stream as the login and unlock events.
    logAuth('setup', { ip: clientIp(req), username, outcome: 'ok' });
    res.status(201).json({ username });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const ip = clientIp(req);
    const gate = loginLimiter.check(ip);
    if (gate.limited) {
      logAuth('login', { ip, outcome: 'ratelimited' });
      res.set('Retry-After', String(gate.retryAfter));
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    const { username, password } = req.body || {};
    // Hash against the decoy when the username does not match, so a wrong username and a
    // wrong password cost the same. `matched` still decides the outcome.
    const matched = !!auth.admin && auth.admin.username === username;
    const ok = await verifyPassword(password, matched ? auth.admin : DECOY_ADMIN);
    if (!matched || !ok) {
      loginLimiter.fail(ip);
      logAuth('login', { ip, username: typeof username === 'string' ? username : null, outcome: 'fail' });
      throw new ApiError(401, 'invalid credentials');
    }
    await issueSession(res, username);
    res.json({ username });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    // Clearing the cookie only tells one browser to forget it. The token is a signed payload
    // with a 30 day exp and no server-side record, so every copy taken off a shared machine, a
    // backup or a proxy log stays an admin credential until it lapses. Rotating adminSecret is
    // the same eviction the password route does, and this account is single-admin, so signing
    // every device out is the whole set of sessions the operator has.
    //
    // Only a caller already holding a live session triggers the rotation. An anonymous POST
    // still answers 200 and writes nothing, so the route cannot be used to sign the operator
    // out, and a browser whose cookie already lapsed keeps getting the answer it expects.
    if (sessionPrincipal(req)) {
      const rotated = crypto.randomBytes(32).toString('hex');
      await update((a) => {
        a.adminSecret = rotated;
      });
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/password', requireSession, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    validatePassword(newPassword);
    const hashed = await hashPassword(newPassword);
    // Changing the password is how an admin responds to a suspected stolen cookie, so it
    // has to actually evict one. Rotating adminSecret invalidates every admin session,
    // then the caller gets a fresh cookie so the browser they are sitting at stays signed
    // in. Capability links keep working — those are signed with sessionSecret.
    const rotated = crypto.randomBytes(32).toString('hex');
    await update(async (a) => {
      if (!a.admin) throw new ApiError(409, 'no admin account');
      // The current password is checked against the stored record, not this process's cached
      // copy. On a fleet the cache can be a password change old, and accepting a superseded
      // password here would let it set a new one.
      if (!(await verifyPassword(currentPassword, a.admin))) {
        throw new ApiError(401, 'current password incorrect');
      }
      a.admin = { username: a.admin.username, ...hashed };
      a.adminSecret = rotated;
    });
    await issueSession(res, auth.admin.username);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Managed API keys — admin session or bootstrap admin bearer only.
app.get('/api/keys', requireAdmin, async (req, res, next) => {
  try {
    // An entry with no id (a null or a bare string left by a hand edit) cannot be addressed by
    // PATCH or DELETE, so listing it would draw a row whose buttons do nothing. Those are named
    // by position in the boot warning instead. Everything else lists, broken records included,
    // because this is the screen the operator revokes them from.
    const rows = auth.keys.filter((k) => k && typeof k === 'object' && typeof k.id === 'string');
    // How many redirects each key has published. A leaked publish-scoped key that has started
    // minting phishing hops shows as a count that does not match what the key is for, which is
    // the knob a self-hoster asked for. Counted on read rather than kept as a running total on
    // the record: a delete would leave a stored counter high forever, and this is an admin
    // route that already costs a full read of the artifact list one screen over.
    const redirects = countRedirectsByKey(await listArtifactMetas());
    res.json(rows.map((k) => ({ ...publicKey(k), redirects: redirects.get(k.id) || 0 })));
  } catch (err) {
    next(err);
  }
});

app.post('/api/keys', requireAdmin, async (req, res, next) => {
  try {
    const { name, scopes, expiresAt } = req.body || {};
    const parsed = parseKeyInput(name, scopes, expiresAt);
    const token = 'ah_' + crypto.randomBytes(24).toString('hex');
    const record = {
      id: nanoid(),
      name: parsed.name,
      hash: hashKey(token),
      prefix: token.slice(0, 11), // 'ah_' + first 8 hex chars, for display
      scopes: parsed.scopes,
      createdAt: new Date().toISOString(),
      expiresAt: parsed.expiresAt,
      lastUsedAt: null,
      disabled: false,
    };
    await update((a) => {
      a.keys.push(record);
    });
    // The full token is shown once, here, and never stored in the clear. `redirects: 0` is
    // there so this row has the same shape as a row from GET /api/keys, which the dashboard
    // and the CLI both drop straight into their list without a second fetch.
    res.status(201).json({ ...publicKey(record), redirects: 0, key: token });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/keys/:id', requireAdmin, async (req, res, next) => {
  try {
    // k?.id, not k.id: a null or string entry in the array throws on property access and takes
    // the whole route down with a 500, whichever key is being patched.
    const updated = await update((a) => {
      const key = a.keys.find((k) => k?.id === req.params.id);
      if (!key) throw new ApiError(404, 'key not found');
      if (typeof req.body?.disabled === 'boolean') key.disabled = req.body.disabled;
      return publicKey(key);
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/keys/:id', requireAdmin, async (req, res, next) => {
  try {
    await update((a) => {
      const idx = a.keys.findIndex((k) => k?.id === req.params.id);
      if (idx === -1) throw new ApiError(404, 'key not found');
      a.keys.splice(idx, 1);
    });
    res.json({ deleted: req.params.id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// MCP (streamable HTTP, stateless)
// ---------------------------------------------------------------------------

// `keyId` names the managed key that authenticated /mcp, so a redirect published through a
// tool is counted against the same key a REST publish would be. Null for the bootstrap key.
function createMcpServer(scopes = SCOPES, keyId = null) {
  const server = new McpServer({ name: 'artifacts-host', version: VERSION });

  // Per-tool scope gate — the key that authenticated /mcp carries a scope; a
  // read-only key can list but not mutate, delete needs full. A thrown Error
  // surfaces to the client as the tool-call error.
  const requireScope = (needed) => {
    if (!hasScope(scopes, needed)) {
      throw new Error(`this API key lacks the "${needed}" scope required for this tool`);
    }
  };

  server.registerTool(
    'publish_artifact',
    {
      title: 'Publish artifact',
      description:
        'Publish an HTML, JSX/TSX (single React component with default export), or Markdown artifact. Returns the share URL: bare for public, or a ?k= capability link for private and password, which opens the artifact on its own. Omit slug for a random unguessable one. type "redirect" instead publishes a short link: content is the absolute http(s) target, and the URL answers 301 once the visibility gate has let the request through. type "pdf" takes base64 bytes in content; prefer the CLI or the REST endpoint for that, because a multi-megabyte base64 string fills your context with nothing you can read.',
      inputSchema: {
        content: z.string().describe('Full source of the artifact, the target URL when type is "redirect", or base64-encoded bytes when type is "pdf"'),
        type: z.enum(['html', 'jsx', 'tsx', 'md', 'pdf', 'redirect']).default('html'),
        slug: z
          .string()
          .optional()
          .describe('Custom URL slug: 3-64 chars of [a-z0-9-], starting with a letter or digit'),
        title: z.string().optional(),
        description: z
          .string()
          .optional()
          .describe('One-line summary for a link preview (max 300 chars). Rendered into the head of the viewer frame and of a md artifact, never into the author\'s own HTML'),
        ogImage: z
          .string()
          .optional()
          .describe('Absolute http(s) URL of the preview image (og:image). Another artifact URL works; a relative path does not, because the unfurler fetches it on its own'),
        expiresAt: z
          .string()
          .optional()
          .describe('ISO 8601 datetime after which the URL stops serving (410)'),
        frame: z
          .boolean()
          .optional()
          .describe('Show the top viewer frame for this artifact, overriding the server default. Ignored while the server has frames switched off'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags for organizing artifacts: 1-32 chars each of [a-z0-9-], starting with a letter or digit, max 10. Stored lowercased and deduped'),
        project: z
          .string()
          .optional()
          .describe('Project this artifact belongs to (single grouping label): 1 to 64 chars of letters, digits, spaces, and - _ . (starting with a letter or digit)'),
        visibility: z
          .enum(['public', 'private', 'password'])
          .optional()
          .describe('private (the default: opens through the returned ?k= link, for anyone holding it), public (anyone with the bare link), or password (the bare link prompts for the shared password, but the ?k= link returned here skips that prompt)'),
        password: z
          .string()
          .optional()
          .describe('Shared view password; required when visibility is "password"'),
      },
    },
    async (args) => {
      requireScope('publish');
      const { url } = await saveArtifact(args, { keyId });
      return { content: [{ type: 'text', text: url }] };
    },
  );

  server.registerTool(
    'update_artifact',
    {
      title: 'Update artifact',
      description:
        'Rewrite an existing artifact by slug. Only type resets when omitted: it becomes html, and changing the type deletes the files the old type owned, so pass it on every update of a jsx, tsx, md, pdf or redirect artifact. A pdf refuses the update outright when type is omitted, because its bytes cannot be rebuilt from a reply. Every other field, title included, keeps its current value. Returns the share URL, tokened for private and password artifacts.',
      inputSchema: {
        slug: z.string(),
        content: z.string(),
        // Optional rather than .default('html') the way publish_artifact has it: a default is
        // filled in by the schema, so the server could not tell "type omitted" from "type
        // html", and a pdf rewrote itself as HTML with its bytes deleted before anything got
        // to refuse. Omitted still means html for every other type.
        type: z
          .enum(['html', 'jsx', 'tsx', 'md', 'pdf', 'redirect'])
          .optional()
          .describe('Omit and the artifact is rewritten as html, deleting the files the old type owned. A pdf refuses the call instead, because its bytes cannot be rebuilt from a reply'),
        title: z.string().optional(),
        description: z
          .string()
          .optional()
          .describe('Link-preview summary (max 300 chars); omit to keep the current one, pass "" to clear it'),
        ogImage: z
          .string()
          .optional()
          .describe('Absolute http(s) URL of the preview image; omit to keep the current one, pass "" to clear it'),
        frame: z
          .boolean()
          .optional()
          .describe('Show the top viewer frame for this artifact, overriding the server default. Ignored while the server has frames switched off'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Replaces all tags when provided; omit to keep existing tags'),
        project: z
          .string()
          .optional()
          .describe('Project this artifact belongs to; omit to keep the existing project'),
        visibility: z
          .enum(['public', 'private', 'password'])
          .optional()
          .describe('Change access level; omit to keep the current visibility'),
        password: z
          .string()
          .optional()
          .describe('Set/rotate the shared password; required when changing visibility to "password"'),
      },
    },
    async (args) => {
      requireScope('publish');
      const { url } = await saveArtifact(args, { replace: true, keyId });
      return { content: [{ type: 'text', text: url }] };
    },
  );

  server.registerTool(
    'rename_artifact',
    {
      title: 'Rename artifact',
      description:
        'Change the URL slug of an existing artifact. Returns the new share URL, tokened for private and password artifacts. The old slug stops serving, and any link already handed out with it dies with it.',
      inputSchema: {
        slug: z.string().describe('Current slug'),
        newSlug: z
          .string()
          .describe('New URL slug: 3-64 chars of [a-z0-9-], starting with a letter or digit'),
      },
    },
    async ({ slug, newSlug }) => {
      requireScope('publish');
      const { url } = await patchArtifact(slug, { slug: newSlug });
      return { content: [{ type: 'text', text: url }] };
    },
  );

  server.registerTool(
    'set_artifact_expiry',
    {
      title: 'Set artifact expiry',
      description:
        'Set or clear the expiry of an artifact. After expiry the URL returns 410 but the content is kept.',
      inputSchema: {
        slug: z.string(),
        expiresAt: z
          .string()
          .nullable()
          .describe('ISO 8601 datetime, or null to clear the expiry'),
      },
    },
    async ({ slug, expiresAt }) => {
      requireScope('publish');
      await patchArtifact(slug, { expiresAt });
      const text = expiresAt ? `${slug} expires ${expiresAt}` : `expiry cleared for ${slug}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'set_artifact_tags',
    {
      title: 'Set artifact tags',
      description:
        'Replace the tags of an artifact. Tags are 1-32 chars each of [a-z0-9-], starting with a letter or digit, max 10, stored lowercased and deduped. An empty array clears all tags.',
      inputSchema: {
        slug: z.string(),
        tags: z.array(z.string()).describe('Full tag list; empty array clears'),
      },
    },
    async ({ slug, tags }) => {
      requireScope('publish');
      await patchArtifact(slug, { tags });
      const text = tags.length ? `${slug} tagged: ${tags.join(', ')}` : `tags cleared for ${slug}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'set_artifact_project',
    {
      title: 'Set artifact project',
      description:
        'Set or clear the project an artifact belongs to. Projects group artifacts in the web UI. An empty string clears it.',
      inputSchema: {
        slug: z.string(),
        project: z
          .string()
          .describe('Project name: 1 to 64 chars of letters, digits, spaces, and - _ . (starting with a letter or digit). Empty string clears it'),
      },
    },
    async ({ slug, project }) => {
      requireScope('publish');
      await patchArtifact(slug, { project });
      const text = project.trim() ? `${slug} → project “${project.trim()}”` : `project cleared for ${slug}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'set_artifact_visibility',
    {
      title: 'Set artifact visibility',
      description:
        'Set an artifact to public (anyone with the bare link), private (opens through a ?k= link, for anyone holding it), or password (the bare link prompts for the shared password). Provide password when setting "password". Mint a ?k= link with GET /api/artifacts/<slug>/link; on a password artifact that link skips the prompt.',
      inputSchema: {
        slug: z.string(),
        visibility: z.enum(['public', 'private', 'password']),
        password: z
          .string()
          .optional()
          .describe('Required when setting visibility to "password"; also rotates an existing one'),
      },
    },
    async ({ slug, visibility, password }) => {
      requireScope('publish');
      await patchArtifact(slug, { visibility, password });
      return { content: [{ type: 'text', text: `${slug} visibility → ${visibility}` }] };
    },
  );

  server.registerTool(
    'disable_artifact',
    {
      title: 'Disable artifact',
      description:
        'Disable an artifact: its public URL returns 404 but the content is kept. Re-enable with enable_artifact.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      requireScope('publish');
      await patchArtifact(slug, { disabled: true });
      return { content: [{ type: 'text', text: `disabled ${slug}` }] };
    },
  );

  server.registerTool(
    'enable_artifact',
    {
      title: 'Enable artifact',
      description: 'Re-enable a disabled artifact so its public URL serves again.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      requireScope('publish');
      await patchArtifact(slug, { disabled: false });
      return { content: [{ type: 'text', text: `enabled ${slug}` }] };
    },
  );

  server.registerTool(
    'set_artifact_frame',
    {
      title: 'Set artifact frame',
      description:
        'Control the top viewer frame for an artifact. Ignored while the server has frames switched off.',
      inputSchema: {
        slug: z.string(),
        frame: z
          .boolean()
          .nullable()
          .describe('true = framed, false = unframed, null = inherit the global default'),
      },
    },
    async ({ slug, frame }) => {
      requireScope('publish');
      await patchArtifact(slug, { frame });
      const text =
        frame === null ? `frame reset to default for ${slug}` : `frame ${frame ? 'on' : 'off'} for ${slug}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'list_artifacts',
    {
      title: 'List artifacts',
      description:
        'List all published artifacts. Each entry carries slug, type, title, createdAt, updatedAt, tags, and whichever of project, expiresAt, frame, visibility, disabled, files, target, description, ogImage and hasPassword the artifact has set. A public artifact has no visibility field at all. A redirect carries target, the URL its 301 points at, unless it was published before targets were stored on the artifact. description and ogImage are the link-preview fields. No passwords or tokens. Pass tag and/or project to filter.',
      inputSchema: {
        tag: z.string().optional().describe('Only return artifacts with this tag'),
        project: z.string().optional().describe('Only return artifacts in this project'),
      },
    },
    async ({ tag, project }) => {
      requireScope('read');
      const opts = {};
      if (tag) opts.tag = tag;
      if (project) opts.project = project;
      const items = await listArtifacts(opts);
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_artifact',
    {
      title: 'Delete artifact',
      description: 'Delete a published artifact by slug.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      requireScope('full');
      await deleteArtifact(slug);
      return { content: [{ type: 'text', text: `deleted ${slug}` }] };
    },
  );

  return server;
}

app.post('/mcp', requireApiKey('read'), async (req, res) => {
  try {
    const server = createMcpServer(req.principal.scopes, req.principal.keyId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal server error' },
        id: null,
      });
    }
  }
});

app.all('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'method not allowed' },
    id: null,
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

app.get('/favicon.ico', (req, res) => {
  const icon = dashboardFavicon(config.current.branding);
  if (!icon) return res.status(204).end();
  // no-cache, because a browser that cached the 204 or an old icon would otherwise sit on it
  // for the rest of the session after the operator changes the branding. nosniff because these
  // are operator-supplied bytes: DATA_IMAGE_RE already pins the type to one of four raster
  // formats, so nothing here is reachable, and the header costs nothing.
  res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (icon.redirect) return res.redirect(302, icon.redirect);
  res.type(icon.contentType).send(icon.body);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

// The dashboard shell with the branding filled in. 119 kB of template, refilled on every
// request when this landed, plus express's ETag hashing the result: measured 1.85 ms of the
// server's own time per unauthenticated GET /, where sendFile used to stream the file with a
// stat-based ETag. The fill only changes when the config does, so it is cached and dropped when
// the branding is saved.
let dashboardPageCache = null;
function dropDashboardCache() {
  dashboardPageCache = null;
}
function dashboardPage() {
  if (dashboardPageCache === null) {
    const html = fillShell(DASHBOARD_SHELL, dashboardBrandSlots(config.current.branding));
    // Set on the response below so express does not hash the body itself on every request. Same
    // value while the page is the same page, which is what an ETag is for.
    const tag = `W/"${crypto.createHash('sha1').update(html).digest('base64url')}"`;
    dashboardPageCache = { html, tag };
  }
  return dashboardPageCache;
}

app.get('/', (req, res) => {
  res.set(APP_HEADERS);
  // no-store rather than no-cache: this is the one page carrying the admin session, and the
  // reason no-cache was set here (a branding change showing on the next load) is served just as
  // well by not writing it to disk at all.
  res.set('Cache-Control', 'no-store');
  const page = dashboardPage();
  res.set('ETag', page.tag);
  res.type('html').send(page.html);
});

// Which errors get to name themselves lives in lib/errors.js so a test can hand it the shapes
// body-parser throws. A caller error is answered and not logged: a malformed body is a typo on
// the other end, and a stack trace per typo buries the logs that matter.
app.use((err, req, res, next) => {
  const answer = clientFacingError(err);
  if (answer) {
    // A storage call that ran out of time names how long to wait; nothing else here does.
    if (answer.retryAfter) res.set('Retry-After', String(answer.retryAfter));
    return res.status(answer.status).json({ error: answer.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`artifacts-host listening on :${PORT} (base url ${BASE_URL})`);
  if (TRUST_PROXY === 'none') {
    console.warn(
      'TRUST_PROXY=none: rate limits key on the socket address. Behind a proxy or ' +
        'tunnel (cloudflared), all clients share one bucket — set TRUST_PROXY=cloudflare.',
    );
  }
});
