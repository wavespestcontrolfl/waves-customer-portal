// Smoke test + Chrome Web Store images for the Bug Identifier extension.
//
// Loads the real extension into Chromium and answers its API calls with v2
// answers built by the REAL species-catalog answer builder
// (server/services/photo-id-v2/pest-engine.js buildAnswer — no model call),
// checks each panel state, the page selector and the crop math, then writes
// the store images (1280x800 screenshots + the 440x280 promo tile) to
// store/screenshots/. Exits 1 if any check fails.
//
// Usage, from the repo root after `npm ci`:
//   node extensions/bug-identifier/scripts/screenshots.mjs
// Set CHROMIUM_PATH to use a Chromium other than the one Playwright installed.
//
// The page.evaluate() callbacks below run inside Chromium, not Node:
/* global chrome, window, document, OffscreenCanvas, createImageBitmap */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(EXT, '..', '..');
const OUT = join(EXT, 'store', 'screenshots');
const PHOTOS = join(EXT, 'store', 'sample-photos');
const API = 'https://portal.wavespestcontrol.com/api/public/bug-id-extension/identify';
const PANEL = { width: 400, height: 760 };

// ── v2 answers from the real engine's answer builder ──
const engine = require(join(REPO, 'server/services/photo-id-v2/pest-engine'));
const catalog = require(join(REPO, 'server/services/species-catalog'));

function candidate(slug, confidence, traitsVisible = [1, 2, 3], traitsNotVisible = []) {
  const c = engine.resolveCandidate({ slug, confidence, traits_visible: traitsVisible, traits_not_visible: traitsNotVisible });
  assert.ok(c.entry, `catalog has ${slug}`);
  return { ...c, checked: true, verified: true };
}

function answer(candidates) {
  const built = engine.buildAnswer({
    candidates, disagreed: false, disagreementNode: null, escalationTriggered: false, openaiAnswered: false,
    openaiStoodInAlone: false, qualityUsable: true, qualityIssue: 'none', subjectConflict: false,
    evidenceKind: { shownKind: 'organism', hiddenKind: 'sign' }, currentMonth: new Date().getMonth() + 1,
  });
  return {
    version: 2, catalog_version: catalog.CATALOG_VERSION, tier: built.tier, answer: built.answer, group: built.group,
    entry: built.entry, evidence: built.evidence, candidates: built.candidatesBlock, next_photo: built.nextPhoto,
    referral: built.referral, generic_safety_line: built.genericSafetyLine,
  };
}

const referralEntry = catalog.listEntries({ section: 'pest' })
  .find((e) => e.service && e.service.referral && engine.isApproved(e) && engine.REFERRAL_TEMPLATES[e.service.referral]);
const ANSWERS = {
  orbweaver: answer([candidate('golden-silk-orbweaver', 0.93), candidate('spinybacked-orbweaver', 0.04, [1])]),
  wolf: answer([candidate('wolf-spider', 0.91, [1, 2])]),
  widow: answer([candidate('black-widow', 0.66, [1], [2, 3]), candidate('brown-widow', 0.3, [1])]),
  unknown: answer([]),
  referral: referralEntry ? answer([candidate(referralEntry.slug, 0.92)]) : null,
};

// ── tiny runner ──
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${err.message.split('\n').join('\n     ')}`);
  }
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const photoB64 = async (file) => (await readFile(join(PHOTOS, file))).toString('base64');
const dataUrl = (b64, mime) => `data:${mime};base64,${b64}`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
// Panel-only captures feed the store images; they are not store images.
const SCRATCH = await mkdtemp(join(os.tmpdir(), 'bugid-shots-'));
const userDataDir = await mkdtemp(join(os.tmpdir(), 'bugid-profile-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const site = http.createServer(async (req, res) => {
  if (req.url === '/photo.jpg') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(await readFile(join(PHOTOS, 'golden-silk-orbweaver.jpg')));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><body style="margin:0"><img src="/photo.jpg" style="display:block;width:100vw;height:100vh;object-fit:cover"></body>');
});

try {
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extId = new URL(worker.url()).host;

  // API mock: each step sets the next response. A step can also hold the
  // next call in flight until it resolves `holdNextCall`; a held call keeps
  // the response that was set when it arrived.
  let nextResponse = null;
  let holdNextCall = null;
  const apiCalls = [];
  await context.route(API, async (route) => {
    apiCalls.push(JSON.parse(route.request().postData() || '{}'));
    const { status = 200, body } = nextResponse;
    const hold = holdNextCall;
    holdNextCall = null;
    if (hold) await hold;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const answerWith = (v2) => { nextResponse = { body: { success: true, result: v2 } }; };

  const panel = await context.newPage();
  await panel.setViewportSize(PANEL);
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  const windowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const headline = panel.locator('#result .headline');
  const reset = async () => {
    await panel.getByRole('button', { name: 'Identify another bug' }).click();
    await panel.locator('#start').waitFor();
  };
  const handOver = (photo, forWindow = windowId) => panel.evaluate(
    ({ job }) => chrome.storage.session.set({ job }),
    { job: { status: 'ready', photo, windowId: forWindow, at: Date.now() } },
  );

  await check('start view', async () => {
    assert.ok(await panel.locator('#start').isVisible());
    await panel.screenshot({ path: join(SCRATCH, 'panel-start.png') });
  });

  await check('chosen photo → resized JPEG sent → species answer with tracked profile link', async () => {
    answerWith(ANSWERS.orbweaver);
    await panel.setInputFiles('#file', join(PHOTOS, 'golden-silk-orbweaver.jpg'));
    await headline.waitFor();
    assert.equal(await headline.textContent(), ANSWERS.orbweaver.answer.headline);
    const sent = apiCalls.at(-1).photos;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mimeType, 'image/jpeg');
    assert.match(sent[0].data, /^[A-Za-z0-9+/]+={0,2}$/);
    const href = await panel.locator('#result a.link').getAttribute('href');
    assert.ok(href.startsWith(`${ANSWERS.orbweaver.entry.site_url}?utm_source=chrome-extension&utm_medium=bug-identifier`), href);
    await panel.locator('details.about summary').click();
    await panel.screenshot({ path: join(SCRATCH, 'panel-result.png') });
  });

  await check('right-click hand-over (session job) → likely answer → "Add this photo" sends 2 photos', async () => {
    await reset();
    answerWith(ANSWERS.widow);
    const wolf = await photoB64('wolf-spider.jpg');
    await handOver({ data: wolf, mimeType: 'image/jpeg' });
    await headline.waitFor();
    assert.equal(await headline.textContent(), ANSWERS.widow.answer.headline);
    assert.ok(await panel.locator('#result .safety').first().isVisible(), 'safety line shown');
    assert.ok((await panel.locator('#result').textContent()).includes('Other possibilities'));
    assert.equal(await panel.evaluate(() => chrome.storage.session.get('job').then((r) => r.job)), undefined, 'job cleared');
    await panel.getByRole('button', { name: 'Add this photo' }).click();
    assert.ok((await panel.locator('#append-note').textContent()).includes(ANSWERS.widow.next_photo.ask));
    await panel.setInputFiles('#file', join(PHOTOS, 'wolf-spider.jpg'));
    await headline.waitFor();
    assert.equal(apiCalls.at(-1).photos.length, 2);
  });

  await check("another window's hand-over is ignored", async () => {
    await reset();
    const before = apiCalls.length;
    await handOver({ data: await photoB64('wolf-spider.jpg'), mimeType: 'image/jpeg' }, windowId + 999);
    await panel.waitForTimeout(800);
    assert.equal(apiCalls.length, before);
    assert.ok(await panel.locator('#start').isVisible());
    await panel.evaluate(() => chrome.storage.session.remove('job'));
  });

  await check('a hand-over that arrives mid-request is identified next, not dropped', async () => {
    let release;
    holdNextCall = new Promise((resolve) => { release = resolve; });
    answerWith(ANSWERS.orbweaver);
    const before = apiCalls.length;
    await panel.setInputFiles('#file', join(PHOTOS, 'golden-silk-orbweaver.jpg'));
    await waitUntil(() => apiCalls.length === before + 1);
    answerWith(ANSWERS.wolf);
    const wolf = await photoB64('wolf-spider.jpg');
    await handOver({ data: wolf, mimeType: 'image/jpeg' });
    // The panel has taken the hand-over while the first call is still held.
    await waitUntil(async () => (await panel.evaluate(() => chrome.storage.session.get('job').then((r) => r.job))) === undefined);
    release();
    await panel.locator('#result .headline', { hasText: ANSWERS.wolf.answer.headline }).waitFor({ timeout: 10_000 });
    assert.equal(apiCalls.length, before + 2);
    assert.equal(apiCalls.at(-1).photos[0].data, wolf);
    await reset();
  });

  await check('daily limit (429) shows the server message; Start over returns', async () => {
    nextResponse = { status: 429, body: { error: "Today's free identifications are used up. Please try again tomorrow." } };
    await panel.setInputFiles('#file', join(PHOTOS, 'wolf-spider.jpg'));
    await panel.locator('#error').waitFor();
    assert.match(await panel.locator('#error-text').textContent(), /used up/);
    assert.equal(await panel.locator('#error-retry').textContent(), 'Start over');
    await panel.locator('#error-retry').click();
    assert.ok(await panel.locator('#start').isVisible());
  });

  await check('outage (503) → Try again re-sends the same photo', async () => {
    nextResponse = { status: 503, body: { error: 'down' } };
    await panel.setInputFiles('#file', join(PHOTOS, 'wolf-spider.jpg'));
    await panel.locator('#error').waitFor();
    assert.equal(await panel.locator('#error-retry').textContent(), 'Try again');
    const failed = apiCalls.at(-1).photos[0].data;
    answerWith(ANSWERS.wolf);
    await panel.locator('#error-retry').click();
    await headline.waitFor();
    assert.equal(apiCalls.at(-1).photos[0].data, failed);
    assert.ok(await panel.locator('#result .waves').isVisible(), 'Waves card shown');
  });

  await check('gate off (404) reads as not available yet', async () => {
    await reset();
    nextResponse = { status: 404, body: { error: 'Not found' } };
    await panel.setInputFiles('#file', join(PHOTOS, 'wolf-spider.jpg'));
    await panel.locator('#error').waitFor();
    assert.match(await panel.locator('#error-text').textContent(), /isn't available yet/);
    await panel.locator('#error-retry').click();
  });

  await check("unknown answer: needs more evidence, the engine's next-photo ask", async () => {
    answerWith(ANSWERS.unknown);
    await panel.setInputFiles('#file', join(PHOTOS, 'wolf-spider.jpg'));
    await headline.waitFor();
    assert.equal(await headline.textContent(), "We couldn't tell from these photos");
    assert.ok((await panel.locator('#result').textContent()).includes('Needs more evidence'));
    assert.ok((await panel.locator('#result').textContent()).includes(ANSWERS.unknown.next_photo.ask));
  });

  await check('a referral answer shows the referral and no Waves sales card', async () => {
    assert.ok(ANSWERS.referral, 'the catalog has an approved entry with a referral');
    await reset();
    answerWith(ANSWERS.referral);
    await panel.setInputFiles('#file', join(PHOTOS, 'wolf-spider.jpg'));
    await headline.waitFor();
    assert.ok(await panel.locator('#result .referral').isVisible());
    assert.equal(await panel.locator('#result .waves').count(), 0);
  });

  await check('crop math: screenshot pixels follow the viewport scale (DPR / zoom)', async () => {
    const out = await panel.evaluate(async () => {
      const { toJpegPhoto } = await import('./lib/image.js');
      // A 200x100 "screenshot" of a 100x50 viewport (device pixel ratio 2):
      // left half red, right half blue.
      const shot = new OffscreenCanvas(200, 100);
      const ctx = shot.getContext('2d');
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 100, 100);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(100, 0, 100, 100);
      const photo = await toJpegPhoto(await shot.convertToBlob(), { x: 60, y: 10, width: 30, height: 30, viewportW: 100 });
      const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${photo.data}`)).blob());
      const probe = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      probe.drawImage(bitmap, 0, 0);
      return { width: photo.width, height: photo.height, rgb: Array.from(probe.getImageData(30, 30, 1, 1).data).slice(0, 3) };
    });
    assert.equal(out.width, 60);
    assert.equal(out.height, 60);
    assert.ok(out.rgb[2] > 200 && out.rgb[0] < 60, `expected blue, got ${out.rgb}`);
  });

  await check('page selector: drag reports the box, then removes itself; Esc cancels', async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`http://127.0.0.1:${site.address().port}/`);
    const inject = async () => {
      await page.evaluate(() => {
        window.__sent = [];
        window.chrome = window.chrome || {};
        window.chrome.runtime = { sendMessage: (message) => window.__sent.push(message) };
      });
      await page.addScriptTag({ path: join(EXT, 'content', 'select-region.js') });
    };
    await inject();
    await page.mouse.move(560, 90);
    await page.mouse.down();
    await page.mouse.move(860, 560, { steps: 8 });
    await page.screenshot({ path: join(OUT, '2-select-on-page.png') });
    await page.mouse.up();
    await page.waitForFunction(() => window.__sent.length === 1);
    const [message] = await page.evaluate(() => window.__sent);
    assert.deepEqual(message, { type: 'bugid:region', rect: { x: 560, y: 90, width: 300, height: 470, viewportW: 1280 } });
    assert.equal(await page.evaluate(() => window.__wavesBugIdSelect), undefined, 'overlay flag cleared');
    assert.equal(await page.evaluate(() => document.documentElement.lastElementChild.tagName), 'BODY', 'overlay removed');
    await inject();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__sent.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__sent[0]), { type: 'bugid:region-cancel' });
    await page.close();
  });

  // ── store images ──
  await check('store screenshots (1280x800) and small promo tile (440x280)', async () => {
    const stage = await context.newPage();
    const photo = dataUrl(await photoB64('golden-silk-orbweaver.jpg'), 'image/jpeg');
    const shots = [
      ['1-identify.png', 'panel-result.png', 'Identify bugs, spiders and insects', 'Right-click any image on the web, or drop in your own photo.'],
      ['3-start.png', 'panel-start.png', 'Free bug ID, right in Chrome', 'From a licensed Florida pest control company.'],
    ];
    await stage.setViewportSize({ width: 1280, height: 800 });
    for (const [file, panelShot, title, sub] of shots) {
      const panelImg = dataUrl((await readFile(join(SCRATCH, panelShot))).toString('base64'), 'image/png');
      await stage.setContent(`<!doctype html><body style="margin:0;width:1280px;height:800px;box-sizing:border-box;padding:40px 56px;display:flex;gap:48px;align-items:center;background:linear-gradient(135deg,#1B2C5B 0%,#0d5f8a 60%,#009CDE 100%);font-family:Inter,system-ui,sans-serif;color:#fff">
        <div style="flex:1;display:flex;flex-direction:column;gap:18px">
          <h1 style="margin:0;font-size:46px;line-height:1.08;font-weight:800">${title}</h1>
          <p style="margin:0;font-size:21px;color:#cdeefb">${sub}</p>
          <img src="${photo}" style="width:100%;height:420px;object-fit:cover;border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.35)">
        </div>
        <img src="${panelImg}" style="width:${PANEL.width}px;height:${PANEL.height - 40}px;object-fit:cover;object-position:top;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.4)">
      </body>`);
      await stage.screenshot({ path: join(OUT, file) });
    }
    const icon = dataUrl((await readFile(join(EXT, 'icons', 'icon-128.png'))).toString('base64'), 'image/png');
    await stage.setViewportSize({ width: 440, height: 280 });
    await stage.setContent(`<!doctype html><body style="margin:0;width:440px;height:280px;display:flex;align-items:center;gap:8px;padding:0 28px;box-sizing:border-box;background:linear-gradient(135deg,#1B2C5B,#009CDE);font-family:Inter,system-ui,sans-serif;color:#fff">
      <img src="${icon}" width="128" height="128">
      <div><div style="font-size:34px;font-weight:800;line-height:1.05">Bug Identifier</div>
      <div style="font-size:16px;color:#FFD700;font-weight:700;margin-top:8px">Insect &amp; spider ID by Waves</div></div>
    </body>`);
    await stage.screenshot({ path: join(OUT, 'promo-small-440x280.png') });
    await stage.close();
  });
} finally {
  await context.close();
  site.close();
  await rm(userDataDir, { recursive: true, force: true });
  await rm(SCRATCH, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed — images in ${OUT}`);
process.exit(failures ? 1 : 0);
