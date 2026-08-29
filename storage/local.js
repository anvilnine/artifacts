// Local-filesystem backend (default). Stores each artifact as plain files under
// `${DATA_DIR}/artifacts/<slug>/...`, exactly as the server always has — so an existing
// `/data` volume keeps working with zero migration.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import { assertSafeKey, UnsafeKeyError } from './index.js';

function isMissing(err) {
  return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

// The mode fs.writeFile would have created a new file with. Read once at load: the no-argument
// process.umask() is implemented as umask(0) followed by umask(old), so calling it per write
// leaves a window where the mask is 0 and any directory another request creates in that window
// comes out world-writable. Publishing hard enough produced 0777 artifact directories, and
// meta.json lives in one of those.
const DEFAULT_FILE_MODE = 0o666 & ~process.umask();

// The scratch file put() renames into place: a dot, the target's name, a uuid, `.tmp`.
// Matched rather than guessed at, so a published file that happens to end in `.tmp` is never
// mistaken for one. A killed process leaves one behind holding the whole record it was writing,
// which for meta.json includes the view-password hash, so sweepScratch clears them at boot and
// copySlug and the git backend refuse to carry them anywhere.
const SCRATCH_RE = /^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export function isScratchFile(name) {
  return SCRATCH_RE.test(name);
}

// The root and one level down, which is where auth.json and every meta.json live. Not a full
// recursive walk: that would read every file of every zip site before the port opens, and it
// would follow a symlinked directory out of the storage root. Dirent.isDirectory() is false for
// a symlink, so this descends into real directories only.
async function sweepScratch(root) {
  let swept = 0;
  const clear = async (dir, entries) => {
    for (const entry of entries) {
      if (entry.isFile() && isScratchFile(entry.name)) {
        await fs.rm(path.join(dir, entry.name), { force: true }).catch(() => {});
        swept++;
      }
    }
  };
  let top;
  try {
    top = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }
  await clear(root, top);
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    await clear(dir, inner);
  }
  if (swept) {
    console.log(`storage: cleared ${swept} half-written file(s) left behind by a previous run.`);
  }
}

export async function create() {
  const dataDir = path.resolve(process.env.DATA_DIR || '/data');
  return createAt(path.join(dataDir, 'artifacts'));
}

// Build a filesystem-backed store rooted at an arbitrary directory. Exported so other
// backends (e.g. git, whose working copy is a local tree) can reuse the hardened read/
// write/serve logic — streaming range reads, symlink refusal, realpath containment — and
// layer their own durability on top.
export async function createAt(root) {
  await fs.mkdir(root, { recursive: true });
  // Resolve the root through any symlinks once (e.g. /tmp -> /private/tmp) so containment
  // checks compare real paths against a real base.
  const realRoot = await fs.realpath(root);
  await sweepScratch(realRoot);

  // Map a validated key to an absolute path and confirm it stays within `root`. The guard
  // already rejects `..`/absolute/backslash segments; this is belt-and-suspenders against
  // path.join surprises.
  function resolveKey(key) {
    assertSafeKey(key);
    const abs = path.join(root, key);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new UnsafeKeyError('key escapes storage root');
    }
    return abs;
  }

  // Is a resolved real path still inside the store?
  function contained(real) {
    return real === realRoot || real.startsWith(realRoot + path.sep);
  }

  // Refuse symlinks and confirm the real path is still inside realRoot, so a symlink
  // planted out-of-band can never be followed out of the namespace. Returns the lstat, or
  // null if the target is missing / a symlink / a directory (not a servable object).
  async function statFile(abs) {
    let st;
    try {
      st = await fs.lstat(abs);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (st.isSymbolicLink() || st.isDirectory()) return null;
    let real;
    try {
      real = await fs.realpath(abs);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    if (!contained(real)) return null;
    return st;
  }

  // The write side of the same guard. Reads refuse a symlink and re-check the real path, but
  // put and delete only compared against `root`, which a symlinked slug directory walks
  // straight past: a delete removed the file outside the store and a put wrote a new one out
  // there. The object may not exist yet, so this follows the deepest part of the path that
  // does, which for a new file is the directory it lands in.
  async function assertInsideRoot(abs) {
    let st = null;
    try {
      st = await fs.lstat(abs);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    // A link at the target itself: a write through it lands on whatever it points at, and a
    // delete through it takes that file rather than the link.
    if (st && st.isSymbolicLink()) {
      throw new UnsafeKeyError('key resolves outside storage root');
    }
    let probe = st ? abs : path.dirname(abs);
    while (probe !== root) {
      let real;
      try {
        real = await fs.realpath(probe);
      } catch (err) {
        if (!isMissing(err)) throw err;
        // Nothing there yet, so put() will create it. Ask its parent instead.
        probe = path.dirname(probe);
        continue;
      }
      if (!contained(real)) throw new UnsafeKeyError('key resolves outside storage root');
      return;
    }
  }

  return {
    kind: 'local',
    streams: true,

    async getBuffer(key) {
      const abs = resolveKey(key);
      if (!(await statFile(abs))) return null;
      try {
        return await fs.readFile(abs);
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    async head(key) {
      const st = await statFile(resolveKey(key));
      // mtime is what the sweep's age floor reads (lib/artifact-files.js). The stat is already
      // done here, so it costs nothing.
      return st ? { size: st.size, mtime: st.mtimeMs } : null;
    },

    async get(key, { range } = {}) {
      const abs = resolveKey(key);
      const st = await statFile(abs);
      if (!st) return null;
      if (range) {
        return {
          stream: createReadStream(abs, { start: range.start, end: range.end }),
          size: st.size,
        };
      }
      return { stream: createReadStream(abs), size: st.size };
    },

    // Write the bytes to a scratch file beside the target, then rename it into place.
    // Rename within one filesystem swaps the whole object at once, so a reader gets either
    // all of the old bytes or all of the new ones. A bare writeFile let two writers to one
    // key interleave: the shorter write landed inside the longer one, meta.json stopped
    // parsing, and the artifact dropped out of the list and answered 404 on its own DELETE.
    // The random name keeps two writers off each other's scratch file and off any name a
    // caller could ask for. s3 and the SQL stores need none of this: one PUT and one upsert
    // are already whole-object writes.
    async put(key, data) {
      const abs = resolveKey(key);
      await assertInsideRoot(abs);
      const dir = path.dirname(abs);
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(abs)}.${randomUUID()}.tmp`);
      try {
        // 'wx' refuses an existing path, so the write can never follow something planted at the
        // scratch name. 0600 while it is in flight, because it holds the whole record.
        await fs.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
        // A rename brings a new inode, so it also brings a new mode. writeFile truncated the
        // object in place and kept whatever the file already had, which is what made the
        // `chmod 600 auth.json` in docs/deploy.md stick. Carry the old mode over, and fall back
        // to what writeFile would have created the file with.
        let current = null;
        try {
          current = await fs.stat(abs);
        } catch (err) {
          // Only "there is nothing there yet" means use the default. Anything else (a permission
          // problem on the directory) would quietly hand a hardened file back at 0644.
          if (!isMissing(err)) throw err;
        }
        await fs.chmod(tmp, current ? current.mode & 0o7777 : DEFAULT_FILE_MODE);
        await fs.rename(tmp, abs);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    },

    async listMetas() {
      let entries;
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
      const slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const metas = await Promise.all(
        slugs.map(async (slug) => {
          const buffer = await this.getBuffer(`${slug}/meta.json`).catch(() => null);
          return buffer ? { slug, buffer } : null;
        }),
      );
      return metas.filter(Boolean);
    },

    async move(oldSlug, newSlug) {
      await fs.rename(resolveKey(oldSlug), resolveKey(newSlug));
    },

    // Copy a whole namespace's content objects to a new slug. Skips the top-level
    // meta.json so the caller can write the copy's meta LAST (the commit marker) — a crash
    // mid-copy then leaves the destination invisible (no meta), never half-served.
    async copySlug(srcSlug, dstSlug) {
      const absSrc = resolveKey(srcSlug);
      const absDst = resolveKey(dstSlug);
      const skipMeta = path.join(absSrc, 'meta.json');
      // Scratch files are skipped for the same reason meta.json is: one carries the source's
      // whole record, view-password hash included, and a copy is never allowed to inherit it.
      await fs.cp(absSrc, absDst, {
        recursive: true,
        filter: (source) => source !== skipMeta && !isScratchFile(path.basename(source)),
      });
    },

    // Remove one object. `force` so a key that is already gone is not an error: a conversion
    // asks for the old type's files without checking, and an artifact published before that
    // type owned one of them has nothing there to drop.
    async delete(key) {
      const abs = resolveKey(key);
      await assertInsideRoot(abs);
      await fs.rm(abs, { force: true });
    },

    async deleteSlug(slug) {
      // meta.json first so a crash mid-delete leaves an invisible (404) namespace, never a
      // live artifact with missing files.
      await fs.rm(resolveKey(`${slug}/meta.json`), { force: true });
      await fs.rm(resolveKey(slug), { recursive: true, force: true });
    },
  };
}
