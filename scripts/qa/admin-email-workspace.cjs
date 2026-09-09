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
  async function openPage(width, { engine = browser, role = 'admin', coarse = width < 1100, timezone = 'America/New_York' } = {}) {
    const state = { emails: structuredClone(fixtureMail), role, connected: true, fail: new Set(), sends: [], blocked: [{ id: 'fixture-block', domain: 'unwanted.example.invalid', reason: 'Manual block from admin portal', blocked_count: 3, created_at: stamp(200) }] };
    states.push(state);
    // The top-frame fixture below disables registration. Playwright's blanket
    // block script reads denied APIs inside sandboxed HTML email frames.
    const page = await engine.newPage({ viewport: { width, height: width < 600 ? 844 : 1000 }, hasTouch: coarse, timezoneId: timezone });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    await page.addInitScript(() => {
      if (window !== window.top) return;
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
      else if (api.startsWith('/admin/email/thread/')) { await state.threadHold; body = { thread: state.history || state.emails.filter((mail) => api.endsWith(mail.gmail_thread_id)) }; }
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
    await page.screenshot({ path: path.join(output, file), fullPage: true, animations: "disabled" });
    if (!baseline) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Page must fit the viewport');
    report.screenshots.push(file);
  }
  const row = (page, mail = a) => page.getByRole('button', { name: `Open email: ${mail.subject}`, exact: true });
  async function inbox(page, route = '/admin/communications#tab=email') {
    await page.goto(`${server.baseUrl}${route}`);
    await row(page).waitFor();
  }
  async function openMail(page, mail = a) {
    await row(page, mail).click();
    await page.getByRole('heading', { name: mail.subject, exact: true }).waitFor();
    await page.getByText(mail.body_text, { exact: true }).waitFor();
  }
  async function geometry(page, label) {
    const measurements = await page.locator('[data-ui-density="comfortable"] button, [data-ui-density="comfortable"] input:not([type="radio"]):not([type="checkbox"]), [data-ui-density="comfortable"] textarea, [data-ui-density="comfortable"] select').evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length).map((node) => ({ tag: node.tagName, name: node.getAttribute('aria-label') || node.textContent.trim() || node.id, height: node.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(node).fontSize) })));
    assert.ok(measurements.length);
    for (const item of measurements) {
      assert.ok(item.height >= 43.5, `${label}: ${item.name} must be at least 44px`);
      assert.ok(item.fontSize >= (item.tag === 'BUTTON' ? 14 : 16), `${label}: ${item.name} text must be readable`);
    }
    report.geometry.push({ label, measurements });
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
    if (!baseline) {
      await scenario('Older email dates stay Eastern in a UTC browser', async () => {
        const { page, state } = await openPage(1440, { timezone: 'UTC' });
        state.emails[0].received_at = '2020-07-02T02:30:00.000Z';
        await inbox(page);
        await row(page).getByText('Jul 1', { exact: true }).waitFor();
        await page.close();
      });
      await scenario('Desktop draft browsing, refresh, channels and browser history', async () => {
        const { page, state } = await openPage(1440);
        await inbox(page, `/admin/email?id=${a.id}&source=fixture#tab=email`);
        await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('Retained first reply');
        await openMail(page, b);
        assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), '');
        await page.goBack();
        await page.getByRole('heading', { name: a.subject, exact: true }).waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), 'Retained first reply');
        await page.goForward();
        await page.getByRole('heading', { name: b.subject, exact: true }).waitFor();
        await openMail(page, a);
        await channel(page, 'SMS').click();
        const reads = report.requests.filter((request) => request.path.startsWith('/admin/email/')).length;
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(report.requests.filter((request) => request.path.startsWith('/admin/email/')).length, reads);
        await channel(page, 'Email').click();
        await page.getByRole('textbox', { name: 'Reply', exact: true }).waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), 'Retained first reply');
        await page.reload();
        await page.getByRole('textbox', { name: 'Reply', exact: true }).waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), 'Retained first reply');
        assert.equal(new URL(page.url()).searchParams.get('source'), 'fixture');
        assert.equal(state.sends.length, 0);
        await shot(page, 'recovered-reply-1440');
        await page.close();
      });
      for (const width of [1440, 390]) {
        await scenario(`Reply failure, pending guard and confirmed send at ${width}`, async () => {
          const { page, state } = await openPage(width);
          await inbox(page); await openMail(page);
          const reply = page.getByRole('textbox', { name: 'Reply', exact: true });
          const send = page.getByRole('button', { name: 'Send reply', exact: true });
          await reply.fill('Fixture reply with a clear recipient');
          state.fail.add('/admin/email/send');
          await send.click();
          await page.getByText('Reply send was not confirmed. Your draft is still here.', { exact: true }).waitFor();
          assert.equal(await reply.inputValue(), 'Fixture reply with a clear recipient');
          await shot(page, `failed-reply-${width}`);
          state.fail.delete('/admin/email/send');
          state.sendHold = new Promise((resolve) => { state.releaseSend = resolve; });
          await send.click();
          await page.waitForFunction(() => document.querySelector('button[aria-busy="true"]'));
          assert.equal(await send.isDisabled(), true);
          await send.evaluate((button) => button.click());
          assert.equal(state.sends.length, 2, 'A repeated pending click must not submit again');
          assert.deepEqual(state.sends[1], { to: a.from_address, subject: `Re: ${a.subject}`, body: 'Fixture reply with a clear recipient', threadId: a.gmail_thread_id });
          state.releaseSend();
          await page.getByText('Reply sent.', { exact: true }).waitFor();
          assert.equal(await reply.inputValue(), '');
          await shot(page, `sent-reply-${width}`);
          await page.close();
        });
        await scenario(`Compose recovery, customer lookup, Quick Links and focus at ${width}`, async () => {
          const { page, state } = await openPage(width);
          await inbox(page);
          const opener = page.getByRole('button', { name: 'New email', exact: true });
          await opener.click();
          const dialog = page.getByRole('dialog', { name: 'New email', exact: true });
          await dialog.getByLabel('To', { exact: false }).fill('Avery');
          await dialog.getByRole('button', { name: /Avery Sample/ }).click();
          assert.equal(await dialog.getByLabel('To', { exact: false }).inputValue(), a.from_address);
          await dialog.getByLabel('Subject', { exact: true }).fill('Fixture subject');
          await dialog.getByLabel('Message', { exact: false }).fill('Fixture draft for recovery');
          const links = dialog.getByRole('button', { name: 'Quick Links', exact: true });
          await links.click();
          const picker = page.getByRole('dialog', { name: 'Quick Links', exact: true });
          await picker.getByRole('searchbox').fill('quote');
          await shot(page, `quick-links-${width}`);
          await geometry(page, `Quick Links ${width}`);
          await page.keyboard.press('Escape');
          assert.equal(await links.evaluate((element) => element === document.activeElement), true);
          await links.click();
          await picker.getByRole('button', { name: /^Request a quote/ }).click();
          assert.ok((await dialog.getByLabel('Message', { exact: false }).inputValue()).includes('https://www.wavespestcontrol.com/quote/'));
          await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('button', { name: 'Resume draft', exact: true }).evaluate((element) => element === document.activeElement), true);
          await page.reload();
          await page.getByRole('button', { name: 'Resume draft', exact: true }).click();
          assert.equal(await dialog.getByLabel('To', { exact: false }).inputValue(), a.from_address);
          assert.equal(await dialog.getByLabel('Subject', { exact: true }).inputValue(), 'Fixture subject');
          await shot(page, `recovered-compose-${width}`);
          await geometry(page, `Compose ${width}`);
          if (width === 390) {
            await page.setViewportSize({ width, height: 480 });
            await dialog.getByLabel('Message', { exact: false }).focus();
            await dialog.getByLabel('Message', { exact: false }).scrollIntoViewIfNeeded();
            const footer = await dialog.getByRole('button', { name: 'Send', exact: true }).boundingBox();
            assert.ok(footer.y >= 0 && footer.y + footer.height <= 480);
            await shot(page, 'compose-contracted-viewport-390');
          }
          await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
          await page.getByRole('button', { name: 'New email', exact: true }).waitFor();
          assert.equal(state.sends.length, 0);
          await page.close();
        });
      }
      await scenario('Keyboard inbox selection, mobile return and authenticated attachment download', async () => {
        const { page } = await openPage(390);
        await inbox(page);
        await row(page).focus(); await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: a.subject, exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: a.subject, exact: true }).evaluate((node) => document.activeElement === node), true);
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
      await scenario('Loading, connection failure, inbox retry and partial counts', async () => {
        const { page, state } = await openPage(390);
        state.statusHold = new Promise((resolve) => { state.releaseStatus = resolve; });
        await page.goto(`${server.baseUrl}/admin/communications#tab=email`);
        await page.getByText('Loading email…', { exact: true }).waitFor();
        await shot(page, 'loading-390');
        state.fail.add('/admin/email/oauth/status'); state.releaseStatus();
        await page.getByText('Email connection status is unavailable.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: /Connect Gmail/ }).count(), 0);
        await shot(page, 'connection-error-390');
        state.fail.delete('/admin/email/oauth/status'); state.fail.add('/admin/email/inbox');
        state.fail.add('/admin/email/stats'); state.fail.add('/admin/email/daily-digest');
        await page.getByRole('button', { name: 'Try again', exact: true }).click();
        await page.getByText('The email inbox is unavailable.', { exact: true }).waitFor();
        await page.getByText('Email activity', { exact: true }).click();
        await page.getByText('Email counts are unavailable.', { exact: true }).waitFor();
        await shot(page, 'partial-data-390');
        state.fail.delete('/admin/email/inbox'); state.emails = [];
        await page.getByRole('region', { name: 'Email inbox', exact: true }).getByRole('button', { name: 'Try again', exact: true }).click();
        await page.getByText('No emails found', { exact: true }).waitFor();
        await shot(page, 'empty-inbox-390');
        await page.close();
      });
      await scenario('Blocked sender failures retain the entered address and confirmed writes update the list', async () => {
        const { page, state } = await openPage(390);
        await inbox(page);
        await page.getByRole('navigation', { name: 'Email section', exact: true }).getByRole('button', { name: 'Blocked senders', exact: true }).click();
        await page.getByText('unwanted.example.invalid', { exact: true }).waitFor();
        await page.getByLabel('Domain or email to block', { exact: true }).fill('newsletter.example.invalid');
        state.fail.add('/admin/email/block');
        await page.getByRole('button', { name: 'Block', exact: true }).click();
        await page.getByText('Could not block the sender. Try again.', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Domain or email to block', { exact: true }).inputValue(), 'newsletter.example.invalid');
        await shot(page, 'blocked-send-failure-390');
        state.fail.delete('/admin/email/block');
        await page.getByRole('button', { name: 'Block', exact: true }).click();
        await page.getByText('newsletter.example.invalid', { exact: true }).waitFor();
        const entry = page.getByRole('listitem').filter({ hasText: 'newsletter.example.invalid' });
        await entry.getByRole('button', { name: 'Unblock', exact: true }).click();
        await page.getByText('Sender unblocked.', { exact: true }).waitFor();
        assert.equal(await entry.count(), 0);
        await shot(page, 'blocked-senders-390');
        await page.close();
      });
      await scenario('Filters, pagination and sandboxed HTML keep their existing contracts', async () => {
        const { page, state } = await openPage(1440);
        state.total = 101;
        state.emails[0].body_html = '<p>Fixture HTML email content</p><script>parent.fixtureUnsafe = true</script>';
        await inbox(page);
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await page.getByText('Page 2 of 3', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Unread (7)', exact: true }).click();
        await page.getByText('Page 1 of 3', { exact: true }).waitFor();
        await page.getByLabel('Search emails', { exact: true }).fill('question');
        await page.waitForResponse((response) => response.url().includes('/email/inbox?') && response.url().includes('search=question'));
        const archivedResponse = page.waitForResponse((response) => response.url().includes('/email/inbox?') && response.url().includes('is_archived=true'));
        await page.getByRole('button', { name: 'Archived', exact: true }).click();
        await archivedResponse;
        await row(page).click();
        await page.frameLocator('iframe[title="Email body"]').getByText('Fixture HTML email content', { exact: true }).waitFor();
        assert.equal(await page.locator('iframe[title="Email body"]').getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
        assert.equal(await page.evaluate(() => window.fixtureUnsafe), undefined);
        await shot(page, 'html-email-1440');
        await page.close();
      });
      await scenario('Long conversations follow new mail while preserving an older reading position', async () => {
        const { page, state } = await openPage(1440);
        state.history = Array.from({ length: 18 }, (_, index) => ({ ...a, id: `history-${index}`, has_attachments: false, attachments: [], body_text: `Fixture history message ${index + 1}.\n\nA longer update about the appointment and access notes.`, received_at: stamp(36 - index) }));
        await inbox(page); await row(page).click();
        const history = page.getByRole('region', { name: 'Email history', exact: true });
        await history.getByText(state.history.at(-1).body_text, { exact: true }).waitFor();
        assert.ok(await history.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop < 64));
        await shot(page, 'long-history-1440');
        await history.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
        const reply = page.getByRole('textbox', { name: 'Reply', exact: true });
        await reply.fill('Fixture refresh while reading older mail');
        await page.getByRole('button', { name: 'Send reply', exact: true }).click();
        await page.getByText('Reply sent.', { exact: true }).waitFor();
        assert.equal(await history.evaluate((node) => node.scrollTop), 0);
        await page.close();
      });
      await scenario('CSR role cannot open Email or make Email requests', async () => {
        const { page } = await openPage(390, { role: 'csr' });
        await page.goto(`${server.baseUrl}/admin/communications?id=${a.id}#tab=email`);
        await channel(page, 'SMS').waitFor();
        assert.equal(await channel(page, 'Email').count(), 0);
        assert.equal(report.requests.filter((request) => request.stage === stage && request.path.startsWith('/admin/email/')).length, 0);
        await page.close();
      });
      safari = await require('playwright').webkit.launch();
      for (const [width, engine, coarse, label] of [[700, browser, true, '700 coarse'], [820, browser, true, '820 coarse'], [1024, browser, false, '1024 fine'], [1440, browser, false, '1440 fine'], [720, browser, false, '200 percent layout equivalent'], [390, safari, true, 'WebKit 390']]) {
        await scenario(`Responsive controls and draft return: ${label}`, async () => {
          const { page } = await openPage(width, { engine, coarse });
          await inbox(page); await geometry(page, label);
          await shot(page, `inbox-${label.replaceAll(' ', '-')}`);
          await openMail(page);
          await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('Fixture responsive reply');
          await geometry(page, `${label} reply`);
          if (width < 1280) {
            assert.equal(await row(page).isVisible(), false);
            await page.getByRole('button', { name: 'Back to inbox', exact: true }).click();
            await row(page).waitFor(); await openMail(page);
            assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), 'Fixture responsive reply');
          }
          await shot(page, `reply-${label.replaceAll(' ', '-')}`);
          await page.close();
        });
      }
    }
    assert.deepEqual(report.unmatched, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    for (const state of states) { state.releaseSend?.(); state.releaseDraft?.(); state.releaseThread?.(); state.releaseInbox?.(); state.releaseStatus?.(); }
    await server?.close();
    await Promise.allSettled([browser, safari].filter(Boolean).map(async (engine) => {
      for (const context of engine.contexts()) await context.setOffline(true).catch(() => {});
      await Promise.race([engine.close(), new Promise((resolve) => { const timer = setTimeout(resolve, 10000); timer.unref(); })]);
    }));
  }
  console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, output }));
}
main().catch((error) => { console.error(error); process.exit(1); });
