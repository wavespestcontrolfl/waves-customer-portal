'use strict';
// Synthetic frontend only. Every API request is intercepted; no messages leave this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/communications-sms');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  let server, browser;
  const report = { ...evidence(root), screenshots: [], scenarios: [], errors: [], unmatched: [] };
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    for (const width of [1440, 390]) {
      let failLog = false;
      const messages = [
        { id: 'fixture-a', from: '+19415550100', to: '+19413187612', direction: 'inbound', body: 'Please check the gate.', createdAt: '2024-07-01T12:00:00Z', isRead: true },
        { id: 'fixture-b', from: '+19415550101', to: '+19413187612', direction: 'inbound', body: 'Please check the lawn.', createdAt: '2024-07-01T12:01:00Z', isRead: true },
      ];
      const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 1000 }, timezoneId: 'America/New_York' });
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => report.errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('waves_admin_token', 'fixture-token');
        localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-owner', role: 'admin' }));
        navigator.sendBeacon = () => true;
        if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'fixture' });
      });
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io/')) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const api = url.pathname.slice(4);
        let body = {}, status = 200;
        if (api === '/admin/auth/me') body = { id: 'fixture-owner', name: 'Fixture operator', role: 'admin' };
        else if (api === '/health') body = { status: 'ok', gates: {} };
        else if (api === '/admin/feature-flags') body = { flags: { 'admin-navigation': true } };
        else if (api === '/admin/notifications/unread-count') body = { count: 0 };
        else if (api === '/admin/communications/unread-count') body = { conversations: 0 };
        else if (api === '/admin/usage/track') body = {};
        else if (api === '/admin/communications/log') {
          body = failLog ? { error: 'Fixture unavailable' } : { messages, hasMore: false, page: 1 };
          status = failLog ? 503 : 200;
        } else if (api === '/admin/communications/stats') body = { totalSent: 8, totalReceived: 12, channelStats: [] };
        else if (api === '/admin/communications/blocked-numbers') body = { numbers: [] };
        else if (api === '/admin/communications/ai-auto-reply-status') body = { enabled: false };
        else if (api === '/admin/communications/agent-draft') body = { draft: null };
        else if (api === '/admin/communications/messages/read') body = { success: true };
        else { report.unmatched.push(api); status = 404; body = { error: 'No fixture' }; }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(`${server.baseUrl}/admin/communications#tab=sms`);
      const field = page.getByRole('textbox', { name: 'Text message' });
      await field.waitFor();
      await waitForFonts(page);
      const open = async (body) => {
        await page.getByText(body, { exact: true }).click();
        await page.getByRole('button', { name: 'Text back', exact: true }).click();
      };
      await open('Please check the gate.');
      await field.fill('Draft for the gate conversation');
      await open('Please check the lawn.');
      assert.equal(await field.inputValue(), '');
      await field.fill('Draft for the lawn conversation');
      await open('Please check the gate.');
      assert.equal(await field.inputValue(), 'Draft for the gate conversation');
      await page.reload();
      await open('Please check the gate.');
      assert.equal(await field.inputValue(), 'Draft for the gate conversation');
      report.scenarios.push(`${width}: isolated drafts and reload recovery`);
      await page.getByRole('button', { name: 'Refresh messages' }).scrollIntoViewIfNeeded();
      const ready = path.join(output, `ready-${width}.png`);
      await page.screenshot({ path: ready, fullPage: true }); report.screenshots.push(ready);
      failLog = true;
      await page.getByRole('button', { name: 'Refresh messages' }).click();
      await page.getByRole('alert').filter({ hasText: 'Messages could not be refreshed' }).waitFor();
      assert.equal(await page.getByText('Please check the gate.', { exact: true }).count(), 1);
      assert.equal(await field.inputValue(), 'Draft for the gate conversation');
      const failed = path.join(output, `retry-${width}.png`);
      await page.screenshot({ path: failed, fullPage: true }); report.screenshots.push(failed);
      failLog = false;
      messages.push({ ...messages[0], id: 'fixture-c', from: '+19415550102', body: 'New incoming message.' });
      await page.getByRole('button', { name: 'Try again' }).click();
      await page.getByText('New incoming message.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      report.scenarios.push(`${width}: retained messages, retry recovery and no horizontal overflow`);
      await page.close();
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.unmatched, []);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await server?.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
