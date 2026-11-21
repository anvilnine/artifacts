// Optional browser regression check: run from the repo with Playwright and Chromium installed.
import { chromium } from 'playwright';
import AdmZip from 'adm-zip';
import {startServer, TEST_KEY} from '../test/helpers/server.js';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const s=await startServer({ARTIFACTS_ADMIN_USERNAME:'local-admin', ARTIFACTS_ADMIN_PASSWORD:'local-password-123'});
let b;
try {
  b=await chromium.launch();
  const ctx=await b.newContext();
  for(const visibility of ['private','password','public']){
    const slug='browser-'+visibility;
    assert.equal((await s.api('POST','/api/artifacts',{slug,type:'html',visibility,password:visibility==='password'?'local-fixture-pass':undefined,content:'<p>'+slug+'</p>',frame:false})).status,201);
    assert.equal(execFileSync(process.execPath,['cli.js','source',slug,'--url',s.base,'--key',TEST_KEY],{encoding:'utf8'}),'<p>'+slug+'</p>');
  }
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from('<p>private zip</p><img src="asset.svg">'));
  zip.addFile('asset.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'));
  assert.equal((await s.api('POST', '/api/artifacts/zip?slug=browser-zip', zip.toBuffer(), {
    'Content-Type': 'application/zip',
  })).status, 201);
  const p=await ctx.newPage(); await p.goto(s.base);
  await p.locator('#lockUser').fill('local-admin'); await p.locator('#lockPass').fill('local-password-123'); await p.locator('#lockSubmit').click();
  for(const visibility of ['private','password','public']){
    const slug='browser-'+visibility;
    const opened=ctx.waitForEvent('page');
    await p.locator('.slug').filter({hasText:slug}).first().click();
    const tab=await opened;
    await tab.waitForURL('**/a/'+slug); await tab.locator('p',{hasText:slug}).waitFor();
    assert.equal(await tab.evaluate(()=>window.opener===null),true);
    await tab.close();
    console.log('opened '+visibility+' from dashboard; CLI source matched');
  }
  const opened = ctx.waitForEvent('page');
  await p.locator('.slug').filter({ hasText: 'browser-zip' }).first().click();
  const site = await opened;
  await site.waitForURL('**/a/browser-zip/');
  const asset = site.frameLocator('iframe').locator('img[src="asset.svg"]');
  await asset.waitFor();
  assert.equal(await asset.evaluate(async img => { await img.decode(); return img.naturalWidth; }), 2);
  assert.equal((await fetch(s.base+'/a/browser-private')).status,404);
  assert.equal((await fetch(s.base+'/a/browser-zip/asset.svg')).status,404);
} finally {await b?.close();await s.stop();}
