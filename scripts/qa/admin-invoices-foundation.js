'use strict';
/* global document, window, localStorage, navigator, innerWidth, getComputedStyle, requestAnimationFrame */
// Actual invoice UI with synthetic API responses. No backend, payment provider,
// delivery, real customer, native payment app or AI service is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webkit } = require('playwright');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-invoices-foundation');
const customer = { id: 'customer-example', first_name: 'Avery', last_name: 'Example', phone: '9415550100', email: 'avery@example.invalid', property_type: 'residential' };
const invoice = {
  customer_id: customer.id, ...customer, id: 'invoice-example',
  invoice_number: 'WPC-QA-001', total: 120, subtotal: 120, tax: 0, tax_rate: 0,
  status: 'sent', token: 'synthetic-invoice-token', title: 'Quarterly pest control',
  service_date: '2026-09-08', created_at: '2026-09-08T14:00:00Z', sent_at: '2026-09-08T15:00:00Z',
  due_date: '2099-12-31', card_on_file: { brand: 'visa', last_four: '4242' },
  line_items: [{ description: 'Quarterly pest control', quantity: 1, unit_price: 120, amount: 120 }],
};
const paid = { ...invoice, id: 'invoice-paid', invoice_number: 'WPC-QA-002', first_name: 'Jordan', last_name: 'Example', status: 'paid', total: 1234.56, paid_at: '2026-09-08T16:00:00Z', payment_method: 'cash', receipt_sent_at: null };
const draft = { ...invoice, id: 'invoice-draft', invoice_number: 'WPC-QA-003', first_name: 'Casey', last_name: 'Example', status: 'draft', sent_at: null };
const recipient = { customerName: 'Avery Example', emailRecipient: { email: 'billing@example.invalid', name: 'Example Accounts', role: 'billing' }, smsRecipient: { phone: customer.phone } };
const attachment = { id: 'attachment-example', file_name: 'Synthetic inspection.pdf', file_size_bytes: 512, mime_type: 'application/pdf' };
const notice = { id: 'notice-example', payer_name: 'Avery Example', amount_cents: 12000, memo: 'Synthetic invoice payment', received_at: '2026-09-09T02:00:00Z', park_reason: 'name_mismatch', candidates: [{ invoice_id: invoice.id, invoice_number: invoice.invoice_number, customer_name: 'Avery Example', amount_due_cents: 12000, exact_amount: true, name_match: false }] };

function fixtures(state) {
  const map = new Map([
    ['GET /api/admin/auth/me', () => ({ id: 'fixture-user', role: state.role || 'admin', name: 'Fixture operator' })],
    ['GET /api/admin/feature-flags', () => ({ flags: { ff_invoice_send_receipt: true, ff_invoice_ai_summary: true, ff_invoice_email_message: true } })],
    ['GET /api/admin/notifications/unread-count', () => ({ count: 0 })],
    ['GET /api/admin/communications/unread-count', () => ({ count: 0, conversations: 0 })],
    ['POST /api/admin/usage/track', () => ({ ok: true })],
    ['GET /api/admin/invoices/stats', () => ({ paid: 1, outstanding: 1, overdue: 0, deposits: { onHand: 0, onHandCount: 0 } })],
    ['GET /api/admin/invoices/payment-notices', () => ({ notices: state.notices ? [notice] : [] })],
    ['GET /api/admin/invoices', (url) => {
      const search = (url.searchParams.get('search') || '').toLowerCase();
      const status = url.searchParams.get('status');
      let rows = state.empty ? [] : state.invoices;
      if (search) rows = rows.filter((row) => `${row.first_name} ${row.last_name} ${row.invoice_number}`.toLowerCase().includes(search));
      if (status && status !== 'all') rows = rows.filter((row) => status === 'unpaid' ? !['paid','prepaid','void'].includes(row.status) : row.status === status);
      return { invoices: rows, total: rows.length, page: 1 };
    }],
    ['GET /api/admin/invoices/customers/search', () => ({ customers: [customer] })],
    [`GET /api/admin/invoices/service-records/${customer.id}`, () => ({ records: [] })],
    ['GET /api/admin/discounts', () => ({ discounts: [{ id: 'discount-example', name: 'Example discount', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true }] })],
    ['GET /api/admin/services', () => ({ services: [{ id: 'service-example', name: 'Quarterly pest control', base_price: 120 }] })],
    [`GET /api/admin/customers/${customer.id}/cards`, () => ({ cards: [{ id: 'pm-example', brand: 'visa', last_four: '4242' }, { id: 'pm-bank-example', method_type: 'ach', bank_name: 'Example Bank', last_four: '6789' }] })],
    ['POST /api/admin/invoices', (_url, body) => {
      const created = { ...draft, id: 'invoice-created', invoice_number: 'WPC-QA-004', ...body, total: 120 };
      state.invoices.push(created); return created;
    }],
    ['POST /api/admin/invoices/notes/ai', () => ({ notes: 'Synthetic service summary.' })],
    ['POST /api/admin/invoices/email-message/ai', () => ({ message: 'Thank you for choosing Waves Pest Control.' })],
    ['POST /api/admin/invoices/payment-notices/notice-example/apply', () => ({ ok: true, invoice_number: invoice.invoice_number })],
    ['POST /api/admin/invoices/payment-notices/notice-example/ignore', () => { state.notices = false; return { ok: true }; }],
    ['POST /api/admin/invoices/batch/send', () => ({ sent_count: 1, total: 1, failed_count: 0 })],
    ['POST /api/admin/invoices/batch/send-receipts', () => ({ sent_count: 1, total: 1, failed_count: 0 })],
  ]);
  for (const row of [invoice, paid, draft, { ...draft, id: 'invoice-created' }]) {
    const base = `/api/admin/invoices/${row.id}`;
    map.set(`GET ${base}`, () => ({ ...row, ...(state.invoices.find((entry) => entry.id === row.id) || {}), suggested_coverage: { serviceType: 'Quarterly pest control', cadence: 'quarterly' } }));
    map.set(`GET ${base}/recipients`, () => recipient);
    map.set(`GET ${base}/credit-context`, () => ({ balance: state.zeroCredit ? 0 : 1000, amount_due: 120 }));
    map.set(`GET ${base}/attachments`, () => ({ attachments: state.attachments }));
    map.set(`GET ${base}/attachments/${attachment.id}/url`, () => ({ url: 'https://example.invalid/synthetic-file.pdf' }));
    map.set(`GET ${base}/followup`, () => ({ sequence: { status: 'paused', paused_reason: 'Synthetic pause', touches_sent: 1, step_index: 0 }, steps: [{ label: 'Payment reminder' }], autopayFailureThreshold: 3 }));
    map.set(`PUT ${base}`, (_url, body) => { const index = state.invoices.findIndex((item) => item.id === row.id); state.invoices[index] = { ...state.invoices[index], ...body }; return state.invoices[index]; });
    for (const action of ['send', 'send-receipt', 'record-payment', 'apply-credit', 'annual-prepay', 'payment-plan', 'charge-card', 'schedule-send', 'void', 'unvoid', 'archive', 'unarchive', 'reverse-prepaid', 'payment-plan/cancel', 'followup/resume', 'followup/pause', 'followup/stop', 'followup/send-now']) {
      map.set(`POST ${base}/${action}`, () => ({ ok: true, applied: 120, restored: 120, amount: 120, brand: 'visa', last4: '4242', sms: { ok: true }, email: { ok: true, recipient: { email: recipient.emailRecipient.email } }, receipt: { sms: { ok: true }, email: { ok: true } } }));
    }
    map.set(`DELETE ${base}/annual-prepay`, () => ({ ok: true }));
    map.set(`POST ${base}/attachments`, () => { state.attachments = [attachment]; return { attachments: [attachment] }; });
    map.set(`DELETE ${base}/attachments/${attachment.id}`, () => { state.attachments = []; return { ok: true }; });
  }
  return map;
}

async function installFixtures(page, server, state) {
  const handlers = fixtures(state);
  await page.addInitScript(() => {
    localStorage.setItem('waves_admin_token', 'synthetic-local-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'fixture-user', role: 'admin', name: 'Fixture operator' }));
    if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic-local-test' });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => String(input).endsWith('/admin/usage/track')
      ? Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : originalFetch(input, options);
    // Render the existing dictation control without contacting speech services.
    window.SpeechRecognition = class { start() {} stop() { this.onend?.(); } };
  });
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') state.consoleErrors.push({ text: message.text(), url: message.location().url }); });
  await page.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== server.baseUrl || url.pathname.startsWith('/socket.io')) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const key = `${request.method()} ${url.pathname}`;
    const body = request.method() === 'GET' ? null : request.headers()['content-type']?.includes('multipart/form-data') ? { multipartBytes: request.postDataBuffer()?.length || 0 } : request.postDataJSON();
    state.requests.push({ method: request.method(), path: url.pathname, query: url.search, body });
    if (state.hold?.key === key) await state.hold.promise;
    let status = 200, result;
    if (state.failures.has(key)) {
      if (request.method() !== 'GET') state.failures.delete(key);
      status = 503; state.expectedFailures.push(url.href); result = { error: 'Synthetic request failed. Try again.' };
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
    const controls = [...root.querySelectorAll('button, input:not([type="checkbox"]):not([type="file"]), select, textarea, a')].filter(visible).map((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return { name: node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.textContent.trim(), tag: node.tagName, height: rect.height, width: rect.width, left: rect.left, right: rect.right, font: parseFloat(style.fontSize), family: style.fontFamily, transform: style.textTransform, labeled: !['INPUT','SELECT','TEXTAREA'].includes(node.tagName) || !!node.labels?.length };
    });
    const choices = [...root.querySelectorAll('input[type="checkbox"]')].filter(visible).map((node) => ({ name: node.getAttribute('aria-label') || node.labels?.[0]?.textContent, height: node.closest('label')?.getBoundingClientRect().height || 0 }));
    const smallText = [...root.querySelectorAll('*')].filter(visible).filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())).filter((node) => parseFloat(getComputedStyle(node).fontSize) < 14).map((node) => node.textContent.slice(0,70));
    return { controls, choices, smallText, overflow: document.documentElement.scrollWidth > innerWidth + 1, titleSize: parseFloat(getComputedStyle(document.querySelector('main h1')).fontSize) };
  });
  state.geometry.push({ surface, viewport: page.viewportSize(), ...measured });
  assert.equal(measured.overflow, false, `${surface}: page overflow`);
  assert.equal(measured.titleSize, 22, `${surface}: page title`);
  assert.deepEqual(measured.smallText, [], `${surface}: text below 14px`);
  for (const control of measured.controls) {
    assert.ok(control.height >= 43.5, `${surface}: short control ${JSON.stringify(control)}`);
    assert.ok(control.width >= 43.5, `${surface}: narrow control ${JSON.stringify(control)}`);
    assert.ok(control.left >= -1 && control.right <= page.viewportSize().width + 1, `${surface}: off-screen control ${JSON.stringify(control)}`);
    assert.ok(control.font >= (['INPUT','SELECT','TEXTAREA'].includes(control.tag) ? 16 : 14), `${surface}: small field ${JSON.stringify(control)}`);
    assert.ok(control.labeled && control.name, `${surface}: missing label ${JSON.stringify(control)}`);
    assert.equal(control.transform, 'none', `${surface}: uppercase control`);
    assert.match(control.family, /Roboto/, `${surface}: admin font`);
  }
  for (const choice of measured.choices) assert.ok(choice.name && choice.height >= 44, `${surface}: checkbox target ${JSON.stringify(choice)}`);
}

async function screenshot(page, report, name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file }); report.screenshots.push(path.relative(root,file));
}

async function widths(page,state,surface) {
  const original = page.viewportSize();
  for (const viewport of [{width:390,height:844},{width:700,height:1000},{width:820,height:1000},{width:1024,height:1000},{width:1440,height:1000},{width:844,height:390},{width:390,height:420}]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await geometry(page,state,surface);
  }
  await page.setViewportSize(original);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function pendingFailure(page,state,button,key) {
  let release;
  state.failures.add(key);
  state.hold = {key,promise:new Promise(resolve => {release=resolve;})};
  const before = await button.boundingBox();
  const count = state.requests.filter(request => `${request.method} ${request.path}` === key).length;
  await button.click();
  await page.waitForFunction(() => !!document.querySelector('button[aria-busy="true"]'));
  const after = await button.boundingBox();
  assert.ok(Math.abs(after.width-before.width)<0.5,`${key}: pending width`);
  assert.ok(Math.abs(after.height-before.height)<0.5,`${key}: pending height`);
  assert.equal(await button.isDisabled(),true,`${key}: pending disabled`);
  await button.evaluate(node => node.click());
  assert.equal(state.requests.filter(request => `${request.method} ${request.path}` === key).length,count+1,`${key}: duplicate invocation`);
  state.hold=null;release();
  await page.getByText(/Synthetic request failed/).first().waitFor();
}

async function invoiceRoute(page,server,id=invoice.id) {
  await page.goto(`${server.baseUrl}/admin/invoices?customerId=${customer.id}&invoice=${id}&source=qa`);
  await page.locator(`#invoice-detail-${id}`).waitFor();
}

async function failureWorkflows(page,server,state,report,name) {
  // The builder created by initialWorkflow is still the same local draft.
  const createKey='POST /api/admin/invoices';
  const create=page.getByRole('button',{name:'Create draft',exact:true});
  await pendingFailure(page,state,create,createKey);
  assert.equal(await page.getByLabel('Notes (optional)',{exact:true}).inputValue(),'Synthetic invoice notes retained on failure.');
  assert.equal(await page.getByLabel('Price ($)',{exact:true}).inputValue(),'120');
  await create.click();
  await page.getByRole('button',{name:/WPC-QA-004/}).waitFor();
  const creates=state.requests.filter(request=>`${request.method} ${request.path}`===createKey);
  assert.equal(creates.length,2);assert.deepEqual(creates[0].body,creates[1].body,'Create retry payload');
  assert.equal(state.requests.filter(request=>request.method==='POST'&&/\/(send|schedule-send)$/.test(request.path)).length,0,'Draft must not send');

  await invoiceRoute(page,server);
  assert.equal(new URL(page.url()).searchParams.get('customerId'),customer.id);
  await page.reload();await page.getByRole('button',{name:'Resend',exact:true}).waitFor();
  await page.getByRole('button',{name:/Jordan Example.*WPC-QA-002/}).click();
  await page.getByRole('button',{name:'Send receipt',exact:true}).waitFor();
  await page.goBack();await page.waitForFunction(() => document.querySelector('#invoice-detail-invoice-example'));await page.getByRole('button',{name:'Resend',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('source'),'qa');
  await page.goForward();await page.getByRole('button',{name:'Send receipt',exact:true}).waitFor();

  await invoiceRoute(page,server);
  await page.getByRole('button',{name:'Add payment',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'Add payment',exact:true});
  await dialog.getByText(/billing@example.invalid/).waitFor();
  await dialog.getByRole('button',{name:'Zelle',exact:true}).click();
  await dialog.getByLabel('Zelle confirmation #').fill('SYNTHETIC-123');
  await dialog.getByLabel('Note (optional)').fill('Keep this payment note.');
  await dialog.getByRole('checkbox',{name:/Send receipt now/}).uncheck();
  let key=`POST /api/admin/invoices/${invoice.id}/record-payment`;
  let submit=dialog.getByRole('button',{name:'Record payment',exact:true});
  await pendingFailure(page,state,submit,key);
  assert.equal(await dialog.getByLabel('Zelle confirmation #').inputValue(),'SYNTHETIC-123');
  assert.equal(await dialog.getByLabel('Note (optional)').inputValue(),'Keep this payment note.');
  await screenshot(page,report,`${name}-payment-error`);
  await submit.click();await dialog.waitFor({state:'hidden'});
  let writes=state.requests.filter(request=>`${request.method} ${request.path}`===key);
  assert.deepEqual(writes.map(request=>request.body),Array(2).fill({method:'zelle',reference:'SYNTHETIC-123',note:'Keep this payment note.',sendReceipt:false}));

  await page.getByRole('button',{name:'Resend',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Resend invoice',exact:true});
  await dialog.getByText('billing@example.invalid',{exact:true}).waitFor();
  await dialog.getByRole('checkbox',{name:'Send invoice email to someone else'}).check();
  await dialog.getByLabel('Name',{exact:true}).fill('Example Accounts');
  await dialog.getByLabel('Email',{exact:true}).fill('alternate@example.invalid');
  await geometry(page,state,'Recipient override');
  await screenshot(page,report,`${name}-recipient-override`);
  submit=dialog.getByRole('button',{name:/^(Send|Resend)/});key=`POST /api/admin/invoices/${invoice.id}/send`;
  await pendingFailure(page,state,submit,key);
  assert.equal(await dialog.getByLabel('Email',{exact:true}).inputValue(),'alternate@example.invalid');
  await submit.click();await dialog.waitFor({state:'hidden'});
  writes=state.requests.filter(request=>`${request.method} ${request.path}`===key);
  assert.deepEqual(writes.map(request=>request.body),Array(2).fill({invoiceRecipientEmail:'alternate@example.invalid',invoiceRecipientName:'Example Accounts',saveBillingRecipient:false}));

  key=`GET /api/admin/invoices/${invoice.id}/credit-context`;state.failures.add(key);
  await page.getByRole('button',{name:'Apply credit',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Apply account credit',exact:true});
  await dialog.getByText(/Couldn't load account credit/).waitFor();
  assert.equal(await dialog.getByText('$0.00',{exact:true}).count(),0,'Credit read failure is not zero');
  state.failures.delete(key);await dialog.getByRole('button',{name:'Try again',exact:true}).click();
  await dialog.getByLabel('Note (optional)').fill('Retain account credit note.');
  await dialog.getByRole('checkbox',{name:/Waive initial/}).check();
  submit=dialog.getByRole('button',{name:'Apply & mark prepaid',exact:true});key=`POST /api/admin/invoices/${invoice.id}/apply-credit`;
  await pendingFailure(page,state,submit,key);assert.equal(await dialog.getByLabel('Note (optional)').inputValue(),'Retain account credit note.');
  await submit.click();await dialog.waitFor({state:'hidden'});
  writes=state.requests.filter(request=>`${request.method} ${request.path}`===key);
  assert.deepEqual(writes.map(request=>request.body),Array(2).fill({waiveSetupFee:true,note:'Retain account credit note.'}));

  await page.getByRole('button',{name:'Payment plan',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Create payment plan',exact:true});
  await dialog.getByLabel('Payment amount',{exact:true}).fill('40');
  await dialog.getByLabel('Start date',{exact:true}).fill('2099-01-01');
  await dialog.getByLabel('Next payment',{exact:true}).fill('2099-02-01');
  await dialog.getByLabel('Note (optional)').fill('Three synthetic payments.');
  submit=dialog.getByRole('button',{name:'Create plan',exact:true});key=`POST /api/admin/invoices/${invoice.id}/payment-plan`;
  await pendingFailure(page,state,submit,key);assert.equal(await dialog.getByLabel('Next payment').inputValue(),'2099-02-01');
  await submit.click();await dialog.waitFor({state:'hidden'});
  writes=state.requests.filter(request=>`${request.method} ${request.path}`===key);assert.deepEqual(writes[0].body,writes[1].body);

  await page.getByRole('button',{name:'Annual prepay',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Mark as annual prepay',exact:true});
  await dialog.getByLabel('Plan label').fill('Synthetic annual coverage');
  submit=dialog.getByRole('button',{name:'Mark prepaid',exact:true});key=`POST /api/admin/invoices/${invoice.id}/annual-prepay`;
  await pendingFailure(page,state,submit,key);assert.equal(await dialog.getByLabel('Plan label').inputValue(),'Synthetic annual coverage');
  await submit.click();await dialog.waitFor({state:'hidden'});
  writes=state.requests.filter(request=>`${request.method} ${request.path}`===key);assert.deepEqual(writes[0].body,writes[1].body);

  await invoiceRoute(page,server,paid.id);
  await page.getByRole('button',{name:'Send receipt',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Send receipt & close',exact:true});
  await dialog.getByRole('checkbox',{name:/^SMS/}).uncheck();
  await dialog.getByLabel('Optional memo').fill('Retain receipt memo.');
  submit=dialog.getByRole('button',{name:'Send receipt',exact:true});key=`POST /api/admin/invoices/${paid.id}/send-receipt`;
  await pendingFailure(page,state,submit,key);assert.equal(await dialog.getByLabel('Optional memo').inputValue(),'Retain receipt memo.');
  await submit.click();await dialog.waitFor({state:'hidden'});
  writes=state.requests.filter(request=>`${request.method} ${request.path}`===key);assert.deepEqual(writes.map(request=>request.body),Array(2).fill({memo:'Retain receipt memo.',via:'email'}));

  state.notices=true;await page.goto(`${server.baseUrl}/admin/invoices`);
  await page.getByRole('button',{name:'Ignore',exact:true}).waitFor();
  await screenshot(page,report,`${name}-payment-notices`);await widths(page,state,'Payment notices');
  page.on('dialog',prompt=>prompt.accept());
  submit=page.getByRole('button',{name:'Ignore',exact:true});key='POST /api/admin/invoices/payment-notices/notice-example/ignore';
  await pendingFailure(page,state,submit,key);await submit.click();await submit.waitFor({state:'hidden'});

  await invoiceRoute(page,server);
  await page.getByRole('button',{name:`Remove ${attachment.file_name}`,exact:true}).click();
  await page.getByText('No files attached.',{exact:true}).waitFor();
  await page.locator('input[type="file"]').setInputFiles({name:'Synthetic inspection.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 Synthetic QA file')});
  await page.getByRole('button',{name:attachment.file_name,exact:true}).waitFor();
  assert.equal(state.requests.filter(request=>request.method==='POST' && request.path.endsWith('/attachments')).length,1);
  await page.getByRole('checkbox',{name:'Select invoice WPC-QA-001',exact:true}).check();
  await widths(page,state,'Batch selection');await screenshot(page,report,`${name}-batch`);
  submit=page.getByRole('button',{name:'Send 1',exact:true});key='POST /api/admin/invoices/batch/send';
  await pendingFailure(page,state,submit,key);
  assert.equal(await page.getByRole('checkbox',{name:'Select invoice WPC-QA-001',exact:true}).isChecked(),true);
  await submit.click();await submit.waitFor({state:'hidden'});
  writes=state.requests.filter(request=>`${request.method} ${request.path}`===key);
  assert.deepEqual(writes.map(request=>request.body),Array(2).fill({invoiceIds:[invoice.id]}));
  await page.goto(`${server.baseUrl}/admin/invoices`);
  await page.getByLabel('Search invoices').fill('no-match');
  await page.getByText('No invoices match',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await page.getByRole('button',{name:/Avery Example.*WPC-QA-001/}).waitFor();
  state.failures.add('GET /api/admin/invoices/stats');state.failures.add('GET /api/admin/invoices');
  await page.reload();await page.getByText('Could not load invoices',{exact:true}).waitFor();
  await page.getByText('Invoice totals could not be loaded.',{exact:true}).waitFor();
  await screenshot(page,report,`${name}-read-error`);await geometry(page,state,'Invoice read errors');
  state.failures.clear();await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('button',{name:/Avery Example.*WPC-QA-001/}).waitFor();
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.getByText('Invoice totals could not be loaded.',{exact:true}).waitFor({state:'hidden'});
}

async function initialWorkflow(page, server, state, report, name) {
  await page.goto(`${server.baseUrl}/admin/invoices?source=qa`);
  await page.getByRole('button', { name: /Avery Example.*WPC-QA-001/ }).waitFor();
  await waitForFonts(page);
  await screenshot(page, report, `${name}-directory`);
  await geometry(page, state, 'Invoice directory');
  await widths(page,state,'Invoice directory');
  await page.getByRole('button', { name: /Avery Example.*WPC-QA-001/ }).click();
  await page.getByRole('button', { name: 'Add payment', exact: true }).waitFor();
  await page.getByText(attachment.file_name, { exact: true }).waitFor();
  await page.getByText('Automated follow-ups', { exact: true }).waitFor();
  await screenshot(page, report, `${name}-expanded`);
  await geometry(page, state, 'Expanded invoice');
  await widths(page,state,'Expanded invoice');
  await page.getByRole('button', {name:'Add payment',exact:true}).scrollIntoViewIfNeeded();
  await screenshot(page,report,`${name}-invoice-actions`);
  for (const [buttonName, dialogName, slug] of [
    ['Resend','Resend invoice','send'],
    ['Add payment','Add payment','payment'],
    ['Apply credit','Apply account credit','credit'],
    ['Payment plan','Create payment plan','payment-plan'],
    ['Annual prepay','Mark as annual prepay','annual-prepay'],
    ['Charge card on file','Charge card on file','saved-card'],
  ]) {
    const opener = page.getByRole('button', { name: buttonName, exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
    await dialog.waitFor();
    await page.waitForFunction(() => !/Loading (recipients|account credit|annual prepay|cards)/.test(document.querySelector('[role="dialog"]').textContent));
    await screenshot(page, report, `${name}-${slug}`);
    await geometry(page, state, dialogName);
    await widths(page,state,dialogName);
    if (slug === 'annual-prepay') {
      await dialog.getByRole('button', {name:'Mark prepaid',exact:true}).scrollIntoViewIfNeeded();
      await screenshot(page,report,`${name}-annual-prepay-actions`);
    }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await opener.evaluate((node) => document.activeElement === node), true, `${dialogName}: opener focus`);
  }
  await page.getByRole('button', { name: /Jordan Example.*WPC-QA-002/ }).click();
  await page.getByRole('button', { name: 'Send receipt', exact: true }).click();
  const receiptDialog = page.getByRole('dialog', { name: 'Send receipt & close', exact: true });
  await receiptDialog.getByText('billing@example.invalid', { exact: false }).first().waitFor();
  await screenshot(page, report, `${name}-receipt`); await geometry(page, state, 'Send receipt');
  await widths(page,state,'Send receipt');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Create invoice', exact: true }).click();
  await page.getByLabel('Find customer').fill('Avery');
  await page.getByRole('button', { name: /Avery Example/ }).click();
  await page.getByLabel('Service', { exact: true }).fill('Quarterly pest control');
  await page.getByLabel('Quantity', { exact: true }).fill('1');
  await page.getByLabel('Price ($)', { exact: true }).fill('120');
  await page.getByLabel('Send', { exact: true }).selectOption('draft');
  await page.getByLabel('Notes (optional)', { exact: true }).fill('Synthetic invoice notes retained on failure.');
  await page.getByText('No services match. Check Services catalog.', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByText('Searching services...', {exact:true}).waitFor({state:'hidden'});
  await page.getByLabel('Notes (optional)',{exact:true}).focus();
  // The existing service picker closes 150ms after blur to allow option clicks.
  await page.waitForTimeout(200);
  await page.getByText('Invoice builder',{exact:true}).evaluate(node => { for (let parent=node;parent;parent=parent.parentElement) parent.scrollTop=0; });
  await screenshot(page, report, `${name}-builder`); await geometry(page, state, 'Invoice builder');
  await widths(page,state,'Invoice builder');
  await page.getByLabel('Notes (optional)', {exact:true}).scrollIntoViewIfNeeded();
  await screenshot(page,report,`${name}-delivery`);
  await page.getByRole('button', {name:'Create draft',exact:true}).scrollIntoViewIfNeeded();
  await screenshot(page,report,`${name}-summary`);
}

function writeGallery(report) {
  const sections = ['directory','expanded','invoice-actions','builder','delivery','summary','send','recipient-override','payment','credit','payment-plan','annual-prepay','annual-prepay-actions','saved-card','receipt','payment-notices','batch','payment-error','read-error','empty'];
  const figures = sections.map(section => {
    const files = ['desktop','touch-webkit'].map(device => `${device}-${section}.png`).filter(file=>fs.existsSync(path.join(output,file)));
    if (!files.length) return '';
    const title = section.replaceAll('-', ' ');
    return `<section><h2>${title}</h2><div class="pair">${files.map(file=>`<figure><figcaption>${file.startsWith('desktop')?'Desktop · Chromium':'Phone · WebKit'}</figcaption><a href="${file}"><img loading="lazy" src="${file}" alt="${title}"></a></figure>`).join('')}</div></section>`;
  }).join('');
  fs.writeFileSync(path.join(output,'review.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoices UI review</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f4f5;color:#18181b;font:16px/1.5 system-ui}main{max-width:1440px;margin:auto;padding:28px}h1{font-size:28px}h2{text-transform:capitalize;font-size:22px}section{margin:40px 0}.pair{display:grid;grid-template-columns:minmax(0,3fr) minmax(280px,1fr);gap:20px}figure{margin:0}figcaption{margin-bottom:10px}img{display:block;width:100%;border:1px solid #d4d4d8;border-radius:6px}@media(max-width:800px){.pair{grid-template-columns:1fr}}</style><main><h1>Invoices UI review</h1><p>Invoice directory, builder, payment and delivery forms. Synthetic records only.</p><p>Source: ${report.sha.slice(0,12)} · ${report.dirty?'working tree':'clean commit'} · ${report.startedAt}</p>${figures}</main></html>`);
}

async function main() {
  fs.mkdirSync(output,{recursive:true});
  const report = { ...evidence(root), screenshots: [], browsers: [] };
  const server = await previewServer(root);
  try {
    for (const [name, launch, viewport, hasTouch] of [
      ['desktop', launchBrowser, {width:1440,height:1000}, false],
      ['touch-webkit', () => webkit.launch({headless:true}), {width:390,height:844}, true],
    ]) {
      const browser = await launch();
      const state = { invoices: structuredClone([invoice,paid,draft]), attachments: [attachment], requests: [], unmatched: [], pageErrors: [], consoleErrors: [], expectedFailures: [], failures: new Set(), geometry: [] };
      report.browsers.push({ name,state });
      const page = await browser.newPage({viewport,hasTouch,timezoneId:'America/New_York',serviceWorkers:'block'});
      try {
        await installFixtures(page,server,state);
        await initialWorkflow(page,server,state,report,name);
        await failureWorkflows(page,server,state,report,name);
        const unexpected = state.consoleErrors.filter(entry => !state.expectedFailures.includes(entry.url) || !/^Failed to load resource: the server responded with a status of 503 \([^)]*\)$/.test(entry.text));
        assert.deepEqual(unexpected,[],'Unexpected console errors');
        assert.deepEqual(state.pageErrors,[],'Page errors');assert.deepEqual(state.unmatched,[],'Unmatched API requests');
      } catch(error) {
        await screenshot(page,report,`${name}-failure`);report.error=error.stack;report.failureUrl=page.url();report.expanded=await page.locator('[id^="invoice-detail-"]').evaluateAll(nodes=>nodes.map(node=>node.id));
        throw error;
      } finally { await browser.close(); }
    }
  } finally {
    writeGallery(report);
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    await server.close();
  }
  console.log(`Invoice UI checks passed. Evidence: ${path.relative(root,output)}`);
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
