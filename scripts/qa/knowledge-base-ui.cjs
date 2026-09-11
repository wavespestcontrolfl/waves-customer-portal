'use strict';
// Actual-route UI proof with fictional fixtures. All API writes stay in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require('playwright');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/knowledge-base-ui');
const entryFixture = { id: 'fixture-entry', title: 'Fixture knowledge entry with a deliberately long operational title', content: 'Fictional local knowledge content.\n\nThis is not treatment guidance.', category: 'operations', tags: '["fixture","operations"]', confidence: 'medium', status: 'active', source: 'manual', usage_count: 3, verified_by: 'Fixture operator', last_verified_at: '2026-09-01T14:00:00Z', created_at: '2026-08-01T14:00:00Z', updated_at: '2026-09-01T14:00:00Z' };
const wikiFixture = { id: 'fixture-wiki', slug: 'protocol/fixture-page', title: 'Fixture field intelligence page', category: 'protocol', review_tier: 'red', review_status: 'pending_review', data_point_count: 4, confidence: 'low', content: 'Fictional field intelligence content for local UI verification.', risk_flags: '["fixture_review_required"]', human_notes: 'Synthetic review note.' };
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, sizes: [], scenarios: [], requests: [], unmatched: [], pageErrors: [], screenshots: [] };
  let server, chrome, safari;
  try {
    server = await previewServer(root); chrome = await launchBrowser(); safari = await webkit.launch();
    for (const [name, browser, touch] of [['desktop', chrome, false], ['mobile', safari, true]]) {
      const context = await browser.newContext({ viewport: { width: touch ? 390 : 1440, height: 900 }, hasTouch: touch, serviceWorkers: 'block', timezoneId: 'America/New_York' });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const entries = [{ ...entryFixture }]; const wiki = { ...wikiFixture };
      let fixtureRole = 'admin', failPath = '', failMethod = '';
      await page.addInitScript(() => {
        localStorage.setItem('waves_admin_token', 'synthetic-local-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', role: 'admin', name: 'Fixture operator' }));
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, options) => String(input).endsWith('/admin/usage/track')
          ? Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
          : originalFetch(input, options);
      });
      page.on('pageerror', (error) => report.pageErrors.push(error.message));
      await page.routeWebSocket('**/*', (socket) => socket.close());
      await page.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        let body, status = 200;
        const payload = request.postData() ? request.postDataJSON() : null;
        if (/^\/api\/admin\/(kb|wiki)(\/|$)/.test(url.pathname)) {
          report.requests.push({ name, method, path: url.pathname, search: url.search, body: payload });
          assert.equal(request.headers().authorization, 'Bearer synthetic-local-token');
          if (method !== 'GET') await new Promise((resolve) => setTimeout(resolve, 200));
          if (url.pathname === failPath && method === failMethod) { status = 503; body = { error: 'Synthetic request failure' }; }
          else if (url.pathname === '/api/admin/kb/stats') body = { active: entries.length, flagged: 1, stale: 1, highConfidence: 1, lowConfidence: 1 };
          else if (url.pathname === '/api/admin/kb' && method === 'GET') body = { entries: entries.filter((entry) => (!url.searchParams.get('category') || entry.category === url.searchParams.get('category')) && (!url.searchParams.get('status') || entry.status === url.searchParams.get('status'))), total: entries.length, page: 1 };
          else if (url.pathname === '/api/admin/kb/search') body = { results: entries.filter((entry) => entry.title.toLowerCase().includes((url.searchParams.get('q') || '').toLowerCase())), query: url.searchParams.get('q') };
          else if (url.pathname === '/api/admin/kb' && method === 'POST') { const entry = { ...payload, id: 'fixture-created', status: 'active', created_at: '2026-09-10T14:00:00Z' }; entries.push(entry); body = { entry }; }
          else if (url.pathname === '/api/admin/kb/fixture-entry' && method === 'PUT') { entries[0].content = payload.content; body = { entry: entries[0] }; }
          else if (url.pathname === '/api/admin/kb/fixture-entry' && method === 'DELETE') { entries.splice(0, 1); body = { success: true }; }
          else if (url.pathname === '/api/admin/kb/fixture-entry/verify') { entries[0].confidence = 'high'; body = { entry: entries[0] }; }
          else if (url.pathname === '/api/admin/kb/fixture-entry/flag') { entries[0].status = 'flagged'; body = { entry: entries[0] }; }
          else if (url.pathname === '/api/admin/kb/audit/run') body = { audited: 1, flagged: 1, results: [{ id: 'fixture-entry', title: entryFixture.title, status: 'flagged', confidence: 'low', issues: ['Synthetic audit finding'], summary: 'Synthetic audit summary.' }] };
          else if (url.pathname === '/api/admin/kb/tokens/status') body = { tokens: [{ id: 'fixture-token', platform: 'Fixture integration', env_var_name: 'FIXTURE_CREDENTIAL', status: 'error', last_error: 'Synthetic integration health finding.', last_verified_at: '2026-09-10T14:00:00Z', metadata: '{"ttl":"Fixture TTL"}' }] };
          else if (url.pathname === '/api/admin/kb/tokens/check') body = { checked: 1, healthy: 0, failures: 1, results: [] };
          else if (url.pathname === '/api/admin/wiki/review/queue') body = { pending: wiki.review_status === 'pending_review' ? [wiki] : [], blocked: wiki.review_status === 'blocked' ? [wiki] : [], recentYellow: [] };
          else if (url.pathname === '/api/admin/wiki') body = { pages: [wiki] };
          else if (url.pathname === '/api/admin/wiki/protocol/fixture-page') body = { page: wiki };
          else if (url.pathname === '/api/admin/wiki/review/protocol/fixture-page') { wiki.review_status = payload.action === 'approve' ? 'approved' : 'blocked'; body = { success: true }; }
          else if (url.pathname === '/api/admin/wiki/tier/protocol/fixture-page') { wiki.review_tier = payload.tier; body = { success: true }; }
          else if (url.pathname === '/api/admin/wiki/update/protocol/fixture-page') body = { success: true };
          else { report.unmatched.push(`${method} ${url.pathname}`); status = 404; body = {}; }
        } else if (url.pathname === '/api/admin/auth/me') body = { id: 'fixture-user', role: fixtureRole, name: 'Fixture operator' };
        else if (url.pathname === '/api/admin/feature-flags') body = { flags: {} };
        else if (['/api/admin/notifications/unread-count', '/api/admin/communications/unread-count'].includes(url.pathname)) body = { count: 0, conversations: 0 };
        else if (url.pathname === '/api/admin/usage/track') body = { ok: true };
        else { report.unmatched.push(`${method} ${url.pathname}`); status = 404; body = {}; }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      async function screenshot(surface) {
        const file = path.join(output, `${name}-${surface}.png`);
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled' }); report.screenshots.push(path.relative(root, file));
      }
      async function measure(surface) {
        for (const width of [390, 700, 820, 1024, 1440]) for (const height of [900, 390]) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(300);
          const metrics = await page.locator('[data-ui-density="comfortable"]').evaluateAll((nodes) => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            controls: [...new Set(nodes.flatMap((node) => [...node.querySelectorAll('button,input,select,textarea')]))].filter((node) => node.getClientRects().length).map((node) => ({ text: node.textContent || node.getAttribute('aria-label'), tag: node.tagName, height: node.getBoundingClientRect().height, font: parseFloat(getComputedStyle(node).fontSize) })),
          }));
          assert.equal(metrics.overflow, false, `${name} ${surface} overflow at ${width}x${height}`);
          assert.ok(metrics.controls.length > 0, `${surface} has measurable comfortable controls`);
          for (const control of metrics.controls) {
            assert.ok(control.height >= 44, `${surface}: ${control.text} height ${control.height}`);
            assert.ok(control.font >= (control.tag === 'BUTTON' ? 14 : 16), `${surface}: ${control.text} font ${control.font}`);
          }
          report.sizes.push({ name, surface, width, height, ...metrics });
        }
        await page.setViewportSize({ width: touch ? 390 : 1440, height: 900 });
        await page.waitForTimeout(300);
      }
      for (const tab of ['browse', 'create', 'field', 'audit', 'tokens']) {
        await page.goto(`${server.baseUrl}/admin/knowledge?area=base&source=fixture&kbTab=${tab}`);
        await page.getByRole('heading', { name: 'Knowledge base', exact: true }).waitFor(); await waitForFonts(page);
        if (tab === 'browse') await page.getByText(entryFixture.title, { exact: true }).waitFor();
        if (tab === 'field') await page.getByText(wikiFixture.title, { exact: true }).first().waitFor();
        if (tab === 'tokens') await page.getByText('Fixture integration', { exact: true }).waitFor();
        await measure(tab); await screenshot(tab);
      }
      const requests = (method, requestPath) => report.requests.filter((entry) => entry.name === name && entry.method === method && entry.path === requestPath);
      const gotoTab = async (tab) => {
        await page.goto(`${server.baseUrl}/admin/knowledge?area=base&source=fixture&kbTab=${tab}`);
        await page.getByRole('heading', { name: 'Knowledge base', exact: true }).waitFor();
      };
      await gotoTab('browse');
      const search = page.getByLabel('Search knowledge base', { exact: true });
      await search.fill('no matching fixture');
      await page.getByText(entryFixture.title, { exact: true }).waitFor({ state: 'detached' });
      await search.fill(''); await page.getByText(entryFixture.title, { exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('operations');
      await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('active');
      const entryButton = page.getByRole('button', { name: new RegExp(entryFixture.title) });
      await entryButton.focus(); await page.keyboard.press('Enter');
      await page.getByText(entryFixture.content, { exact: true }).waitFor();
      await measure('entry-detail');
      await page.getByText(entryFixture.content, { exact: true }).scrollIntoViewIfNeeded();
      await screenshot('entry-detail');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const content = page.getByRole('textbox', { name: 'Content', exact: true });
      await content.fill('Synthetic edited content');
      failPath = '/api/admin/kb/fixture-entry'; failMethod = 'PUT';
      await page.getByRole('button', { name: 'Save', exact: true }).evaluate((node) => { node.click(); node.click(); });
      await page.getByRole('alert').filter({ hasText: 'Synthetic request failure' }).first().waitFor();
      assert.equal(await content.inputValue(), 'Synthetic edited content');
      assert.equal(requests('PUT', failPath).length, 1, 'Duplicate Save is guarded');
      failPath = ''; failMethod = '';
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Synthetic edited content', { exact: true }).waitFor();
      assert.deepEqual(requests('PUT', '/api/admin/kb/fixture-entry').at(-1).body, { content: 'Synthetic edited content' });
      await page.getByRole('button', { name: 'Verify', exact: true }).evaluate((node) => { node.click(); node.click(); });
      await page.getByText('Marked as verified', { exact: true }).waitFor();
      assert.equal(requests('POST', '/api/admin/kb/fixture-entry/verify').length, 1);
      assert.deepEqual(requests('POST', '/api/admin/kb/fixture-entry/verify')[0].body, {});
      await page.getByRole('button', { name: 'Flag', exact: true }).click();
      await page.getByText('Entry flagged for review', { exact: true }).waitFor();
      assert.deepEqual(requests('POST', '/api/admin/kb/fixture-entry/flag')[0].body, { reason: 'Flagged from admin UI' });
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      const deletion = page.getByRole('dialog', { name: 'Delete this knowledge base entry?', exact: true });
      await deletion.waitFor(); await measure('delete-dialog'); await screenshot('delete-dialog');
      await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(requests('DELETE', '/api/admin/kb/fixture-entry').length, 0);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      failPath = '/api/admin/kb/fixture-entry'; failMethod = 'DELETE';
      await deletion.getByRole('button', { name: 'Delete', exact: true }).click();
      await deletion.getByRole('alert').waitFor(); failPath = ''; failMethod = '';
      await deletion.getByRole('button', { name: 'Delete', exact: true }).click();
      await deletion.waitFor({ state: 'detached' });
      assert.equal(requests('DELETE', '/api/admin/kb/fixture-entry').length, 2);

      await gotoTab('create');
      await page.getByRole('button', { name: 'Create entry', exact: true }).click();
      await page.getByText('Title is required.', { exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'Title', exact: false }).fill('Fixture created entry');
      await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('operations');
      await page.getByRole('combobox', { name: 'Confidence', exact: true }).selectOption('low');
      await page.getByRole('textbox', { name: 'Tags (comma-separated)', exact: true }).fill(' alpha, beta ,, ');
      await page.getByRole('textbox', { name: 'Content (Markdown)', exact: true }).fill('Synthetic new entry content');
      failPath = '/api/admin/kb'; failMethod = 'POST';
      await page.getByRole('button', { name: 'Create entry', exact: true }).evaluate((node) => { node.click(); node.click(); });
      await page.getByRole('alert').filter({ hasText: 'Synthetic request failure' }).first().waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Title', exact: false }).inputValue(), 'Fixture created entry');
      assert.equal(requests('POST', '/api/admin/kb').length, 1);
      await screenshot('create-error'); failPath = ''; failMethod = '';
      await page.getByRole('button', { name: 'Create entry', exact: true }).click();
      await page.getByText('Fixture created entry', { exact: true }).waitFor();
      assert.deepEqual(requests('POST', '/api/admin/kb').at(-1).body, { title: 'Fixture created entry', category: 'operations', content: 'Synthetic new entry content', tags: ['alpha', 'beta'], confidence: 'low', source: 'manual' });
      assert.equal(new URL(page.url()).search, '?area=base&source=fixture');

      await gotoTab('audit'); await page.getByRole('spinbutton', { name: 'Max entries to review', exact: true }).fill('4');
      await page.getByRole('button', { name: 'Audit stale & low-confidence', exact: true }).evaluate((node) => { node.click(); node.click(); });
      await page.getByText('Synthetic audit finding', { exact: true }).waitFor();
      assert.equal(requests('POST', '/api/admin/kb/audit/run').length, 1);
      assert.deepEqual(requests('POST', '/api/admin/kb/audit/run')[0].body, { maxEntries: 4, forceAll: false });
      await page.getByRole('button', { name: 'Audit all (force)', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent === 'Audit all (force)' && !node.disabled));
      await screenshot('audit-results');
      assert.deepEqual(requests('POST', '/api/admin/kb/audit/run').at(-1).body, { maxEntries: 4, forceAll: true });

      failPath = '/api/admin/kb/tokens/status'; failMethod = 'GET'; await gotoTab('tokens');
      await page.getByText('Token status could not be loaded.', { exact: true }).waitFor(); failPath = ''; failMethod = '';
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByText('Fixture integration', { exact: true }).waitFor();
      failPath = '/api/admin/kb/tokens/check'; failMethod = 'POST';
      await page.getByRole('button', { name: 'Run health check', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Synthetic request failure' }).first().waitFor(); failPath = ''; failMethod = '';
      await page.getByRole('button', { name: 'Run health check', exact: true }).click();
      await page.getByText('Checked 1 tokens: 0 healthy, 1 failed', { exact: true }).waitFor();
      assert.equal(requests('POST', '/api/admin/kb/tokens/check').length, 2);

      await gotoTab('field');
      const openField = async () => {
        await page.getByRole('button', { name: new RegExp(wikiFixture.title) }).first().click();
        await page.getByRole('button', { name: 'Close', exact: true }).waitFor();
      };
      await openField(); await measure('field-detail');
      await page.getByText(wikiFixture.content, { exact: true }).scrollIntoViewIfNeeded();
      await screenshot('field-detail');
      await page.getByRole('button', { name: 'Block', exact: true }).last().click();
      const blocking = page.getByRole('dialog', { name: 'Why is this page blocked? (stored as review notes)', exact: true });
      await blocking.getByRole('textbox', { name: 'Review notes', exact: true }).fill('Synthetic block reason');
      await measure('block-dialog'); await screenshot('block-dialog');
      await blocking.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(requests('POST', '/api/admin/wiki/review/protocol/fixture-page').length, 0);
      await page.getByRole('button', { name: 'Block', exact: true }).last().click();
      await blocking.getByRole('textbox', { name: 'Review notes', exact: true }).fill('Synthetic block reason');
      failPath = '/api/admin/wiki/review/protocol/fixture-page'; failMethod = 'POST';
      await blocking.getByRole('button', { name: 'Block', exact: true }).click();
      await blocking.getByRole('alert').waitFor();
      assert.equal(await blocking.getByRole('textbox', { name: 'Review notes', exact: true }).inputValue(), 'Synthetic block reason');
      failPath = ''; failMethod = '';
      await blocking.getByRole('button', { name: 'Block', exact: true }).click(); await blocking.waitFor({ state: 'detached' });
      assert.deepEqual(requests('POST', '/api/admin/wiki/review/protocol/fixture-page').at(-1).body, { action: 'block', notes: 'Synthetic block reason' });
      await openField(); await page.getByRole('combobox', { name: 'Pin review tier', exact: true }).selectOption('yellow');
      await page.getByText('Tier pinned to yellow', { exact: true }).waitFor();
      assert.deepEqual(requests('PUT', '/api/admin/wiki/tier/protocol/fixture-page')[0].body, { tier: 'yellow' });
      await openField();
      await page.getByRole('button', { name: 'Regenerate', exact: true }).evaluate((node) => { node.click(); node.click(); });
      await page.getByText('Page regenerated', { exact: true }).waitFor();
      assert.equal(requests('POST', '/api/admin/wiki/update/protocol/fixture-page').length, 1);
      assert.deepEqual(requests('POST', '/api/admin/wiki/update/protocol/fixture-page')[0].body, {});
      await page.getByRole('button', { name: 'Approve', exact: true }).last().click();
      await page.getByText('Page approved — now agent-visible', { exact: true }).waitFor();
      assert.deepEqual(requests('POST', '/api/admin/wiki/review/protocol/fixture-page').at(-1).body, { action: 'approve' });

      fixtureRole = 'technician';
      const tokenReads = requests('GET', '/api/admin/kb/tokens/status').length;
      await gotoTab('tokens'); await page.getByText('Fixture created entry', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /^(tokens|token health|ai audit)$/i }).count(), 0);
      assert.equal(requests('GET', '/api/admin/kb/tokens/status').length, tokenReads);
      assert.equal(new URL(page.url()).searchParams.get('kbTab'), 'tokens', 'Restricted deep link falls back without rewriting URL');
      await gotoTab('field'); await openField();
      assert.equal(await page.getByRole('button', { name: 'Regenerate', exact: true }).count(), 0);
      report.scenarios.push({ name, passed: true });
      await context.close();
    }
    assert.deepEqual(report.unmatched, []); assert.deepEqual(report.pageErrors, []); report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await safari?.close(); await chrome?.close(); await server?.close();
  }
  console.log(`Knowledge Base UI proof passed: ${report.sizes.length} viewport cases. Evidence: ${output}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
