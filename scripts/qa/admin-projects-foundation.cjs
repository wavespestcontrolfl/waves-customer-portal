'use strict';
// SYNTHETIC UI QA. Every API request is fulfilled in-browser; no database or
// provider is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-projects-foundation');
const now = new Date().toISOString();
const project = {
  id: 'project-1', project_type: 'pest_inspection', customer_id: 'customer-1', customer_name: 'Synthetic customer',
  title: 'Synthetic inspection', project_date: '2026-09-10', created_at: now, tech_name: 'Fixture technician',
  status: 'draft', photo_count: 4, findings: { scope: 'Kitchen inspection complete' },
  recommendations: 'Monitor the kitchen and schedule follow-up treatment.', delivery_channels: null,
};
const photos = Array.from({ length: 4 }, (_, index) => ({
  id: `photo-${index + 1}`,
  caption: `Inspection photo ${index + 1}`,
  category: 'inspection',
}));
const photoDataUrl = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="240" height="240"%3E%3Crect width="240" height="240" fill="%23d4d4d8"/%3E%3Cpath d="M40 180l48-58 38 36 32-45 42 67" fill="none" stroke="%2352525b" stroke-width="10"/%3E%3C/svg%3E';
const types = {
  pest_inspection: { label: 'Pest inspection', findingsFields: [{ key: 'scope', label: 'Inspection scope', type: 'text', required: true }] },
  wdo_inspection: { label: 'WDO inspection', appointmentManaged: true, linkedCreationOnly: true, findingsFields: [] },
};

function fixture(api, method, body) {
  if (api === '/health') return { status: 'ok', gates: {} };
  if (api === '/admin/auth/me') return { id: 'fixture-admin', name: 'Fixture operator', role: 'admin' };
  if (api === '/admin/feature-flags') return { flags: {} };
  if (api === '/admin/notifications/unread-count') return { count: 0 };
  if (api === '/admin/communications/unread-count') return { conversations: 0, messages: 0 };
  if (api === '/admin/usage/track') return { ok: true };
  if (api === '/admin/projects/types') return { types };
  if (api === '/admin/projects' && method === 'GET') return { projects: [] };
  if (api === '/admin/projects/project-1/activity') return { activity: [{ id: 'event-1', action: 'project_created', description: 'Synthetic report created.', actor_name: 'Fixture technician', created_at: now }] };
  if (api === '/admin/projects/project-1' && method === 'GET') return { project, photos, upcomingAppointment: null, closeoutPreview: { canClose: true, billing: { required: false }, followup: { required: false }, portal: { attached: false }, serviceCompletion: { linked: false } } };
  if (api === '/admin/projects/project-1' && method === 'PUT') return { success: true, received: body };
  if (/^\/admin\/projects\/project-1\/photos\/photo-\d+\/url$/.test(api) && method === 'GET') return { url: photoDataUrl };
  if (/^\/admin\/projects\/project-1\/photos\/photo-\d+$/.test(api) && method === 'PUT') return { success: true, received: body };
  if (api === '/admin/projects/project-1/send' && body?.dry_run) return { email_routing: { recipient: 'customer@example.invalid', report_copies: [] } };
  if (api === '/admin/projects/project-1/send') return { sent: true, report_url: '/report/project/synthetic', channels: { email: { ok: true }, sms: { ok: true } } };
  if (api === '/admin/projects/project-1/send-portal-invite') return { success: true };
  if (api === '/admin/projects/project-1/send-prep-guide') return { template_key: 'pest-inspection-prep' };
  if (api === '/admin/projects/project-1/close') return { serviceCompleted: false, portalAttached: false };
  return null;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), scenarios: [], requests: [], unmatched: [], blockedExternal: [], consoleErrors: [], pageErrors: [], screenshots: [] };
  let server;
  let browser;
  let stage = 'startup';
  let fontsVerified = false;

  async function openPage(width) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => {
      localStorage.setItem('waves_admin_token', 'synthetic-local-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-admin', name: 'Fixture operator', role: 'admin' }));
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    });
    page.on('pageerror', (error) => report.pageErrors.push({ stage, message: error.message }));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push({ stage, message: message.text() }); });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl) { report.blockedExternal.push({ stage, origin: url.origin }); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      const method = request.method();
      let requestBody = null;
      try { requestBody = request.postData() ? JSON.parse(request.postData()) : null; } catch { requestBody = request.postData(); }
      report.requests.push({ stage, method, path: api, search: url.search, body: requestBody });
      const isWdoQuery = api === '/admin/projects' && url.searchParams.get('project_type') === 'wdo_inspection';
      const responseBody = isWdoQuery ? { projects: [] } : api === '/admin/projects' && method === 'GET' ? { projects: [project] } : fixture(api, method, requestBody);
      if (responseBody === null) {
        report.unmatched.push({ stage, method, path: api, search: url.search });
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Unmatched synthetic fixture' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseBody) });
    });
    return page;
  }

  async function assertFoundation(page) {
    const surface = page.locator('[data-ui-density="comfortable"]').last();
    await surface.waitFor();
    const inlineStyles = await surface.locator('[style]:not(.ui-select)').evaluateAll((elements) => elements
      .filter((element) => !element.closest('[data-shared-project-fields]') && element.getAttribute('style')?.trim())
      .map((element) => ({ tag: element.tagName, style: element.getAttribute('style') })).slice(0, 8));
    assert.deepEqual(inlineStyles, [], `page-owned inline styles must be absent: ${JSON.stringify(inlineStyles)}`);
    const undersizedText = await surface.evaluate((rootElement) => Array.from(rootElement.querySelectorAll('*'))
      .filter((element) => !element.closest('[data-shared-project-fields]') && element.children.length === 0 && element.textContent.trim() && getComputedStyle(element).display !== 'none')
      .map((element) => ({ text: element.textContent.trim().slice(0, 80), size: parseFloat(getComputedStyle(element).fontSize) }))
      .filter((item) => item.size < 14));
    assert.deepEqual(undersizedText, [], `readable page-owned text below 14px: ${JSON.stringify(undersizedText)}`);
    const undersizedControls = await surface.evaluate((rootElement) => Array.from(rootElement.querySelectorAll('button, a[href], input, select, textarea, summary'))
      .filter((element) => !element.closest('[data-shared-project-fields]') && getComputedStyle(element).display !== 'none' && !element.classList.contains('u-touch-hit'))
      .map((element) => ({ name: element.getAttribute('aria-label') || element.textContent.trim(), height: element.getBoundingClientRect().height }))
      .filter((item) => item.height < 44));
    assert.deepEqual(undersizedControls, [], `page-owned controls below 44px: ${JSON.stringify(undersizedControls)}`);
  }

  async function shot(page, name) {
    if (!fontsVerified) {
      console.log(`Waiting for fonts: ${name}`);
      await waitForFonts(page);
      fontsVerified = true;
    }
    await page.evaluate(() => { window.scrollTo(0, 0); for (const element of document.querySelectorAll('*')) if (element.scrollHeight > element.clientHeight) element.scrollTop = 0; });
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    report.screenshots.push({ name, file: path.relative(root, file), width: page.viewportSize().width, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
  }

  async function scenario(name, work) { stage = name; console.log(`Checking: ${name}`); await work(); report.scenarios.push({ name, passed: true }); }

  try {
    server = await previewServer(root, process.env.ADMIN_UI_PREVIEW_URL);
    browser = await launchBrowser();
    const desktop = await openPage(1440);
    await scenario('desktop directory, report edit and delivery parity', async () => {
      await desktop.goto(`${server.baseUrl}/admin/projects?projectId=project-1`);
      await desktop.getByRole('heading', { name: 'Reports', level: 1 }).waitFor();
      await desktop.getByText('Customer report preview', { exact: true }).waitFor();
      await assertFoundation(desktop);
      const finding = desktop.getByLabel('Inspection scope');
      const findingBox = await finding.boundingBox();
      const findingParentBox = await finding.locator('xpath=..').boundingBox();
      assert.ok(findingBox.width >= findingParentBox.width - 2, `shared field should fill its container (${findingBox.width}px of ${findingParentBox.width}px)`);
      console.log('Desktop foundation passed');
      await shot(desktop, 'projects-desktop-1440');
      const editCaption = desktop.getByRole('button', { name: 'Edit caption' }).first();
      await editCaption.scrollIntoViewIfNeeded();
      await editCaption.click();
      const captionInput = desktop.getByPlaceholder('Photo caption');
      const captionTile = captionInput.locator('xpath=../..');
      const [tileBox, inputBox, saveBox, cancelBox] = await Promise.all([
        captionTile.boundingBox(),
        captionInput.boundingBox(),
        desktop.getByRole('button', { name: 'Save caption' }).boundingBox(),
        desktop.getByRole('button', { name: 'Cancel caption edit' }).boundingBox(),
      ]);
      assert.ok(inputBox.x >= tileBox.x && inputBox.x + inputBox.width <= tileBox.x + tileBox.width, 'caption input must remain inside the photo tile');
      assert.ok(saveBox.y >= inputBox.y + inputBox.height && cancelBox.y >= inputBox.y + inputBox.height, 'caption actions must sit below the input');
      assert.ok(cancelBox.x + cancelBox.width <= tileBox.x + tileBox.width, 'caption actions must remain inside the photo tile');
      await captionInput.fill('Updated inspection caption');
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/projects/project-1/photos/photo-1') && request.method() === 'PUT' && request.postDataJSON().caption === 'Updated inspection caption'),
        desktop.getByRole('button', { name: 'Save caption' }).click(),
      ]);
      console.log('Desktop photo caption geometry and save passed');
      const title = desktop.getByLabel('Report title');
      await title.fill('Updated synthetic inspection');
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/projects/project-1') && request.method() === 'PUT' && request.postDataJSON().title === 'Updated synthetic inspection'),
        desktop.getByRole('button', { name: 'Save changes', exact: true }).click(),
      ]);
      await desktop.getByText('Changes saved.', { exact: true }).waitFor();
      console.log('Desktop save passed');
      await desktop.getByRole('button', { name: 'Portal invite', exact: true }).click();
      let confirm = desktop.getByRole('dialog', { name: 'Confirmation' });
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/projects/project-1/send-portal-invite') && request.method() === 'POST'),
        confirm.getByRole('button', { name: 'Send', exact: true }).click(),
      ]);
      await desktop.getByText('Portal invite sent.', { exact: true }).waitFor();
      console.log('Desktop portal invite passed');
      const sendReport = desktop.getByRole('button', { name: 'Send report', exact: true });
      await desktop.waitForFunction(() => {
        const button = Array.from(document.querySelectorAll('button')).find((element) => element.textContent.trim() === 'Send report');
        return button && !button.disabled;
      });
      console.log('Desktop send report ready');
      await sendReport.click();
      console.log('Desktop send report preview requested');
      confirm = desktop.getByRole('dialog', { name: 'Confirmation' });
      await confirm.waitFor();
      const confirmationText = await confirm.textContent();
      assert.match(confirmationText, /Email to: customer@example\.invalid/);
      await Promise.all([
        desktop.waitForRequest((request) => request.url().endsWith('/api/admin/projects/project-1/send') && request.method() === 'POST' && !request.postDataJSON().dry_run),
        confirm.getByRole('button', { name: 'Send', exact: true }).click(),
      ]);
      await desktop.getByText(/Report delivered/).waitFor();
      console.log('Desktop report delivery passed');
    });

    const mobile = await openPage(390);
    await scenario('mobile detail and directory return without overflow', async () => {
      await mobile.goto(`${server.baseUrl}/admin/projects?projectId=project-1`);
      await mobile.getByText('Customer report preview', { exact: true }).waitFor();
      await assertFoundation(mobile);
      assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await mobile.getByRole('button', { name: 'Close', exact: true }).click();
      await mobile.getByText('Synthetic customer', { exact: true }).waitFor();
      await shot(mobile, 'projects-mobile-390');
    });

    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.blockedExternal, []);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Evidence: ${path.relative(root, path.join(output, 'report.json'))}`);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
