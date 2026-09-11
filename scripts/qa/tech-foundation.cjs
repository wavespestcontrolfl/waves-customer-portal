'use strict';
/* global window, document, getComputedStyle, innerWidth, innerHeight, matchMedia, scrollTo */
// Actual Tech route, entirely synthetic APIs. No customer/provider requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require('playwright');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const baseline = process.argv.includes('--baseline');
const output = path.join(root, '.tmp/tech-foundation', baseline ? 'baseline' : 'current');
const user = { id: 'fixture-tech', role: 'technician', name: 'Fixture operator' };
const product = { id: 1, name: 'Example gel', category: 'Insecticide', default_rate: '0.1-0.5', default_unit: 'g/spot' };
const photoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const photoPreview = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#d8e3df"/><path d="M0 270H640V400H0Z" fill="#7a9b82"/><path d="M70 290V105H570V290" fill="#adbbb5" stroke="#506963" stroke-width="12"/><path d="M155 110V290M240 110V290M325 110V290M410 110V290M495 110V290" stroke="#d8e3df" stroke-width="9"/><rect x="85" y="22" width="470" height="58" rx="8" fill="#0f1923"/><text x="320" y="60" text-anchor="middle" fill="#e2e8f0" font-family="sans-serif" font-size="26">Synthetic photo fixture</text></svg>').toString('base64')}`;
const services = [
  { id: 'visit-a', customerId: 'customer-a', customerName: 'Avery Example', status: 'on_site',
    technicianId: user.id, address: '100 Example Court, Example City, FL 34201',
    serviceType: 'Quarterly Pest Control', completionProfile: { category: 'pest_control' }, windowStart: '14:00', windowEnd: '16:00',
    propertyAlerts: [{ type: 'access', text: 'Use the side gate. Dogs secured indoors.' }],
    traceEligible: false, billingLane: { prediction: { kind: 'prepaid', amount: 0 } } },
  { id: 'visit-b', customerId: 'customer-b', customerName: 'Jordan Example', status: 'on_site',
    technicianId: user.id, address: '200 Example Court, Example City, FL 34201',
    serviceType: 'Quarterly Pest Control', completionProfile: { category: 'pest_control' }, windowStart: '16:00', windowEnd: '18:00', traceEligible: false },
];

function writeGallery(report) {
  const titles = { today: 'Today', 'access-plan': 'Access and approved plan', photos: 'Visit photos',
    'actual-treatment': 'Record actual treatment', recovery: 'Restore the visit draft', 'manual-complete': 'Complete without AI',
    completed: 'Completed visit', 'photo-pending': 'Upload pending', 'photo-error': 'Retry the selected photo',
    'photo-saved': 'Photo saved', 'photo-list-error': 'Retry an unavailable photo list', 'completion-pending': 'Completion pending',
    'completion-error': 'Draft retained after failure', 'photos-completed': 'Photos attached to the completed visit', 'photo-marking': 'Optional photo marking' };
  const pair = (name) => `<section id="${name}"><h2>${titles[name]}</h2><div class="pair">${['desktop', 'mobile'].map((device) => `<figure><figcaption>${device === 'desktop' ? 'Desktop · Chromium' : 'Phone · WebKit'}</figcaption><a href="current/${device}-${name}.png"><img loading="lazy" src="current/${device}-${name}.png" alt="${titles[name]} — ${device}"></a></figure>`).join('')}</div></section>`;
  const primary = ['today', 'access-plan', 'photos', 'actual-treatment', 'recovery', 'manual-complete', 'completed'];
  const checks = Object.keys(titles).filter((name) => !primary.includes(name));
  fs.writeFileSync(path.join(root, '.tmp/tech-foundation/review.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tech visit workflow review</title><style>
    *{box-sizing:border-box}body{margin:0;background:#0f1923;color:#e2e8f0;font:16px/1.55 system-ui,sans-serif}main{max-width:1320px;margin:auto;padding:28px}h1{font-size:30px;margin-bottom:8px}h2{font-size:21px;margin:28px 0 12px}p,figcaption{color:#94a3b8}a{color:#7dd3fc}nav{display:flex;flex-wrap:wrap;gap:18px;margin:24px 0}section{scroll-margin-top:20px}.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,390px);gap:24px;align-items:start}figure{margin:0}figcaption{margin-bottom:8px;font-size:14px}img{display:block;max-width:100%;height:auto;border:1px solid #334155;border-radius:12px}details{margin:36px 0;border-top:1px solid #334155;padding-top:20px}summary{cursor:pointer;font-size:19px}.meta{font-size:14px} @media(max-width:800px){main{padding:18px}.pair{grid-template-columns:1fr}figure{max-width:100%}}
    </style><main><h1>Tech visit workflow</h1><p>Local review with sample data. Shared controls, Tech's own presentation, and visit recovery.</p><p><a href="https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4180">View the estimate builder review</a></p><p class="meta">48 layout checks · Desktop and phone workflows passed · Browser source ${report.sha.slice(0, 10)}</p><nav>${primary.map((name) => `<a href="#${name}">${titles[name]}</a>`).join('')}</nav>${primary.map(pair).join('')}<details><summary>Failure, retry and nested-dialog checks</summary>${checks.map(pair).join('')}</details><p class="meta">No live customer or provider request was made. Pending photos require the dialog to stay open; device draft storage can recover recap text and actual rates. Physical camera, keyboard and home-screen behavior still need device checks.</p></main></html>`);
}
async function main() {
  if (!baseline) fs.rmSync(path.join(root, '.tmp/tech-foundation/review.html'), { force: true });
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), baseline, passed: false, scenarios: [], screenshots: [] };
  let server;
  try {
    server = await previewServer(root, process.argv.find((arg) => arg.startsWith('http://')));
    for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const browser = device === 'desktop' ? await launchBrowser() : await webkit.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport, hasTouch: device === 'mobile', timezoneId: 'America/New_York', serviceWorkers: 'block' });
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
        const state = { device, errors: [], consoleErrors: [], injectedFailures: [], photoRequests: [], unmatched: [], writes: [], geometry: [], passed: false };
        report.scenarios.push(state);
        const rows = structuredClone(services), photosByVisit = new Map(rows.map((service) => [service.id, []])), completed = new Map();
        const marksByVisit = new Map(rows.map((service) => [service.id, {}]));
        let activeVisit = 'visit-a';
        let failPhoto = true, failCompletion = true, releasePhoto, releaseCompletion, marksEnabled = false, failPhotoList = false;
        const pendingPhoto = new Promise((resolve) => { releasePhoto = resolve; });
        const pendingCompletion = new Promise((resolve) => { releaseCompletion = resolve; });
        await page.addInitScript((profile) => {
          localStorage.setItem('waves_admin_token', 'synthetic-local-token');
          localStorage.setItem('waves_admin_user', JSON.stringify(profile));
          if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
          const originalFetch = window.fetch.bind(window);
          window.fetch = (input, options) => String(input).endsWith('/admin/usage/track')
            ? Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
            : originalFetch(input, options);
        }, user);
        page.on('pageerror', (error) => state.errors.push(error.message));
        page.on('console', (message) => { if (message.type() === 'error') state.consoleErrors.push({ text: message.text(), url: message.location().url }); });
        const routes = new Map(Object.entries({
          '/api/admin/auth/me': user,
          '/api/admin/feature-flags': { flags: {} },
          '/api/tech/staff-documents/availability': { available: false },
          '/api/admin/schedule': { services: rows },
          '/api/tech/notifications': { notifications: [] },
          '/api/tech/line': { line: null },
          '/api/admin/intelligence-bar/quick-actions': { actions: [] },
          '/api/tech/timetracking/status': { clockedIn: true, currentJob: { jobId: 'visit-a' }, todaySummary: { shiftMinutes: 120, jobCount: 1 } },
          '/api/tech/timetracking/pending-signoff': { pending: false },
        }).map(([endpoint, response]) => [`GET ${endpoint}`, () => ({ response })]));
        for (const service of rows) {
          const photos = photosByVisit.get(service.id);
          const schedule = `/api/admin/schedule/${service.id}`;
          const recap = `/api/admin/dispatch/${service.id}/pest-recap`;
          const photoPath = `/api/tech/services/${service.id}`;
          routes.set(`GET ${schedule}/estimate-source`, () => ({ response: {
            linked: true, estimateId: 'estimate-example', estimateSlug: 'EXAMPLE-001',
            lines: [{ name: 'Quarterly Pest Control', cadence: 'quarterly', perApplicationPrice: 95 }], payment: { billingTerm: 'per_service' },
          } }));
          routes.set(`GET ${schedule}/visit-brief`, () => ({ response: { brief: null, facts: {
            access: { codes: { propertyGate: 'EXAMPLE 1234' }, pets: 'Dogs secured indoors', accessNotes: 'Use the side gate.', alerts: [] },
            last_visit: { date: '2026-06-02', type: 'Quarterly Pest Control', products: [{ name: 'Prior example product' }] },
          } } }));
          routes.set(`GET ${recap}/context`, () => ({ response: {
            service: { ...service, hasPhone: false }, products: [product], existingRecord: completed.get(service.id) || null,
            timeline: [{ to_status: 'on_site', transitioned_at: '2026-09-08T18:00:00Z' }],
          } }));
          routes.set(`POST ${recap}/draft`, () => ({ status: 503, response: { error: 'Example AI unavailable. Complete manually.' } }));
          routes.set(`POST ${recap}`, async (body) => {
            if (failCompletion) {
              await pendingCompletion; failCompletion = false;
              return { status: 503, response: { error: 'Example completion failed. Your draft is retained.' } };
            }
            completed.set(service.id, { technician_notes: body.technicianNotes, products: body.products });
            service.status = 'completed';
            photos.forEach((photo) => { photo.staged = false; });
            return { response: { ok: true } };
          });
          routes.set(`GET ${photoPath}/photo-marks`, () => ({ response: {
            supported: marksEnabled, kinds: [{ kind: 'foam_injection', label: 'Example treated point' }], defaultKind: 'foam_injection', marksByS3Key: marksByVisit.get(service.id),
          } }));
          routes.set(`PUT ${photoPath}/photo-marks`, (body) => {
            marksByVisit.get(service.id)[body.s3Key] = structuredClone(body.marks);
            return { response: { marks: body.marks } };
          });
          routes.set(`GET ${photoPath}/photos`, () => failPhotoList
            ? { status: 503, response: { error: 'Example photo list unavailable.' } }
            : { response: { photos } });
          routes.set(`POST ${photoPath}/photos`, async () => {
            if (failPhoto) {
              await pendingPhoto; failPhoto = false;
              return { status: 503, response: { error: 'Example photo upload failed.' } };
            }
            photos.push({ id: 'photo-example', photo_type: 'before', caption: 'Example side gate before treatment', staged: true, url: photoPreview });
            return { response: { photo: photos[0] } };
          });
        }
        await page.route('**/*', async (route) => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
          if (!url.pathname.startsWith('/api/')) return route.continue();
          const method = request.method(), endpoint = url.pathname;
          const photoVisit = endpoint.match(/^\/api\/tech\/services\/([^/]+)\/(?:photos|photo-marks)$/)?.[1];
          if (photoVisit) state.photoRequests.push({ endpoint, method, visitId: photoVisit, expectedVisitId: activeVisit });
          const body = method === 'GET' ? null : request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : request.postData();
          if (method !== 'GET') state.writes.push({ endpoint, method, body });
          const handler = routes.get(`${method} ${endpoint}`);
          if (!handler) {
            state.unmatched.push({ endpoint, method });
            return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'Unmatched synthetic endpoint' }) });
          }
          const { response, status = 200 } = await handler(body);
          if (status === 503) state.injectedFailures.push(request.url());
          return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) });
        });
        async function screenshot(name, locator) {
          if (locator) await locator.scrollIntoViewIfNeeded();
          await waitForFonts(page);
          const file = path.join(output, `${device}-${name}.png`);
          await page.screenshot({ path: file });
          const relative = path.relative(root, file);
          if (!report.screenshots.includes(relative)) report.screenshots.push(relative);
        }
        async function geometry(dialog, surface) {
          for (const [width, height] of [[390, 844], [700, 900], [820, 1180], [1024, 768], [1440, 1000], [844, 390]]) {
            await page.setViewportSize({ width, height });
            const measured = await dialog.evaluate((node, kind) => {
              // The legacy Intelligence Bar retains its separate UX scope.
              const legacyBar = kind === 'today' ? node.querySelector('#tech-intelligence-prompt')?.parentElement.parentElement : null;
              const controls = [...node.querySelectorAll('button,input,textarea,select')].filter((control) => control.getBoundingClientRect().height > 0 && !legacyBar?.contains(control));
              const describe = (control) => ({ name: control.getAttribute('aria-label') || control.labels?.[0]?.textContent.trim() || control.textContent.trim(), height: control.getBoundingClientRect().height, size: parseFloat(getComputedStyle(control).fontSize) });
              const rect = node.getBoundingClientRect();
              return { width: innerWidth, height: innerHeight, coarse: matchMedia('(any-pointer: coarse)').matches,
                overflow: node.scrollWidth > node.clientWidth || document.documentElement.scrollWidth > innerWidth,
                outsideViewport: rect.top < 0 || rect.bottom > innerHeight + 1,
                shortTargets: controls.filter((control) => control.type !== 'checkbox').map(describe).filter((control) => control.height < 48),
                smallFields: controls.filter((control) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(control.tagName) && control.type !== 'checkbox').map(describe).filter((control) => control.size < 16),
                unlabelled: controls.map(describe).filter((control) => !control.name),
                shortChoices: controls.filter((control) => control.type === 'checkbox').filter((control) => control.labels[0].getBoundingClientRect().height < 48).map(describe),
              };
            }, surface);
            state.geometry.push({ surface, ...measured });
            assert.equal(measured.overflow, false, `${device} ${surface} ${width}px overflow`);
            if (surface !== 'today') assert.equal(measured.outsideViewport, false);
            for (const key of ['shortTargets', 'smallFields', 'unlabelled', 'shortChoices']) assert.deepEqual(measured[key], [], `${device} ${surface} ${width}px ${key}`);
          }
          await page.setViewportSize(viewport);
        }
        await page.goto(`${server.baseUrl}/tech`);
        const stop = page.getByRole('button', { name: /Avery Example.*on site/ });
        await stop.waitFor();
        await screenshot('today');
        {
          await geometry(page.locator('main'), 'today');
          const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
          if (await dismiss.count()) {
            await screenshot('install-hint', dismiss);
            await dismiss.click();
            await page.evaluate(() => scrollTo(0, 0));
            await screenshot('today');
          }
        }
        await stop.click();
        await page.getByText('EXAMPLE 1234', { exact: true }).waitFor();
        await screenshot('visit', stop);
        await page.getByText('EXAMPLE 1234', { exact: true }).evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await screenshot('access-plan');
        assert.equal(await page.getByText('Quoted · EXAMPLE-001', { exact: true }).count(), 1);
        assert.equal(await page.getByRole('link', { name: 'Estimate', exact: true }).count(), 0, 'Owner-only quoting stays hidden for technicians');
        await page.getByRole('button', { name: /Photos/, exact: false }).click();
        await page.getByText('No photos yet.', { exact: true }).waitFor();
        await screenshot('photos');
        {
          const dialog = page.getByRole('dialog', { name: 'Service Photos', exact: true });
          await geometry(dialog, 'photos');
          await dialog.getByRole('button', { name: 'before', exact: true }).click();
          await dialog.getByRole('textbox', { name: 'Caption (optional)', exact: true }).fill('Example side gate before treatment');
          await dialog.getByLabel('Choose service photo').setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: photoBytes });
          await dialog.getByText('Uploading photo…', { exact: true }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Close service photos', exact: true }).isDisabled(), true);
          await page.keyboard.press('Escape');
          assert.equal(await dialog.count(), 1);
          await screenshot('photo-pending', dialog.getByText('Uploading photo…', { exact: true }));
          releasePhoto();
          await dialog.getByText('Example photo upload failed.', { exact: true }).waitFor();
          await screenshot('photo-error', dialog.getByRole('button', { name: 'Retry upload', exact: true }));
          await dialog.getByRole('button', { name: 'Retry upload', exact: true }).click();
          await dialog.getByText(/Photo saved — it will attach/).waitFor();
          await dialog.getByText('Attached (1)', { exact: true }).waitFor();
          const uploads = state.writes.filter((write) => write.endpoint.endsWith('/photos'));
          assert.equal(uploads.length, 2);
          for (const upload of uploads) {
            assert.equal(upload.endpoint, '/api/tech/services/visit-a/photos');
            assert.ok(upload.body.includes('Example side gate before treatment'));
            assert.ok(upload.body.includes('name="photoType"\r\n\r\nbefore'));
            assert.ok(upload.body.includes('filename="example.png"'));
          }
          await screenshot('photo-saved', dialog.getByText('Attached (1)', { exact: true }));
          await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('button', { name: /Photos/ }).evaluate((node) => node === document.activeElement), true);
          failPhotoList = true;
          await page.getByRole('button', { name: /Photos/ }).click();
          await dialog.getByText('Example photo list unavailable.', { exact: true }).waitFor();
          assert.equal(await dialog.getByText('No photos yet.', { exact: true }).count(), 0);
          await screenshot('photo-list-error', dialog.getByRole('button', { name: 'Retry photos', exact: true }));
          failPhotoList = false;
          await dialog.getByRole('button', { name: 'Retry photos', exact: true }).click();
          await dialog.getByText('Attached (1)', { exact: true }).waitFor();
        }
        await page.getByRole('button', { name: /Close|×/, exact: false }).last().click();
        await page.getByRole('button', { name: '🗂️ Report', exact: true }).click();
        await page.getByRole('button', { name: 'Example gel', exact: true }).waitFor();
        await screenshot('recap');
        {
          const dialog = page.getByRole('dialog', { name: 'Service Recap', exact: true });
          const note = dialog.getByRole('textbox', { name: 'What did you do?', exact: true });
          await note.fill('Actual treatment recorded manually for Avery only.');
          await dialog.getByRole('button', { name: 'Example gel', exact: true }).click();
          await dialog.getByRole('spinbutton', { name: 'Application rate for Example gel', exact: true }).fill('0.4');
          await dialog.getByRole('textbox', { name: 'Message to customer', exact: true }).fill('Manual recap retained for this visit.');
          await dialog.getByText('Draft saved on this device. Not submitted.', { exact: true }).waitFor();
          await screenshot('actual-treatment', dialog.getByRole('spinbutton'));
          await geometry(dialog, 'recap');
          const close = dialog.getByRole('button', { name: 'Close', exact: true });
          await close.focus();
          await page.keyboard.press('Shift+Tab');
          assert.equal(await dialog.getByRole('button', { name: 'Complete Service', exact: true }).evaluate((node) => node === document.activeElement), true);
          state.choiceAppearance = await dialog.getByRole('checkbox', { name: 'Include recent customer calls/texts/emails', exact: true }).evaluate((node) => ({ checked: node.checked, content: getComputedStyle(node, '::after').content, border: getComputedStyle(node, '::after').borderRightWidth, borderStyle: getComputedStyle(node, '::after').borderRightStyle }));
          assert.ok(parseFloat(state.choiceAppearance.border) > 0, 'Selected checkboxes must have a visible check stroke');
          assert.equal(state.choiceAppearance.borderStyle, 'solid');
          await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('button', { name: '🗂️ Report', exact: true }).evaluate((node) => node === document.activeElement), true);
          activeVisit = 'visit-b';
          await page.getByRole('button', { name: /Jordan Example.*on site/ }).click();
          await page.getByRole('button', { name: '🗂️ Report', exact: true }).click();
          await dialog.getByRole('button', { name: 'Example gel', exact: true }).waitFor();
          assert.equal(await note.inputValue(), '');
          assert.equal(await dialog.getByRole('button', { name: 'Restore draft', exact: true }).count(), 0);
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: /Photos/ }).click();
          await page.getByRole('dialog', { name: 'Service Photos', exact: true }).getByText('No photos yet.', { exact: true }).waitFor();
          await page.keyboard.press('Escape');
          activeVisit = 'visit-a';
          await stop.click();
          await page.getByRole('button', { name: '🗂️ Report', exact: true }).click();
          await dialog.getByRole('button', { name: 'Restore draft', exact: true }).click();
          assert.equal(await note.inputValue(), 'Actual treatment recorded manually for Avery only.');
          await page.reload();
          await stop.click();
          await page.getByRole('button', { name: '🗂️ Report', exact: true }).click();
          await screenshot('recovery', dialog.getByRole('button', { name: 'Restore draft', exact: true }));
          await dialog.getByRole('button', { name: 'Restore draft', exact: true }).click();
          assert.equal(await note.inputValue(), 'Actual treatment recorded manually for Avery only.');
          assert.equal(await dialog.getByRole('spinbutton', { name: 'Application rate for Example gel', exact: true }).inputValue(), '0.4');
          await dialog.getByRole('button', { name: /Draft with AI/ }).click();
          await dialog.getByText('Example AI unavailable. Complete manually.', { exact: true }).waitFor();
          assert.equal(await dialog.getByRole('textbox', { name: 'Message to customer', exact: true }).inputValue(), 'Manual recap retained for this visit.');
          const complete = dialog.getByRole('button', { name: 'Complete Service', exact: true });
          await screenshot('manual-complete', complete);
          const before = await complete.boundingBox();
          await complete.click();
          await dialog.getByText('Saving completion… Keep this visit open.', { exact: true }).waitFor();
          const pending = await complete.boundingBox();
          assert.equal(before.width, pending.width);
          assert.equal(before.height, pending.height);
          assert.equal(await note.isDisabled(), true);
          assert.equal(await close.isDisabled(), true);
          await complete.evaluate((node) => node.click());
          assert.equal(state.writes.filter((write) => write.endpoint.endsWith('/pest-recap')).length, 1);
          await page.keyboard.press('Escape');
          await page.keyboard.press('Tab');
          assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true);
          await screenshot('completion-pending', dialog.getByText('Saving completion… Keep this visit open.', { exact: true }));
          releaseCompletion();
          await dialog.getByText('Example completion failed. Your draft is retained.', { exact: true }).waitFor();
          assert.equal(await note.inputValue(), 'Actual treatment recorded manually for Avery only.');
          await screenshot('completion-error', complete);
          await complete.click();
          await dialog.waitFor({ state: 'detached' });
          const completedStop = page.getByRole('button', { name: /Avery Example.*completed/i });
          await completedStop.waitFor();
          const writes = state.writes.filter((write) => write.endpoint.endsWith('/pest-recap'));
          assert.equal(writes.length, 2);
          assert.deepEqual(writes[0].body, writes[1].body);
          assert.equal(writes[1].body.sendSms, false);
          assert.equal(writes[1].body.products[0].application_rate, 0.4);
          assert.equal(writes[1].body.products[0].rate_unit, 'g/spot');
          assert.equal(await page.evaluate(() => localStorage.getItem('waves_completion_draft_visit-a_recap_fixture-tech_technician')), null);
          await screenshot('completed', completedStop);
          if (await completedStop.getAttribute('aria-expanded') !== 'true') await completedStop.click();
          await page.getByRole('button', { name: /Photos/ }).click();
          const photoDialog = page.getByRole('dialog', { name: 'Service Photos', exact: true });
          await photoDialog.getByText('Attached (1)', { exact: true }).waitFor();
          assert.equal(await photoDialog.getByText('before · staged', { exact: true }).count(), 0);
          await screenshot('photos-completed', photoDialog.getByText('Attached (1)', { exact: true }));
          // The next read also supplies an eligible after-photo fixture to
          // exercise the existing optional marking gate and nested dialog.
          marksEnabled = true;
          photosByVisit.get('visit-a').push({ id: 'photo-after-example', s3_key: 'synthetic/after.jpg', photo_type: 'after',
            caption: 'Example completed treatment area', url: photoPreview });
          await page.keyboard.press('Escape');
          await page.getByRole('button', { name: /Photos/ }).click();
          const mark = photoDialog.getByRole('button', { name: 'Mark spots', exact: true });
          await mark.click();
          const marks = page.getByRole('dialog', { name: 'Mark treated spots', exact: true });
          await marks.getByRole('button', { name: 'Example treated point', exact: true }).waitFor();
          assert.equal(await marks.evaluate((node) => node.contains(document.activeElement)), true);
          await geometry(marks, 'marking');
          await screenshot('photo-marking');
          await page.keyboard.press('Escape');
          await marks.waitFor({ state: 'detached' });
          assert.equal(await mark.evaluate((node) => node === document.activeElement), true);
          assert.equal(await photoDialog.count(), 1);
          await mark.click();
          await marks.getByRole('img', { name: 'Treated area', exact: true }).click();
          await marks.getByText('1 mark', { exact: true }).waitFor();
          await marks.getByRole('button', { name: 'Save marks', exact: true }).click();
          await marks.waitFor({ state: 'detached' });
          const markWrites = state.writes.filter((write) => write.endpoint.endsWith('/photo-marks'));
          assert.equal(markWrites.length, 1);
          assert.equal(markWrites[0].endpoint, '/api/tech/services/visit-a/photo-marks');
          assert.equal(markWrites[0].method, 'PUT');
          assert.equal(markWrites[0].body.s3Key, 'synthetic/after.jpg');
          assert.equal(markWrites[0].body.marks.length, 1);
          assert.equal(markWrites[0].body.marks[0].kind, 'foam_injection');
          assert.ok(Math.abs(markWrites[0].body.marks[0].x - 0.5) < 0.01);
          assert.ok(Math.abs(markWrites[0].body.marks[0].y - 0.5) < 0.01);
          await mark.click();
          await marks.getByText('1 mark', { exact: true }).waitFor();
          await page.keyboard.press('Escape');
          assert.deepEqual(marksByVisit.get('visit-b'), {}, 'The second visit must retain its separate empty marks');
          state.pendingCompletion = { width: pending.width, height: pending.height, duplicateSuppressed: true };
          const resourceError = 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';
          assert.deepEqual(state.consoleErrors.filter(({ text, url }) => text !== resourceError || !state.injectedFailures.includes(url)), []);
          assert.ok(state.photoRequests.every(({ visitId, expectedVisitId }) => visitId === expectedVisitId), 'Photo requests must use the active visit');
          assert.deepEqual(photosByVisit.get('visit-b'), [], 'The second visit must retain its separate empty photo list');
          assert.ok(state.writes.every((write) => !/\/sms$|\/call$|\/send$/.test(write.endpoint)));
        }
        assert.deepEqual(state.errors, []);
        assert.deepEqual(state.unmatched, []);
        assert.equal(report.screenshots.length, new Set(report.screenshots).size, 'Screenshot inventory must contain unique files');
        state.passed = true;
        console.log(`Tech workflow complete: ${device}`);
      } finally { await browser.close(); }
    }
    report.passed = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    try {
      await server?.close();
      if (!baseline && report.passed) writeGallery(report);
    } catch (error) {
      report.passed = false;
      report.finalizationFailure = { name: error.name, message: error.message };
      if (!baseline) fs.rmSync(path.join(root, '.tmp/tech-foundation/review.html'), { force: true });
      throw error;
    } finally {
      const reportPath = path.join(output, 'report.json');
      try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
      catch (error) {
        report.passed = false;
        if (!baseline) fs.rmSync(path.join(root, '.tmp/tech-foundation/review.html'), { force: true });
        fs.rmSync(reportPath, { force: true });
        throw error;
      }
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
