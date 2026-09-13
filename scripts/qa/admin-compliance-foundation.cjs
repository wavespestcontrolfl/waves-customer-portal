'use strict';
// Frontend-only proof. Every API is fulfilled with synthetic data and all
// external traffic and sockets are blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require('playwright');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-compliance-foundation');
const technicianId = '11111111-1111-4111-8111-111111111111';
const credentialId = '22222222-2222-4222-8222-222222222222';

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, requests: [], sizes: [], unmatched: [], pageErrors: [] };
  let server;
  let chrome;
  let safari;
  try {
    server = await previewServer(root);
    chrome = await launchBrowser();
    safari = await webkit.launch();

    for (const [name, browser, hasTouch] of [['desktop', chrome, false], ['mobile', safari, true]]) {
      let failLicenseSave = true;
      let credentials = [{
        id: credentialId,
        slug: 'synthetic-license',
        displayName: 'Synthetic operating license',
        credentialType: 'license',
        credentialNumber: 'TEST-100',
        status: 'active',
        expirationDate: '2027-12-31',
        jurisdictions: ['FL'],
        isPublic: true,
        sortOrder: 100,
        archivedAt: null,
      }];
      const context = await browser.newContext({
        viewport: { width: hasTouch ? 390 : 1440, height: 900 },
        hasTouch,
        serviceWorkers: 'block',
        timezoneId: 'America/New_York',
        acceptDownloads: true,
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem('waves_admin_token', 'synthetic-local-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-admin', role: 'admin', name: 'Fixture admin' }));
      });
      page.on('pageerror', (error) => report.pageErrors.push(`${name}: ${error.message}`));
      await page.routeWebSocket('**/*', (socket) => socket.close());
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();

        let body = {};
        let contentType = 'application/json';
        const requestRecord = { viewport: name, method: request.method(), path: url.pathname, search: url.search };
        if (request.postData()) requestRecord.body = request.postDataJSON();

        if (url.pathname === '/api/admin/compliance-v2/dashboard') {
          body = { ytdApplications: 42, uniqueProducts: 6, warningCount: 1, licensedTechs: 1, expiringLicenses: 1, restrictedUseApps: 2,
            recentApplications: [{ id: 'application-1', date: '2026-09-10', product: 'Synthetic treatment', customer: 'Example customer', tech: 'Fixture technician' }] };
        } else if (url.pathname === '/api/admin/compliance-v2/nitrogen-status') {
          body = { activeBlackoutCount: 1, blackoutPeriods: [{ jurisdiction: 'manatee_county', start: '2026-06-01', end: '2026-09-30' }],
            customers: [{ customerId: 'customer-1', customerName: 'Example lawn customer', city: 'Bradenton', county: 'manatee_county', lawnType: 'St. Augustine', nitrogenAppsYTD: 2, blackoutActive: true }] };
        } else if (url.pathname === '/api/admin/compliance-v2/applications') {
          report.requests.push(requestRecord);
          body = { total: 1, applications: [{ id: 'application-1', applicationDate: '2026-09-10', productName: 'Synthetic treatment', activeIngredient: 'Example ingredient', epaRegNumber: '100-TEST', applicationRate: '1.5', rateUnit: 'oz/gal', customerName: 'Example customer', techName: 'Fixture technician', applicationMethod: 'spot treatment' }] };
        } else if (url.pathname === '/api/admin/compliance-v2/report/export') {
          report.requests.push(requestRecord);
          contentType = 'text/csv';
          body = 'date,product\n2026-09-10,Synthetic treatment\n';
          return route.fulfill({ status: 200, contentType, headers: { 'Content-Disposition': 'attachment; filename="dacs-report.csv"' }, body });
        } else if (url.pathname === '/api/admin/compliance-v2/product-limits') {
          report.requests.push(requestRecord);
          body = { customerName: 'Example lawn customer', limits: [{ limitType: 'annual_max_apps', limitValue: 3, currentUsage: 2, status: 'warning', severity: 'hard_block', description: 'Synthetic annual limit' }] };
        } else if (url.pathname === '/api/admin/compliance-v2/licenses' && request.method() === 'GET') {
          body = { technicians: [{ id: technicianId, name: 'Fixture technician', license: 'OLD-1', licenseExpiry: '2027-02-01', licenseCategories: ['General Household Pest'], licenseStatus: 'expiring_soon' }] };
        } else if (url.pathname === `/api/admin/compliance-v2/licenses/${technicianId}`) {
          assert.equal(request.method(), 'PUT');
          assert.deepEqual(request.postDataJSON(), { fl_applicator_license: 'NEW-2', license_expiry: '2027-02-01', license_categories: ['General Household Pest'] });
          report.requests.push(requestRecord);
          if (failLicenseSave) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic license save failure. Retry after checking this draft.' }) });
          body = { success: true };
        } else if (url.pathname === '/api/admin/credentials' && request.method() === 'GET') {
          body = { credentials };
        } else if (url.pathname === `/api/admin/credentials/${credentialId}` && request.method() === 'DELETE') {
          report.requests.push(requestRecord);
          credentials = credentials.map((row) => ({ ...row, archivedAt: '2026-09-11' }));
          body = { success: true };
        } else if (url.pathname === '/api/admin/auth/me') {
          body = { id: 'fixture-admin', role: 'admin', name: 'Fixture admin' };
        } else if (url.pathname === '/api/admin/feature-flags') {
          body = { flags: {} };
        } else if (['/api/admin/notifications/unread-count', '/api/admin/communications/unread-count'].includes(url.pathname)) {
          body = { count: 0, conversations: 0 };
        } else if (url.pathname === '/api/admin/usage/track') {
          body = { ok: true };
        } else {
          report.unmatched.push(`${request.method()} ${url.pathname}`);
          return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        }
        return route.fulfill({ status: 200, contentType, body: JSON.stringify(body) });
      });

      await page.goto(`${server.baseUrl}/admin/compliance?source=synthetic`);
      await page.getByText('Synthetic treatment', { exact: true }).first().waitFor();
      await waitForFonts(page);
      const surface = page.locator('[data-ui-density="comfortable"]').filter({ has: page.getByRole('heading', { name: 'Compliance' }) }).first();
      assert.equal(await surface.count(), 1);

      for (const width of [390, 700, 820, 1024, 1440]) {
        for (const height of [900, 500]) {
          await page.setViewportSize({ width, height });
          const metrics = await surface.evaluate((node) => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls: [...node.querySelectorAll('button,input,select,textarea')].filter((element) => element.getClientRects().length).map((element) => ({ height: element.getBoundingClientRect().height, font: parseFloat(getComputedStyle(element).fontSize) })),
            readable: [...node.querySelectorAll('p,span,td,th,h1,h2,h3,label')].filter((element) => element.getClientRects().length && element.textContent.trim()).map((element) => parseFloat(getComputedStyle(element).fontSize)),
          }));
          assert.equal(metrics.overflow, false, `${name} overflow at ${width}x${height}`);
          for (const control of metrics.controls) {
            assert.ok(control.height >= 44, `${name} control ${control.height}px at ${width}x${height}`);
            assert.ok(control.font >= 14, `${name} control font ${control.font}px at ${width}x${height}`);
          }
          for (const font of metrics.readable) assert.ok(font >= 14, `${name} readable font ${font}px at ${width}x${height}`);
          report.sizes.push({ name, width, height, controls: metrics.controls.length, readable: metrics.readable.length });
        }
      }

      await page.setViewportSize({ width: hasTouch ? 390 : 1440, height: 900 });
      // The viewport matrix crosses the desktop/mobile breakpoint in both
      // directions. Reload at the evidence width so shell-local drawer state
      // cannot obscure the direct-load screenshot.
      await page.reload();
      await page.getByText('Synthetic treatment', { exact: true }).first().waitFor();
      await page.screenshot({ path: path.join(output, `${name}-dashboard.png`), fullPage: true });

      await page.getByRole('button', { name: 'Application Log' }).click();
      // The waiter is armed before the fill that triggers the request: the
      // synthetic route fulfils immediately, so a listener installed after the
      // action can miss the response and time out on a page that behaved.
      const filteredApplications = page.waitForResponse((response) => response.url().includes('productName=Synthetic+treatment'));
      await page.getByLabel('Product name').fill('Synthetic treatment');
      await filteredApplications;
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export for DACS' }).click();
      await downloadPromise;
      await page.screenshot({ path: path.join(output, `${name}-application-log.png`), fullPage: true });

      await page.getByRole('button', { name: 'Product Limits' }).click();
      await page.getByLabel('Customer ID').fill('customer-1');
      await page.getByRole('button', { name: 'Check Limits' }).click();
      await page.getByText('Synthetic annual limit').waitFor();

      await page.getByRole('button', { name: 'Licenses' }).click();
      await page.getByText('Fixture technician', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit' }).click();
      await page.getByRole('dialog', { name: 'Edit license' }).waitFor();
      await page.getByLabel('License #').fill('NEW-2');
      await page.screenshot({ path: path.join(output, `${name}-license-dialog.png`), fullPage: true });
      await page.setViewportSize({ width: 820, height: 360 });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: "Couldn't save the license — HTTP 503" }).waitFor();
      const licenseDialog = page.getByRole('dialog', { name: 'Edit license' });
      assert.equal(await page.getByLabel('License #').inputValue(), 'NEW-2');
      const footer = await licenseDialog.getByRole('button', { name: 'Save', exact: true }).boundingBox();
      assert.ok(footer.y >= 0 && footer.y + footer.height <= 360, 'Save remains inside short viewport');
      await page.getByLabel('License #').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${name}-license-error-landscape.png`) });
      failLicenseSave = false;
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await licenseDialog.waitFor({ state: 'detached' });
      await page.setViewportSize({ width: hasTouch ? 390 : 1440, height: 900 });

      await page.getByRole('button', { name: 'Credentials' }).click();
      await page.getByText('Synthetic operating license', { exact: true }).waitFor();
      await page.getByRole('button', { name: '+ Add Credential' }).click();
      await page.getByRole('dialog', { name: 'Add credential' }).waitFor();
      await page.screenshot({ path: path.join(output, `${name}-credential-dialog.png`), fullPage: true });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Archive' }).click();
      await page.getByRole('dialog', { name: 'Archive credential' }).waitFor();
      await page.getByRole('button', { name: 'Archive', exact: true }).last().click();
      await page.getByRole('heading', { name: 'Archived' }).waitFor();
      await page.reload();
      await page.getByRole('heading', { name: 'Archived' }).waitFor();
      assert.equal(new URL(page.url()).search, '?source=synthetic&tab=credentials');
      await context.close();
    }

    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    assert.ok(report.requests.some((request) => request.path === '/api/admin/compliance-v2/report/export'));
    assert.ok(report.requests.some((request) => request.path === `/api/admin/compliance-v2/licenses/${technicianId}`));
    assert.ok(report.requests.some((request) => request.path === `/api/admin/credentials/${credentialId}`));
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await safari?.close();
    await chrome?.close();
    await server?.close();
  }
  console.log(`Admin compliance foundation proof passed: ${report.sizes.length} viewport cases. Evidence: ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
