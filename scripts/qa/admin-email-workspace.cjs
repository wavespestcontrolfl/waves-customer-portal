'use strict';
// SYNTHETIC UI QA. Only the managed frontend runs; every API is intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, waitForFonts, evidence } = require('./browser');
const root = path.resolve(__dirname, '../..');
const baseline = process.argv.includes('--baseline');
const output = path.join(root, '.tmp/email-workspace', baseline ? 'before' : 'after');
const stamp = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const fixtureMail = [
  { id: '00000000-0000-4000-8000-000000000001', gmail_thread_id: 'thread-a', from_address: 'avery@example.invalid', from_name: 'Avery Sample', subject: 'A question before tomorrow’s visit', snippet: 'Should I move the patio furniture before you arrive?', body_text: 'Hi Waves,\n\nShould I move the patio furniture before you arrive tomorrow? The side gate will be unlocked and the dog will be inside.\n\nThanks,\nAvery', classification: 'customer_request', is_read: false, is_starred: false, received_at: stamp(6), to_address: 'office@example.invalid', has_attachments: true, attachments: [{ id: 'fixture-file', gmail_attachment_id: 'fixture-attachment', filename: 'Patio notes.pdf', size_bytes: 24576 }] },
  { id: '00000000-0000-4000-8000-000000000002', gmail_thread_id: 'thread-b', from_address: 'jordan@example.invalid', from_name: 'Jordan Example', subject: 'Please help me find my service report', snippet: 'I would like to review the notes from my last service.', body_text: 'Hello, could you help me find my latest service report? Thank you.', classification: 'customer_request', is_read: false, is_starred: true, received_at: stamp(18) },
  { id: '00000000-0000-4000-8000-000000000003', gmail_thread_id: 'thread-c', from_address: 'morgan@example.invalid', from_name: 'Morgan Fixture', subject: 'Lawn care in Parrish', snippet: 'We are interested in a lawn care plan for our home.', body_text: 'Hello, we are interested in a lawn care plan for our home in Parrish.', classification: 'lead_inquiry', is_read: true, received_at: stamp(35), extracted_data: { person_name: 'Morgan Fixture', service_interest: 'Lawn care', urgency: 'normal' } },
  { id: '00000000-0000-4000-8000-000000000004', gmail_thread_id: 'thread-d', from_address: 'supplier@example.invalid', from_name: 'Sample Supply', subject: 'September supplies', snippet: 'Your requested invoice is ready for review.', body_text: 'Your requested invoice is ready for review.', classification: 'vendor_invoice', is_read: true, received_at: stamp(95), extracted_data: { vendor_name: 'Sample Supply', invoice_amount: '125.00' } },
];
const a = fixtureMail[0], b = fixtureMail[1];
const channel = (page, name) => page.getByRole('navigation', { name: 'Communications section', exact: true }).getByRole('button', { name, exact: true });

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), scenarios: [], requests: [], unmatched: [], pageErrors: [], screenshots: [], geometry: [] };
  let server, browser, safari;
  let stage = 'startup';
  const states = [];
  async function openPage(width, { engine = browser, role = 'admin', coarse = width < 1100 } = {}) {
    const state = { emails: structuredClone(fixtureMail), role, connected: true, fail: new Set(), sends: [], blocked: [{ id: 'fixture-block', domain: 'unwanted.example.invalid', reason: 'Manual block from admin portal', blocked_count: 3, created_at: stamp(200) }] };
    states.push(state);
    const page = await engine.newPage({ viewport: { width, height: width < 600 ? 844 : 1000 }, hasTouch: coarse, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    await page.addInitScript(() => {
      localStorage.setItem('waves_admin_token', 'fixture-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-owner', role: 'admin' }));
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, options) => String(url).endsWith('/admin/usage/track') ? Promise.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } })) : realFetch(url, options);
      navigator.sendBeacon = () => true;
      if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'fixture' });
    });
    page.on('pageerror', (error) => report.pageErrors.push({ stage, message: error.message }));
    page.on('dialog', (dialog) => dialog.accept());
    await page.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io/')) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const api = url.pathname.slice(4);
      const record = { stage, method: request.method(), path: api, search: url.search };
      report.requests.push(record);
      let body, status = 200;
      if (api === '/admin/auth/me') body = { id: 'fixture-owner', name: 'Fixture operator', email: 'operator@example.invalid', role: state.role };
      else if (api === '/health') body = { status: 'ok', gates: {} };
      else if (api === '/admin/feature-flags') body = { flags: { 'admin-navigation': true } };
      else if (api === '/admin/notifications/unread-count') body = { count: 0 };
      else if (api === '/admin/communications/unread-count') body = { conversations: 0 };
      else if (api === '/admin/usage/track') body = {};
      else if (api === '/admin/email/oauth/status') { await state.statusHold; body = { connected: state.connected }; }
      else if (api === '/admin/email/oauth/auth-url') body = { url: `${server.baseUrl}/synthetic-oauth` };
      else if (api === '/admin/email/inbox') {
        await state.inboxHold;
        const search = (url.searchParams.get('search') || '').toLowerCase();
        let emails = state.emails.filter((mail) => !search || `${mail.subject} ${mail.from_name}`.toLowerCase().includes(search));
        if (url.searchParams.get('category') === 'unread') emails = emails.filter((mail) => !mail.is_read);
        if (url.searchParams.get('category') === 'starred') emails = emails.filter((mail) => mail.is_starred);
        body = { emails, total: state.total ?? emails.length };
      }
      else if (api === '/admin/email/stats') body = { total: 42, unread: 7, today: 12, vendor: 4, starred: 3 };
      else if (api === '/admin/email/daily-digest') body = { total_received: 12, leads_created: 2, spam_quarantined: 1, invoices_processed: 2, domains_blocked_today: 0 };
      else if (api === '/admin/email/blocked') body = { blocked: state.blocked };
      else if (api === '/admin/email/send') { record.payload = request.postDataJSON(); state.sends.push(record.payload); await state.sendHold; body = { success: true, messageId: 'fixture-sent' }; }
      else if (api.startsWith('/admin/email/thread/')) { await state.threadHold; body = { thread: state.emails.filter((mail) => api.endsWith(mail.gmail_thread_id)) }; }
      else if (api.startsWith('/admin/email/message/')) {
        const id = api.split('/')[4], mail = state.emails.find((message) => message.id === id) || fixtureMail.find((message) => message.id === id);
        if (api.endsWith('/read')) { if (mail) mail.is_read = true; body = { read: true }; }
        else if (api.endsWith('/star')) { if (mail && !state.fail.has(api)) mail.is_starred = !mail.is_starred; body = { is_starred: mail?.is_starred }; }
        else if (/\/(archive|trash)$/.test(api)) { if (!state.fail.has(api)) state.emails = state.emails.filter((message) => message.id !== id); body = { success: true }; }
        else if (api.endsWith('/reclassify')) body = { classification: { category: 'customer_request', person_name: 'Avery Sample', urgency: 'normal' } };
        else if (api.endsWith('/ai-draft')) { await state.draftHold; body = { reply_draft: 'Thanks for checking. We will review the access notes before your appointment.' }; }
        else if (api.includes('/attachment/')) return route.fulfill({ contentType: 'application/pdf', body: 'Synthetic attachment' });
        else { if (mail) mail.is_read = true; body = mail || { error: 'Message not found' }; status = mail ? 200 : 404; }
      }
      else if (api === '/admin/email/block') { record.payload = request.postDataJSON(); if (!state.fail.has(api)) state.blocked.push({ id: 'fixture-new-block', ...record.payload, created_at: stamp(0) }); body = { success: true }; }
      else if (api.startsWith('/admin/email/blocked/')) { if (!state.fail.has(api)) state.blocked = state.blocked.filter((entry) => !api.endsWith(entry.id)); body = { success: true }; }
      else if (api === '/admin/communications/link-library') body = { links: [{ key: 'fixture-quote', name: 'Request a quote', category: 'booking', url: 'https://www.wavespestcontrol.com/quote/' }] };
      else if (api === '/admin/customers') body = { customers: [{ id: 'fixture-customer', firstName: 'Avery', lastName: 'Sample', first_name: 'Avery', last_name: 'Sample', email: a.from_address, phone: '9415550111' }] };
      else if (api === '/admin/communications/send-prep') { record.payload = request.postDataJSON(); body = { success: true, message: 'Synthetic guide delivered by email.' }; }
      else if (api === '/admin/communications/log') body = { messages: [], page: 1, hasMore: false };
      else if (api === '/admin/communications/stats') body = {};
      else if (api === '/admin/communications/ai-auto-reply-status') body = { enabled: false };
      else if (api === '/admin/communications/blocked-numbers') body = { blocked: [] };
      else if (api === '/admin/communications/agent-draft') body = { draft: null };
      else { report.unmatched.push(record); body = { error: 'Unmatched synthetic request' }; status = 500; }
      if (state.fail.has(api)) { status = 503; body = { error: 'Synthetic service unavailable' }; }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    return { page, state };
  }
  async function scenario(name, run) { stage = name; console.log(`Checking: ${name}`); await run(); report.scenarios.push({ name, passed: true }); }
  async function shot(page, name) {
    await waitForFonts(page);
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(output, file), fullPage: true });
    if (!baseline) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Page must fit the viewport');
    report.screenshots.push(file);
  }
  try {
    server = await previewServer(root);
    browser = await launchBrowser();
    for (const width of [1440, 390]) {
      await scenario(`Email inbox, conversation and compose at ${width}`, async () => {
        const { page } = await openPage(width);
        await page.goto(`${server.baseUrl}/admin/communications#tab=email`);
        await page.getByText(a.subject, { exact: false }).first().waitFor();
        await shot(page, `inbox-${width}`);
        await page.getByText(a.subject, { exact: false }).first().click();
        await page.getByRole('textbox', { name: 'Reply', exact: true }).waitFor();
        await page.getByText(a.body_text, { exact: true }).waitFor();
        await shot(page, `conversation-${width}`);
        await page.getByRole('button', { name: /New email/i, exact: true }).click();
        await page.getByRole('dialog', { name: 'New email', exact: true }).waitFor();
        await shot(page, `compose-${width}`);
        await page.close();
      });
    }
    await scenario('Keyboard inbox selection, mobile return and authenticated attachment download', async () => {
      const { page } = await openPage(390);
      await page.goto(`${server.baseUrl}/admin/communications#tab=email`);
      const row = page.getByRole('button', { name: `Open email: ${a.subject}`, exact: true });
      await row.focus(); await page.keyboard.press('Enter');
      const heading = page.getByRole('heading', { name: a.subject, exact: true });
      await heading.waitFor();
      assert.equal(await heading.evaluate((node) => document.activeElement === node), true);
      const downloading = page.waitForEvent('download');
      await page.getByRole('link', { name: /Patio notes.pdf/ }).click();
      const download = await downloading;
      assert.equal(download.suggestedFilename(), 'Patio notes.pdf');
      assert.equal(await download.failure(), null);
      await page.getByRole('button', { name: 'Back to inbox', exact: true }).click();
      await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label, `Open email: ${a.subject}`);
      assert.equal(new URL(page.url()).searchParams.has('id'), false);
      await page.close();
    });
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await server?.close();
    await Promise.allSettled([browser, safari].filter(Boolean).map(async (engine) => {
      for (const context of engine.contexts()) await context.setOffline(true).catch(() => {});
      await Promise.race([engine.close(), new Promise((resolve) => { const timer = setTimeout(resolve, 10000); timer.unref(); })]);
    }));
  }
  console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, output }));
}
main().catch((error) => { console.error(error); process.exit(1); });
