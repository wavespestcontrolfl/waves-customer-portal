'use strict';
/* global localStorage, document, getComputedStyle, innerWidth */
// Synthetic frontend-only QA: every API request is fulfilled locally.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-contracts-foundation');
const template = { templateKey: 'qa.agreement', name: 'Example agreement', category: 'service_agreement', documentType: 'service_agreement', status: 'active', description: 'Synthetic agreement', requiresSignature: true, tags: [], variables: ['customer.name'], activeVersion: { versionNumber: 1, title: 'Example agreement', body: 'Agreement for {{customer.name}}', signerDisclosure: 'Electronic signature consent', requiredFields: ['signedName'] } };
const request = { id: 'qa-request', title: 'Example agreement', documentTemplateKey: template.templateKey, contractType: 'document_template', status: 'viewed', customerId: 'qa-customer', customer: { name: 'Avery Example', phone: '9415550100', email: 'avery@example.test' }, createdAt: '2026-09-01T12:00:00Z', shareTokenExpiresAt: '2026-09-15T12:00:00Z', deliverySummary: { emailSent: 1, smsSent: 0, remindersSent: 0 } };
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, screenshots: [], scenarios: [], unmatched: [], pageErrors: [], requests: [] };
  const server = await previewServer(root);
  let browser = null;
  try {
    browser = await launchBrowser();
    for (const width of [1440, 390, 700, 820, 1024]) {
      let failSave = true, empty = false;
      template.name = "Example agreement";
      template.category = "service_agreement"; template.documentType = "service_agreement"; template.requiresSignature = true;
      const context = await browser.newContext({ viewport: { width, height: width === 1024 ? 700 : 1000 }, hasTouch: width !== 1440, timezoneId: 'America/New_York', serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.routeWebSocket("**/*", socket => socket.close());
      page.on('pageerror', e => report.pageErrors.push(e.message));
      await page.addInitScript(() => {
        localStorage.setItem('waves_admin_token', 'synthetic-local-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'qa-admin', name: 'Fixture operator', role: 'admin' }));
      });
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), method = req.method();
        if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const key = `${method} ${url.pathname}`;
        report.requests.push({ key, search: url.search, body: req.postDataJSON() });
        let body, status = 200;
        if (key === 'GET /api/admin/auth/me') body = { id: 'qa-admin', name: 'Fixture operator', role: 'admin' };
        else if (key === 'GET /api/admin/feature-flags') body = { flags: {} };
        else if (url.pathname.endsWith('/unread-count')) body = { count: 0, conversations: 0 };
        else if (key === 'POST /api/admin/usage/track') body = { ok: true };
        else if (key === 'GET /api/admin/document-templates') body = { templates: [template, ...Array.from({ length: 12 }, (_, index) => ({ ...template, templateKey: `qa.extra-${index}`, name: `Additional fixture ${index}` }))] };
        else if (key === 'GET /api/admin/document-templates/qa.agreement') body = { template };
        else if (key === 'PUT /api/admin/document-templates/qa.agreement') {
          if (failSave) { body = { error: 'Synthetic save failure' }; status = 503; }
          else { template.name = req.postDataJSON().name; body = { template }; }
        }
        else if (key === 'POST /api/admin/document-templates/qa.agreement/bulk-preview') body = { counts: { matched: 1, sendable: 1 }, sampleCustomers: [] };
        else if (key === 'POST /api/admin/document-templates/qa.agreement/bulk-send') body = { summary: { sentSms: 1, created: 1 } };
        else if (key === 'GET /api/admin/contracts/requests') body = { requests: empty ? [] : [request] };
        else if (key === 'GET /api/admin/contracts/requests/stats') body = { stats: null };
        else if (key === 'POST /api/admin/contracts/qa-request/cancel') body = { ok: true };
        else if (key === 'POST /api/admin/contracts/qa-request/send-email') body = { signingUrl: 'https://example.test/contract/fixture' };
        else { report.unmatched.push(key); body = { error: 'Unmatched synthetic fixture' }; status = 404; }
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(`${server.baseUrl}/admin/contracts?source=qa`);
      await page.getByLabel('Name', { exact: true }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('input')].some(input => input.value === 'Example agreement'));
      await page.getByLabel('Name', { exact: true }).fill('Revised example agreement');
      await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Synthetic save failure' }).waitFor();
      assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Revised example agreement');
      failSave = false;
      await page.getByRole('button', { name: 'Save metadata', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Template saved' }).waitFor();
      if (width === 1024) {
        await page.locator('main').evaluate(el => { el.scrollTop = 0; });
        await page.getByRole('button').filter({ has: page.getByText('Revised example agreement', { exact: true }) }).click();
        await page.waitForFunction(() => {
          const label = [...document.querySelectorAll('input')].find(el => el.value === 'Revised example agreement');
          return label && label.getBoundingClientRect().top >= 0 && label.getBoundingClientRect().top < innerHeight;
        });
      }
      await waitForFonts(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      const templatesShot = path.join(output, `templates-${width}.png`);
      await page.screenshot({ path: templatesShot, fullPage: true }); report.screenshots.push(templatesShot);
      const form = await page.getByLabel('Name', { exact: true }).evaluate(el => ({ height: el.getBoundingClientRect().height, font: parseFloat(getComputedStyle(el).fontSize) }));
      assert.ok(form.height >= 44 && form.font >= 16, JSON.stringify(form));
      const typography = await page.locator('main .ui-surface').first().evaluate(root => {
        const visible = node => node.getClientRects().length > 0 && !node.closest('[hidden], [inert]');
        return [...root.querySelectorAll('*')].filter(visible).filter(node => [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())).filter(node => parseFloat(getComputedStyle(node).fontSize) < 14).map(node => node.textContent.slice(0, 60));
      });
      assert.deepEqual(typography, [], 'Readable text must be at least 14px');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Template page must not overflow');
      await page.getByRole('button', { name: 'Requests', exact: true }).click();
      await page.getByRole('link', { name: 'Avery Example' }).waitFor();
      assert.ok(page.url().includes('source=qa') && page.url().includes('tab=requests'));
      await page.getByLabel('Search requests').fill('Avery');
      await page.getByRole('button', { name: 'Email', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'EMAIL sent' }).waitFor();
      assert.ok(report.requests.some(r => r.key === 'POST /api/admin/contracts/qa-request/send-email' && JSON.stringify(r.body) === '{}'));
      await page.locator('main').evaluate(el => { el.scrollTop = 0; });
      const requestsShot = path.join(output, `requests-${width}.png`);
      await page.screenshot({ path: requestsShot, fullPage: true }); report.screenshots.push(requestsShot);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Request page must not overflow');
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
      const cancellationsBefore = report.requests.filter(r => r.key.endsWith('/cancel')).length;
      await cancel.click();
      const dialog = page.getByRole('dialog', { name: 'Cancel document request' });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Cancel request', exact: true }).count(), 1);
      await dialog.getByRole('button', { name: 'Keep request' }).click();
      assert.equal(report.requests.filter(r => r.key.endsWith('/cancel')).length, cancellationsBefore);
      await cancel.click();
      const dialogShot = path.join(output, `cancel-${width}.png`);
      await page.screenshot({ path: dialogShot }); report.screenshots.push(dialogShot);
      await dialog.getByRole('button', { name: 'Cancel request', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Document request cancelled' }).waitFor();
      const cancellation = report.requests.filter(r => r.key === 'POST /api/admin/contracts/qa-request/cancel').at(-1);
      assert.deepEqual(cancellation.body, { reason: 'Cancelled from document requests queue' });
      empty = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByText('No document requests match this view.').waitFor();
      await page.reload();
      await page.getByLabel('Search requests').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Requests', exact: true }).getAttribute('aria-current'), 'page');
      template.category = 'marketing'; template.documentType = 'customer_guide'; template.requiresSignature = false;
      await page.getByRole('button', { name: 'Templates', exact: true }).click();
      const bulk = page.getByText('Bulk send guide', { exact: true }).locator('../..');
      await bulk.getByRole('button', { name: 'Preview', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Bulk audience preview ready' }).waitFor();
      const sendsBefore = report.requests.filter(r => r.key.endsWith('/bulk-send')).length;
      await bulk.getByRole('button', { name: 'Send batch', exact: true }).click();
      const sendDialog = page.getByRole('dialog', { name: 'Send batch', exact: true });
      await sendDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(report.requests.filter(r => r.key.endsWith('/bulk-send')).length, sendsBefore);
      await bulk.getByRole('button', { name: 'Send batch', exact: true }).click();
      await sendDialog.getByRole('button', { name: 'Send batch', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Bulk send complete' }).waitFor();
      assert.equal(report.requests.filter(r => r.key.endsWith('/bulk-send')).length, sendsBefore + 1);
      assert.deepEqual(report.requests.filter(r => r.key.endsWith('/bulk-send')).at(-1).body, report.requests.filter(r => r.key.endsWith('/bulk-preview')).at(-1).body);
      report.scenarios.push({ width, draftRecovery: true, metadataPayload: true, requestDeliveryPayload: true, queryNavigation: true, emptyState: true, form });
      await context.setOffline(true);
      await context.close();
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    try { if (browser) await browser.close(); }
    finally { await server.close(); }
  }
  console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios, output }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
