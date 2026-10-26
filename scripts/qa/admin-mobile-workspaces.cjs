"use strict";
/* global document, localStorage, navigator, getComputedStyle, innerWidth */
// Synthetic frontend-only checks of the actual mobile schedule components.
// Every API request is intercepted; external requests and sockets are blocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webkit } = require("playwright");
const { previewServer, launchBrowser, waitForFonts, evidence } = require("./browser");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, ".tmp/admin-mobile-workspaces");
const html = `<!doctype html><html class="admin-app"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body class="admin-shell-v2"><main id="root" style="padding:16px"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { useState } = React;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const { default: MobileDispatchList } = await import('/src/components/schedule/MobileDispatchList.jsx');
const { default: MobileAppointmentDetailSheet } = await import('/src/components/schedule/MobileAppointmentDetailSheet.jsx');
const service = { id: 'fixture-visit', customerId: 'fixture-customer', customerName: 'Avery Example', address: '100 Example Boulevard, Building Three, Example City, FL 34201', serviceType: 'Pest Control', status: 'confirmed', windowStart: '08:00', windowEnd: '10:00', scheduledTime: '08:00', scheduledDate: '2026-10-26', technicianId: 'fixture-tech', prepaidAmount: 120, estimatedDriveMinutes: 105, notes: '' };
function App() {
 const [selected, setSelected] = useState(null);
 return React.createElement(React.Fragment, null,
  React.createElement('div', { 'data-fixture': 'schedule' }, React.createElement(MobileDispatchList, { mode: 'day', date: '2026-10-26', services: [service, { ...service, id: 'fixture-second', customerName: 'Jordan Example', status: 'completed' }], technicians: [{ id: 'fixture-tech', name: 'Example Technician' }], onEdit: setSelected, onEnRoute: () => {}, onProtocol: () => {} })),
  selected && React.createElement(MobileAppointmentDetailSheet, { service: selected, onClose: () => setSelected(null), onEdit: () => {}, onReviewCheckout: () => {}, onCompleteService: () => {} }));
}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;

async function readable(locator) {
  const metrics = await locator.evaluate((root) => {
    const visible = (node) => node.getClientRects().length && !node.closest('[hidden], [inert]');
    const text = [...root.querySelectorAll('*')].filter(visible).filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()));
    return {
      nativeButtons: [...root.querySelectorAll('button')].filter(visible).filter((node) => getComputedStyle(node).appearance !== 'none').map((node) => node.textContent.trim()),
      beveledButtons: [...root.querySelectorAll('button')].filter(visible).filter((node) => {
        const style = getComputedStyle(node);
        return ['Top', 'Right', 'Bottom', 'Left'].some((side) =>
          parseFloat(style[`border${side}Width`]) > 0 && ['inset', 'outset'].includes(style[`border${side}Style`]),
        );
      }).map((node) => node.textContent.trim()),
      small: text.filter((node) => parseFloat(getComputedStyle(node).fontSize) < 14).map((node) => node.textContent.trim().slice(0, 90)),
      clipped: text.filter((node) => {
        const box = node.getBoundingClientRect();
        return box.left < -1 || box.right > innerWidth + 1;
      }).map((node) => node.textContent.trim().slice(0, 90)),
    };
  });
  assert.deepEqual(metrics.nativeButtons, [], 'Custom buttons suppress native browser appearance');
  assert.deepEqual(metrics.beveledButtons, [], 'Custom buttons suppress native inset/outset borders');
  assert.deepEqual(metrics.small, [], 'Readable text stays at or above 14px');
  assert.deepEqual(metrics.clipped, [], 'Visible text stays within the viewport');
  return metrics;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, cases: [], screenshots: [], unmatched: [], errors: [] };
  let server;
  try {
    server = await previewServer(root);
    for (const engine of ['chromium', 'webkit']) {
      const browser = engine === 'webkit' ? await webkit.launch({ headless: true }) : await launchBrowser();
      try {
        for (const width of [320, 390, 820, 1440]) {
          const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 1100, timezoneId: 'America/New_York', serviceWorkers: 'block' });
          await context.routeWebSocket('**/socket.io/**', (socket) => socket.close());
          const page = await context.newPage();
          page.setDefaultTimeout(15000);
          page.setDefaultNavigationTimeout(60000);
          page.on('pageerror', (error) => report.errors.push(error.message));
          await page.addInitScript(() => {
            localStorage.setItem('waves_admin_token', 'synthetic-token');
            localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-admin', role: 'admin' }));
            if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({});
          });
          await page.route('**/*', (route) => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
            if (url.pathname === '/qa-mobile-workspaces') return route.fulfill({ contentType: 'text/html', body: html });
            if (!url.pathname.startsWith('/api/')) return route.continue();
            const fixtures = {
              '/api/admin/customers/fixture-customer/cards': { cards: [] },
              '/api/admin/schedule/fixture-visit/card-request': {},
              '/api/admin/schedule/fixture-visit/estimate-source': {},
              '/api/admin/schedule/annual-prepay-availability': { enabled: false },
              '/api/admin/feature-flags': { flags: {} },
            };
            const body = request.method() === 'GET' ? fixtures[url.pathname] : undefined;
            if (body === undefined) report.unmatched.push(`${request.method()} ${url.pathname}`);
            return route.fulfill({ status: body === undefined ? 404 : 200, contentType: 'application/json', body: JSON.stringify(body || {}) });
          });
          await page.goto(`${server.baseUrl}/qa-mobile-workspaces`);
          await page.locator('[data-fixture="schedule"]').waitFor();
          await waitForFonts(page);
          await readable(page.locator('[data-fixture="schedule"]'));
          const opener = page.getByRole('button').filter({ hasText: 'Avery Example' }).first();
          await opener.click();
          const detail = page.getByRole('dialog');
          await detail.waitFor();
          assert.equal(await detail.getAttribute('aria-modal'), 'true');
          await readable(detail);
          // Reverse-tab from the first close control must wrap inside the sheet.
          await detail.getByRole('button', { name: 'Close', exact: true }).focus();
          await page.keyboard.press('Shift+Tab');
          assert.ok(await detail.evaluate((node) => node.contains(document.activeElement)));
          if ([390, 1440].includes(width)) {
            await detail.evaluate((node) => { node.scrollTop = 0; });
            await page.waitForFunction((node) => node.scrollTop === 0, await detail.elementHandle());
            const file = path.join(output, `${engine}-appointment-${width}.png`);
            await page.screenshot({ path: file }); report.screenshots.push(file);
          }
          await page.keyboard.press('Escape');
          await detail.waitFor({ state: 'hidden' });
          assert.ok(await opener.evaluate((node) => node === document.activeElement), 'Closing restores appointment row focus');
          report.cases.push({ engine, width, passed: true });
          await context.close();
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log(JSON.stringify({ passed: true, cases: report.cases.length, screenshots: report.screenshots.length }));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await server?.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
