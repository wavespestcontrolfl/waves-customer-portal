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
const { SURCHARGE_API_VERSION } = require('../../server/services/stripe-pricing');
const paymentIntents = new Map();
const byIdempotencyKey = new Map();
const unitCents = (value) => Number.isInteger(value) ? value : Number(value);
// A refund of a QA intent, keyed by idempotency key like Stripe's own layer. Only an intent this fake created can be refunded.
const refundsByIntent = new Map();
const refundsByIdempotencyKey = new Map();
// A new refund waits briefly for a second call with the same key, so a double submission always overlaps the first
// one in flight (a real network round trip leaves that window; a local fake would otherwise close it at once). The
// second call then waits for the first to finish and gets Stripe's idempotent answer.
const refundsInFlight = new Map();
const OVERLAP_WAIT_MS = 1500;
const stable = (value) => (Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value);
const sameParams = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const refundedCents = (intentId) => (refundsByIntent.get(intentId) || []).reduce((sum, refund) => sum + refund.amount, 0);
// A repeated idempotency key returns the first refund, and refuses any changed parameter, as Stripe does.
function replayRefund(key, params) {
  const replay = refundsByIdempotencyKey.get(key);
  if (!replay) throw new Stripe.errors.StripeAPIError({ message: 'The earlier request with this key failed', type: 'api_error' });
  if (!sameParams(replay.params, params)) {
    throw new Stripe.errors.StripeIdempotencyError({ message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.', type: 'idempotency_error' });
  }
  capture('stripe-refund-result', { refundId: replay.refund.id, replayed: true });
  return replay.refund;
}
function createRefund(params, key) {
  const intent = paymentIntents.get(params.payment_intent);
  const remaining = unitCents(intent.amount) - refundedCents(intent.id);
  const requested = params.amount === undefined ? remaining : unitCents(params.amount);
  if (!Number.isInteger(requested) || requested <= 0 || requested > remaining) {
    throw new Stripe.errors.StripeInvalidRequestError({ message: `Refund amount ($${(requested / 100).toFixed(2)}) is greater than unrefunded amount on charge ($${(remaining / 100).toFixed(2)})`, type: 'invalid_request_error' });
  }
  const refund = { id: `re_qa_${crypto.randomBytes(12).toString('hex')}`, object: 'refund', amount: requested, currency: intent.currency,
    charge: intent.latest_charge, payment_intent: intent.id, status: 'succeeded', reason: params.reason || null,
    created: Math.floor(Date.now() / 1000), metadata: { ...params.metadata } };
  refundsByIntent.set(intent.id, [...(refundsByIntent.get(intent.id) || []), refund]);
  if (key) refundsByIdempotencyKey.set(key, { params: JSON.parse(JSON.stringify(params)), refund });
  capture('stripe-refund-result', { refundId: refund.id, replayed: false });
  return refund;
}
const stripeStubs = {
  Refunds: {
    create: async (params, options = {}) => {
      if (!paymentIntents.has(params.payment_intent)) throw new Error('QA fake Stripe only refunds a payment intent it created');
      capture('stripe', { method: 'refunds.create', payment_intent: params.payment_intent, amount: params.amount,
        reason: params.reason, idempotencyKey: options.idempotencyKey });
      const key = options.idempotencyKey;
      const inFlight = key && refundsInFlight.get(key);
      if (inFlight) {
        inFlight.release();
        await inFlight.done.catch(() => {});
        return replayRefund(key, params);
      }
      if (key && refundsByIdempotencyKey.has(key)) return replayRefund(key, params);
      if (!key) return createRefund(params, key);
      let release;
      let finish;
      const entry = { release: () => release?.(), done: new Promise((resolve, reject) => { finish = { resolve, reject }; }) };
      refundsInFlight.set(key, entry);
      try {
        await new Promise((resolve) => { const timer = setTimeout(resolve, OVERLAP_WAIT_MS); release = () => { clearTimeout(timer); resolve(); }; });
        const refund = createRefund(params, key);
        finish.resolve(refund);
        return refund;
      } catch (error) {
        finish.reject(error);
        throw error;
      } finally {
        refundsInFlight.delete(key);
      }
    },
    // The refund history of a QA charge or intent, newest first, as Stripe lists it.
    // Like the SDK, the result is a promise of one page that also offers autoPagingEach / autoPagingToArray.
    list: (params = {}) => {
      capture('stripe', { method: 'refunds.list', charge: params.charge, payment_intent: params.payment_intent });
      const intentId = params.payment_intent || String(params.charge || '').replace(/^ch_/, '');
      if (!paymentIntents.has(intentId)) return Promise.reject(new Error('QA fake Stripe only lists refunds of a payment intent it created'));
      const data = [...(refundsByIntent.get(intentId) || [])].reverse();
      const page = Promise.resolve({ object: 'list', data, has_more: false, url: '/v1/refunds' });
      page.autoPagingToArray = async () => [...data];
      page.autoPagingEach = async (onItem) => { for (const item of data) if (await onItem(item) === false) break; };
      return page;
    },
  },
  Charges: {
    retrieve: async (id) => {
      capture('stripe', { method: 'charges.retrieve', id });
      if (id === `ch_${fixture.paymentIntentId}`) {
        return { id, payment_method_details: { type: 'us_bank_account', us_bank_account: { last4: '6789' } } };
      }
      const intent = paymentIntents.get(String(id).replace(/^ch_/, ''));
      if (!intent) throw new Error('Unknown QA charge');
      const refunded = refundedCents(intent.id);
      return { id, object: 'charge', payment_intent: intent.id, amount: intent.amount, currency: intent.currency, status: 'succeeded',
        amount_refunded: refunded, refunded: refunded >= intent.amount,
        payment_method_details: { type: 'card', card: { brand: fixture.cardBrand, last4: fixture.cardLastFour, funding: 'credit' } } };
    },
  },
  PaymentIntents: {
    // Only the saved-card charge for the synthetic customer: off-session, confirmed at creation.
    create: async (params, options = {}) => {
      if (params.customer !== fixture.stripeCustomerId || params.payment_method !== fixture.stripePaymentMethodId) {
        throw new Error('QA fake Stripe only charges the synthetic saved card');
      }
      // Stripe accepts amount_details.surcharge only on the preview API version; the default client version refuses it.
      if (params.amount_details?.surcharge && options.apiVersion !== SURCHARGE_API_VERSION) {
        throw new Error(`QA fake Stripe: a surcharge needs apiVersion ${SURCHARGE_API_VERSION}, got ${options.apiVersion}`);
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
