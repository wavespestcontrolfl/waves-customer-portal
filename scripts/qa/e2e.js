#!/usr/bin/env node
'use strict';
/* global document, localStorage */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { readContext, childEnvironment } = require('../dev/context');
const { doctor } = require('../dev/doctor');
const { launchBrowser, evidence, waitForFonts } = require('./browser');
const { fixtureIdentity, seed, cleanup } = require('./fixtures');
const { etDateString } = require('../../server/utils/datetime-et');
const { createScheduledService } = require('../../server/services/booking/create-scheduled-service');

async function main() {
  const context = readContext();
  const env = childEnvironment(context, { database: true });
  const databaseName = `waves_qa_${context.id.replaceAll('-', '')}`;
  if (new URL(env.DATABASE_URL).pathname !== `/${databaseName}`) throw new Error("Run qa:database first: QA requires this worktree's private database.");
  const artifactDir = path.join(context.root, '.tmp/qa/e2e');
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const fixtureFile = path.join(artifactDir, 'fixture.json');
  const captureFile = path.join(artifactDir, 'captures.jsonl');
  const databaseFingerprint = crypto.createHash('sha256').update(env.DATABASE_URL).digest('hex');
  const db = require('knex')({ client: 'pg', connection: env.DATABASE_URL, pool: { min: 0, max: 4 } });
  let browser;
  let browserContext;
  let server;
  let fixture;
  const report = { provenance: evidence(context.root), steps: [] };
  try {
    if (fs.existsSync(fixtureFile)) {
      const previous = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
      if (previous.databaseFingerprint !== databaseFingerprint) throw new Error('Fixture database changed; refusing cleanup in another database.');
      await cleanup(db, previous);
      fs.unlinkSync(fixtureFile);
    }
    if (process.argv.includes('--cleanup')) return;
    await doctor(context);
    if (!process.argv.includes('--seed')) {
      // Always rebuild: ignored dist assets can belong to a previous checkout.
      // Use the managed frontend environment, without database/provider secrets.
      await new Promise((resolve, reject) => {
        const build = spawn('npm', ['run', 'build'], { cwd: context.root,
          env: { ...childEnvironment(context), NODE_ENV: 'production' }, stdio: 'inherit' });
        build.once('error', reject);
        build.once('exit', (code, signal) => code === 0 ? resolve()
          : reject(new Error(`Frontend QA build failed (${signal || code}).`)));
      });
      if (!fs.existsSync(path.join(context.root, 'client/dist/index.html'))) throw new Error('Frontend QA build did not produce client/dist/index.html.');
    }
    fixture = { ...fixtureIdentity(), databaseFingerprint };
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
    await seed(db, fixture);
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
    if (process.argv.includes('--seed')) { console.log(`Synthetic fixture credentials: ${fixtureFile}`); return; }
    fs.writeFileSync(captureFile, '', { mode: 0o600 });
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const baseUrl = `http://127.0.0.1:${context.ports.api}`;
    const localEnv = { ...env, NODE_ENV: 'production', QA_FIXTURE_FILE: fixtureFile, QA_CAPTURE_FILE: captureFile,
      CLIENT_URL: baseUrl, STRIPE_SECRET_KEY: 'sk_test_qa_fixture', STRIPE_WEBHOOK_SECRET: webhookSecret };
    const log = fs.openSync(path.join(artifactDir, 'server.log'), 'w', 0o600);
    server = spawn(process.execPath, ['scripts/qa/server.js'], { cwd: context.root, env: localEnv, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { ready = (await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup */ }
      if (ready) break;
      if (server.exitCode !== null) throw new Error('QA server exited; inspect the private server.log.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('QA server readiness timed out.');
    browser = await launchBrowser();
    browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await browserContext.tracing.start({ screenshots: true, snapshots: true });
    await browserContext.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
    const page = await browserContext.newPage();
    let adminToken;
    let customerToken;
    async function step(name, action) {
      try {
        await action();
        report.steps.push({ name, passed: true });
        console.log(`PASS ${name}`);
      } catch (error) {
        const result = { name, passed: false, error: error.message };
        report.steps.push(result);
        await page.screenshot({ path: path.join(artifactDir, `${name}-failed.png`), fullPage: true })
          .catch((screenshotError) => { result.screenshotError = screenshotError.message; });
        throw error;
      }
    }
    async function json(response, expected = 200) {
      const body = await response.json();
      assert.equal(response.status(), expected, JSON.stringify(body));
      return body;
    }
    await step('staff-login-and-role-isolation', async () => {
      await page.goto(`${baseUrl}/admin/login`);
      await page.getByLabel('Email address', { exact: true }).fill(fixture.adminEmail);
      await page.getByLabel('Password', { exact: true }).fill(fixture.password);
      const login = page.waitForResponse((response) => response.url().endsWith('/api/admin/auth/login'));
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      adminToken = (await json(await login)).token;
      assert.ok(adminToken);
      const tech = await json(await page.request.post(`${baseUrl}/api/admin/auth/login`, { data: { email: fixture.techEmail, password: fixture.password } }));
      assert.equal((await page.request.get(`${baseUrl}/api/admin/settings`, { headers: { Authorization: `Bearer ${tech.token}` } })).status(), 403);
      assert.equal((await page.request.get(`${baseUrl}/api/admin/settings`)).status(), 401);
    });
    await step('customer-otp-login-and-permissions', async () => {
      await page.goto(`${baseUrl}/login`);
      await page.getByLabel('Phone number', { exact: true }).fill(fixture.phone.slice(2));
      const send = page.waitForResponse((response) => response.url().endsWith('/api/auth/send-code'));
      await page.getByRole('button', { name: 'Send code', exact: true }).click();
      await json(await send);
      const captures = fs.readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      const code = captures.filter((item) => item.kind === 'verification').at(-1)?.code;
      assert.ok(code, 'Expected captured OTP from the real send-code route');
      await page.getByLabel('Verification code', { exact: true }).fill(code);
      const login = page.waitForResponse((response) => response.url().endsWith('/api/auth/verify-code'));
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      customerToken = (await json(await login)).token;
      assert.ok(customerToken);
      assert.equal((await page.request.get(`${baseUrl}/api/admin/settings`, { headers: { Authorization: `Bearer ${customerToken}` } })).status(), 401);
      await page.waitForFunction(() => document.body.innerText.includes('QA'));
      await waitForFonts(page);
      await page.screenshot({ path: path.join(artifactDir, 'customer-portal.png'), fullPage: true });
    });
    await step('estimate-acceptance-is-idempotent', async () => {
      const data = { slotId: `${fixture.date}_09-00_${fixture.technicianId}`, paymentMethodPreference: 'pay_at_visit' };
      await json(await page.request.put(`${baseUrl}/api/estimates/${fixture.token}/accept`, { data }));
      await json(await page.request.put(`${baseUrl}/api/estimates/${fixture.token}/accept`, { data }));
      const rows = await db('scheduled_services').where({ source_estimate_id: fixture.estimateId }).whereNull('reservation_expires_at');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].customer_id, fixture.customerId);
      assert.equal((await db('estimates').where({ id: fixture.estimateId }).first()).status, 'accepted');
    });
    await step('reschedule-detects-unassigned-conflict-and-preserves-duration', async () => {
      const headers = { Authorization: `Bearer ${adminToken}` };
      // Acceptance uses the catalog's default duration. Arrange a longer
      // synthetic appointment to exercise a non-hourly end in rescheduling.
      await db('scheduled_services').where({ id: fixture.appointmentId }).update({
        window_start: '09:00:00', window_end: '10:30:00', estimated_duration_minutes: 90,
      });
      await createScheduledService({ trx: db, cols: await db('scheduled_services').columnInfo(), source: { sourceAction: 'qa_fixture' },
        insertData: { id: fixture.conflictId, customer_id: fixture.customerId,
          technician_id: null, service_id: fixture.serviceId, service_type: fixture.serviceName,
          scheduled_date: fixture.nextDate, window_start: '11:00:00', window_end: '12:30:00', status: 'confirmed' } });
      const result = await json(await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/reschedule`, {
        headers, data: { newDate: fixture.nextDate, newWindow: { start: '11:00' }, notifyCustomer: false },
      }));
      assert.match(JSON.stringify(result.warnings), /overlap/i, 'Unassigned conflict must be disclosed to staff');
      const moved = await db('scheduled_services').where({ id: fixture.appointmentId }).first();
      assert.equal(moved.window_start, '11:00:00');
      assert.equal(moved.window_end, '12:30:00');
      const invalid = await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/reschedule`, {
        headers, data: { newDate: fixture.nextDate, newWindow: { start: '11:15', end: '12:45' }, notifyCustomer: false },
      });
      assert.equal(invalid.status(), 422);
    });
    await step('payment-webhook-settles-once', async () => {
      const event = { id: fixture.eventId, type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
        data: { object: { id: fixture.paymentIntentId, status: 'succeeded', amount: 9900, amount_received: 9900,
          currency: 'usd', payment_method_types: ['us_bank_account'], latest_charge: `ch_${fixture.paymentIntentId}`,
          metadata: { invoice_id: fixture.invoiceId, customer_id: fixture.customerId } } } };
      const payload = JSON.stringify(event);
      const signature = require('stripe').webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      const request = { headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, data: payload };
      await json(await page.request.post(`${baseUrl}/api/stripe/webhook`, request));
      await json(await page.request.post(`${baseUrl}/api/stripe/webhook`, request));
      assert.equal((await db('invoices').where({ id: fixture.invoiceId }).first()).status, 'paid');
      const payments = await db('payments').where({ stripe_payment_intent_id: fixture.paymentIntentId });
      assert.equal(payments.length, 1);
      assert.equal(Number(payments[0].amount), 99);
      await page.goto(`${baseUrl}/receipt/${fixture.invoiceToken}`);
      await page.getByText('$99.00', { exact: false }).first().waitFor();
      await waitForFonts(page);
      await page.screenshot({ path: path.join(artifactDir, 'receipt.png'), fullPage: true });
    });
    await step('completion-and-report-redaction', async () => {
      const premature = await json(await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, {
        headers: { Authorization: `Bearer ${adminToken}` }, data: {},
      }), 409);
      assert.equal(premature.code, 'future_scheduled_date');
      // Arrange a due-today synthetic visit after proving future visits
      // cannot complete. The production day-of guard remains active.
      await db('scheduled_services').where({ id: fixture.appointmentId }).update({ scheduled_date: etDateString(new Date()) });
      await json(await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, {
        headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': fixture.runId },
        data: { technicianNotes: 'QA-PRIVATE-TECH-NOTE-DO-NOT-PUBLISH', customerRecap: 'Service completed.',
          products: [], sendCompletionSms: false, requestReview: false, offerInspectionCredit: false,
          timeOnSite: 30, areasServiced: ['Exterior'], protocolActionsCompleted: [] },
      }));
      const visit = await db('scheduled_services').where({ id: fixture.appointmentId }).first();
      assert.equal(visit.status, 'completed');
      const record = await db('service_records').where({ scheduled_service_id: fixture.appointmentId }).first();
      assert.ok(record?.report_view_token);
      const data = await json(await page.request.get(`${baseUrl}/api/reports/${record.report_view_token}/data`));
      assert.ok(!JSON.stringify(data).includes('QA-PRIVATE-'));
      await page.evaluate(() => localStorage.clear());
      const renderedReport = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/reports/${record.report_view_token}/data`);
      await page.goto(`${baseUrl}/report/${record.report_view_token}`);
      const reportResponse = await renderedReport;
      assert.equal(reportResponse.request().headers().authorization, undefined);
      const publicReport = await json(reportResponse);
      assert.ok(!publicReport.staffViewer, 'Render the customer report without a staff session');
      assert.ok(!JSON.stringify(publicReport).includes('QA-PRIVATE-'));
      await page.getByRole('heading', { name: /Hi QA/i }).waitFor();
      await waitForFonts(page);
      await page.screenshot({ path: path.join(artifactDir, 'report.png'), fullPage: true });
    });
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    report.cleanupErrors = [];
    for (const [label, close] of [
      ['Trace', () => browserContext?.tracing.stop({ path: path.join(artifactDir, 'trace.zip') })],
      ['Browser', () => browser?.close()],
      ['Server', async () => {
        if (!server || server.exitCode !== null || server.signalCode != null) return;
        const exited = new Promise((resolve) => server.once('exit', resolve));
        server.kill('SIGTERM');
        const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(timer);
      }],
      ['Database', () => db.destroy()],
    ]) {
      try { await close(); }
      catch (error) { report.cleanupErrors.push(`${label}: ${error.message}`); }
    }
    if (report.cleanupErrors.length) process.exitCode = 1;
    const reportFile = process.argv.includes('--cleanup') ? 'cleanup.json' : 'report.json';
    fs.writeFileSync(path.join(artifactDir, reportFile), JSON.stringify(report, null, 2) + '\n');
    console.log(`Private QA artifacts: ${artifactDir}`);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
