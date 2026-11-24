#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { readContext, childEnvironment } = require('../dev/context');
const { doctor } = require('../dev/doctor');
const { launchBrowser, evidence, waitForFonts } = require('./browser');
const { fixtureIdentity, seed, cleanup } = require('./fixtures');

// Journeys run in this order and share state through one context object (see ctx in main).
const journeys = [
  require('./journeys/staff-login-and-role-isolation'),
  require('./journeys/customer-otp-login-and-permissions'),
  require('./journeys/communications-policy-delivery-and-read-boundary'),
  require('./journeys/account-property-switch-and-record-isolation'),
  require('./journeys/estimate-acceptance-is-idempotent'),
  require('./journeys/reschedule-detects-unassigned-conflict-and-preserves-duration'),
  require('./journeys/technician-photo-ownership-interruption-retry-and-deduplication'),
  require('./journeys/completion-and-report-redaction'),
  require('./journeys/completion-replay-and-new-key-refusal'),
  require('./journeys/completed-photo-concurrent-retry'),
  require('./journeys/completion-invoice-lineage'),
  require('./journeys/payment-webhook-settles-once'),
  require('./journeys/saved-card-charge-matches-shown-total'),
  require('./journeys/prepayment-and-series-cancellation-race'),
];

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
      // The 8 AM-8 PM ET text window stays off, so a run at any hour sends receipts at once (journeys wait seconds).
      GATE_TWILIO_SMS: 'true', GATE_SMS_SEND_WINDOW: 'false', TWILIO_SIGNATURE_VALIDATION: 'enforce',
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
    const ctx = { page, db, fixture, baseUrl, json, artifactDir, captureFile, fixtureFile, objectDir, webhookSecret, waitForFonts };
    for (const journey of journeys) await step(journey.name, () => journey.run(ctx));

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
