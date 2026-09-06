'use strict';
// SYNTHETIC UI QA. Managed local frontend only; all APIs are intercepted.
// Mocked send/AI/read requests never reach a provider or application server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/email-browser');
const a = { id: '00000000-0000-4000-8000-000000000001', gmail_thread_id: 'thread-a', from_address: 'a@example.invalid', subject: 'First fixture message', is_read: true, received_at: new Date().toISOString(), body_text: 'First fixture body' };
const b = { ...a, id: '00000000-0000-4000-8000-000000000002', gmail_thread_id: 'thread-b', from_address: 'b@example.invalid', subject: 'Second fixture message', body_text: 'Second fixture body' };

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), scenarios: [], requests: [], unmatched: [], pageErrors: [], screenshots: [] };
  let server;
  let browser;
  let stage = 'startup';
  let failSend = false;
  let sendHold;
  let releaseSend;
  let draftHold;
  let releaseDraft;
  let smsMessages = [];
  let refreshedEmail = false;
  let blockedSenders = [];
  async function openPage(role = 'admin', width = 1440) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => {
      localStorage.setItem('waves_admin_token', 'fixture-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-owner', role: 'admin' }));
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, options) => String(url).endsWith('/admin/usage/track')
        ? Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } })) : realFetch(url, options);
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'fixture' });
    });
    page.on('pageerror', (error) => report.pageErrors.push({ stage, message: error.message }));
    page.on('dialog', (dialog) => dialog.accept());
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.baseUrl) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      report.requests.push({ stage, method: request.method(), path: api, search: url.search });
      let body;
      let status = 200;
      if (api === '/admin/auth/me') body = { id: 'fixture-owner', name: 'Fixture operator', email: 'operator@example.invalid', role };
      else if (api === '/health') body = { status: 'ok', gates: {} };
      else if (api === '/admin/feature-flags') body = { flags: {} };
      else if (api === '/admin/notifications/unread-count') body = { count: 0 };
      else if (api === '/admin/email/oauth/status') body = { connected: true };
      else if (api === '/admin/email/inbox') body = { emails: [b], total: 1 };
      else if (api === '/admin/email/stats') body = { total: 1, unread: 0 };
      else if (api === '/admin/email/daily-digest') body = { total_received: 0 };
      else if (api === '/admin/email/blocked') body = { blocked: blockedSenders };
      else if (api === '/admin/email/send' && request.method() === 'POST') { await sendHold; body = failSend ? { error: 'Synthetic send failure' } : { success: true }; status = failSend ? 503 : 200; }
      else if (api === `/admin/email/message/${a.id}/ai-draft` && request.method() === 'POST') { await draftHold; body = { reply_draft: 'Synthetic delayed suggestion' }; }
      else if (api === `/admin/email/message/${a.id}`) body = a;
      else if (api === `/admin/email/message/${b.id}`) body = refreshedEmail ? { ...b, body_text: 'Synthetic updated Email body' } : b;
      else if (api === '/admin/email/thread/thread-a') body = { thread: [a] };
      else if (api === '/admin/email/thread/thread-b') body = { thread: [refreshedEmail ? { ...b, body_text: 'Synthetic updated Email body' } : b] };
      else if (api === '/admin/communications/log') body = { messages: smsMessages, page: 1, hasMore: false };
      else if (api === '/admin/communications/stats') body = {};
      else if (api === '/admin/communications/ai-auto-reply-status') body = { enabled: false };
      else if (api === '/admin/communications/agent-draft') body = { draft: null };
      else if (api === '/admin/customers') body = { customers: [] };
      else { report.unmatched.push({ stage, method: request.method(), path: api }); body = { error: 'Unmatched synthetic request' }; status = 500; }
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return page;
  }
  const channel = (page, name) => page.getByRole('navigation', { name: 'Communications section', exact: true }).getByRole('button', { name, exact: true });
  async function scenario(name, work) { stage = name; console.log(`Checking: ${name}`); await work(); report.scenarios.push({ name, passed: true }); }
  async function shot(page, name) {
    await waitForFonts(page);
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(output, file), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Page must fit the viewport');
    report.screenshots.push(file);
  }
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    const page = await openPage();
    await scenario('legacy Email links open off-list messages with all URL context', async () => {
      await page.goto(`${server.baseUrl}/admin/email?id=${a.id}&tag=a&tag=b#source=bell`);
      await page.getByText(a.body_text, { exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/admin/communications');
      assert.deepEqual(new URL(page.url()).searchParams.getAll('tag'), ['a', 'b']);
      assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('source'), 'bell');
      assert.equal(await channel(page, 'Email').getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('h1').count(), 1);
      await shot(page, 'email-desktop-1440');
    });
    await scenario('Email reply and SMS composer both survive channel switches', async () => {
      await page.getByRole('textbox', { name: 'Reply' }).fill('Synthetic reply to A');
      await page.getByPlaceholder('Search emails...', { exact: true }).fill('Synthetic saved filter');
      await channel(page, 'SMS').click();
      await page.getByPlaceholder('Type your message…', { exact: true }).fill('Synthetic unsent SMS');
      await channel(page, 'Email').click();
      await page.getByRole('textbox', { name: 'Reply' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Reply' }).inputValue(), 'Synthetic reply to A');
      assert.equal(await page.getByPlaceholder('Search emails...', { exact: true }).inputValue(), 'Synthetic saved filter');
      await channel(page, 'SMS').click();
      assert.equal(await page.getByPlaceholder('Type your message…', { exact: true }).inputValue(), 'Synthetic unsent SMS');
      await page.goBack();
      await page.getByRole('textbox', { name: 'Reply' }).waitFor();
      assert.equal(await channel(page, 'Email').getAttribute('aria-current'), 'page');
    });
    await scenario('Email reply recovery survives a real reload', async () => {
      await page.reload();
      await page.getByRole('textbox', { name: 'Reply' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Reply' }).inputValue(), 'Synthetic reply to A');
    });
    await scenario('compose recovers after reload and a failed send; explicit success clears it', async () => {
      await page.getByRole('button', { name: 'New Email', exact: true }).click();
      await page.getByLabel('To *', { exact: true }).fill('recipient@example.invalid');
      await page.getByLabel('Subject', { exact: true }).fill('Synthetic subject');
      await page.getByLabel('Message *', { exact: true }).fill('Synthetic compose text');
      await page.reload();
      await page.getByRole('button', { name: 'Resume draft', exact: true }).click();
      assert.equal(await page.getByLabel('Message *', { exact: true }).inputValue(), 'Synthetic compose text');
      failSend = true;
      await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Message *', { exact: true }).inputValue(), 'Synthetic compose text');
      await shot(page, 'compose-desktop-1440');
      failSend = false;
      await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('button', { name: 'Resume draft', exact: true }).count(), 0);
      assert.equal(report.requests.filter((r) => r.path === '/admin/email/send').length, 2);
    });
    await scenario('pending reply survives channel switching without allowing another send', async () => {
      sendHold = new Promise((resolve) => { releaseSend = resolve; });
      const before = report.requests.filter((r) => r.path === '/admin/email/send').length;
      await page.getByRole('button', { name: 'Send Reply', exact: true }).click();
      await page.getByRole('button', { name: /Sending/ }).waitFor();
      await channel(page, 'SMS').click();
      await channel(page, 'Email').click();
      const pending = page.getByRole('button', { name: /Sending/ });
      await pending.waitFor();
      assert.equal(await pending.isDisabled(), true);
      assert.equal(report.requests.filter((r) => r.path === '/admin/email/send').length, before + 1);
      releaseSend(); sendHold = undefined; releaseSend = undefined;
      await page.getByRole('button', { name: 'Send Reply', exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Reply' }).inputValue(), '');
    });
    await scenario('blocked senders remains in the Email sub-section', async () => {
      await page.getByRole('navigation', { name: 'Email section', exact: true }).getByRole('button', { name: 'Blocked Senders' }).click();
      await page.getByPlaceholder('Block domain or email (e.g. spammer.com or bad@example.com)').waitFor();
      await channel(page, 'SMS').click();
      blockedSenders = [{ id: 'fixture-block', domain: 'blocked.example.invalid', created_at: new Date().toISOString() }];
      await channel(page, 'Email').click();
      await page.getByPlaceholder('Block domain or email (e.g. spammer.com or bad@example.com)').waitFor();
      await page.getByText('blocked.example.invalid', { exact: true }).waitFor();
      blockedSenders = [];
      await page.getByRole('navigation', { name: 'Email section', exact: true }).getByRole('button', { name: 'Inbox', exact: true }).click();
    });
    await scenario('hidden Email defers a changed message link until the channel opens', async () => {
      await channel(page, 'SMS').click();
      const before = report.requests.filter((r) => r.path === `/admin/email/message/${b.id}`).length;
      await page.evaluate(async (id) => {
        history.pushState({}, '', `/admin/communications?id=${id}#tab=sms`);
        dispatchEvent(new PopStateEvent('popstate'));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, b.id);
      assert.equal(report.requests.filter((r) => r.path === `/admin/email/message/${b.id}`).length, before);
      await channel(page, 'Email').click();
      await page.getByText(b.body_text, { exact: true }).waitFor();
      assert.equal(report.requests.filter((r) => r.path === `/admin/email/message/${b.id}`).length, before + 1);
    });
    await scenario('returning to Email refreshes the selected message and preserves its reply', async () => {
      await page.getByRole('textbox', { name: 'Reply' }).fill('Synthetic reply preserved during Email refresh');
      await channel(page, 'SMS').click();
      refreshedEmail = true;
      await channel(page, 'Email').click();
      await page.getByText('Synthetic updated Email body', { exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Reply' }).inputValue(), 'Synthetic reply preserved during Email refresh');
      refreshedEmail = false;
    });
    await scenario('retained SMS follows new notification and compose targets without losing channel-switch drafts', async () => {
      const sms = await openPage();
      smsMessages = [
        { id: 'fixture-sms-a', customerId: 'fixture-customer-a', from: '+19415550101', body: 'Synthetic first SMS' },
        { id: 'fixture-sms-b', customerId: 'fixture-customer-b', from: '+19415550102', body: 'Synthetic second SMS' },
      ].map((message) => ({ ...message, to: '+19413187612', direction: 'inbound', isRead: true, createdAt: new Date().toISOString() }));
      const recipient = sms.getByPlaceholder('Search by name or enter phone number…', { exact: true });
      const composer = sms.getByPlaceholder('Type your message…', { exact: true });
      const navigate = (search, tab) => sms.evaluate(({ search, tab }) => {
        history.pushState({}, '', `/admin/communications?${search}#tab=${tab}`);
        dispatchEvent(new PopStateEvent('popstate'));
      }, { search, tab });
      await sms.goto(`${server.baseUrl}/admin/communications?thread=fixture-customer-a#tab=sms`);
      await recipient.waitFor();
      await sms.waitForFunction(() => document.querySelector('input[placeholder="Search by name or enter phone number…"]')?.value === '+19415550101');
      // Let the existing 300ms search debounce settle before simulating time
      // in another channel, so an initial request cannot mask stale data.
      await sms.waitForTimeout(400);
      await composer.fill('Synthetic draft for first recipient');
      await channel(sms, 'Email').click();
      await navigate('id=' + a.id, 'email');
      await sms.getByText(a.body_text, { exact: true }).waitFor();
      smsMessages.push({ ...smsMessages[0], id: 'fixture-sms-new', body: 'Synthetic SMS received while in Email', createdAt: new Date().toISOString() });
      await channel(sms, 'SMS').click();
      assert.equal(await recipient.inputValue(), '+19415550101');
      assert.equal(await composer.inputValue(), 'Synthetic draft for first recipient');
      await sms.getByText('Synthetic SMS received while in Email', { exact: true }).first().waitFor();
      await channel(sms, 'Email').click();
      const reads = report.requests.filter((r) => r.path === '/admin/communications/log').length;
      await navigate('thread=fixture-customer-b', 'email');
      await sms.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(report.requests.filter((r) => r.path === '/admin/communications/log').length, reads);
      await channel(sms, 'SMS').click();
      await sms.waitForFunction(() => document.querySelector('input[placeholder="Search by name or enter phone number…"]')?.value === '+19415550102');
      assert.equal(await composer.inputValue(), '', 'An explicit new SMS destination must not inherit the old recipient’s text');
      await channel(sms, 'Email').click();
      await navigate('phone=%2B19415550103&draft=Synthetic%20linked%20draft', 'sms');
      await sms.waitForFunction(() => document.querySelector('input[placeholder="Search by name or enter phone number…"]')?.value === '+19415550103');
      assert.equal(await composer.inputValue(), 'Synthetic linked draft');
      await sms.close();
      smsMessages = [];
    });
    const mobile = await openPage('admin', 390);
    await scenario('mobile Email keeps one header and a recoverable full-screen composer', async () => {
      await mobile.goto(`${server.baseUrl}/admin/communications?id=${a.id}#tab=email`);
      await mobile.getByText(a.body_text, { exact: true }).waitFor();
      await shot(mobile, 'email-mobile-390');
      await mobile.getByRole('button', { name: 'New Email', exact: true }).click();
      await mobile.getByLabel('Message *', { exact: true }).fill('Synthetic mobile draft');
      await shot(mobile, 'compose-mobile-390');
      await mobile.getByRole('button', { name: 'Close', exact: true }).first().click();
      await channel(mobile, 'SMS').click();
      await channel(mobile, 'Email').click();
      await mobile.getByRole('button', { name: 'Resume draft', exact: true }).click();
      assert.equal(await mobile.getByLabel('Message *', { exact: true }).inputValue(), 'Synthetic mobile draft');
    });
    await scenario('mobile Settings sign-out clears Email recovery', async () => {
      await mobile.getByRole('button', { name: 'Close', exact: true }).first().click();
      await mobile.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Settings', exact: true }).click();
      await mobile.getByRole('button', { name: 'Sign Out', exact: true }).click();
      await mobile.getByLabel('Email address', { exact: true }).waitFor();
      assert.equal(new URL(mobile.url()).pathname, '/admin/login');
      assert.equal(await mobile.evaluate(() => sessionStorage.getItem('waves_admin_email_drafts_v1')), null);
      // openPage's init script restores the synthetic account on navigation.
      // A fresh session for that same account must not recover the signed-out draft.
      await mobile.goto(`${server.baseUrl}/admin/communications?id=${a.id}#tab=email`);
      await mobile.getByRole('button', { name: 'New Email', exact: true }).waitFor();
      assert.equal(await mobile.getByRole('button', { name: 'Resume draft', exact: true }).count(), 0);
    });
    const tech = await openPage('technician', 390);
    await scenario('verified technician role blocks Email despite a forged stored admin role', async () => {
      await tech.goto(`${server.baseUrl}/admin/communications#tab=email`);
      await channel(tech, 'SMS').waitFor();
      assert.equal(await channel(tech, 'Email').count(), 0);
      assert.equal(report.requests.filter((r) => r.stage === stage && r.path.startsWith('/admin/email/')).length, 0);
      await shot(tech, 'communications-technician-mobile-390');
    });
    const recovery = await openPage();
    await scenario('a delayed AI suggestion cannot restore a discarded reply', async () => {
      await recovery.goto(`${server.baseUrl}/admin/communications?id=${a.id}#tab=email`);
      await recovery.getByRole('textbox', { name: 'Reply' }).waitFor();
      draftHold = new Promise((resolve) => { releaseDraft = resolve; });
      await recovery.getByRole('button', { name: /AI Draft/ }).click();
      await recovery.getByRole('button', { name: 'Drafting...', exact: true }).waitFor();
      await recovery.getByRole('textbox', { name: 'Reply' }).fill('Synthetic discarded reply');
      await recovery.getByRole('button', { name: 'Discard reply', exact: true }).click();
      releaseDraft(); draftHold = undefined; releaseDraft = undefined;
      await recovery.getByRole('button', { name: /AI Draft/ }).waitFor();
      assert.equal(await recovery.getByRole('textbox', { name: 'Reply' }).inputValue(), '');
    });
    await scenario('storage failure keeps the real reload warning after leaving Communications', async () => {
      await recovery.evaluate(() => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (this === sessionStorage) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
          return setItem.call(this, key, value);
        };
      });
      await recovery.getByRole('textbox', { name: 'Reply' }).fill('Synthetic memory-only reply');
      await recovery.getByRole('alert').filter({ hasText: 'Draft recovery is unavailable' }).waitFor();
      await shot(recovery, 'email-recovery-warning-desktop-1440');
      await recovery.evaluate(() => {
        history.pushState({}, '', '/admin/settings?tab=general');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      await recovery.getByText('Company Info', { exact: true }).waitFor();
      recovery.removeAllListeners('dialog');
      const cdp = await recovery.context().newCDPSession(recovery);
      const beforeReload = (await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId;
      const warning = recovery.waitForEvent('dialog');
      // DevTools issues the real reload without waiting for a new document's
      // load event: dismissing beforeunload deliberately prevents that event.
      const reload = cdp.send('Page.reload');
      const dialog = await warning;
      assert.equal(dialog.type(), 'beforeunload');
      await dialog.dismiss();
      await reload;
      assert.equal((await cdp.send('Page.getFrameTree')).frameTree.frame.loaderId, beforeReload,
        'Dismissing the reload warning keeps the current document');
      await cdp.detach();
      await recovery.goBack();
      await recovery.getByRole('textbox', { name: 'Reply' }).waitFor();
      assert.equal(await recovery.getByRole('textbox', { name: 'Reply' }).inputValue(), 'Synthetic memory-only reply');
      await recovery.getByRole('button', { name: 'Discard reply', exact: true }).click();
      await recovery.reload();
      await recovery.getByRole('textbox', { name: 'Reply' }).waitFor();
      assert.equal(await recovery.getByRole('textbox', { name: 'Reply' }).inputValue(), '');
    });
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.requests.filter((r) => r.method !== 'GET'
      && r.path !== '/admin/email/send' && r.path !== `/admin/email/message/${a.id}/ai-draft`), []);
    report.passed = true;
  } catch (error) {
    report.failure = { stage, message: error.message };
    report.failure.pages = await Promise.all((browser?.contexts() || []).flatMap((context) => context.pages()).map(async (page) => ({
      url: page.url(),
      recipient: await page.getByPlaceholder('Search by name or enter phone number…', { exact: true }).inputValue({ timeout: 500 }).catch(() => null),
    })));
    throw error;
  } finally {
    releaseSend?.();
    releaseDraft?.();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    try { for (const context of browser?.contexts() || []) await context.setOffline(true); await browser?.close(); }
    finally { await server?.close(); }
  }
  console.log(`Synthetic Email QA passed: ${report.scenarios.length} scenarios.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
