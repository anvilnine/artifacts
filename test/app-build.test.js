// App builds read with no server: the plist and manifest readers against real binary formats
// (test/fixtures/app, built by aapt2 and plutil), the build inspector, and every state of the
// install page.
import test from 'node:test';
import assert from 'node:assert/strict';

import AdmZip from 'adm-zip';

import { parseBinaryXml, parseProtoXml, readManifestFields } from '../lib/android-manifest.js';
import { appDownloadName, appInfo, appMaxBytes, buildInstallManifest, inspectAppBuild, ipaInstallBlocker } from '../lib/app-build.js';
import { appPageSlots, guessPlatform } from '../lib/app-page.js';
import { parsePlist, PlistError, writeXmlPlist } from '../lib/plist.js';
import { fixture, makeIpa } from './helpers/app-builds.js';

const zipEntry = (buf, name) => new AdmZip(buf).getEntry(name).getData();

test('binary plist from plutil reads back the values Xcode writes', () => {
  const info = parsePlist(fixture('Info.plist'));
  assert.equal(info.CFBundleIdentifier, 'com.example.kiln');
  assert.equal(info.CFBundleShortVersionString, '2.3.1');
  assert.equal(info.CFBundleVersion, '42');
  assert.deepEqual(info.UIDeviceFamily, [1, 2]);
});

test('XML plist writer and reader round-trip, and escape markup', () => {
  const value = { a: [1, true, false, 'x<&>"'], b: {}, c: '' };
  assert.deepEqual(parsePlist(Buffer.from(writeXmlPlist(value))), value);
});

test('broken plists throw PlistError instead of hanging or recursing', () => {
  const truncated = fixture('Info.plist').subarray(0, 40);
  assert.throws(() => parsePlist(truncated), PlistError);
  // A binary plist whose top object is an array holding itself.
  const cyclic = Buffer.concat([
    Buffer.from('bplist00'),
    Buffer.from([0xa1, 0x00]), // object 0: array of one ref -> object 0
    Buffer.from([0x08]), // offset table: object 0 at byte 8
    Buffer.from([0, 0, 0, 0, 0, 0, 1, 1]),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 10]),
  ]);
  assert.throws(() => parsePlist(cyclic), /cycle/);
  assert.throws(() => parsePlist(Buffer.from('<html></html>')), PlistError);
});

test('APK binary manifest and AAB protobuf manifest give the same fields', () => {
  const expected = {
    id: 'com.example.kiln',
    version: '2.3.1',
    build: 42,
    minSdk: 24,
    targetSdk: 35,
    name: 'Kiln Demo',
    debuggable: true,
  };
  assert.deepEqual(readManifestFields(parseBinaryXml(zipEntry(fixture('sample.apk'), 'AndroidManifest.xml'))), expected);
  assert.deepEqual(readManifestFields(parseProtoXml(zipEntry(fixture('sample.aab'), 'base/manifest/AndroidManifest.xml'))), expected);
});

test('a manifest cut short throws rather than reading past the buffer', () => {
  const full = zipEntry(fixture('sample.apk'), 'AndroidManifest.xml');
  for (const len of [4, 12, 100, full.length - 7]) {
    assert.throws(() => readManifestFields(parseBinaryXml(full.subarray(0, len))));
  }
});

test('inspectAppBuild detects the kind of build from its contents', () => {
  assert.equal(inspectAppBuild(fixture('sample.apk')).type, 'apk');
  assert.equal(inspectAppBuild(fixture('sample.aab')).type, 'aab');
  const ipa = inspectAppBuild(makeIpa());
  assert.equal(ipa.type, 'ipa');
  assert.equal(ipa.app.name, 'Kiln Demo');
  assert.equal(ipa.app.minOs, '16.0');
  assert.deepEqual(ipa.app.devices, ['iphone', 'ipad']);
  assert.equal(ipa.app.profile.kind, 'adhoc');
  assert.equal(ipa.app.profile.devices, 3);
  assert.equal(ipa.app.profile.teamId, 'ABCDE12345');
  assert.match(ipa.app.sha256, /^[0-9a-f]{64}$/);
  // The UDIDs never reach the record.
  assert.doesNotMatch(JSON.stringify(ipa.app), /00008110/);
});

test('inspectAppBuild classifies each provisioning profile', () => {
  const kind = (profile) => inspectAppBuild(makeIpa({ profile })).app.profile?.kind;
  assert.equal(kind({ kind: 'adhoc' }), 'adhoc');
  assert.equal(kind({ kind: 'development' }), 'development');
  assert.equal(kind({ kind: 'enterprise' }), 'enterprise');
  assert.equal(kind({ kind: 'app-store' }), 'app-store');
  assert.equal(kind(null), undefined);
});

test('inspectAppBuild refuses what is not a build, and a type that does not match', () => {
  assert.throws(() => inspectAppBuild(Buffer.from('%PDF-1.7 not a zip')), /zip archives/);
  const site = new AdmZip();
  site.addFile('index.html', Buffer.from('<h1>hi</h1>'));
  assert.throws(() => inspectAppBuild(site.toBuffer()), /not an app build/);
  assert.throws(() => inspectAppBuild(fixture('sample.apk'), { expect: 'ipa' }), /named but the file is an apk/);
  assert.throws(() => inspectAppBuild(fixture('sample.apk'), { expect: 'exe' }), /type must be one of/);
  const noId = Buffer.from(writeXmlPlist({ CFBundleName: 'X' }));
  assert.throws(() => inspectAppBuild(makeIpa({ info: noId })), /CFBundleIdentifier/);
});

test('an entry that inflates past the cap is refused before it fills memory', () => {
  const zip = new AdmZip();
  zip.addFile('AndroidManifest.xml', Buffer.alloc(5 * 1024 * 1024));
  assert.throws(() => inspectAppBuild(zip.toBuffer()), /larger than 4 MB/);
});

test('ipaInstallBlocker names the reason an IPA cannot install from a link', () => {
  const info = (profile) => appInfo({ type: 'ipa', app: inspectAppBuild(makeIpa({ profile })).app });
  assert.equal(ipaInstallBlocker(info({ kind: 'adhoc' })), null);
  assert.match(ipaInstallBlocker(info({ kind: 'app-store' })), /App Store/);
  assert.match(ipaInstallBlocker(info(null)), /no provisioning profile/);
  assert.match(ipaInstallBlocker(info({ kind: 'adhoc', expiresAt: '2020-01-01T00:00:00Z' })), /expired/);
});

test('install manifest carries the four keys iOS requires, escaped', () => {
  const xml = buildInstallManifest({
    ipaUrl: 'https://x.test/a/s/K.ipa?t=a&b',
    info: { id: 'com.example.kiln', version: '2.3.1' },
    title: 'Kiln <beta>',
  });
  const parsed = parsePlist(Buffer.from(xml));
  const item = parsed.items[0];
  assert.equal(item.assets[0].kind, 'software-package');
  assert.equal(item.assets[0].url, 'https://x.test/a/s/K.ipa?t=a&b');
  assert.deepEqual(item.metadata, { 'bundle-identifier': 'com.example.kiln', 'bundle-version': '2.3.1', kind: 'software', title: 'Kiln <beta>' });
  assert.match(xml, /K\.ipa\?t=a&amp;b/);
});

test('download names keep to a safe character set', () => {
  assert.equal(appDownloadName({ slug: 's1', type: 'apk', app: { name: 'Kiln Demo', version: '2.3.1' } }), 'Kiln-Demo-2.3.1.apk');
  assert.equal(appDownloadName({ slug: 's1', type: 'ipa', app: { name: 'a"b\r\nc', version: '1/2' } }), 'a-b-c-1-2.ipa');
  assert.equal(appDownloadName({ slug: 'my-slug', type: 'aab', app: { name: '日本' } }), 'my-slug.aab');
});

test('APP_MAX_MB sets the cap and junk falls back to the default', () => {
  assert.equal(appMaxBytes({}), 200 * 1024 * 1024);
  assert.equal(appMaxBytes({ APP_MAX_MB: '50' }), 50 * 1024 * 1024);
  assert.equal(appMaxBytes({ APP_MAX_MB: 'lots' }), 200 * 1024 * 1024);
  assert.equal(appMaxBytes({ APP_MAX_MB: '0' }), 200 * 1024 * 1024);
});

test('guessPlatform reads the User-Agent', () => {
  assert.equal(guessPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
  assert.equal(guessPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'android');
  assert.equal(guessPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'desktop');
});

function slots(meta, extra = {}) {
  return appPageSlots(meta, {
    urls: { download: '/a/s/K.ipa?t=tok', install: 'itms-services://?action=download-manifest&url=x' },
    qrSvg: '<svg></svg>',
    https: true,
    platform: 'ios',
    ...extra,
  });
}

test('install page: an installable IPA gets an Install button and the profile steps', () => {
  const app = inspectAppBuild(makeIpa({ profile: { kind: 'adhoc' } })).app;
  const s = slots({ slug: 's', type: 'ipa', title: 'Kiln Demo', app, updatedAt: '2026-11-18T00:00:00Z' });
  assert.match(s.PANEL_IOS, /id="install" href="itms-services:/);
  assert.match(s.PANEL_IOS, /Developer Mode/);
  assert.match(s.PANEL_IOS, /3 devices registered/);
  assert.match(s.DETAILS, /Ad Hoc · 3 devices · expires/);
  assert.match(s.SUBLINE, /2\.3\.1 \(42\) · iOS/);

  const ent = slots({ slug: 's', type: 'ipa', app: inspectAppBuild(makeIpa({ profile: { kind: 'enterprise' } })).app });
  assert.match(ent.PANEL_IOS, /VPN &amp; Device Management/);
  assert.match(ent.PANEL_IOS, /Example Team/);
});

test('install page: a blocked IPA explains itself and offers no Install button', () => {
  const store = inspectAppBuild(makeIpa({ profile: { kind: 'app-store' } })).app;
  const s = slots({ slug: 's', type: 'ipa', app: store });
  assert.doesNotMatch(s.PANEL_IOS, /itms-services/);
  assert.match(s.PANEL_IOS, /note-stop/);
  assert.match(s.PANEL_DESKTOP, /App Store/);

  const http = slots({ slug: 's', type: 'ipa', app: inspectAppBuild(makeIpa()).app }, { https: false });
  assert.doesNotMatch(http.PANEL_IOS, /itms-services/);
  assert.match(http.PANEL_IOS, /HTTPS/);
});

test('install page: an APK downloads on Android and redirects an iPhone', () => {
  const app = inspectAppBuild(fixture('sample.apk')).app;
  const s = slots({ slug: 's', type: 'apk', app }, { urls: { download: '/a/s/Kiln-Demo-2.3.1.apk' } });
  assert.match(s.PANEL_ANDROID, /id="install" href="\/a\/s\/Kiln-Demo-2\.3\.1\.apk" download/);
  assert.match(s.PANEL_ANDROID, /unknown apps/);
  assert.match(s.PANEL_IOS, /Android build/);
  assert.match(s.DETAILS, /Android 7\.0 \(API 24\)/);
  assert.equal(s.QR, '<svg></svg>');
});

test('install page: an AAB says it cannot install and shows bundletool', () => {
  const app = inspectAppBuild(fixture('sample.aab')).app;
  const s = slots({ slug: 'kiln-aab', type: 'aab', app });
  for (const panel of [s.PANEL_IOS, s.PANEL_ANDROID, s.PANEL_DESKTOP]) {
    assert.match(panel, /bundletool build-apks --bundle=kiln-aab\.aab/);
    assert.doesNotMatch(panel, /id="install"/);
  }
  assert.equal(s.QR, '');
  assert.equal(s.DESKTOP_DOWNLOAD, '');
});

test('install page escapes everything that came from the build', () => {
  const app = { name: '<img src=x onerror=alert(1)>', id: 'a"b', version: '1<2' };
  const s = slots({ slug: 's', type: 'apk', title: '<b>t</b>', app });
  const all = Object.values(s).join('');
  assert.doesNotMatch(all, /<img src=x/);
  assert.doesNotMatch(all, /<b>t<\/b>/);
  assert.match(s.NAME, /&lt;img/);
});
