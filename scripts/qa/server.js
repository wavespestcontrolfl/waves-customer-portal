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
  // The body lets a journey prove the words sent. The capture file stays private (mode 0600, never uploaded).
  capture('sms', { sid, customerId: fixture.customerId, to: payload.To, body: payload.Body, hasMedia: !!payload.MediaUrl });
  return { statusCode: 201, headers: {}, body: { sid, status: 'queued', to: payload.To,
    from: payload.From, body: payload.Body, num_segments: '1', num_media: '0', error_code: null } };
};

// Real Stripe signature verification, request building and application settlement code run
// unchanged. Only the SDK methods below are answered here, shaped like Stripe's API objects,
// and each call is written to the private capture file as kind 'stripe'. Every other Stripe
// method throws, as the Twilio transport does, so a new provider call shows up as a failure.
const Stripe = require('stripe');
const crypto = require('node:crypto');
const paymentIntents = new Map();
const byIdempotencyKey = new Map();
const unitCents = (value) => Number.isInteger(value) ? value : Number(value);
const stripeStubs = {
  Charges: {
    retrieve: async (id) => {
      capture('stripe', { method: 'charges.retrieve', id });
      if (id === `ch_${fixture.paymentIntentId}`) {
        return { id, payment_method_details: { type: 'us_bank_account', us_bank_account: { last4: '6789' } } };
      }
      const intent = paymentIntents.get(String(id).replace(/^ch_/, ''));
      if (!intent) throw new Error('Unknown QA charge');
      return { id, object: 'charge', payment_intent: intent.id, amount: intent.amount, currency: intent.currency, status: 'succeeded',
        payment_method_details: { type: 'card', card: { brand: fixture.cardBrand, last4: fixture.cardLastFour, funding: 'credit' } } };
    },
  },
  PaymentIntents: {
    // Only the saved-card charge for the synthetic customer: off-session, confirmed at creation.
    create: async (params, options = {}) => {
      if (params.customer !== fixture.stripeCustomerId || params.payment_method !== fixture.stripePaymentMethodId) {
        throw new Error('QA fake Stripe only charges the synthetic saved card');
      }
      const call = { method: 'paymentIntents.create', amount: params.amount, currency: params.currency, customer: params.customer,
        payment_method: params.payment_method, payment_method_types: params.payment_method_types, off_session: params.off_session,
        confirm: params.confirm, amount_details: params.amount_details, metadata: params.metadata,
        idempotencyKey: options.idempotencyKey, apiVersion: options.apiVersion };
      capture('stripe', call);
      // A repeated idempotency key returns the first object, as Stripe does.
      const replay = byIdempotencyKey.get(options.idempotencyKey);
      if (replay) return replay;
      const id = `pi_qa_${crypto.randomBytes(12).toString('hex')}`;
      const intent = { id, object: 'payment_intent', amount: unitCents(params.amount), amount_received: unitCents(params.amount),
        currency: params.currency, customer: params.customer, payment_method: params.payment_method,
        payment_method_types: params.payment_method_types, status: 'succeeded', latest_charge: `ch_${id}`,
        capture_method: 'automatic', confirmation_method: 'automatic', description: params.description || null,
        livemode: false, created: Math.floor(Date.now() / 1000), metadata: { ...params.metadata },
        ...(params.amount_details ? { amount_details: params.amount_details } : {}) };
      paymentIntents.set(id, intent);
      if (options.idempotencyKey) byIdempotencyKey.set(options.idempotencyKey, intent);
      return intent;
    },
  },
};
(function replaceStripeResources(resources, path = []) {
  for (const [name, resource] of Object.entries(resources)) {
    if (typeof resource === 'function' && resource.prototype) {
      for (const method of Object.getOwnPropertyNames(resource.prototype)) {
        if (method === 'constructor' || typeof resource.prototype[method] !== 'function') continue;
        const stub = stripeStubs[name]?.[method];
        resource.prototype[method] = stub || (async () => { throw new Error(`QA blocked an unexpected Stripe call: ${[...path, name].join('.')}.${method}`); });
      }
    } else if (resource && typeof resource === 'object') replaceStripeResources(resource, [...path, name]);
  }
}(Stripe.resources));
require('../../server/index');
