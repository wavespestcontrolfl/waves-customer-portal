'use strict';
// QA-only process entry point; never imported by the production server.
const fs = require('node:fs');
if (process.env.WAVES_LOCAL_DEV !== '1' || process.env.RAILWAY_DEPLOYMENT_ID || !process.env.QA_FIXTURE_FILE) {
  throw new Error('QA server requires the managed local environment and a synthetic fixture file.');
}
if (new URL(process.env.DATABASE_URL).pathname !== `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`) {
  throw new Error('QA server requires the worktree-owned database.');
}
// Keep production application behavior while using the verified dev connection.
// This entry point has already rejected deployed and non-worktree databases.
const knexConfig = require('../../server/knexfile');
knexConfig.production.connection = knexConfig.development.connection;

const fixture = JSON.parse(fs.readFileSync(process.env.QA_FIXTURE_FILE, 'utf8'));
const captureFile = process.env.QA_CAPTURE_FILE;
function capture(kind, detail) {
  fs.appendFileSync(captureFile, JSON.stringify({ kind, ...detail, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
// No provider traffic is permitted in this process. PostgreSQL uses its own
// native TCP connection; HTTP integrations must use the fixtures below.
for (const protocol of ['node:http', 'node:https']) {
  const module = require(protocol);
  module.request = () => { throw new Error('QA blocked an unexpected outbound HTTP request'); };
  module.get = module.request;
}
global.fetch = async () => { throw new Error('QA blocked an unexpected outbound fetch'); };

// Replace only object-storage transport; real multipart parsing, ownership,
// hashing, staging, promotion, and database transactions remain in use.
const { S3Client } = require('@aws-sdk/client-s3');
const failedUploads = new Set();
S3Client.prototype.send = async function (command) {
  const { Key: key, Body: body, Bucket: bucket } = command.input;
  if (bucket !== 'waves-qa-fixture' || !/^service-photo(s|s?-staging)\//.test(key)) throw new Error('Unknown QA storage object');
  const objectFile = require('node:path').join(process.env.QA_OBJECT_DIR, require('node:crypto').createHash('sha256').update(key).digest('hex'));
  if (command.constructor.name === 'PutObjectCommand') {
    if (key.endsWith('qa-fail-once.png') && !failedUploads.has('retry')) {
      failedUploads.add('retry');
      capture('storage-failure', {});
      throw new Error('QA simulated upload interruption');
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(objectFile, body, { mode: 0o600 });
    capture('storage-put', { key, bytes: body.length });
    return {};
  }
  if (command.constructor.name === 'DeleteObjectCommand') {
    fs.rmSync(objectFile, { force: true });
    capture('storage-delete', { key });
    return {};
  }
  throw new Error('Unexpected QA storage command');
};

const Twilio = require('../../server/services/twilio');
let verification = null;
Twilio.sendVerificationCode = async (phone) => {
  if (phone !== fixture.phone) throw new Error('Only the synthetic customer may receive QA verification');
  verification = { code: require('node:crypto').randomInt(100000, 1000000).toString(), expires: Date.now() + 60000 };
  capture('verification', { code: verification.code });
  return { success: true, status: 'pending' };
};
Twilio.checkVerificationCode = async (phone, code) => {
  const success = phone === fixture.phone && verification?.code === code && verification.expires > Date.now();
  if (success) verification = null;
  return { success, status: success ? 'approved' : 'pending' };
};
// Intercept the SDK's HTTP transport, preserving the real send policy,
// audit, legacy sms_log and unified-message writers.
const RequestClient = require('twilio/lib/base/RequestClient');
RequestClient.prototype.request = async function (options) {
  const url = new URL(options.uri);
  const payload = options.data;
  if (url.hostname !== 'api.twilio.com' || options.method.toUpperCase() !== 'POST' ||
      !url.pathname.endsWith('/Messages.json') || payload.To !== fixture.phone) {
    throw new Error('QA blocked an unexpected Twilio transport request');
  }
  const sid = `SM${require('node:crypto').randomBytes(16).toString('hex')}`;
  capture('sms', { sid, customerId: fixture.customerId, hasMedia: !!payload.MediaUrl });
  return { statusCode: 201, headers: {}, body: { sid, status: 'queued', to: payload.To,
    from: payload.From, body: payload.Body, num_segments: '1', num_media: '0', error_code: null } };
};

// Real Stripe signature verification and application settlement code; only
// external charge metadata lookup is simulated. No charge creation is enabled.
const Stripe = require('stripe');
Stripe.resources.Charges.prototype.retrieve = async (id) => {
  if (id !== `ch_${fixture.paymentIntentId}`) throw new Error('Unknown QA charge');
  return { id, payment_method_details: { type: 'us_bank_account', us_bank_account: { last4: '6789' } } };
};
require('../../server/index');
