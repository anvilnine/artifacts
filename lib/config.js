// Server config: global frame settings and markdown render defaults, stored
// through the storage backend. Routing config through storage keeps the global
// frame setting as durable as artifacts: it survives a fresh-container restart
// on the s3/git/postgres backends too.

import { ApiError } from './errors.js';

// A reserved root-level key (single segment, so it never collides with a slug
// (slugs forbid `.`) and is excluded from listMetas, which only matches
// `<slug>/meta.json`).
const CONFIG_KEY = 'config.json';

function boolEnv(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

const MD_FONTS  = ['system', 'serif', 'mono'];
const MD_WIDTHS = ['narrow', 'normal', 'wide'];
const MD_SIZES  = ['small', 'normal', 'large'];
const MD_THEMES = ['auto', 'light', 'dark'];

function enumEnv(name, allowed) {
  const v = process.env[name];
  return v !== undefined && allowed.includes(v) ? v : undefined;
}

// Matches createStorage: env is read when the store is built, not at import.
function defaultConfig() {
  return {
    frame: {
      enabled: boolEnv('FRAME_ENABLED') ?? true,
      default: boolEnv('FRAME_DEFAULT') ?? true,
    },
    md: {
      font:  enumEnv('MD_FONT', MD_FONTS)   ?? 'system',
      width: enumEnv('MD_WIDTH', MD_WIDTHS) ?? 'normal',
      size:  enumEnv('MD_SIZE', MD_SIZES)   ?? 'normal',
      theme: enumEnv('MD_THEME', MD_THEMES) ?? 'auto',
    },
  };
}

function normalizeConfig(raw) {
  const defaults = defaultConfig();
  const frame = raw?.frame || {};
  const md = raw?.md || {};
  const pick = (val, allowed, def) => (allowed.includes(val) ? val : def);
  return {
    frame: {
      enabled: typeof frame.enabled === 'boolean' ? frame.enabled : defaults.frame.enabled,
      default: typeof frame.default === 'boolean' ? frame.default : defaults.frame.default,
    },
    md: {
      font:  pick(md.font,  MD_FONTS,  defaults.md.font),
      width: pick(md.width, MD_WIDTHS, defaults.md.width),
      size:  pick(md.size,  MD_SIZES,  defaults.md.size),
      theme: pick(md.theme, MD_THEMES, defaults.md.theme),
    },
  };
}

// Read persisted config, or fall back to the env/defaults in memory. Defaults are NOT
// written back on boot: that would commit+push on the git backend every startup; the
// file is created only when an operator changes a setting via update().
async function loadConfig(storage) {
  const buf = await storage.getBuffer(CONFIG_KEY);
  if (!buf) return defaultConfig();
  try {
    return normalizeConfig(JSON.parse(buf.toString('utf8')));
  } catch {
    return defaultConfig();
  }
}

// The store owns the current value. Read it through `.current` at the point of
// use, not once at import time, so an update() is picked up by later reads.
export async function createConfigStore(storage) {
  let current = await loadConfig(storage);

  return {
    get current() {
      return current;
    },

    async update(patch) {
      const frame = patch?.frame || {};
      for (const key of ['enabled', 'default']) {
        if (frame[key] !== undefined && typeof frame[key] !== 'boolean') {
          throw new ApiError(400, `frame.${key} must be a boolean`);
        }
      }
      const md = patch?.md || {};
      const mdChecks = { font: MD_FONTS, width: MD_WIDTHS, size: MD_SIZES, theme: MD_THEMES };
      for (const [key, allowed] of Object.entries(mdChecks)) {
        if (md[key] !== undefined && !allowed.includes(md[key])) {
          throw new ApiError(400, `md.${key} must be one of ${allowed.join(', ')}`);
        }
      }
      current = {
        frame: {
          enabled: frame.enabled ?? current.frame.enabled,
          default: frame.default ?? current.frame.default,
        },
        md: {
          font:  md.font  ?? current.md.font,
          width: md.width ?? current.md.width,
          size:  md.size  ?? current.md.size,
          theme: md.theme ?? current.md.theme,
        },
      };
      await storage.put(CONFIG_KEY, JSON.stringify(current, null, 2), { contentType: 'application/json' });
      await storage.flush?.();
      return current;
    },
  };
}
