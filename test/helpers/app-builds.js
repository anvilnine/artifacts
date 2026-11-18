// Builds IPA test inputs in memory. The binary Info.plist and the Android builds are real files
// under test/fixtures/app (see build.sh there); an IPA is only a zip around an Info.plist and a
// provisioning profile, so the variants each test needs are assembled here.
import { readFileSync } from 'node:fs';

import AdmZip from 'adm-zip';

import { writeXmlPlist } from '../../lib/plist.js';

const FIXTURES = new URL('../fixtures/app/', import.meta.url);

export const fixture = (name) => readFileSync(new URL(name, FIXTURES));

// A provisioning profile as the signing tools leave it: DER bytes around an XML plist. The bytes
// on each side stand in for the CMS envelope, which the reader skips.
export function fakeProfile({ kind = 'adhoc', expiresAt = '2099-01-01T00:00:00Z', devices = 3 } = {}) {
  const plist = {
    Name: `Kiln ${kind}`,
    TeamName: 'Example Team',
    TeamIdentifier: ['ABCDE12345'],
    Entitlements: { 'get-task-allow': kind === 'development' },
  };
  if (kind === 'adhoc' || kind === 'development') {
    plist.ProvisionedDevices = Array.from({ length: devices }, (_, i) => `0000811${i}-001C3D2E0A12345E`);
  }
  if (kind === 'enterprise') plist.ProvisionsAllDevices = true;
  const xml = writeXmlPlist(plist).replace(
    '</dict>\n</plist>',
    `\t<key>ExpirationDate</key>\n\t<date>${new Date(expiresAt).toISOString().replace('.000', '')}</date>\n</dict>\n</plist>`,
  );
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x3a, 0x00, 0x06, 0x09]), Buffer.from(xml), Buffer.from([0xa0, 0x82, 0x01])]);
}

export function makeIpa({ profile = { kind: 'adhoc' }, info = fixture('Info.plist'), appName = 'Kiln' } = {}) {
  const zip = new AdmZip();
  zip.addFile(`Payload/${appName}.app/Info.plist`, info);
  zip.addFile(`Payload/${appName}.app/${appName}`, Buffer.alloc(64, 1));
  if (profile) zip.addFile(`Payload/${appName}.app/embedded.mobileprovision`, fakeProfile(profile));
  return zip.toBuffer();
}
