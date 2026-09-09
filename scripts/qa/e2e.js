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
    const objectDir = path.join(artifactDir, 'objects');
    fs.mkdirSync(objectDir, { recursive: true, mode: 0o700 });
    const localEnv = { ...env, NODE_ENV: 'production', QA_FIXTURE_FILE: fixtureFile, QA_CAPTURE_FILE: captureFile,
      QA_OBJECT_DIR: objectDir, S3_BUCKET: 'waves-qa-fixture', AWS_REGION: 'us-east-1',
      GATE_TWILIO_SMS: 'true', TWILIO_SIGNATURE_VALIDATION: 'enforce',
      TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'qa-fixture-auth-token',
      AWS_ACCESS_KEY_ID: 'qa-fixture', AWS_SECRET_ACCESS_KEY: 'qa-fixture-secret',
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
    await browserContext.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === baseUrl) return route.continue();
      if (url.hostname === 'waves-qa-fixture.s3.us-east-1.amazonaws.com') {
        const object = path.join(objectDir, crypto.createHash('sha256').update(decodeURIComponent(url.pathname.slice(1))).digest('hex'));
        if (fs.existsSync(object)) return route.fulfill({ contentType: 'image/png', body: fs.readFileSync(object) });
      }
      return route.abort();
    });
    const page = await browserContext.newPage();
    let adminToken;
    let customerToken;
    let customerRefreshToken;
    let techToken;
    let otherTechToken;
    async function step(name, action) {
      try {
        const observations = await action();
        report.steps.push({ name, passed: true, ...(observations ? { observations } : {}) });
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
      techToken = tech.token;
      otherTechToken = (await json(await page.request.post(`${baseUrl}/api/admin/auth/login`, { data: { email: fixture.otherTechEmail, password: fixture.password } }))).token;
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
      const session = await json(await login);
      customerToken = session.token;
      customerRefreshToken = session.refreshToken;
      assert.ok(customerToken);
      assert.equal((await page.request.get(`${baseUrl}/api/admin/settings`, { headers: { Authorization: `Bearer ${customerToken}` } })).status(), 401);
      await page.waitForFunction(() => document.body.innerText.includes('QA'));
      await waitForFonts(page);
      await page.screenshot({ path: path.join(artifactDir, 'customer-portal.png'), fullPage: true });
    });
    await step('communications-policy-delivery-and-read-boundary', async () => {
      const headers = { Authorization: `Bearer ${adminToken}` };
      await db('notification_prefs').insert({ customer_id: fixture.customerId, sms_enabled: true }).onConflict('customer_id').merge({ sms_enabled: true });
      const outbound = await json(await page.request.post(`${baseUrl}/api/admin/communications/sms`, { headers,
        data: { customerId: fixture.customerId, to: fixture.phone, body: 'QA connected messaging check', messageType: 'manual' } }));
      assert.equal(outbound.sent, true, JSON.stringify(outbound));
      const legacy = await db('sms_log').where({ customer_id: fixture.customerId, message_body: 'QA connected messaging check', direction: 'outbound' }).first();
      assert.ok(legacy?.twilio_sid);
      assert.equal(legacy.admin_user_id, fixture.adminId);
      let unified;
      // The canonical sender deliberately dual-writes asynchronously. Await
      // the observable handoff before delivering its carrier callback.
      for (let attempt = 0; attempt < 50; attempt++) {
        unified = await db('messages').where({ twilio_sid: legacy.twilio_sid }).first();
        if (unified) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(unified, 'Accepted SMS must reach the unified inbox');
      assert.equal(unified.admin_user_id, fixture.adminId);
      const callbackUrl = `${baseUrl}/api/webhooks/twilio/status`;
      const form = { MessageSid: legacy.twilio_sid, MessageStatus: 'delivered' };
      assert.equal((await page.request.post(callbackUrl, { form })).status(), 403);
      const signature = require('twilio').getExpectedTwilioSignature('qa-fixture-auth-token', callbackUrl, form);
      for (let retry = 0; retry < 2; retry++) assert.equal((await page.request.post(callbackUrl, { headers: { 'X-Twilio-Signature': signature }, form })).status(), 200);
      assert.equal((await db('sms_log').where({ id: legacy.id }).first()).status, 'delivered');
      assert.equal((await db('messages').where({ id: unified.id }).first()).delivery_status, 'delivered');
      assert.equal((await db('messages').where({ twilio_sid: legacy.twilio_sid })).length, 1);
      const boundary = new Date(Date.now() - 1000);
      const inbound = [crypto.randomUUID(), crypto.randomUUID()];
      const sids = inbound.map(id => `SM${id.replaceAll('-', '')}`);
      for (let index = 0; index < 2; index++) {
        const created = new Date(boundary.getTime() + (index ? 500 : -500));
        await db('messages').insert({ id: inbound[index], conversation_id: unified.conversation_id, channel: 'sms', direction: 'inbound', author_type: 'customer',
          body: 'QA inbound boundary check', twilio_sid: sids[index], is_read: false, created_at: created });
        await db('sms_log').insert({ customer_id: fixture.customerId, direction: 'inbound', from_phone: fixture.phone, to_phone: legacy.from_phone,
          message_body: 'QA inbound boundary check', twilio_sid: sids[index], is_read: false, created_at: created });
      }
      const read = await json(await page.request.post(`${baseUrl}/api/admin/communications/messages/read`, { headers,
        data: { conversationIds: [unified.conversation_id], readBefore: boundary.toISOString() } }));
      assert.equal(read.updated, 1);
      assert.equal((await db('messages').where({ id: inbound[0] }).first()).read_by_admin_user_id, fixture.adminId);
      assert.equal((await db('messages').where({ id: inbound[1] }).first()).is_read, false);
      assert.equal((await db('sms_log').where({ twilio_sid: sids[0] }).first()).is_read, true);
      assert.equal((await db('sms_log').where({ twilio_sid: sids[1] }).first()).is_read, false);
      const count = await json(await page.request.get(`${baseUrl}/api/admin/communications/unread-count?customerId=${fixture.customerId}`, { headers }));
      assert.deepEqual(count, { conversations: 1, messages: 1 });
      await json(await page.request.post(`${baseUrl}/api/admin/communications/messages/read`, { headers, data: { messageIds: [inbound[1]] } }));
      assert.deepEqual(await json(await page.request.get(`${baseUrl}/api/admin/communications/unread-count?customerId=${fixture.customerId}`, { headers })), { conversations: 0, messages: 0 });
      return { providerTransportSimulated: true, signedCallbackStatus: 200, unsignedCallbackStatus: 403,
        legacyAndUnifiedDelivered: true, callbackRetryRows: 1, authorAttributed: true, readBoundaryPreserved: true, finalUnread: 0 };
    });
    await step('account-property-switch-and-record-isolation', async () => {
      let headers = { Authorization: `Bearer ${customerToken}` };
      const properties = (await json(await page.request.get(`${baseUrl}/api/auth/properties`, { headers }))).properties;
      assert.deepEqual(properties.map(row => row.id).sort(), [fixture.customerId, fixture.siblingCustomerId].sort());
      await json(await page.request.post(`${baseUrl}/api/auth/select-property`, { headers,
        data: { customerId: fixture.foreignCustomerId, refreshToken: customerRefreshToken } }), 403);
      for (const route of [`/services/${fixture.foreignRecordId}`, `/documents/${fixture.foreignDocumentId}/download`, `/documents/service-report/${fixture.foreignRecordId}`]) {
        await json(await page.request.get(`${baseUrl}/api${route}`, { headers }), 404);
      }
      await json(await page.request.post(`${baseUrl}/api/schedule/${fixture.foreignAppointmentId}/confirm`, { headers, data: {} }), 404);
      const sibling = await json(await page.request.post(`${baseUrl}/api/auth/select-property`, { headers,
        data: { customerId: fixture.siblingCustomerId, refreshToken: customerRefreshToken } }));
      assert.equal(sibling.customer.id, fixture.siblingCustomerId);
      customerToken = sibling.token;
      customerRefreshToken = sibling.refreshToken;
      headers = { Authorization: `Bearer ${customerToken}` };
      const schedule = await json(await page.request.get(`${baseUrl}/api/schedule`, { headers }));
      assert.ok(JSON.stringify(schedule).includes(fixture.siblingAppointmentId));
      assert.ok(!JSON.stringify(schedule).includes(fixture.foreignAppointmentId));
      assert.ok(!JSON.stringify(schedule).includes(fixture.appointmentId));
      await json(await page.request.get(`${baseUrl}/api/notification-prefs`, { headers }));
      await json(await page.request.put(`${baseUrl}/api/notification-prefs`, { headers,
        data: { serviceReminder24h: false, customerId: fixture.foreignCustomerId } }));
      await json(await page.request.put(`${baseUrl}/api/property/preferences`, { headers, data: { parkingNotes: 'QA sibling parking' } }));
      const refreshed = await json(await page.request.post(`${baseUrl}/api/auth/refresh`, { data: { refreshToken: customerRefreshToken } }));
      customerToken = refreshed.token;
      customerRefreshToken = refreshed.refreshToken;
      headers = { Authorization: `Bearer ${customerToken}` };
      assert.equal((await json(await page.request.get(`${baseUrl}/api/property/preferences`, { headers }))).preferences.parkingNotes, 'QA sibling parking');
      assert.equal((await db('notification_prefs').where({ customer_id: fixture.siblingCustomerId }).first()).service_reminder_24h, false);
      assert.equal(await db('notification_prefs').where({ customer_id: fixture.foreignCustomerId }).first(), undefined);
      assert.equal(await db('property_preferences').where({ customer_id: fixture.foreignCustomerId }).first(), undefined);
      const primary = await json(await page.request.post(`${baseUrl}/api/auth/select-property`, { headers,
        data: { customerId: fixture.customerId, refreshToken: customerRefreshToken } }));
      customerToken = primary.token;
      customerRefreshToken = primary.refreshToken;
      return { siblingSwitch: true, foreignSwitchStatus: 403, foreignRecordStatuses: [404, 404, 404], refreshedPreferencePersisted: true };
    });
    await step('estimate-acceptance-is-idempotent', async () => {
      const data = { slotId: `${fixture.date}_09-00_${fixture.technicianId}`, paymentMethodPreference: 'pay_at_visit' };
      const attempts = await Promise.all([
        page.request.put(`${baseUrl}/api/estimates/${fixture.token}/accept`, { data }),
        page.request.put(`${baseUrl}/api/estimates/${fixture.token}/accept`, { data }),
      ]);
      assert.ok(attempts.some(response => response.status() === 200), 'One acceptance must succeed');
      for (const response of attempts) {
        // The atomic status update rejects a concurrently stale accept; an
        // ordinary retry after the winner commits must recover its success.
        if (response.status() === 409) {
          assert.equal((await json(response, 409)).error, 'Estimate is no longer active');
        } else await json(response);
      }
      assert.equal((await json(await page.request.put(`${baseUrl}/api/estimates/${fixture.token}/accept`, { data }))).alreadyAccepted, true);
      const rows = await db('scheduled_services').where({ source_estimate_id: fixture.estimateId }).whereNull('reservation_expires_at');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].customer_id, fixture.customerId);
      assert.equal((await db('estimates').where({ id: fixture.estimateId }).first()).status, 'accepted');
      return { estimateId: fixture.estimateId, customerId: fixture.customerId,
        scheduledServiceId: rows[0].id, appointmentCount: rows.length, acceptanceStatuses: attempts.map(response => response.status()) };
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
      return { scheduledServiceId: moved.id, windowStart: moved.window_start, windowEnd: moved.window_end,
        unassignedConflictReported: true, invalidStartStatus: invalid.status() };
    });
    await step('technician-photo-ownership-interruption-retry-and-deduplication', async () => {
      const endpoint = `${baseUrl}/api/tech/services/${fixture.appointmentId}/photos`;
      const headers = { Authorization: `Bearer ${techToken}` };
      const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
      const multipart = { photo: { name: 'qa-fail-once.png', mimeType: 'image/png', buffer }, photoType: 'before', caption: 'QA exterior photo' };
      await json(await page.request.post(endpoint, { headers, multipart: { photoType: 'before' } }), 400);
      await json(await page.request.post(endpoint, { headers, multipart: { photo: { name: 'qa-oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(15 * 1024 * 1024 + 1) } } }), 413);
      await json(await page.request.get(endpoint, { headers: { Authorization: `Bearer ${otherTechToken}` } }), 403);
      await json(await page.request.post(endpoint, { headers: { Authorization: `Bearer ${otherTechToken}` }, multipart }), 403);
      await json(await page.request.get(`${baseUrl}/api/admin/dispatch/${fixture.foreignAppointmentId}/completion-status`, { headers }), 403);
      await json(await page.request.post(endpoint, { headers, multipart }), 500);
      assert.equal((await db('scheduled_service_photo_staging').where({ scheduled_service_id: fixture.appointmentId })).length, 0);
      const uploads = await Promise.all([page.request.post(endpoint, { headers, multipart }), page.request.post(endpoint, { headers, multipart })]);
      const uploaded = await Promise.all(uploads.map(response => json(response)));
      assert.equal(uploaded[0].photo.id, uploaded[1].photo.id);
      const rows = await db('scheduled_service_photo_staging').where({ scheduled_service_id: fixture.appointmentId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].technician_id, fixture.technicianId);
      const object = path.join(objectDir, crypto.createHash('sha256').update(rows[0].s3_key).digest('hex'));
      assert.deepEqual(fs.readFileSync(object), buffer);
      const reopened = await json(await page.request.get(endpoint, { headers }));
      assert.equal(reopened.photos.length, 1);
      assert.equal(reopened.photos[0].id, rows[0].id);
      await json(await page.request.post(endpoint, { headers, multipart: { ...multipart, photoType: 'invalid' } }), 400);
      // Exercise the existing field UI against the same stored photo.
      await db('scheduled_services').where({ id: fixture.appointmentId }).update({ scheduled_date: etDateString() });
      await page.evaluate(token => localStorage.setItem('waves_admin_token', token), techToken);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${baseUrl}/tech`);
      await page.getByRole('button', { name: /QA Customer/ }).click();
      await page.getByRole('button', { name: /Photos/ }).click();
      await page.getByRole('heading', { name: 'Service Photos', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Attached (1)', exact: true }).waitFor();
      await page.locator('input[type=file]:not([multiple])').setInputFiles({ name: 'qa-ui-retry.png', mimeType: 'image/png', buffer });
      await page.getByText('Photo saved — it will attach when the visit is completed', { exact: true }).waitFor();
      await page.waitForFunction(() => [...document.images].some(img => img.alt === 'QA exterior photo' && img.naturalWidth > 0));
      await waitForFonts(page);
      await page.screenshot({ path: path.join(artifactDir, 'tech-photos-mobile.png'), fullPage: false });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: path.join(artifactDir, 'tech-photos-desktop.png'), fullPage: false });
      await page.getByRole('dialog', { name: 'Service Photos', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
      await page.reload();
      await page.getByRole('button', { name: /QA Customer/ }).click();
      await page.getByRole('button', { name: /Photos/ }).click();
      await page.getByRole('heading', { name: 'Attached (1)', exact: true }).waitFor();
      await db('scheduled_services').where({ id: fixture.appointmentId }).update({ scheduled_date: fixture.nextDate });
      return { unauthorizedStatuses: [403, 403, 403], interruptedUploadStatus: 500, persistedAfterFailure: 0,
        retryStatuses: uploads.map(response => response.status()), stagedCount: rows.length, storedBytesMatch: true, browserUploadAndReload: true, reopenCount: reopened.photos.length };
    });
    await step('completion-and-report-redaction', async () => {
      const premature = await json(await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, {
        headers: { Authorization: `Bearer ${adminToken}` }, data: {},
      }), 409);
      assert.equal(premature.code, 'future_scheduled_date');
      // Arrange a due-today synthetic visit after proving future visits
      // cannot complete. The production day-of guard remains active.
      await db('scheduled_services').where({ id: fixture.appointmentId }).update({ scheduled_date: etDateString(new Date()) });
      const completionRequest = {
        headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': fixture.runId },
        data: { technicianNotes: 'QA-PRIVATE-TECH-NOTE-DO-NOT-PUBLISH', customerRecap: 'Service completed.',
          products: [{ productId: fixture.productId, totalAmount: 1, amountUnit: 'fl_oz', rateUnit: 'fl_oz', areaValue: 100, areaUnit: 'linear_ft', applicationArea: 'Exterior' }], sendCompletionSms: false, requestReview: false, offerInspectionCredit: false,
          timeOnSite: 30, areasServiced: ['Exterior'], protocolActionsCompleted: [] },
      };
      const missingArea = await json(await page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, {
        ...completionRequest, headers: { ...completionRequest.headers, 'Idempotency-Key': `${fixture.runId}-missing-area` },
        data: { ...completionRequest.data, products: [{ ...completionRequest.data.products[0], areaValue: null, areaUnit: null }] },
      }), 400);
      assert.equal(missingArea.code, 'linear_ft_required');
      assert.equal((await db('service_records').where({ scheduled_service_id: fixture.appointmentId })).length, 0);
      assert.equal(Number((await db('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand), 10);
      const completions = await Promise.all([
        page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, completionRequest),
        page.request.post(`${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`, completionRequest),
      ]);
      assert.ok(completions.some(response => response.status() === 200), JSON.stringify(await Promise.all(completions.map(async response => ({ status: response.status(), body: await response.json() })))));
      for (const response of completions) {
        if (response.status() === 409) assert.equal((await json(response, 409)).code, 'completion_pending');
        else await json(response);
      }
      const visit = await db('scheduled_services').where({ id: fixture.appointmentId }).first();
      assert.equal(visit.status, 'completed');
      const record = await db('service_records').where({ scheduled_service_id: fixture.appointmentId }).first();
      assert.ok(record?.report_view_token);
      const applied = await db('service_products').where({ service_record_id: record.id });
      assert.equal(applied.length, 1);
      assert.equal(applied[0].product_id, fixture.productId);
      assert.equal(Number(applied[0].total_amount), 1);
      const movements = await db('product_inventory_movements').where({ service_record_id: record.id, product_id: fixture.productId });
      assert.equal(movements.length, 1);
      assert.equal(Number(movements[0].stock_before), 10);
      assert.equal(Number(movements[0].stock_after), 9);
      assert.equal(Number(movements[0].cost_used), 5);
      assert.equal(Number((await db('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand), 9);
      const photos = await db('service_photos').where({ service_record_id: record.id });
      assert.equal(photos.length, 1, 'Staged photo must promote exactly once on completion');
      assert.equal((await db('scheduled_service_photo_staging').where({ scheduled_service_id: fixture.appointmentId })).length, 0);
      assert.ok(photos[0].image_sha256);
      assert.ok(photos[0].hash_sha256);
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
      return { scheduledServiceId: visit.id, serviceRecordId: record.id, status: visit.status,
        publicReportStatus: reportResponse.status(), privateNoteExcluded: true, concurrentCompletionStatuses: completions.map(response => response.status()), materialRows: applied.length, inventoryMovements: movements.length, stockAfter: 9, materialCost: 5 };
    });
    await step('completion-replay-and-new-key-refusal', async () => {
      const endpoint = `${baseUrl}/api/admin/dispatch/${fixture.appointmentId}/complete`;
      const data = { technicianNotes: 'QA-PRIVATE-TECH-NOTE-DO-NOT-PUBLISH', customerRecap: 'Service completed.',
        products: [{ productId: fixture.productId, totalAmount: 1, amountUnit: 'fl_oz', rateUnit: 'fl_oz', areaValue: 100, areaUnit: 'linear_ft', applicationArea: 'Exterior' }], sendCompletionSms: false, requestReview: false, offerInspectionCredit: false,
        timeOnSite: 30, areasServiced: ['Exterior'], protocolActionsCompleted: [] };
      const replay = await json(await page.request.post(endpoint, { headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': fixture.runId }, data }));
      assert.equal(replay.replayed, true);
      const refused = await json(await page.request.post(endpoint, { headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': crypto.randomUUID() }, data }), 409);
      assert.equal(refused.code, 'service_already_completed');
      assert.equal((await db('product_inventory_movements').where({ product_id: fixture.productId })).length, 1);
      assert.equal(Number((await db('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand), 9);
      assert.equal((await db('service_records').where({ scheduled_service_id: fixture.appointmentId })).length, 1);
      assert.equal((await db('invoices').where({ scheduled_service_id: fixture.appointmentId })).length, 1);
      return { replayed: true, newKeyStatus: 409, serviceRecordCount: 1, invoiceCount: 1 };
    });
    await step('completed-photo-concurrent-retry', async () => {
      const endpoint = `${baseUrl}/api/tech/services/${fixture.appointmentId}/photos`;
      const headers = { Authorization: `Bearer ${techToken}` };
      const buffer = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'), Buffer.from('QA second image')]);
      const multipart = { photo: { name: 'qa-after.png', mimeType: 'image/png', buffer }, photoType: 'after', caption: 'QA after photo' };
      const attempts = await Promise.all([page.request.post(endpoint, { headers, multipart }), page.request.post(endpoint, { headers, multipart })]);
      const results = await Promise.all(attempts.map(response => json(response)));
      assert.equal(results[0].photo.id, results[1].photo.id, 'Concurrent completed-photo retries must return the same photo');
      const record = await db('service_records').where({ scheduled_service_id: fixture.appointmentId }).first();
      const rows = await db('service_photos').where({ service_record_id: record.id });
      assert.equal(rows.length, 2);
      const { validatePhotoChainRows } = require('../../server/services/service-report/photo-chain');
      const chain = validatePhotoChainRows(rows);
      assert.equal(chain.valid, true, JSON.stringify(chain));
      return { statuses: attempts.map(response => response.status()), photoCount: rows.length, chainValid: true };
    });
    await step('completion-invoice-lineage', async () => {
      const invoices = await db('invoices').where({ scheduled_service_id: fixture.appointmentId });
      assert.equal(invoices.length, 1, 'Completion must create exactly one linked invoice');
      const invoice = invoices[0];
      assert.equal(invoice.customer_id, fixture.customerId);
      assert.equal(Number(invoice.total), 99);
      assert.notEqual(invoice.status, 'paid');
      // Capture the real completion-generated identity for webhook and cleanup.
      fixture.invoiceId = invoice.id;
      fixture.invoiceToken = invoice.token;
      fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
      await db('invoices').where({ id: invoice.id }).update({ stripe_payment_intent_id: fixture.paymentIntentId });
      return { invoiceId: invoice.id, customerId: invoice.customer_id, scheduledServiceId: invoice.scheduled_service_id,
        invoiceCount: invoices.length, total: Number(invoice.total), status: invoice.status };
    });
    await step('payment-webhook-settles-once', async () => {
      const event = { id: fixture.eventId, type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000),
        data: { object: { id: fixture.paymentIntentId, status: 'succeeded', amount: 9900, amount_received: 9900,
          currency: 'usd', payment_method_types: ['us_bank_account'], latest_charge: `ch_${fixture.paymentIntentId}`,
          metadata: { invoice_id: fixture.invoiceId, customer_id: fixture.customerId } } } };
      const payload = JSON.stringify(event);
      const signature = require('stripe').webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      const request = { headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, data: payload };
      const deliveries = await Promise.all([
        page.request.post(`${baseUrl}/api/stripe/webhook`, request),
        page.request.post(`${baseUrl}/api/stripe/webhook`, request),
      ]);
      assert.ok(deliveries.some(response => response.status() === 200), 'One delivery must finish processing');
      for (const response of deliveries) {
        // An overlapping duplicate is deliberately retriable while the winner
        // owns the claim. Only that documented 503 is acceptable here.
        if (response.status() === 503) {
          assert.equal((await json(response, 503)).error, 'Event in-flight, retry');
        } else await json(response);
      }
      // Repeat after both in-flight deliveries settle as well.
      assert.equal((await json(await page.request.post(`${baseUrl}/api/stripe/webhook`, request))).duplicate, true);
      assert.equal((await db('stripe_webhook_events').where({ id: fixture.eventId }).first()).processed, true);
      assert.equal((await db('invoices').where({ id: fixture.invoiceId }).first()).status, 'paid');
      const payments = await db('payments').where({ stripe_payment_intent_id: fixture.paymentIntentId });
      assert.equal(payments.length, 1);
      assert.equal(Number(payments[0].amount), 99);
      assert.equal(payments[0].customer_id, fixture.customerId);
      assert.equal((await db('receipt_delivery_jobs').where({ invoice_id: fixture.invoiceId })).length, 1);
      await page.goto(`${baseUrl}/receipt/${fixture.invoiceToken}`);
      await page.getByText('$99.00', { exact: false }).first().waitFor();
      await waitForFonts(page);
      await page.screenshot({ path: path.join(artifactDir, 'receipt.png'), fullPage: true });
      return { invoiceId: fixture.invoiceId, customerId: payments[0].customer_id,
        paymentIntentId: fixture.paymentIntentId, paymentCount: payments.length, amount: Number(payments[0].amount),
        concurrentStatuses: deliveries.map(response => response.status()), processed: true, receiptJobs: 1 };
    });

    await step('prepayment-and-series-cancellation-race', async () => {
      const id = fixture.foreignAppointmentId;
      const headers = { Authorization: `Bearer ${adminToken}` };
      await db('scheduled_services').where({ id }).update({ is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true, estimated_price: 95 });
      const responses = await Promise.all([
        page.request.post(`${baseUrl}/api/admin/schedule/${id}/prepaid`, { headers, data: { amount: 95, method: 'cash' } }),
        page.request.put(`${baseUrl}/api/admin/dispatch/${id}/status`, { headers, data: { status: 'cancelled', scope: 'series', notifyCustomer: false } }),
      ]);
      assert.deepEqual(responses.map(response => response.status()).sort(), [200, 409]);
      const row = await db('scheduled_services').where({ id }).first();
      if (responses[0].status() === 200) {
        assert.equal((await json(responses[1], 409)).code, 'BILLING_COVERED_VISIT');
        assert.notEqual(row.status, 'cancelled');
        assert.equal(Number(row.prepaid_amount), 95);
      } else {
        assert.equal((await json(responses[0], 409)).code, 'visit_terminal');
        assert.equal(row.status, 'cancelled');
        assert.equal(Number(row.prepaid_amount || 0), 0);
      }
      return { concurrentStatuses: responses.map(response => response.status()), finalStatus: row.status,
        prepaidAmount: Number(row.prepaid_amount || 0), contradictoryStatePrevented: true };
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
