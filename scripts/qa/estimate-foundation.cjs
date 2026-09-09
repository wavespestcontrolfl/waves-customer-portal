'use strict';
// Actual admin routes with synthetic API responses. No database, customer,
// pricing service, provider send, or other external request is reached.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require('playwright');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const baseline = process.argv.includes('--baseline');
const output = path.join(root, '.tmp/estimate-foundation', baseline ? 'baseline' : 'current');
const result = {
  recurring: { tier: 'Bronze', serviceCount: 1, monthlyTotal: 50, grandTotal: 50, annualAfterDiscount: 600,
    services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600 }] },
  oneTime: { total: 99, items: [{ service: 'pest_initial', name: 'Initial service', price: 99 }] },
  results: {}, totals: { year2mo: 50, year1: 699, year2: 600 },
};
const source = {
  id: 'estimate-example-a', status: 'draft', editable: true, editVersion: 'version-a',
  customerId: 'customer-example-a', customerName: 'Avery Example', customerPhone: '+19415550100',
  customerEmail: 'avery@example.invalid', address: '100 Example Court, Example City, FL 34201',
  notes: 'Notes for Avery only.', propertyId: 'property-example-a',
  inputs: { svcPest: true, homeSqFt: '2000', lotSqFt: '6000',
    manualDiscountPreset: '__custom__', manualDiscountType: 'FIXED', manualDiscountValue: '25',
    manualDiscountLabel: 'Customer-specific credit', manualDiscountInternalReason: 'First customer only',
    serviceSpecificDiscountKeys: ['first-customer-credit'] },
  engineRequest: { profile: { homeSqFt: 2000, lotSqFt: 6000 }, selectedServices: ['PEST'], options: { pestTier: 'quarterly' } },
  result, token: 'synthetic-example-token', updatedAt: '2026-09-08T15:00:00Z',
};

async function main() {
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
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(60000);
        const state = { device, errors: [], consoleErrors: [], unmatched: [], reads: [], writes: [], geometry: [], passed: false };
        report.scenarios.push(state);
        const records = new Map([[source.id, structuredClone(source)]]);
        let failCreate = true;
        let releaseCreate;
        const pendingCreate = new Promise((resolve) => { releaseCreate = resolve; });
        let releaseCalculation;
        const pendingCalculation = new Promise((resolve) => { releaseCalculation = resolve; });
        let conflictRevision = false;
        await page.addInitScript(() => {
          localStorage.setItem('waves_admin_token', 'synthetic-local-token');
          localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', role: 'admin', name: 'Fixture operator' }));
          if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
          const originalFetch = window.fetch.bind(window);
          window.fetch = (input, options) => new URL(String(input), window.location.href).href === `${window.location.origin}/api/admin/usage/track` && options?.method === 'POST'
            ? Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
            : originalFetch(input, options);
        });
        page.on('pageerror', (error) => state.errors.push(error.message));
        page.on('console', (message) => { if (message.type() === 'error') state.consoleErrors.push({ text: message.text(), url: message.location().url }); });
        await page.route('**/*', async (route) => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
          if (!url.pathname.startsWith('/api/')) return route.continue();
          const method = request.method(), endpoint = url.pathname;
          const body = method === 'GET' ? null : request.postDataJSON();
          if (method === 'GET') state.reads.push({ endpoint, method });
          else state.writes.push({ endpoint, method, body });
          let response, status = 200;
          if (endpoint === '/api/admin/auth/me') response = { id: 'fixture-user', role: 'admin', name: 'Fixture operator' };
          else if (endpoint === '/api/admin/feature-flags') response = { flags: {} };
          else if (endpoint.endsWith('/unread-count')) response = { count: 0, conversations: 0 };
          else if (endpoint === '/api/admin/discounts') response = [];
          else if (endpoint.startsWith('/api/admin/pricing-config/')) response = { data: null, featureAvailable: false, subFeaturesAvailable: {} };
          else if (endpoint === '/api/admin/customers') response = { customers: [] };
          else if (endpoint === '/api/admin/triage') response = { items: [] };
          else if (endpoint.endsWith('/properties')) response = { properties: [] };
          else if (endpoint.includes('/estimates/customer-spend/')) response = { services: [] };
          else if (endpoint.endsWith('/group')) response = { estimates: [] };
          else if (endpoint === '/api/admin/estimator/turf-preview') response = { turfSf: 4000 };
          else if (endpoint === '/api/admin/estimator/calculate-estimate') {
            await pendingCalculation;
            response = structuredClone(result);
          }
          else if (endpoint.endsWith('/edit-source')) response = records.get(endpoint.split('/').at(-2));
          else if (endpoint.endsWith('/send-preview')) {
            const record = records.get(endpoint.split('/').at(-2));
            response = { ...record, previewPath: '/preview-estimate.html?scenario=pest',
              customerUrl: `${server.baseUrl}/preview-estimate.html?scenario=pest`, messageVersion: 'message-example-v1', groupVersions: [],
              messages: { sms: 'A fictional estimate preview for the selected recipient.', email: { subject: 'Example estimate', text: 'A fictional estimate email preview.' } } };
          } else if (endpoint === '/api/admin/estimates' && method === 'POST') {
            if (failCreate) {
              await pendingCreate;
              failCreate = false; status = 503; response = { error: 'Example save failed. Please retry.' };
            }
            else {
              const record = { ...body, id: 'estimate-example-created', status: 'draft', editable: true,
                editVersion: 'created-v1', token: 'synthetic-created-token', updatedAt: source.updatedAt,
                inputs: body.estimateData.inputs, result: body.estimateData.result, engineRequest: body.estimateData.engineRequest };
              records.set(record.id, record); response = record;
            }
          } else if (endpoint.startsWith('/api/admin/estimates/') && method === 'PUT') {
            if (conflictRevision) return route.fulfill({ status: 409, contentType: 'application/json',
              body: JSON.stringify({ error: 'This example changed in another editor. Reopen the saved estimate.' }) });
            const id = endpoint.split('/').at(-1), prior = records.get(id);
            assert.equal(body.expectedEditVersion, prior.editVersion, 'The current revision must be sent');
            const record = { ...prior, ...body, editVersion: `${prior.editVersion}-next`,
              inputs: body.estimateData.inputs, result: body.estimateData.result, engineRequest: body.estimateData.engineRequest };
            if (!body.dryRun) records.set(id, record);
            response = record;
          }
          if (response === undefined) { state.unmatched.push({ endpoint, method }); response = {}; }
          return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) });
        });
        async function screenshot(name, locator) {
          if (locator) await locator.scrollIntoViewIfNeeded();
          await waitForFonts(page);
          const file = path.join(output, `${device}-${name}.png`);
          await page.screenshot({ path: file });
          report.screenshots.push(path.relative(root, file));
        }
        await page.goto(`${server.baseUrl}/admin/estimates?tab=new`);
        await page.getByRole('heading', { name: 'Create estimate', exact: true }).waitFor();
        assert.equal(new URL(page.url()).pathname, '/admin/pipeline', 'The existing redirect remains authoritative');
        await screenshot('create');
        await page.getByRole('textbox', { name: 'Customer name', exact: true }).fill('Avery Example');
        await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('+19415550100');
        await page.getByRole('textbox', { name: 'Email', exact: true }).fill('avery@example.invalid');
        await page.getByRole('textbox', { name: 'Service address', exact: true }).fill(source.address);
        await page.getByRole('spinbutton', { name: 'Home Sq Ft', exact: true }).fill('2000');
        await page.getByRole('spinbutton', { name: 'Lot Sq Ft', exact: true }).fill('6000');
        await page.getByRole('checkbox', { name: 'Pest Control', exact: true }).check();
        await page.getByRole('textbox', { name: 'Customer-visible notes', exact: true }).fill('Retain this unsaved note.');
        const sections = page.getByRole('navigation', { name: 'Estimate sections', exact: true });
        await sections.getByRole('button', { name: 'Customer & property', exact: true }).focus();
        if (device === 'desktop') {
          await page.keyboard.press('Tab');
          assert.equal(await sections.getByRole('button', { name: 'Services', exact: true }).evaluate((node) => node === document.activeElement), true);
        } else {
          // WebKit's default keyboard preference skips native buttons on
          // Tab. Verify keyboard activation; device settings remain a
          // physical-device check.
          await sections.getByRole('button', { name: 'Services', exact: true }).focus();
        }
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('#estimate-services').evaluate((node) => node === document.activeElement), true);
        await sections.getByRole('button', { name: 'Pricing & terms', exact: true }).click();
        assert.equal(await page.getByRole('textbox', { name: 'Customer-visible notes', exact: true }).inputValue(), 'Retain this unsaved note.');
        await screenshot('services', page.locator('#estimate-services'));
        await screenshot('pricing', page.locator('#estimate-pricing'));
        const generate = page.getByRole('button', { name: 'Generate Estimate', exact: true });
        const beforeGenerate = await generate.boundingBox();
        try {
          const calculationRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url() === `${server.baseUrl}/api/admin/estimator/calculate-estimate`);
          await generate.click();
          const calculation = (await calculationRequest).postDataJSON();
          assert.equal(calculation.profile.homeSqFt, 2000);
          assert.equal(calculation.profile.lotSqFt, 6000);
          assert.deepEqual(calculation.selectedServices, ['PEST']);
          assert.equal(calculation.options.pestFreq, 4);
          assert.equal(calculation.options.address, source.address);
          assert.equal(calculation.options.manualDiscount, null);
          assert.deepEqual(calculation.options.serviceSpecificDiscounts, []);
          const busyGenerate = page.locator('#estimate-review button[aria-busy="true"]');
          await busyGenerate.waitFor();
          assert.equal((await busyGenerate.innerText()).trim(), 'Generate Estimate');
          assert.equal(await busyGenerate.isDisabled(), true);
          const pendingGenerate = await busyGenerate.boundingBox();
          assert.equal(pendingGenerate.width, beforeGenerate.width, 'Generate width must remain stable while pending');
          assert.equal(pendingGenerate.height, beforeGenerate.height, 'Generate height must remain stable while pending');
          state.pendingGenerate = { label: 'Generate Estimate', width: pendingGenerate.width, height: pendingGenerate.height };
        } finally { releaseCalculation(); }
        const save = page.getByRole('button', { name: 'Save draft', exact: true });
        await save.waitFor();
        await screenshot('review', page.locator('#estimate-review'));
        const beforeSave = await save.boundingBox();
        await save.click();
        await page.waitForFunction(() => document.querySelector('#estimate-review button[aria-busy="true"]'));
        assert.equal(await save.isDisabled(), true);
        const pendingSave = await save.boundingBox();
        assert.equal(beforeSave.width, pendingSave.width);
        assert.equal(beforeSave.height, pendingSave.height);
        await save.evaluate((node) => node.click());
        assert.equal(state.writes.filter((write) => write.endpoint === '/api/admin/estimates').length, 1);
        state.pendingSave = { width: pendingSave.width, height: pendingSave.height, duplicateSuppressed: true };
        releaseCreate();
        await page.getByText('Example save failed. Please retry.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Customer-visible notes', exact: true }).inputValue(), 'Retain this unsaved note.');
        await save.click();
        await page.getByText('Draft saved. It has not been sent.', { exact: true }).waitFor();
        const creates = state.writes.filter((write) => write.endpoint === '/api/admin/estimates');
        assert.equal(creates.length, 2);
        assert.equal(creates[0].body.clientDraftId, creates[1].body.clientDraftId);
        assert.equal(new URL(page.url()).searchParams.get('editEstimateId'), 'estimate-example-created');
        await page.reload();
        await page.getByText(/Editing existing estimate for Avery Example/).waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Customer-visible notes', exact: true }).inputValue(), 'Retain this unsaved note.');
        await page.getByRole('textbox', { name: 'Customer name', exact: true }).fill('Avery Updated');
        await save.click();
        await page.getByText('Draft saved. It has not been sent.', { exact: true }).waitFor();
        assert.equal(records.get('estimate-example-created').customerName, 'Avery Updated');
        const send = page.getByRole('button', { name: 'Review and send', exact: true });
        await send.click();
        const dialog = page.getByRole('dialog', { name: 'Review and send', exact: true });
        await dialog.getByText('Avery Updated', { exact: true }).waitFor();
        await dialog.getByRole('radio', { name: 'Text message', exact: true }).check();
        await screenshot('send-review');
        await screenshot('send-actions', dialog.getByRole('button', { name: 'Confirm send', exact: true }));
        state.sendReview = await dialog.evaluate((node) => ({
          overflow: node.scrollWidth > node.clientWidth,
          targets: [...node.querySelectorAll('button,input[type="datetime-local"],.ui-choice-label')].map((control) => control.getBoundingClientRect().height),
        }));
        assert.equal(state.sendReview.overflow, false);
        assert.ok(state.sendReview.targets.every((height) => height >= 44));
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await send.evaluate((node) => node === document.activeElement), true);
        conflictRevision = true;
        await page.getByRole('textbox', { name: 'Customer name', exact: true }).fill('Keep this unsaved revision');
        await save.click();
        await page.getByText('This example changed in another editor. Reopen the saved estimate.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Customer name', exact: true }).inputValue(), 'Keep this unsaved revision');
        assert.equal(records.get('estimate-example-created').customerName, 'Avery Updated');
        await screenshot('conflict', page.locator('#estimate-review'));
        page.once('dialog', (dialog) => dialog.accept());
        await page.goto(`${server.baseUrl}/admin/estimates?editEstimateId=${source.id}`);
        await page.getByText(/Editing existing estimate for Avery Example/).waitFor();
        await screenshot('reopened');
        assert.equal(await page.getByLabel('Type', { exact: true }).inputValue(), 'FIXED');
        assert.equal(await page.getByLabel('Amount', { exact: true }).inputValue(), '25');
        assert.equal(await page.getByRole('textbox', { name: 'Customer-visible notes', exact: true }).inputValue(), source.notes);
        await page.getByRole('button', { name: 'Next estimate (keep services)', exact: true }).click();
        assert.equal(await page.getByRole('textbox', { name: 'Customer-visible notes', exact: true }).inputValue(), '');
        assert.equal(await page.getByRole('textbox', { name: 'Customer name', exact: true }).inputValue(), '');
        assert.equal(await page.getByRole('checkbox', { name: 'Pest Control', exact: true }).isChecked(), true);
        assert.equal(await page.getByLabel('Type', { exact: true }).inputValue(), 'NONE');
        for (const label of ['Amount', 'Label (shown on estimate)', 'Internal reason']) {
          assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), '');
        }
        await page.getByRole('textbox', { name: 'Customer name', exact: true }).fill('Next Example');
        await page.getByRole('spinbutton', { name: 'Home Sq Ft', exact: true }).fill('2000');
        await page.getByRole('button', { name: 'Generate Estimate', exact: true }).click();
        await save.click();
        await page.getByText('Draft saved. It has not been sent.', { exact: true }).waitFor();
        const nextSaved = state.writes.filter((write) => write.endpoint === '/api/admin/estimates').at(-1).body;
        assert.equal(nextSaved.customerName, 'Next Example');
        for (const key of ['customerId', 'propertyId']) assert.equal(nextSaved[key], null, `Next estimate clears ${key}`);
        for (const key of ['address', 'customerPhone', 'customerEmail']) assert.equal(nextSaved[key], '', `Next estimate clears ${key}`);
        assert.equal(nextSaved.notes, '');
        assert.equal(nextSaved.estimateData.inputs.manualDiscountType, 'NONE');
        for (const key of ['manualDiscountPreset', 'manualDiscountValue', 'manualDiscountLabel', 'manualDiscountInternalReason']) {
          assert.equal(nextSaved.estimateData.inputs[key], '');
        }
        assert.deepEqual(nextSaved.estimateData.inputs.serviceSpecificDiscountKeys, []);
        await page.getByRole('checkbox', { name: 'Lawn Care', exact: true }).check();
        for (const [width, height] of [[390, 844], [700, 900], [820, 1180], [1024, 768], [1440, 1000], [844, 390]]) {
          await page.setViewportSize({ width, height });
          const geometry = await page.locator('.estimate-builder').evaluate((builder) => {
            const visible = (node) => node.getBoundingClientRect().height > 0 && !node.closest('details:not([open])');
            const buttons = [...builder.querySelectorAll('button')].filter(visible);
            const controls = [...builder.querySelectorAll('input,select,textarea')].filter(visible);
            const measurements = (node) => ({
              name: (node.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim()
                || node.getAttribute('aria-label')?.trim() || [...(node.labels || [])].map((label) => label.textContent.trim()).join(' ').trim()
                || (node.tagName === 'BUTTON' ? node.textContent.trim() : ''),
              height: node.getBoundingClientRect().height, size: parseFloat(getComputedStyle(node).fontSize),
            });
            return {
              viewport: { width: innerWidth, height: innerHeight }, coarse: matchMedia('(any-pointer: coarse)').matches,
              overflow: document.documentElement.scrollWidth > innerWidth || builder.scrollWidth > builder.clientWidth,
              shortButtons: buttons.map(measurements).filter((node) => node.height < 44),
              shortControls: controls.filter((node) => !['checkbox', 'radio'].includes(node.type)).map(measurements).filter((node) => node.height < 44),
              smallFields: controls.filter((node) => !['checkbox', 'radio', 'range'].includes(node.type)).map(measurements).filter((node) => node.size < 16),
              unlabelled: controls.map(measurements).filter((node) => !node.name),
              shortChoices: controls.filter((node) => ['checkbox', 'radio'].includes(node.type)).filter((node) => !node.labels?.[0] || node.labels[0].getBoundingClientRect().height < 44).map(measurements),
            };
          });
          state.geometry.push(geometry);
          assert.equal(geometry.coarse, device === 'mobile', `${device} ${width}px: expected pointer mode`);
          assert.equal(geometry.overflow, false, `${device} ${width}px: horizontal overflow`);
          for (const key of ['shortButtons', 'shortControls', 'smallFields', 'unlabelled', 'shortChoices']) assert.deepEqual(geometry[key], [], `${device} ${width}px: ${key}`);
        }
        await page.setViewportSize(viewport);
        assert.deepEqual(state.unmatched, []);
        assert.deepEqual(state.errors, []);
        assert.deepEqual(state.consoleErrors, [
          { text: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)', url: `${server.baseUrl}/api/admin/estimates` },
          { text: 'Failed to load resource: the server responded with a status of 409 (Conflict)', url: `${server.baseUrl}/api/admin/estimates/estimate-example-created` },
        ]);
        const allowedReads = new Set([
          'GET /api/admin/auth/me',
          'GET /api/admin/feature-flags',
          'GET /api/admin/communications/unread-count',
          'GET /api/admin/notifications/unread-count',
          'GET /api/admin/discounts',
          'GET /api/admin/triage',
          'GET /api/admin/pricing-config/lawn_pricing_v2',
          'GET /api/admin/pricing-config/onetime_flea',
          'GET /api/admin/pricing-config/rodent_bait_brackets',
          'GET /api/admin/pricing-config/rodent_setup_fee',
          'GET /api/admin/pricing-config/rodent_waveguard',
          'GET /api/admin/pricing-config/termite_rental',
          `GET /api/admin/customers/${source.customerId}/properties`,
          `GET /api/admin/estimates/customer-spend/${source.customerId}`,
          `GET /api/admin/estimates/${source.id}/edit-source`,
          `GET /api/admin/estimates/${source.id}/group`,
          'GET /api/admin/estimates/estimate-example-created/edit-source',
          'GET /api/admin/estimates/estimate-example-created/group',
          'GET /api/admin/estimates/estimate-example-created/send-preview',
        ]);
        assert.deepEqual(state.reads.filter(({ method, endpoint }) => !allowedReads.has(`${method} ${endpoint}`)), []);
        const allowedWrites = new Set([
          'POST /api/admin/estimator/turf-preview',
          'POST /api/admin/estimator/calculate-estimate',
          'POST /api/admin/estimates',
          'PUT /api/admin/estimates/estimate-example-created',
        ]);
        assert.deepEqual(state.writes.filter(({ method, endpoint }) => !allowedWrites.has(`${method} ${endpoint}`)), []);
        state.passed = true;
        console.log(`Estimate workflow complete: ${device}`);
      } finally { await browser.close(); }
    }
    report.passed = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    try { await server?.close(); }
    catch (error) {
      report.passed = false;
      report.cleanupFailure = { name: error.name, message: error.message };
      throw error;
    } finally {
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
