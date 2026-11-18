// App builds: APK, AAB and IPA artifacts, published to be installed over the air.
//
// An app build is the second artifact type that is not text, after pdf, and the first that is
// routinely bigger than a JSON body can carry. So it arrives as raw bytes on its own endpoint
// (POST /api/artifacts/app, PUT /api/artifacts/:slug/app) the way a zip site does, and this
// module turns those bytes into the record the install page is drawn from.
//
// Everything the page shows is read here, once, at upload: the app's name, bundle or package
// id, version and build number, the minimum OS, and for an IPA the provisioning profile that
// decides which devices can install it. The serve path renders from meta.json and never opens
// the archive again, so a reader cannot make the server inflate anything.
//
// The kind of build is decided by what is inside the archive, not by the file name:
//   ipa  Payload/<Name>.app/Info.plist
//   aab  base/manifest/AndroidManifest.xml (a protobuf manifest, Play Console upload format)
//   apk  AndroidManifest.xml at the root (binary XML)
// A caller that names a type and sends a different kind of build gets a 400 that says both.

import crypto from 'node:crypto';

import AdmZip from 'adm-zip';

import { ApiError } from './errors.js';
import { parsePlist, extractEmbeddedPlist, writeXmlPlist } from './plist.js';
import { parseBinaryXml, parseProtoXml, readManifestFields } from './android-manifest.js';
import { readZipEntry } from './zip-entry.js';

export const APP_TYPES = ['apk', 'aab', 'ipa'];
const APP_TYPE_SET = new Set(APP_TYPES);
export const isAppType = (type) => APP_TYPE_SET.has(type);

export const APP_MIME = {
  apk: 'application/vnd.android.package-archive',
  aab: 'application/octet-stream',
  ipa: 'application/octet-stream',
};

// Largest build accepted, from APP_MAX_MB (default 200). Real release builds run 20 to 150 MB.
// The whole body is held in memory while it is checked, so this is also the memory one upload
// can cost. A value that does not parse falls back to the default rather than to no cap.
export function appMaxBytes(env = process.env) {
  const mb = Number(env.APP_MAX_MB);
  const valid = Number.isFinite(mb) && mb >= 1 && mb <= 4096;
  return Math.floor((valid ? mb : 200) * 1024 * 1024);
}

// The entries read out of a build are small (an Info.plist, a manifest, a profile). 4 MB is
// far above any real one and keeps a crafted entry from inflating into memory.
const ENTRY_CAP = 4 * 1024 * 1024;
const ENTRY_TOO_BIG = 'an entry inside the build is larger than 4 MB once decompressed';

const IPA_INFO_RE = /^Payload\/([^/]+)\.app\/Info\.plist$/;

function bad(message) {
  return new ApiError(400, message);
}

// Strings that land on the page and in the install manifest. Bounded and stripped of control
// characters, since every one of them came from the uploader.
function clean(value, max = 200) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

// What the archive holds, decided by content. Throws a 400 when it holds none of the three.
function detect(entries) {
  const names = new Map(entries.map((e) => [e.entryName, e]));
  const info = entries.find((e) => IPA_INFO_RE.test(e.entryName));
  if (info) return { type: 'ipa', info };
  if (names.has('base/manifest/AndroidManifest.xml')) {
    return { type: 'aab', manifest: names.get('base/manifest/AndroidManifest.xml') };
  }
  if (names.has('AndroidManifest.xml')) return { type: 'apk', manifest: names.get('AndroidManifest.xml') };
  throw bad('not an app build: expected an .apk (AndroidManifest.xml), an .aab (base/manifest/AndroidManifest.xml) or an .ipa (Payload/<App>.app/Info.plist)');
}

// Who a provisioning profile lets install the app.
//   enterprise  ProvisionsAllDevices: any device, after the user trusts the developer.
//   development ProvisionedDevices + get-task-allow: listed devices, Developer Mode on.
//   adhoc       ProvisionedDevices, no get-task-allow: listed devices, Developer Mode on.
//   app-store   neither: App Store and TestFlight only, never from a link.
export function profileKind(profile) {
  if (profile.ProvisionsAllDevices === true) return 'enterprise';
  if (Array.isArray(profile.ProvisionedDevices)) {
    return profile.Entitlements?.['get-task-allow'] === true ? 'development' : 'adhoc';
  }
  return 'app-store';
}

function readProfile(entry) {
  let plist;
  try {
    plist = extractEmbeddedPlist(readZipEntry(entry, ENTRY_CAP, ENTRY_TOO_BIG));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // A profile the reader cannot parse leaves the page without signing details. It does not
    // refuse the build: the device is the real judge of the signature.
    return undefined;
  }
  if (!plist || typeof plist !== 'object') return undefined;
  const expires = plist.ExpirationDate instanceof Date && !Number.isNaN(plist.ExpirationDate.getTime())
    ? plist.ExpirationDate.toISOString()
    : undefined;
  const out = {
    kind: profileKind(plist),
    name: clean(plist.Name),
    team: clean(plist.TeamName),
    teamId: clean(Array.isArray(plist.TeamIdentifier) ? plist.TeamIdentifier[0] : undefined, 20),
    expiresAt: expires,
  };
  // The count only. The device UDIDs identify people's phones and the page has no use for them.
  if (Array.isArray(plist.ProvisionedDevices)) out.devices = plist.ProvisionedDevices.length;
  return out;
}

function inspectIpa(entries, info) {
  let plist;
  try {
    plist = parsePlist(readZipEntry(info, ENTRY_CAP, ENTRY_TOO_BIG));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw bad(`the build's Info.plist could not be read: ${err.message}`);
  }
  if (!plist || typeof plist !== 'object') throw bad("the build's Info.plist is not a dictionary");
  const id = clean(plist.CFBundleIdentifier, 255);
  if (!id) throw bad("the build's Info.plist has no CFBundleIdentifier");
  const appDir = info.entryName.slice(0, -'Info.plist'.length);
  const app = {
    platform: 'ios',
    name: clean(plist.CFBundleDisplayName) || clean(plist.CFBundleName) || clean(IPA_INFO_RE.exec(info.entryName)[1]),
    id,
    version: clean(plist.CFBundleShortVersionString, 64) || clean(plist.CFBundleVersion, 64),
    build: clean(plist.CFBundleVersion, 64),
    minOs: clean(plist.MinimumOSVersion, 16),
  };
  const family = Array.isArray(plist.UIDeviceFamily) ? plist.UIDeviceFamily : [];
  const devices = [];
  if (family.includes(1)) devices.push('iphone');
  if (family.includes(2)) devices.push('ipad');
  if (devices.length) app.devices = devices;
  const profileEntry = entries.find((e) => e.entryName === `${appDir}embedded.mobileprovision`);
  if (profileEntry) {
    const profile = readProfile(profileEntry);
    if (profile) app.profile = profile;
  }
  return app;
}

function inspectAndroid(type, entry) {
  let fields;
  try {
    const bytes = readZipEntry(entry, ENTRY_CAP, ENTRY_TOO_BIG);
    fields = readManifestFields(type === 'aab' ? parseProtoXml(bytes) : parseBinaryXml(bytes));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw bad(`the build's AndroidManifest.xml could not be read: ${err.message}`);
  }
  const app = {
    platform: 'android',
    name: clean(fields.name),
    id: clean(fields.id, 255),
    version: clean(fields.version, 64),
    build: fields.build !== undefined ? String(fields.build) : undefined,
  };
  if (fields.minSdk !== undefined) app.minSdk = fields.minSdk;
  if (fields.targetSdk !== undefined) app.targetSdk = fields.targetSdk;
  if (fields.debuggable) app.debuggable = true;
  return app;
}

// The type and app record for a build, or a 400. `expect` is the type the caller named, if any.
export function inspectAppBuild(buffer, { expect } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw bad('the build is empty');
  if (expect !== undefined && !isAppType(expect)) {
    throw bad(`type must be one of: ${APP_TYPES.join(', ')}`);
  }
  // Every one of the three is a zip. Checked before adm-zip so a PDF or a text file gets a
  // sentence instead of a parser error.
  if (buffer.readUInt32LE(0) !== 0x04034b50) {
    throw bad('not an app build: .apk, .aab and .ipa files are zip archives, and this is not one');
  }
  let entries;
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch (err) {
    throw bad(`the build is not a readable zip archive: ${err.message}`);
  }
  const found = detect(entries);
  if (expect !== undefined && expect !== found.type) {
    throw bad(`type "${expect}" was named but the file is an ${found.type}`);
  }
  const app = found.type === 'ipa'
    ? inspectIpa(entries, found.info)
    : inspectAndroid(found.type, found.manifest);
  // Leave out what was not found, so meta.json carries no empty keys.
  for (const key of Object.keys(app)) if (app[key] === undefined) delete app[key];
  app.size = buffer.length;
  app.sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { type: found.type, app };
}

// Read back the stored record. Tolerant the way pdfSettings is: meta.json can be hand-edited,
// and a value nobody can read should cost the page a line, not the page.
export function appInfo(meta) {
  const a = meta && typeof meta.app === 'object' && meta.app !== null ? meta.app : {};
  const str = (v, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const p = a.profile && typeof a.profile === 'object' ? a.profile : undefined;
  return {
    platform: meta?.type === 'ipa' ? 'ios' : 'android',
    name: str(a.name),
    id: str(a.id, 255),
    version: str(a.version, 64),
    build: str(a.build, 64),
    minOs: str(a.minOs, 16),
    minSdk: num(a.minSdk),
    targetSdk: num(a.targetSdk),
    debuggable: a.debuggable === true,
    devices: Array.isArray(a.devices) ? a.devices.filter((d) => d === 'iphone' || d === 'ipad') : [],
    size: num(a.size),
    sha256: typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256) ? a.sha256 : undefined,
    profile: p
      ? {
        kind: ['enterprise', 'development', 'adhoc', 'app-store'].includes(p.kind) ? p.kind : undefined,
        name: str(p.name),
        team: str(p.team),
        teamId: str(p.teamId, 20),
        expiresAt: typeof p.expiresAt === 'string' && !Number.isNaN(Date.parse(p.expiresAt)) ? p.expiresAt : undefined,
        devices: num(p.devices),
      }
      : undefined,
  };
}

// Whether an IPA can install from a link at all, and if not, the reason in words a tester can
// act on. An Android build has no equivalent check: an APK installs once the reader allows
// installs from the browser, and an AAB never installs, which the page says on its own.
export function ipaInstallBlocker(info, now = Date.now()) {
  const p = info.profile;
  if (!p) {
    return 'This build has no provisioning profile, so iOS will refuse it. Export it from Xcode with an Ad Hoc, Development or Enterprise profile.';
  }
  if (p.kind === 'app-store') {
    return 'This build is signed for the App Store, which only installs through the App Store or TestFlight. Export it again with an Ad Hoc, Development or Enterprise profile to install it from this page.';
  }
  if (p.expiresAt && Date.parse(p.expiresAt) <= now) {
    return 'The provisioning profile in this build has expired, so iOS will refuse to install or open it. Rebuild with a current profile.';
  }
  return null;
}

// The manifest iOS fetches after an itms-services:// tap. Apple requires the four metadata keys
// below; the image assets are optional and left out, since the page has no icon to give.
export function buildInstallManifest({ ipaUrl, info, title }) {
  return writeXmlPlist({
    items: [
      {
        assets: [{ kind: 'software-package', url: ipaUrl }],
        metadata: {
          'bundle-identifier': info.id || 'unknown',
          'bundle-version': info.version || info.build || '1.0',
          kind: 'software',
          title: title || info.name || 'App',
        },
      },
    ],
  });
}

// The file name a download lands on. Built from a whitelist of characters, because it goes
// inside a quoted Content-Disposition header and the app name came from the uploader.
export function appDownloadName(meta) {
  const info = appInfo(meta);
  const part = (s) => (s || '').normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  const base = part(info.name) || part(meta?.slug) || 'app';
  const version = part(info.version);
  const ext = isAppType(meta?.type) ? meta.type : 'bin';
  return `${base}${version ? `-${version}` : ''}.${ext}`;
}
