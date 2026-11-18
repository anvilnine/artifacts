// One zip entry's bytes, inflated with a hard ceiling. Shared by the zip-site deploy and the
// app-build upload, which both open archives a caller sent.
//
// Stored and deflated are the two methods every zip tool writes; anything else, and encrypted
// entries, are refused. The ceiling counts the bytes that come out rather than the size the
// archive declares: adm-zip only bounds inflation when a declared size is above 0, so an entry
// that declared 0 inflated without limit.

import zlib from 'node:zlib';

import { ApiError } from './errors.js';

export function readZipEntry(entry, remaining, tooBig) {
  const name = entry.entryName;
  if (entry.header.flags & 1) throw new ApiError(400, `encrypted zip entries are not supported: ${name}`);
  const method = entry.header.method;
  const raw = entry.getCompressedData();
  let data;
  if (method === 0) {
    data = raw;
  } else if (method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, remaining) });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw new ApiError(400, tooBig);
      throw new ApiError(400, `zip entry could not be decompressed: ${name}`);
    }
  } else {
    throw new ApiError(400, `unsupported zip compression method ${method}: ${name}`);
  }
  if (data.length > remaining) throw new ApiError(400, tooBig);
  if (typeof zlib.crc32 === 'function' && zlib.crc32(data) !== entry.header.crc >>> 0) {
    throw new ApiError(400, `zip entry is corrupt: ${name}`);
  }
  return data;
}
