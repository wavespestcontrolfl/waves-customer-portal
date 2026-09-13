'use strict';
/* global localStorage, document, window, innerWidth */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-audit-recovery');
const fontRoot = path.dirname(require.resolve('@fontsource/roboto/400.css'));
function html(component, exportName = "default", props = {}) {
  return `<!doctype html><html class="admin-app"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"></head><body><main id="root" class="admin-shell-v2" style="padding:16px"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Page=(await import('/src/pages/admin/${component}.jsx'))[${JSON.stringify(exportName)}];
const source=await (await fetch('/src/pages/admin/CompliancePage.jsx')).text();
const routerPath=source.split('\\n').find(line=>line.includes('from "') && line.includes('react-router-dom')).split('"')[1];
const {BrowserRouter}=await import(routerPath);
function Fixture(){const[open,setOpen]=React.useState(true);return open ? React.createElement(Page,{...${JSON.stringify(props)},onClose:()=>setOpen(false),onRescheduled:()=>{}}) : React.createElement('div',null,'Closed');}
createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement(Fixture)));
</script></body></html>`;
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, requests: [], errors: [], unmatched: [], screenshots: [] };
  let server, browser;
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => report.errors.push(error.message));
      let failExport = true, failPosts = true;
      await page.addInitScript(() => {
        localStorage.setItem('waves_admin_token', 'synthetic-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin', email: 'fixture@example.invalid' }));
      });
      await page.routeWebSocket('**/*', socket => socket.close());
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== server.baseUrl) return route.abort();
        if (url.pathname === '/qa-compliance') return route.fulfill({ contentType: 'text/html', body: html('CompliancePage') });
        if (url.pathname === '/qa-decisions') return route.fulfill({ contentType: 'text/html', body: html('AgentDecisionsPage') });
        if (url.pathname === '/qa-hygiene') return route.fulfill({ contentType: 'text/html', body: html('DataHygienePage') });
        if (url.pathname === '/qa-shadow') return route.fulfill({ contentType: 'text/html', body: html('AgentShadowDraftsPage') });
        if (url.pathname === '/qa-staff') return route.fulfill({ contentType: 'text/html', body: html('TimeTrackingPage', 'TeamTab') });
        if (url.pathname === '/qa-services') return route.fulfill({ contentType: 'text/html', body: html('ServiceLibraryPage') });
        if (url.pathname === '/qa-schedule') return route.fulfill({ contentType: 'text/html', body: html('AdminDispatchPage') });
        if (url.pathname === '/qa-reschedule') return route.fulfill({ contentType: 'text/html', body: html('SchedulePage', 'RescheduleModal', { service: { id: 'fixture-visit', customerName: 'Fixture customer', serviceType: 'Pest service', scheduledDate: '2035-01-02', windowStart: '08:00', windowEnd: '09:30' } }) });
        if (url.pathname === '/qa-blog') return route.fulfill({ contentType: 'text/html', body: html('BlogPage') });
        // A symlinked dependency cache resolves font URLs outside this worktree.
        // Serve only the installed Roboto font files in this synthetic fixture.
        if (url.pathname.startsWith('/@fs/')) {
          const fontFile = decodeURIComponent(url.pathname.slice(4));
          if (fontFile.startsWith(`${fontRoot}/files/`) && /\.woff2?$/.test(fontFile)) {
            return route.fulfill({ path: fontFile });
          }
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        report.requests.push({ path: url.pathname, method: req.method() });
        if (url.pathname === '/api/admin/usage/track') return route.fulfill({ json: {} });
        if (url.pathname === '/api/dispatch/csr/slots') return route.fulfill({ json: { slots: [] } });
        assert.equal(req.method(), 'GET', 'No business write expected in this fixture');
        if (url.pathname === '/api/admin/agent-decisions') return route.fulfill({ json: { decisions: [{ id: 'fixture-decision', status: 'pending', customerName: 'Fixture decision customer', detectedIntent: 'GENERAL', confidence: 0.9, inboundMessage: 'Fixture inbound message', suggestedMessage: 'Fixture suggested reply', recommendedActions: [] }] } });
        if (url.pathname === '/api/admin/agent-decisions/fixture-decision/context') return route.fulfill({ json: { context: {} } });
        if (url.pathname === '/api/admin/data-hygiene/proposals') return route.fulfill({ json: { proposals: [{ id: 'fixture-proposal', status: 'approved', field: 'property_notes', proposedValue: 'Fixture note', customer: { name: 'Fixture hygiene customer' } }] } });
        if (url.pathname === '/api/admin/data-hygiene/metrics') return route.fulfill({ json: {} });
        if (url.pathname === '/api/admin/agents/shadow-drafts') return route.fulfill({ json: { drafts: [{ id: 'fixture-draft', customerName: 'Fixture shadow customer', intent: 'GENERAL', draftResponse: 'Fixture draft', inboundMessage: 'Fixture question', createdAt: '2035-01-01T12:00:00Z', judgment: { verdict: 'equivalent', humanReplied: true, humanReplyText: 'Fixture human reply', scores: { safety: 9, overall: 9 } } }] } });
        if (url.pathname === '/api/admin/agents/shadow-scores') return route.fulfill({ json: { intents: [{ intent: 'GENERAL', drafts: 12, judged: 12 }] } });
        if (url.pathname === '/api/admin/agents/intent-modes') return route.fulfill({ json: { intents: [{ intent: 'GENERAL', mode: 'shadow' }] } });
        if (url.pathname === '/api/admin/agents/voice-profiles') return route.fulfill({ json: { pending: { id: 'fixture-profile', version: 2, profile_text: 'Fixture voice guidance.' } } });
        if (url.pathname === '/api/admin/agents/sealed-eval') return route.fulfill({ json: { currentVersion: 'fixture-v1', items: { active: 4, total: 4 }, runs: [{ id: 'fixture-run', promptVersion: 'fixture-v1', providerLeg: 'claude', status: 'complete', itemsJudged: 4, unsafeCount: 0, unsafeRate: 0, avgSafety: 9, startedAt: '2035-01-01T12:00:00Z' }] } });
        if (url.pathname === '/api/admin/agents/pathology') return route.fulfill({ json: { currentVersion: 'fixture-v1', cells: [{ surface: 'prompt', failureMode: 'unsupported_claim', total: 3, currentVersion: 1 }], proposals: [{ id: 'fixture-patch', status: 'pending', surface: 'prompt', failure_mode: 'unsupported_claim', evidence_count: 3, proposal: 'Fixture proposed guidance.' }] } });
        if (url.pathname === '/api/admin/timetracking/technicians') return route.fulfill({ json: { technicians: [{ id: 'fixture-tech', name: 'Fixture Technician', email: 'fixture@example.invalid', role: 'technician', active: true }] } });
        if (url.pathname === '/api/admin/services') return route.fulfill({ json: { total: 1, services: [{ id: 'fixture-service', name: 'Fixture Pest Service', category: 'pest_control', is_active: true, default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 40, base_price: 99, billing_type: 'recurring', service_key: 'fixture-pest' }] } });
        if (url.pathname === '/api/admin/discounts') return route.fulfill({ json: { discounts: [] } });
        if (url.pathname === '/api/admin/feature-flags') return route.fulfill({ json: { flags: {} } });
        if (url.pathname === '/api/health') return route.fulfill({ json: { gates: {} } });
        if (url.pathname === '/api/admin/schedule/recurring-alerts') return route.fulfill({ json: { alerts: [] } });
        if (url.pathname === '/api/admin/schedule') return route.fulfill({ json: { services: [], technicians: [], summary: {} } });
        if (url.pathname === '/api/admin/dispatch/products/catalog') return route.fulfill({ json: { products: [] } });
        if (url.pathname === '/api/dispatch/jobs') return route.fulfill({ json: { jobs: [] } });
        if (url.pathname === '/api/dispatch/insights') return route.fulfill({ json: { summary: {}, days: [], insights: [], stats: {} } });
        if (url.pathname === '/api/admin/compliance-v2/report/export') return route.fulfill(failExport
          ? { status: 503, json: { error: 'Fixture export unavailable' } }
          : { contentType: 'text/csv', body: 'Date,Product\n2035-01-01,Fixture' });
        if (url.pathname === '/api/admin/compliance-v2/applications') return route.fulfill({ json: { applications: [], total: 0 } });
        if (url.pathname === '/api/admin/dispatch/fixture-visit/reschedule-options') return route.fulfill({ json: { options: [{ date: '2035-01-03', displayDate: 'Thursday, January 3', suggestedWindow: { start: '10:00', display: '10:00–12:00' }, currentLoad: 2, sameAreaServices: 1 }] } });
        if (url.pathname === '/api/admin/content/blog/analytics') return route.fulfill({ json: { byStatus: {} } });
        if (url.pathname === '/api/admin/content/blog') return route.fulfill(failPosts
          ? { status: 503, json: { error: 'Fixture post list unavailable' } }
          : { json: { posts: [], counts: {} } });
        report.unmatched.push(`${req.method()} ${url.pathname}`);
        return route.fulfill({ status: 500, json: { error: 'Missing fixture' } });
      });
      async function capture(name) {
        await page.evaluate(async () => {
          await document.fonts.ready;
          const fonts = await document.fonts.load('14px Roboto');
          if (!fonts.length || fonts.some(font => font.status !== 'loaded')) throw new Error('Roboto font unavailable');
        });
        const file = path.join(output, `${name}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        report.screenshots.push(file);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} has page overflow`);
      }
      await page.goto(`${server.baseUrl}/qa-compliance?tab=log`);
      await page.getByRole('button', { name: 'Export for DACS' }).click();
      await page.getByRole('alert').filter({ hasText: 'Export failed (HTTP 503)' }).waitFor();
      await capture('compliance-export-error');
      failExport = false;
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export for DACS' }).click();
      assert.equal((await download).suggestedFilename(), 'dacs-report.csv');
      await page.getByRole('alert').waitFor({ state: 'detached' });
      await page.goto(`${server.baseUrl}/qa-blog?tab=posts`);
      await page.getByRole('alert').filter({ hasText: "Couldn't load posts" }).waitFor();
      assert.equal(await page.getByText('No posts found').count(), 0);
      await capture('blog-list-error');
      failPosts = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await page.getByText('No posts found').waitFor();
      await page.goto(`${server.baseUrl}/qa-reschedule`);
      await page.getByRole('dialog', { name: 'Reschedule service' }).waitFor();
      await page.getByText('Thursday, January 3').waitFor();
      assert.equal(await page.getByLabel('Client booking notifications').inputValue(), 'none');
      await page.getByRole('button', { name: /Pick Custom Date/ }).click();
      await page.getByLabel('Start Time').selectOption('10:00');
      await capture('reschedule-manual');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByText('Closed', { exact: true }).waitFor();
      await page.goto(`${server.baseUrl}/qa-schedule?tab=match`);
      for (const label of ['Tech Match', 'CSR Booking', 'Job Scores', 'Insights']) {
        const tab = page.getByRole('button', { name: label, exact: true });
        await tab.click();
        assert.equal(await tab.getAttribute('aria-current'), 'page');
        await page.getByText({ 'Tech Match': 'Required', 'CSR Booking': 'Recommended windows', 'Job Scores': 'Score formula', 'Insights': 'Period' }[label], { exact: true }).first().waitFor();
        await capture(`schedule-${label.toLowerCase().replaceAll(' ', '-')}`);
      }
      await page.goto(`${server.baseUrl}/qa-services`);
      if (width < 768) await page.getByRole('button', { name: /All Services/ }).click();
      await page.getByText('Fixture Pest Service', { exact: true }).first().click();
      const nameField = width < 768 ? page.getByLabel('Name', { exact: true }) : page.getByRole('textbox', { name: 'Name', exact: true });
      await nameField.fill('Fixture renamed service');
      await capture('service-editor');
      if (width < 768) {
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.goto(`${server.baseUrl}/qa-services`);
        await page.getByRole('button', { name: /Categories/ }).click();
        await capture('service-categories');
      } else {
        await page.goto(`${server.baseUrl}/qa-services?tab=discounts`);
        await page.getByRole('button', { name: '+ New Discount', exact: true }).click();
        await capture('discount-editor');
      }
      await page.goto(`${server.baseUrl}/qa-staff`);
      await page.getByRole('button', { name: 'Deactivate', exact: true }).click();
      const staffDialog = page.getByRole('dialog', { name: 'Deactivate Fixture Technician?' });
      await staffDialog.waitFor();
      await capture('staff-deactivate-dialog');
      await staffDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await staffDialog.waitFor({ state: 'detached' });
      await page.goto(`${server.baseUrl}/qa-decisions`);
      await page.getByText('Fixture decision customer', { exact: true }).first().waitFor();
      await capture('agent-decisions');
      await page.goto(`${server.baseUrl}/qa-hygiene`);
      await page.getByRole('button', { name: 'Revert', exact: true }).click();
      const hygieneDialog = page.getByRole('dialog');
      await capture('data-hygiene-revert');
      await hygieneDialog.getByRole('button', { name: 'Cancel' }).click();
      await hygieneDialog.waitFor({ state: 'detached' });
      await page.goto(`${server.baseUrl}/qa-shadow`);
      await page.getByText('Fixture shadow customer', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Read profile', exact: true }).click();
      await page.getByRole('button', { name: 'Read proposal', exact: true }).click();
      await page.getByText('Sealed exam', { exact: true }).waitFor();
      await capture('agent-shadow-expanded');
      await context.close();
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    try {
      if (browser) await browser.close();
    } finally {
      if (server) await server.close();
    }
  }
  console.log('Admin recovery desktop/mobile fixture passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
