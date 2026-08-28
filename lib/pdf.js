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

// Every PDF starts with this. It is the whole file-type check: Buffer.from(s, 'base64') drops
// characters that are not base64 instead of throwing, so a body of prose decodes to something
// rather than failing, and the magic number is what actually turns it away.
const PDF_MAGIC = '%PDF-';

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
  // base64 string instead would turn a 7 MB limit into a 5.25 MB one.
  if (buf.length > PDF_MAX_BYTES) {
    throw new ApiError(
      400,
      `pdf too large (${buf.length} > ${PDF_MAX_BYTES} bytes once decoded)`,
    );
  }
  return buf;
}
