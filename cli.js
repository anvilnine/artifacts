#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import AdmZip from 'adm-zip';

import { sweepOrphans } from './lib/artifact-files.js';
import { artifactExpired } from './lib/expiry.js';
import { createStorage } from './storage/index.js';

const USAGE = `artifacts — publish to a self-hosted artifacts instance

Usage:
  artifacts publish <file> [--slug s] [--title t] [--tags a,b] [--project p] [--description d] [--og-image url] [--expires ISO] [--type html|jsx|tsx|md|pdf|redirect] [--frame on|off] [--visibility public|private|password] [--password pw]
  artifacts deploy <dir|zip> [--slug s] [--title t] [--tags a,b] [--project p] [--description d] [--og-image url] [--expires ISO] [--visibility public|private|password] [--password pw]
  artifacts update <slug> <file> [--title t] [--tags a,b] [--project p] [--description d] [--og-image url] [--type html|jsx|tsx|md|pdf|redirect]
  artifacts list [--tag t] [--project p]
  artifacts rename <slug> <new-slug>
  artifacts disable <slug>
  artifacts enable <slug>
  artifacts frame <slug> <on|off|default>
  artifacts pdf <slug> <standard|presentation|minimal|download-on|download-off|default>
  artifacts visibility <slug> <public|private|password> [--password pw]
  artifacts rotate <slug>
  artifacts expire <slug> <ISO-date|never>
  artifacts tag <slug> <a,b,c|none>
  artifacts project <slug> <name|none>
  artifacts preview <slug> [--description <d|none>] [--og-image <url|none>]
  artifacts delete <slug>
  artifacts source <slug> [-o file]
  artifacts qr <slug> [--png] [--scale n] [--margin n] [-o file]
  artifacts config [--frame-enabled true|false] [--frame-default true|false]
  artifacts keys list
  artifacts keys create <name> [--scopes read,publish,full] [--expires ISO]
  artifacts keys revoke <id>

Maintenance (runs on the server host against its own storage, not over HTTP):
  artifacts sweep [--apply]

Connection (flags override env):
  --url   server origin        [env: ARTIFACTS_URL]
  --key   API key              [env: ARTIFACTS_API_KEY]

The key can be a managed key (scoped) or the bootstrap ARTIFACTS_API_KEY.
Minting keys (keys create/list/revoke) requires the bootstrap admin key.`;

const EXT_TYPES = { '.html': 'html', '.htm': 'html', '.jsx': 'jsx', '.tsx': 'tsx', '.md': 'md', '.markdown': 'md', '.pdf': 'pdf' };

const { values: opts, positionals } = parseArgs({
  options: {
    url: { type: 'string' },
    key: { type: 'string' },
    slug: { type: 'string' },
    title: { type: 'string' },
    tags: { type: 'string' },
    tag: { type: 'string' },
    project: { type: 'string' },
    description: { type: 'string' },
    'og-image': { type: 'string' },
    expires: { type: 'string' },
    scopes: { type: 'string' },
    type: { type: 'string' },
    frame: { type: 'string' },
    visibility: { type: 'string' },
    password: { type: 'string' },
    'frame-enabled': { type: 'string' },
    'frame-default': { type: 'string' },
    output: { type: 'string', short: 'o' },
    apply: { type: 'boolean' },
    png: { type: 'boolean' },
    scale: { type: 'string' },
    margin: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

const [command, ...args] = positionals;

if (opts.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const url = (opts.url || process.env.ARTIFACTS_URL || '').replace(/\/$/, '');
const key = opts.key || process.env.ARTIFACTS_API_KEY;

// Every verb but `sweep` talks to a running instance. `sweep` opens the configured store
// directly, so it needs the server's env (DATA_DIR / STORAGE_BACKEND) and no URL at all.
if (!url && command !== 'sweep') fail('server URL required: pass --url or set ARTIFACTS_URL');

async function api(method, apiPath, { body, contentType, auth = true } = {}) {
  if (auth && !key) fail('API key required: pass --key or set ARTIFACTS_API_KEY');
  const headers = {};
  if (auth) headers.authorization = `Bearer ${key}`;
  if (contentType) headers['content-type'] = contentType;
  const res = await fetch(url + apiPath, { method, headers, body });
  const text = await res.text();
  if (!res.ok) fail(`${res.status} ${res.statusText}: ${text.trim()}`);
  return text;
}

async function apiJson(method, apiPath, body) {
  const text = await api(method, apiPath, {
    body: body === undefined ? undefined : JSON.stringify(body),
    contentType: body === undefined ? undefined : 'application/json',
  });
  return JSON.parse(text);
}

function fail(message) {
  console.error(`artifacts: ${message}`);
  process.exit(1);
}

function inferType(file) {
  if (opts.type) return opts.type;
  const type = EXT_TYPES[path.extname(file).toLowerCase()];
  if (!type) fail(`cannot infer type from "${file}": pass --type html|jsx|tsx|md|pdf|redirect`);
  return type;
}

// The bytes to send as `content`. A pdf is binary, and the API takes it base64-encoded in the
// same field every other type uses, so the read encoding is the only thing that differs.
function readContent(file, type) {
  return fs.readFile(file, type === 'pdf' ? 'base64' : 'utf8');
}

function need(count, hint) {
  if (args.length < count) fail(`usage: artifacts ${command} ${hint}`);
}

function parseBool(value, name) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  fail(`${name} must be true or false`);
}

switch (command) {
  case 'publish': {
    need(1, '<file> [--slug s] [--title t] [--expires ISO] [--type t] [--frame on|off]');
    if (opts.frame !== undefined && !['on', 'off', 'default'].includes(opts.frame)) {
      fail('--frame must be on, off, or default');
    }
    if (opts.visibility !== undefined && !['public', 'private', 'password'].includes(opts.visibility)) {
      fail('--visibility must be public, private, or password');
    }
    const publishType = inferType(args[0]);
    const content = await readContent(args[0], publishType);
    const out = await apiJson('POST', '/api/artifacts', {
      content,
      type: publishType,
      ...(opts.slug && { slug: opts.slug }),
      ...(opts.title && { title: opts.title }),
      ...(opts.tags !== undefined && { tags: opts.tags }),
      ...(opts.project !== undefined && { project: opts.project }),
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts['og-image'] !== undefined && { ogImage: opts['og-image'] }),
      ...(opts.expires && { expiresAt: opts.expires }),
      ...(opts.frame && opts.frame !== 'default' && { frame: opts.frame === 'on' }),
      ...(opts.visibility !== undefined && { visibility: opts.visibility }),
      ...(opts.password !== undefined && { password: opts.password }),
    });
    console.log(out.url);
    break;
  }

  case 'deploy': {
    need(1, '<dir|zip> [--slug s] [--title t] [--expires ISO]');
    const target = args[0];
    let zipBuffer;
    if ((await fs.stat(target)).isDirectory()) {
      const zip = new AdmZip();
      zip.addLocalFolder(target);
      zipBuffer = zip.toBuffer();
    } else {
      zipBuffer = await fs.readFile(target);
    }
    const params = new URLSearchParams();
    if (opts.slug) params.set('slug', opts.slug);
    if (opts.title) params.set('title', opts.title);
    if (opts.tags) params.set('tags', opts.tags);
    if (opts.project) params.set('project', opts.project);
    if (opts.description) params.set('description', opts.description);
    if (opts['og-image']) params.set('ogImage', opts['og-image']);
    if (opts.expires) params.set('expiresAt', opts.expires);
    if (opts.visibility) params.set('visibility', opts.visibility);
    if (opts.password) params.set('password', opts.password);
    const qs = params.size ? `?${params}` : '';
    const out = JSON.parse(await api('POST', `/api/artifacts/zip${qs}`, {
      body: zipBuffer,
      contentType: 'application/zip',
    }));
    console.log(`${out.url} (${out.files} files)`);
    break;
  }

  case 'update': {
    need(2, '<slug> <file> [--title t] [--type t]');
    const updateType = inferType(args[1]);
    const content = await readContent(args[1], updateType);
    const out = await apiJson('PUT', `/api/artifacts/${args[0]}`, {
      content,
      type: updateType,
      ...(opts.title && { title: opts.title }),
      ...(opts.tags !== undefined && { tags: opts.tags }),
      ...(opts.project !== undefined && { project: opts.project }),
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts['og-image'] !== undefined && { ogImage: opts['og-image'] }),
      ...(opts.visibility !== undefined && { visibility: opts.visibility }),
      ...(opts.password !== undefined && { password: opts.password }),
    });
    console.log(out.url);
    break;
  }

  case 'list': {
    const params = new URLSearchParams();
    if (opts.tag) params.set('tag', opts.tag);
    if (opts.project) params.set('project', opts.project);
    const qs = params.size ? `?${params}` : '';
    const artifacts = await apiJson('GET', `/api/artifacts${qs}`);
    for (const a of artifacts) {
      const frameFlag = a.frame === true ? 'frame:on' : a.frame === false ? 'frame:off' : null;
      const visFlag = a.visibility === 'private' ? 'private' : a.visibility === 'password' ? 'password' : null;
      // The row printed an expiry and never said whether it had passed, so an artifact
      // answering 410 listed the same as a live one, and a stored value that is not a string
      // printed as "expires [object Object]". Same rule the server serves by.
      const expired = artifactExpired(a);
      const expiry = expired ? 'expired' : typeof a.expiresAt === 'string' && `expires ${a.expiresAt}`;
      // One flag for both preview fields: the row has no width for a 300-char description or a
      // full image URL, and what a caller wants from a list is which artifacts still have none.
      const preview = a.description || a.ogImage ? 'preview' : null;
      const flags = [a.disabled && 'disabled', visFlag, frameFlag, preview, expiry].filter(Boolean);
      const project = a.project ? `@${a.project}` : '';
      const tags = a.tags?.length ? `#${a.tags.join(' #')}` : '';
      const meta = [project, tags].filter(Boolean).join(' ');
      console.log(
        `${a.slug}\t${a.type}\t${a.title || ''}${meta ? `\t${meta}` : ''}${flags.length ? `\t[${flags.join(', ')}]` : ''}`,
      );
    }
    break;
  }

  case 'rename': {
    need(2, '<slug> <new-slug>');
    const out = await apiJson('PATCH', `/api/artifacts/${args[0]}`, { slug: args[1] });
    console.log(out.url);
    break;
  }

  case 'disable':
  case 'enable': {
    need(1, '<slug>');
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { disabled: command === 'disable' });
    console.log(`${args[0]} ${command}d`);
    break;
  }

  case 'pdf': {
    need(2, '<slug> <standard|presentation|minimal|download-on|download-off|default>');
    const modes = ['standard', 'presentation', 'minimal'];
    const setting = args[1];
    let value;
    if (setting === 'default') value = null;
    else if (setting === 'download-on') value = { download: true };
    else if (setting === 'download-off') value = { download: false };
    else if (modes.includes(setting)) value = { mode: setting };
    else fail(`pdf value must be ${modes.join(', ')}, download-on, download-off, or default`);
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { pdf: value });
    console.log(`${args[0]} pdf ${setting}`);
    break;
  }

  case 'frame': {
    need(2, '<slug> <on|off|default>');
    const map = { on: true, off: false, default: null };
    if (!Object.hasOwn(map, args[1])) fail('frame value must be on, off, or default');
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { frame: map[args[1]] });
    console.log(`${args[0]} frame ${args[1]}`);
    break;
  }

  case 'visibility': {
    need(2, '<slug> <public|private|password> [--password pw]');
    if (!['public', 'private', 'password'].includes(args[1])) {
      fail('visibility must be public, private, or password');
    }
    if (args[1] === 'password' && !opts.password) {
      fail('--password is required when setting visibility to password');
    }
    const out = await apiJson('PATCH', `/api/artifacts/${args[0]}`, {
      visibility: args[1],
      ...(opts.password !== undefined && { password: opts.password }),
    });
    console.log(out.url); // tokened link for private/password, bare for public
    break;
  }

  case 'rotate': {
    need(1, '<slug>');
    const out = await apiJson('PATCH', `/api/artifacts/${args[0]}`, { rotateToken: true });
    console.log(out.url); // fresh link; every previously shared link now 404s
    break;
  }

  case 'config': {
    const frame = {};
    if (opts['frame-enabled'] !== undefined) frame.enabled = parseBool(opts['frame-enabled'], '--frame-enabled');
    if (opts['frame-default'] !== undefined) frame.default = parseBool(opts['frame-default'], '--frame-default');
    const out = Object.keys(frame).length
      ? await apiJson('PUT', '/api/config', { frame })
      : await apiJson('GET', '/api/config');
    console.log(JSON.stringify(out, null, 2));
    break;
  }

  case 'expire': {
    need(2, '<slug> <ISO-date|never>');
    const expiresAt = args[1] === 'never' ? null : args[1];
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { expiresAt });
    console.log(expiresAt ? `${args[0]} expires ${expiresAt}` : `${args[0]} expiry cleared`);
    break;
  }

  case 'tag': {
    need(2, '<slug> <a,b,c|none>');
    const tags = args[1] === 'none' ? [] : args[1];
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { tags });
    console.log(args[1] === 'none' ? `${args[0]} tags cleared` : `${args[0]} tagged: ${args[1]}`);
    break;
  }

  case 'project': {
    need(2, '<slug> <name|none>');
    const project = args[1] === 'none' ? '' : args[1];
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, { project });
    console.log(args[1] === 'none' ? `${args[0]} project cleared` : `${args[0]} → project ${args[1]}`);
    break;
  }

  // Both preview fields on one verb, because a link preview reads as one thing and setting the
  // image usually means editing the text beside it. Flags rather than positionals, so either
  // field can be set on its own; "none" clears it, the way tag and project take none.
  case 'preview': {
    need(1, '<slug> [--description <d|none>] [--og-image <url|none>]');
    const patch = {
      ...(opts.description !== undefined && {
        description: opts.description === 'none' ? '' : opts.description,
      }),
      ...(opts['og-image'] !== undefined && {
        ogImage: opts['og-image'] === 'none' ? '' : opts['og-image'],
      }),
    };
    if (!Object.keys(patch).length) fail('preview needs --description or --og-image');
    await apiJson('PATCH', `/api/artifacts/${args[0]}`, patch);
    // Echoed under the flag name, not the API field name, so the line names what was typed.
    if ('description' in patch) {
      console.log(patch.description ? `${args[0]} description: ${patch.description}` : `${args[0]} description cleared`);
    }
    if ('ogImage' in patch) {
      console.log(patch.ogImage ? `${args[0]} og-image: ${patch.ogImage}` : `${args[0]} og-image cleared`);
    }
    break;
  }

  case 'delete': {
    need(1, '<slug>');
    await apiJson('DELETE', `/api/artifacts/${args[0]}`);
    console.log(`${args[0]} deleted`);
    break;
  }

  // The one-time cleanup for an install that has been converting artifacts since before the
  // server pruned the old type's files. Prints what it would remove and removes nothing;
  // --apply removes it, the way the destructive verbs above take an explicit argument rather
  // than acting on a bare slug. Safe to run more than once.
  case 'sweep': {
    const apply = Boolean(opts.apply);
    const storage = await createStorage();
    const keys = await sweepOrphans(storage, { apply });
    for (const key of keys) console.log(`${apply ? 'removed' : 'would remove'} ${key}`);
    const count = `${keys.length} orphaned file${keys.length === 1 ? '' : 's'}`;
    console.log(apply ? `${count} removed` : `${count} found; re-run with --apply to remove them`);
    break;
  }

  case 'keys': {
    const sub = args[0];
    if (sub === 'list') {
      const keys = await apiJson('GET', '/api/keys');
      for (const k of keys) {
        // A record missing the hash or the scopes the bearer path reads, or carrying an
        // expiresAt nothing can read. It answers 401 whatever you do with it, so say that
        // and nothing else: the dashboard drops the rest of the line for the same reason,
        // and "expires garbage" next to "always answers 401" reads like a working key with
        // an odd date on it.
        const flags = k.broken ? ['broken, always answers 401'] : [
          k.disabled && 'disabled',
          k.expiresAt && `expires ${k.expiresAt.slice(0, 10)}`,
          k.lastUsedAt ? `used ${k.lastUsedAt.slice(0, 10)}` : 'never used',
          // Only when there are any: most keys have none, and "0 redirects" on every line
          // hides the one line where the number is worth looking at.
          k.redirects && `${k.redirects} redirect${k.redirects === 1 ? '' : 's'}`,
        ].filter(Boolean);
        console.log(`${k.id}\t${k.name}\t${k.scopes.join('/')}\t${k.prefix}…\t[${flags.join(', ')}]`);
      }
    } else if (sub === 'create') {
      if (!args[1]) fail('usage: artifacts keys create <name> [--scopes read,publish,full] [--expires ISO]');
      const scopes = opts.scopes
        ? opts.scopes.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const out = await apiJson('POST', '/api/keys', {
        name: args[1],
        ...(scopes && { scopes }),
        ...(opts.expires && { expiresAt: opts.expires }),
      });
      // The full token is printed once — store it now, it is not recoverable.
      console.log(out.key);
    } else if (sub === 'revoke') {
      if (!args[1]) fail('usage: artifacts keys revoke <id>');
      await apiJson('DELETE', `/api/keys/${args[1]}`);
      console.log(`${args[1]} revoked`);
    } else {
      fail('usage: artifacts keys <list|create|revoke>');
    }
    break;
  }

  case 'source': {
    need(1, '<slug> [-o file]');
    // Read as bytes, the way qr does: a pdf artifact's source is the file itself, and
    // decoding it as text would write a corrupt copy to -o.
    const res = await fetch(`${url}/a/${args[0]}/source`);
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok) fail(`${res.status} ${res.statusText}: ${body.toString('utf8').trim()}`);
    if (opts.output) {
      await fs.writeFile(opts.output, body);
      console.log(opts.output);
    } else {
      process.stdout.write(body);
    }
    break;
  }

  case 'qr': {
    need(1, '<slug> [--png] [--scale n] [--margin n] [-o file]');
    if (!key) fail('API key required: pass --key or set ARTIFACTS_API_KEY');
    // `-o out.png` means a PNG, the same way publish infers the type from the extension.
    const png = opts.png || /\.png$/i.test(opts.output || '');
    // A PNG on a terminal is noise, so refuse before spending the request.
    if (png && !opts.output) fail('--png needs -o <file>');
    const query = new URLSearchParams();
    if (png) query.set('format', 'png');
    if (opts.scale !== undefined) query.set('scale', opts.scale);
    if (opts.margin !== undefined) query.set('margin', opts.margin);
    const suffix = [...query].length ? `?${query}` : '';
    // The PNG is binary, so this path reads the body as bytes rather than going through api().
    const res = await fetch(`${url}/api/artifacts/${args[0]}/qr${suffix}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (!res.ok) fail(`${res.status} ${res.statusText}: ${body.toString('utf8').trim()}`);
    if (opts.output) {
      await fs.writeFile(opts.output, body);
      console.log(opts.output);
    } else {
      process.stdout.write(body.toString('utf8'));
    }
    break;
  }

  default:
    fail(`unknown command "${command}"\n\n${USAGE}`);
}
