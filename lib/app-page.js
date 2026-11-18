// The install page for an app build, as shell slot values.
//
// Pure: everything it needs arrives as arguments (the stored record, the URLs the server built,
// the QR code), so a unit test can render every state the page has with no server, and the
// serve path stays a lookup and a string fill.
//
// One page serves three readers. On an iPhone or iPad it is an Install button; on Android it is
// a download with the steps that follow; on a computer it is a QR code to move the reader to the
// phone. The server guesses which from the User-Agent so the first paint is right, and the shell
// script corrects the guess (an iPad asks for the desktop site and says "Macintosh"). All three
// sets of markup are in the page; the body class picks one.

import { appInfo, ipaInstallBlocker } from './app-build.js';
import { escapeHtml } from './social.js';

const ANDROID_VERSIONS = {
  21: '5.0', 22: '5.1', 23: '6', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10',
  30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16',
};

const PROFILE_LABEL = {
  adhoc: 'Ad Hoc',
  development: 'Development',
  enterprise: 'Enterprise',
  'app-store': 'App Store',
};

// Soon enough that a tester should hear about it before the app stops opening.
const EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;

export function guessPlatform(userAgent = '') {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'desktop';
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function androidRequirement(sdk) {
  if (!Number.isFinite(sdk)) return '';
  const v = ANDROID_VERSIONS[sdk];
  return v ? `Android ${v} (API ${sdk})` : `API ${sdk}`;
}

// The tile that stands in for an icon: the app's first letter on a colour taken from its id, so
// every build of one app gets the same tile and two apps on one server rarely share one.
function tileStyle(seed) {
  let h = 0;
  for (const ch of seed || 'app') h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = h % 360;
  return `--tile-a: hsl(${hue} 62% 52%); --tile-b: hsl(${(hue + 38) % 360} 70% 38%);`;
}

function tileLetter(name) {
  const ch = [...(name || '').trim()][0];
  return ch ? ch.toLocaleUpperCase() : '?';
}

function row(label, value, { mono = false, wrap = false } = {}) {
  if (!value) return '';
  const cls = ['v', mono ? 'mono' : '', wrap ? 'wrap' : ''].filter(Boolean).join(' ');
  return `<div class="row"><dt>${escapeHtml(label)}</dt><dd class="${cls}">${value}</dd></div>`;
}

function steps(items) {
  return `<ol class="steps">${items.map((s) => `<li>${s}</li>`).join('')}</ol>`;
}

function note(text, tone = 'info') {
  return `<p class="note note-${tone}">${text}</p>`;
}

// `urls`: { download, install (the itms-services:// link, ipa only) }.
// `qrSvg`: the code as inline SVG. `https`: whether BASE_URL is https, which iOS insists on.
export function appPageSlots(meta, { urls, qrSvg, https, platform, now = Date.now() }) {
  const info = appInfo(meta);
  const type = meta.type;
  const title = meta.title || info.name || meta.slug;
  const name = info.name || title;
  const h = escapeHtml;
  const size = formatBytes(info.size);
  const ext = `.${type}`;
  const download = h(urls.download);

  const versionText = info.version
    ? `${info.version}${info.build && info.build !== info.version ? ` (${info.build})` : ''}`
    : info.build || '';

  // ---- the action panel for each reader ----
  let ios = '';
  let android = '';
  let desktop = '';
  const secondaryDownload = `<a class="btn btn-quiet" href="${download}" download>Download ${h(ext)}${size ? ` <span class="dim">${h(size)}</span>` : ''}</a>`;

  if (type === 'ipa') {
    const blocker = ipaInstallBlocker(info, now) || (https ? null
      : 'iOS installs apps from a link only over HTTPS, and this server runs on plain HTTP. Put it behind HTTPS to install from this page.');
    const p = info.profile || {};
    const expiringSoon = p.expiresAt && Date.parse(p.expiresAt) - now < EXPIRY_WARN_MS && Date.parse(p.expiresAt) > now;
    let deviceLine = '';
    if (p.kind === 'adhoc' || p.kind === 'development') {
      deviceLine = note(Number.isFinite(p.devices)
        ? `Only the ${p.devices} device${p.devices === 1 ? '' : 's'} registered in this build's profile can install it.`
        : "Only devices registered in this build's profile can install it.");
    }
    const afterSteps = [
      'Tap <strong>Install</strong>, then <strong>Install</strong> again in the prompt.',
      'Go to the Home Screen. The app icon fills in as it downloads.',
    ];
    if (p.kind === 'enterprise') {
      afterSteps.push(`Before the first launch, open <strong>Settings &rsaquo; General &rsaquo; VPN &amp; Device Management</strong> and trust the developer profile for this app.`);
    } else if (p.kind === 'adhoc' || p.kind === 'development') {
      afterSteps.push('On iOS 16 and later, turn on <strong>Settings &rsaquo; Privacy &amp; Security &rsaquo; Developer Mode</strong> and restart if iOS asks for it.');
    }
    if (blocker) {
      ios = `${note(h(blocker), 'stop')}${secondaryDownload}`;
    } else {
      ios = `<a class="btn btn-primary" id="install" href="${h(urls.install)}">Install</a>`
        + (expiringSoon ? note(`The profile expires on ${h(formatDate(p.expiresAt))}. After that the app stops opening.`, 'warn') : '')
        + deviceLine
        + steps(afterSteps)
        + note('Nothing happening? Open this page in Safari. Links opened inside other apps often cannot start an install.', 'quiet');
    }
    android = `${note('This is an iPhone and iPad build. Open this page on an iOS device to install it.')}${secondaryDownload}`;
    desktop = blocker ? note(h(blocker), 'stop') : '';
  } else if (type === 'apk') {
    android = `<a class="btn btn-primary" id="install" href="${download}" download>Download APK${size ? ` <span class="dim">${h(size)}</span>` : ''}</a>`
      + steps([
        'Open the file from the download notification, or from <strong>Files &rsaquo; Downloads</strong>.',
        'If Android asks, allow your browser to install unknown apps, then go back.',
        'Tap <strong>Install</strong>.',
      ])
      + note('An installed copy signed with a different key blocks the update. Uninstall it first.', 'quiet');
    ios = `${note('This is an Android build. Open this page on an Android device to install it.')}${secondaryDownload}`;
  } else {
    // aab
    const cmd = `bundletool build-apks --bundle=${h(meta.slug)}.aab --output=${h(meta.slug)}.apks --mode=universal\nbundletool install-apks --apks=${h(meta.slug)}.apks`;
    const aabPanel = note('An Android App Bundle is the format Google Play takes. A phone cannot install it directly: upload it to Play Console, or turn it into an APK with bundletool.')
      + `<pre class="cmd"><code>${cmd}</code></pre>`
      + secondaryDownload;
    android = aabPanel;
    ios = aabPanel;
    desktop = aabPanel;
  }

  const showQr = type !== 'aab';

  // ---- details ----
  const rows = [];
  rows.push(row('Version', h(versionText)));
  rows.push(row(type === 'ipa' ? 'Bundle ID' : 'Package', h(info.id || ''), { mono: true, wrap: true }));
  if (type === 'ipa') {
    rows.push(row('Requires', info.minOs ? `iOS ${h(info.minOs)}` : ''));
    const dev = info.devices.map((d) => (d === 'iphone' ? 'iPhone' : 'iPad')).join(', ');
    rows.push(row('Runs on', h(dev)));
    const p = info.profile;
    if (p) {
      const bits = [PROFILE_LABEL[p.kind] || 'Unknown'];
      if (Number.isFinite(p.devices)) bits.push(`${p.devices} device${p.devices === 1 ? '' : 's'}`);
      if (p.expiresAt) bits.push(`${Date.parse(p.expiresAt) <= now ? 'expired' : 'expires'} ${formatDate(p.expiresAt)}`);
      rows.push(row('Signing', h(bits.join(' · '))));
      if (p.teamId) rows.push(row('Team ID', h(p.teamId), { mono: true }));
    } else {
      rows.push(row('Signing', 'No provisioning profile'));
    }
  } else {
    rows.push(row('Requires', h(androidRequirement(info.minSdk))));
    rows.push(row('Targets', h(androidRequirement(info.targetSdk))));
    if (info.debuggable) rows.push(row('Build', 'Debuggable'));
  }
  rows.push(row('Size', h(size)));
  rows.push(row('Uploaded', h(formatDate(meta.updatedAt || meta.createdAt))));
  if (meta.expiresAt) rows.push(row('Link expires', h(formatDate(meta.expiresAt))));
  rows.push(row('SHA-256', info.sha256 ? `<span class="hash">${h(info.sha256)}</span>` : '', { mono: true, wrap: true }));

  const platformLabel = type === 'ipa' ? 'iOS' : type === 'apk' ? 'Android' : 'Android App Bundle';

  return {
    TITLE: h(versionText ? `${title} ${versionText}` : title),
    NAME: h(name),
    TILE_STYLE: tileStyle(info.id || name),
    TILE_LETTER: h(tileLetter(name)),
    SUBLINE: h([versionText, platformLabel].filter(Boolean).join(' · ')),
    PLATFORM: platform,
    TYPE: type,
    PANEL_IOS: ios,
    PANEL_ANDROID: android,
    PANEL_DESKTOP: desktop,
    QR: showQr ? qrSvg : '',
    QR_CLASS: showQr ? '' : 'no-qr',
    QR_CAPTION: type === 'ipa' ? 'Scan with the iPhone or iPad camera' : 'Scan with the Android phone camera',
    // The bundle panel already carries its download.
    DESKTOP_DOWNLOAD: type === 'aab' ? '' : secondaryDownload,
    DETAILS: rows.join(''),
  };
}
