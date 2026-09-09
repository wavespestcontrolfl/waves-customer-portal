'use strict';
/* global document, window, localStorage, navigator, innerWidth, getComputedStyle */
// SYNTHETIC UI QA. Actual admin routes; all API calls are fulfilled locally.
// No database, provider, invoice delivery or real account is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require('playwright');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-billing-foundation');
const payerName = 'Example Property Management with a long billing account name';
const payer = {
  id: 42, display_name: payerName, company_name: 'Example Property Group',
  ap_email: 'accounts-payable-with-a-long-name@example.invalid', ap_phone: '9415550100',
  billing_address_line1: '100 Example Court', billing_city: 'Example City', billing_state: 'FL',
  billing_zip: '34201', payment_terms: 'net30', requires_po: true, tax_exempt: false,
  tax_exempt_cert: '', notes: '', active: true,
};
const summary = {
  statement_count: 1, outstanding_total: 240, past_due_total: 240, oldest_days_past_due: 18,
  buckets: { current: { total: 0, count: 0 }, b1_15: { total: 0, count: 0 }, b16_30: { total: 240, count: 1 }, b31_45: { total: 0, count: 0 }, b45_plus: { total: 0, count: 0 } },
};
const statement = { id: 71, status: 'sent', total: 240, period_start: '2026-08-01', period_end: '2026-08-31', due_date: '2026-09-01', invoice_count: 2, overdue: true, days_past_due: 18 };
const visit = { scheduled_service_id: 'visit-example', customer: 'Avery Example', completed_at: '2026-09-08T14:00:00Z', scheduled_date: '2026-09-08', service_type: 'Quarterly pest control', price: 120, billable: true };

function fixtures(state) {
  const handlers = new Map([
    ['GET /api/admin/auth/me', () => ({ id: 'fixture-user', role: 'admin', name: 'Fixture operator' })],
    ['GET /api/admin/feature-flags', () => ({ flags: {} })],
    ['GET /api/admin/notifications/unread-count', () => ({ count: 0 })],
    ['GET /api/admin/communications/unread-count', () => ({ count: 0, conversations: 0 })],
    ['POST /api/admin/usage/track', () => ({ ok: true })],
    ['GET /api/admin/billing-recovery/leaks', () => ({ summary: { leak_dollars: state.emptyRecovery ? 0 : 240, review_dollars: 120, leak_visits: state.emptyRecovery ? 0 : 2, leak_customers: state.emptyRecovery ? 0 : 2, review_visits: 1 }, leaks: state.emptyRecovery ? [] : [visit, { ...visit, scheduled_service_id: 'status-only-example', customer: 'Jordan Example', leak_kind: 'completed_no_service_record', billable: false }], needs_review: [{ ...visit, scheduled_service_id: 'review-example', customer: 'Casey Example', monthly_rate: 40, billing_mode: 'per_application' }] })],
    ['GET /api/admin/billing-recovery/aging', () => ({ total_outstanding: 240, total_overdue: 240, invoice_count: 1, aging: { current: 0, days_30: 240, days_60: 0, days_90_plus: 0 }, top_balances: [{ invoice_id: 'invoice-example', customer: 'Avery Example', status: 'overdue', due_date: '2026-09-01', amount: 240 }] })],
    ['GET /api/admin/billing-recovery/at-risk-mrr', () => ({ atRisk: 40, count: 1, accounts: [{ id: 'customer-example', firstName: 'Casey', lastName: 'Example', monthlyRate: 40, causes: ['service_paused', 'overdue'] }] })],
    ['POST /api/admin/billing-recovery/visit-example/dismiss', () => ({ ok: true })],
    ['POST /api/admin/billing-recovery/visit-example/bill', () => ({ invoice: { id: 'invoice-example' } })],
    ['GET /api/admin/payers', (url) => ({ payers: url.searchParams.get('search') === 'no match' ? [] : [state.payer] })],
    ['GET /api/admin/payers/42', () => ({ payer: state.payer })],
    ['POST /api/admin/payers', (_url, body) => { state.payer = { ...body, id: 42 }; return { payer: state.payer }; }],
    ['PUT /api/admin/payers/42', (_url, body) => { state.payer = { ...body, id: 42 }; return { payer: state.payer }; }],
    ['GET /api/admin/payers/ar-aging', () => ({ ...summary, by_terms: { net30: { total: 240, count: 1 } }, payers: [{ payer_id: 42, payer_name: state.payer.display_name, outstanding_total: 240, past_due_total: 240, oldest_days_past_due: 18 }] })],
    ['GET /api/admin/payers/42/ar', () => ({ summary })],
    ['GET /api/admin/payers/42/statements', () => ({ statements: [state.statement] })],
    ['GET /api/admin/payers/42/statements/71', () => ({ statement: state.statement, lines: [{ service_date: '2026-08-15', service_type: 'Quarterly pest control', service_address: '100 Example Court, Example City, FL 34201', total: 240 }] })],
    ['GET /api/admin/payers/42/statements/71/followups', () => ({ sequence: { status: 'paused' } })],
    ['POST /api/admin/payers/42/statements/71/reconcile', () => { state.statement = { ...state.statement, status: 'paid', paid_at: '2026-09-09T02:00:00Z' }; return { ok: true, statement: state.statement }; }],
  ]);
  return handlers;
}

async function installFixtures(page, server, state) {
  const handlers = fixtures(state);
  await page.addInitScript(() => {
    localStorage.setItem('waves_admin_token', 'synthetic-local-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', role: 'admin', name: 'Fixture operator' }));
    if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    // Keepalive usage pings can outlive Playwright's page route on navigation.
    // Match the existing catalog runner: fulfill these inside the fixture page.
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => String(input).endsWith('/admin/usage/track')
      ? Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : originalFetch(input, options);
  });
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  await page.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const key = `${request.method()} ${url.pathname}`;
    const body = request.method() === 'GET' ? null : request.postDataJSON();
    state.requests.push({ method: request.method(), path: url.pathname, query: url.search, body });
    if (state.hold?.key === key) await state.hold.promise;
    let status = 200, result;
    if (state.failures.has(key)) {
      if (request.method() !== 'GET') state.failures.delete(key);
      status = 503;
      state.expectedFailures.push(url.href);
      result = { error: 'Synthetic request failed. Try again.' };
    } else if (handlers.has(key)) result = handlers.get(key)(url, body);
    else { state.unmatched.push(key); status = 404; result = { error: 'Unmatched fixture' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
}

async function geometry(page, state, surface) {
  const measured = await page.evaluate(() => {
    const root = document.querySelector('[role="dialog"]') || document.querySelector('main .ui-surface');
    if (!root) throw new Error('Migrated surface missing');
    const visible = (node) => node.getClientRects().length > 0 && !node.closest('[hidden], [inert]');
    const controls = [...root.querySelectorAll('button, input:not([type="checkbox"]), select, textarea, [data-ui-text-action]')].filter(visible).map((node) => {
      const style = getComputedStyle(node);
      return { name: node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.textContent.trim(), tag: node.tagName, height: node.getBoundingClientRect().height, font: parseFloat(style.fontSize), family: style.fontFamily, role: node.getAttribute('role'), transform: style.textTransform, labeled: !['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName) || !!node.labels?.length };
    });
    const choices = [...root.querySelectorAll('input[type="checkbox"]')].filter(visible).map((node) => node.closest('label').getBoundingClientRect().height);
    const smallText = [...root.querySelectorAll('*')].filter(visible).filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())).filter((node) => parseFloat(getComputedStyle(node).fontSize) < 14).map((node) => node.textContent.slice(0, 70));
    const wrappedAmounts = [...root.querySelectorAll('*')].filter(visible).flatMap((node) => [...node.childNodes]).filter((node) => node.nodeType === 3 && /^\$[\d,.]+$/.test(node.textContent.trim())).filter((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getClientRects().length > 1;
    }).map((node) => node.textContent);
    return { controls, choices, smallText, wrappedAmounts, overflow: document.documentElement.scrollWidth > innerWidth + 1, titleSize: document.querySelector('main h1') && parseFloat(getComputedStyle(document.querySelector('main h1')).fontSize) };
  });
  const entry = { surface, viewport: page.viewportSize(), ...measured };
  state.geometry.push(entry);
  assert.equal(measured.overflow, false, `${surface}: page overflow`);
  assert.equal(measured.titleSize, 22, `${surface}: page title size`);
  assert.deepEqual(measured.smallText, [], `${surface}: text below 14px`);
  assert.deepEqual(measured.wrappedAmounts, [], `${surface}: currency split across lines`);
  assert.ok(measured.controls.length, `${surface}: controls were checked`);
  for (const control of measured.controls) {
    assert.ok(control.height >= (control.role === 'tab' ? 54 : 44) - 0.5, `${surface}: short control ${JSON.stringify(control)}`);
    assert.ok(control.font >= (['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tag) ? 16 : 14), `${surface}: small field ${JSON.stringify(control)}`);
    assert.ok(control.labeled && control.name, `${surface}: missing label ${JSON.stringify(control)}`);
    assert.equal(control.transform, 'none', `${surface}: uppercase control`);
    assert.match(control.family, /Roboto/, `${surface}: admin font`);
  }
  measured.choices.forEach((height) => assert.ok(height >= 44, `${surface}: checkbox label target`));
}

async function screenshot(page, report, name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(path.relative(root, file));
}

function holdFailure(state, key) {
  let release;
  state.hold = { key, promise: new Promise((resolve) => { release = resolve; }) };
  state.failures.add(key);
  return () => { state.hold = null; release(); };
}

async function pendingAction(page, state, button, key, release) {
  const before = await button.boundingBox();
  const countBefore = state.requests.filter((request) => `${request.method} ${request.path}` === key).length;
  await button.click();
  await page.waitForFunction(() => !!document.querySelector('button[aria-busy="true"]'));
  const after = await button.boundingBox();
  assert.equal(after.width, before.width, `${key}: pending width`);
  assert.equal(after.height, before.height, `${key}: pending height`);
  assert.equal(await button.isDisabled(), true);
  await button.evaluate((node) => node.click());
  assert.equal(state.requests.filter((request) => `${request.method} ${request.path}` === key).length, countBefore + 1, `${key}: duplicate write`);
  release();
  await page.getByText('Synthetic request failed. Try again.', { exact: true }).waitFor();
}

async function recoveryWorkflow(page, server, state, report, name) {
  await page.goto(`${server.baseUrl}/admin/billing-recovery?source=qa`);
  await page.getByRole('button', { name: 'Bill', exact: true }).first().waitFor();
  await waitForFonts(page);
  assert.equal(await page.getByRole('link', { name: 'Open completion' }).getAttribute('href'), '/admin/dispatch?tab=schedule&date=2026-09-08&completeService=status-only-example');
  assert.equal(await page.getByRole('link', { name: 'Casey Example' }).getAttribute('href'), '/admin/customers?customerId=customer-example');
  await screenshot(page, report, `${name}-recovery`);
  const markFree = page.getByRole('button', { name: 'Mark free', exact: true }).first();
  await markFree.click();
  const dialog = page.getByRole('dialog', { name: 'Mark visit as intentionally free' });
  await dialog.getByLabel('Optional note').fill('Retain this synthetic disposition note.');
  await geometry(page, state, 'Free-visit dialog');
  await screenshot(page, report, `${name}-free-visit`);
  const key = 'POST /api/admin/billing-recovery/visit-example/dismiss';
  await pendingAction(page, state, dialog.getByRole('button', { name: 'Mark free', exact: true }), key, holdFailure(state, key));
  assert.equal(await dialog.getByLabel('Optional note').inputValue(), 'Retain this synthetic disposition note.');
  await dialog.getByRole('button', { name: 'Mark free', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const writes = state.requests.filter((request) => request.path.endsWith('/visit-example/dismiss'));
  assert.deepEqual(writes.map((request) => request.body), [{ reason: 'Warranty callback / re-treat — Retain this synthetic disposition note.' }, { reason: 'Warranty callback / re-treat — Retain this synthetic disposition note.' }]);
  await markFree.click();
  await page.keyboard.press('Escape');
  assert.equal(await markFree.evaluate((node) => document.activeElement === node), true, 'Free dialog focus return');
  state.failures.add('GET /api/admin/billing-recovery/leaks');
  await page.getByLabel('Visit window').selectOption('30');
  await page.getByText('Synthetic request failed. Try again.', { exact: true }).waitFor();
  assert.equal(await page.getByText('$0.00', { exact: true }).count(), 0);
  state.failures.delete('GET /api/admin/billing-recovery/leaks');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Bill', exact: true }).first().waitFor();
  state.failures.add('GET /api/admin/billing-recovery/at-risk-mrr');
  await page.getByLabel('Visit window').selectOption('60');
  await page.getByText("At-risk accounts couldn't be loaded — refresh to retry.").waitFor();
  assert.ok(await page.getByRole('button', { name: 'Bill', exact: true }).count());
  state.failures.delete('GET /api/admin/billing-recovery/at-risk-mrr');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('link', { name: 'Casey Example' }).waitFor();
}

async function payerWorkflow(page, server, state, report, name) {
  await page.goto(`${server.baseUrl}/admin/payers?source=qa`);
  await page.getByRole('button', { name: payerName, exact: true }).waitFor();
  await screenshot(page, report, `${name}-payers`);
  await page.getByLabel('Search payers').fill('no match');
  await page.getByText(/No payers yet/).waitFor();
  await page.getByLabel('Search payers').fill('');
  await page.getByRole('button', { name: payerName, exact: true }).waitFor();
  await page.getByLabel('Show inactive').check();
  await page.waitForResponse((response) => response.url().includes('/api/admin/payers?includeInactive=true'));
  const edit = page.getByRole('button', { name: `Edit ${payerName}`, exact: true });
  await edit.click();
  const editor = page.getByRole('dialog', { name: 'Edit payer', exact: true });
  await editor.getByLabel('Notes').fill('Retain this payer draft.');
  await editor.getByLabel('Payment terms').selectOption('net15');
  await geometry(page, state, 'Payer editor');
  await screenshot(page, report, `${name}-payer-editor`);
  const key = 'PUT /api/admin/payers/42';
  await pendingAction(page, state, editor.getByRole('button', { name: 'Save payer' }), key, holdFailure(state, key));
  assert.equal(await editor.getByLabel('Notes').inputValue(), 'Retain this payer draft.');
  assert.equal(await editor.getByLabel('Payment terms').inputValue(), 'net15');
  await editor.getByRole('button', { name: 'Save payer' }).click();
  await editor.waitFor({ state: 'hidden' });
  const writes = state.requests.filter((request) => request.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, { ...payer, payment_terms: 'net15', notes: 'Retain this payer draft.' });
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(await edit.evaluate((node) => document.activeElement === node), true, 'Editor focus return');

  const opener = page.getByRole('button', { name: payerName, exact: true });
  await opener.click();
  const sheet = page.getByRole('dialog', { name: `${payerName} payer details`, exact: true });
  await sheet.getByRole('button', { name: /S-71/ }).click();
  await sheet.getByRole('button', { name: 'Record offline payment' }).click();
  await sheet.getByLabel('Method', { exact: true }).selectOption('wire');
  await sheet.getByLabel('Amount', { exact: true }).fill('239.50');
  await geometry(page, state, 'Statement payment draft');
  await screenshot(page, report, `${name}-statement`);
  const payment = 'POST /api/admin/payers/42/statements/71/reconcile';
  await pendingAction(page, state, sheet.getByRole('button', { name: 'Record', exact: true }), payment, holdFailure(state, payment));
  await sheet.getByRole('tab', { name: 'AR / aging' }).click();
  assert.equal(await sheet.getByRole('textbox', { name: 'Amount' }).count(), 0);
  await sheet.getByRole('tab', { name: 'Statements' }).click();
  assert.equal(await sheet.getByLabel('Amount').inputValue(), '239.50');
  assert.equal(await sheet.getByLabel('Method').inputValue(), 'wire');
  await sheet.getByRole('button', { name: 'Record', exact: true }).click();
  await sheet.getByText('Paid', { exact: true }).waitFor();
  assert.deepEqual(state.requests.filter((request) => request.path.endsWith('/reconcile')).map((request) => request.body), [{ method: 'wire', amount: 239.5 }, { method: 'wire', amount: 239.5 }]);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await opener.evaluate((node) => document.activeElement === node), true, 'Statement focus return');

  state.failures.add('GET /api/admin/payers/ar-aging');
  const agingOpener = page.getByRole('button', { name: 'AR aging', exact: true });
  await agingOpener.click();
  const aging = page.getByRole('dialog', { name: 'Payer AR aging', exact: true });
  await aging.getByText('Synthetic request failed. Try again.', { exact: true }).waitFor();
  assert.equal(await aging.getByText(/No outstanding payer statements/).count(), 0);
  state.failures.delete('GET /api/admin/payers/ar-aging');
  await aging.getByRole('button', { name: 'Try again', exact: true }).click();
  await aging.getByRole('button', { name: payerName, exact: true }).waitFor();
  await geometry(page, state, 'Payer AR aging');
  await screenshot(page, report, `${name}-payer-aging`);
  await aging.getByRole('button', { name: payerName, exact: true }).click();
  await sheet.waitFor();
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  assert.equal(await agingOpener.evaluate((node) => document.activeElement === node), true, 'AR-to-sheet focus handoff');

  await page.reload();
  await opener.waitFor();
  assert.ok(page.url().endsWith('/admin/payers?source=qa'));
  await page.goBack();
  await page.getByRole('heading', { name: 'Billing recovery', exact: true }).waitFor();
  await page.goForward();
  await page.getByRole('heading', { name: 'Payers', exact: true }).waitFor();
}

async function matrix(page, server, state) {
  state.statement = structuredClone(statement);
  for (const [width, height] of [[390, 844], [700, 1000], [820, 1180], [1024, 1000], [1440, 1000], [844, 390], [390, 420]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${server.baseUrl}/admin/billing-recovery`);
    await page.getByRole('button', { name: 'Bill', exact: true }).first().waitFor();
    await geometry(page, state, 'Billing recovery');
    await page.getByRole('button', { name: 'Mark free', exact: true }).first().click();
    await geometry(page, state, 'Free-visit dialog');
    await page.keyboard.press('Escape');
    await page.goto(`${server.baseUrl}/admin/payers`);
    await page.getByRole('button', { name: payerName, exact: true }).waitFor();
    await geometry(page, state, 'Payers');
    await page.getByRole('button', { name: 'New payer', exact: true }).click();
    await geometry(page, state, 'New payer editor');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: payerName, exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: /S-71/ }).click();
    await sheet.getByRole('button', { name: 'Record offline payment' }).click();
    await geometry(page, state, 'Statement payment draft');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'AR aging', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: payerName, exact: true }).waitFor();
    await geometry(page, state, 'Payer AR aging');
    await page.keyboard.press('Escape');
  }
}

async function main() {
  fs.rmSync(output, { force: true, recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, scenarios: [], screenshots: [] };
  let server;
  try {
    server = await previewServer(root, process.argv.find((arg) => arg.startsWith('http://')));
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['touch-webkit', { width: 390, height: 844 }]]) {
      const browser = name === 'desktop' ? await launchBrowser() : await webkit.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport, hasTouch: name !== 'desktop', timezoneId: 'America/New_York', serviceWorkers: 'block' });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const state = { name, passed: false, pageErrors: [], consoleErrors: [], expectedFailures: [], unmatched: [], requests: [], geometry: [], failures: new Set(), payer: structuredClone(payer), statement: structuredClone(statement) };
        report.scenarios.push(state);
        await installFixtures(page, server, state);
        await recoveryWorkflow(page, server, state, report, name);
        await payerWorkflow(page, server, state, report, name);
        await matrix(page, server, state);
        assert.deepEqual(state.pageErrors, []);
        assert.deepEqual(state.unmatched, []);
        const unexpected = state.consoleErrors.filter((entry) => !state.expectedFailures.includes(entry.url) || !/^Failed to load resource: the server responded with a status of 503 \([^)]*\)$/.test(entry.text));
        assert.deepEqual(unexpected, [], 'Unexpected console errors');
        assert.equal(state.requests.some((request) => /\/(send|send-now|close|remind|sms|email)(\/|$)/.test(request.path)), false, 'No delivery action');
        state.passed = true;
        process.stdout.write(`${name}: workflow and ${state.geometry.length} geometry cases passed\n`);
      } finally { await browser.close(); }
    }
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    await server?.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
