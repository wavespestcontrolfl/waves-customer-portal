'use strict';
/* global document, localStorage, getComputedStyle, innerWidth */
// Synthetic frontend-only verification; no live API or provider traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..'), output = path.join(root, '.tmp/admin-agent-estimate-foundation');
const lead = { id: 'qa-lead', name: 'Avery Example', status: 'new', phone: '9415550100', email: 'avery@example.test', address: '100 Example Street', service_interest: 'Pest control' };
const draft = { id: 'qa-draft', token: 'qa-preview', status: 'draft', editable_here: true, customer_phone: lead.phone, customer_email: lead.email, address: lead.address, monthly_total: 39, annual_total: 468, onetime_total: 0, lane: 'yellow', service_template_keys: ['pest_control'], lane_reasons: ['Review evidence'] };
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, unmatched: [], pageErrors: [], scenarios: [], screenshots: [], writes: [] };
  const server = await previewServer(root), browser = await launchBrowser();
  try {
    for (const width of [1440, 390, 820]) {
      let failLearning = true;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 1440, timezoneId: 'America/New_York', serviceWorkers: 'block' });
      const page = await context.newPage();
      page.on('pageerror', e => report.pageErrors.push(e.message));
      await page.addInitScript(() => {
        localStorage.setItem('waves_admin_token', 'synthetic-local-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'qa-admin', name: 'Fixture operator', role: 'admin' }));
      });
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), key = `${req.method()} ${url.pathname}`;
        if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
        if (url.pathname === '/estimate/qa-preview') return route.fulfill({ contentType: 'text/html', body: '<html><body><h1>Synthetic customer preview</h1></body></html>' });
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let body, status = 200;
        if (req.method() !== 'GET') report.writes.push({ key, body: req.postDataJSON() });
        if (key === 'GET /api/admin/auth/me') body = { id: 'qa-admin', name: 'Fixture operator', role: 'admin' };
        else if (key === 'GET /api/admin/feature-flags') body = { flags: { agent_estimate: true } };
        else if (url.pathname.endsWith('/unread-count')) body = { count: 0, conversations: 0 };
        else if (key === 'POST /api/admin/usage/track') body = { ok: true };
        else if (key === 'GET /api/admin/leads') body = { leads: [lead] };
        else if (key === 'GET /api/admin/agent-estimate/lead/qa-lead') body = { context: { lead, current_estimate: draft, calls: [], sms_thread: [], quote_form: { message_fields: [] }, customer_account: { recognized: false } } };
        else if (key === 'GET /api/admin/agent-estimate/memory') body = { memories: [] };
        else if (key === 'GET /api/admin/intelligence-bar/quick-actions') body = { actions: [] };
        else if (key === 'POST /api/admin/agent-estimate/memory') {
          if (failLearning) { status = 503; body = { error: 'Synthetic learning failure' }; }
          else body = { ok: true };
        }
        else { report.unmatched.push(key); status = 404; body = { error: 'Unmatched fixture' }; }
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(`${server.baseUrl}/admin/agent-estimate?leadId=qa-lead`);
      await page.getByRole('button', { name: 'Review or revise draft', exact: true }).waitFor();
      await waitForFonts(page);
      await page.getByRole('button', { name: 'Paste customer text…', exact: true }).click();
      await page.getByLabel('Customer text', { exact: true }).fill('Please verify the front lawn dimensions.');
      await page.getByRole('button', { name: 'Use in prompt', exact: true }).click();
      assert.ok((await page.getByLabel('Ask AI', { exact: true }).inputValue()).includes('front lawn dimensions'));
      assert.equal(report.writes.filter(r => r.key.includes('/query')).length, 0, 'Pasting must not invoke AI');
      await page.getByText('Controlled learning', { exact: true }).click();
      await page.getByLabel('Learning rule', { exact: true }).fill('Verify irrigated turf separately for this property.');
      await page.getByLabel('Rationale (optional)').fill('Synthetic rationale');
      await page.getByRole('button', { name: 'Save learning candidate', exact: true }).click();
      await page.getByText('Synthetic learning failure', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Learning rule', { exact: true }).inputValue(), 'Verify irrigated turf separately for this property.');
      failLearning = false;
      await page.getByRole('button', { name: 'Save learning candidate', exact: true }).click();
      await page.getByText('Learning candidate saved for admin review.', { exact: true }).waitFor();
      assert.deepEqual(report.writes.filter(r => r.key === 'POST /api/admin/agent-estimate/memory').at(-1).body, { rule_text: 'Verify irrigated turf separately for this property.', rationale: 'Synthetic rationale', source_lead_id: 'qa-lead' });
      await page.getByRole('button', { name: 'Preview customer estimate', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Customer preview', exact: true }); await dialog.waitFor();
      assert.equal(await dialog.locator('iframe').getAttribute('src'), '/estimate/qa-preview?adminPreview=1');
      const modalShot = path.join(output, `preview-${width}.png`); await page.screenshot({ path: modalShot }); report.screenshots.push(modalShot);
      await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
      await page.locator('main').evaluate(el => { el.scrollTop = 0; });
      const shot = path.join(output, `workspace-${width}.png`); await page.screenshot({ path: shot }); report.screenshots.push(shot);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page overflow');
      const fields = await page.locator('main .ui-surface input:not([type="file"]), main .ui-surface textarea').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).map(n => ({ font: parseFloat(getComputedStyle(n).fontSize), height: n.getBoundingClientRect().height, label: n.labels?.length || n.getAttribute('aria-label') })));
      for (const field of fields) assert.ok(field.font >= 16 && field.height >= 44 && field.label, JSON.stringify(field));
      report.scenarios.push({ width, pasteWithoutQuery: true, learningRecovery: true, previewDialog: true, fields });
      await context.close();
    }
    assert.deepEqual(report.unmatched, []); assert.deepEqual(report.pageErrors, []); report.passed = true;
  } finally { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }
  console.log(JSON.stringify({ passed: report.passed, output }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
