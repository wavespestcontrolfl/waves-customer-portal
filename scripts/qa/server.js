'use strict';
// QA-only process entry point; never imported by the production server.
const fs = require('node:fs');
if (process.env.WAVES_LOCAL_DEV !== '1' || process.env.RAILWAY_DEPLOYMENT_ID || !process.env.QA_FIXTURE_FILE) {
  throw new Error('QA server requires the managed local environment and a synthetic fixture file.');
}
if (new URL(process.env.DATABASE_URL).pathname !== `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`) {
  throw new Error('QA server requires the worktree-owned database.');
}
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
Twilio.sendSMS = async () => { capture('sms', {}); return { success: true, sid: 'SM_qa_fixture', status: 'queued' }; };
const messaging = require('../../server/services/messaging/send-customer-message');
messaging.sendCustomerMessage = async () => { capture('customer-message', {}); return { sent: true, channel: 'qa' }; };

// Real Stripe signature verification and application settlement code; only
// external charge metadata lookup is simulated. No charge creation is enabled.
const Stripe = require('stripe');
Stripe.resources.Charges.prototype.retrieve = async (id) => {
  if (id !== `ch_${fixture.paymentIntentId}`) throw new Error('Unknown QA charge');
  return { id, payment_method_details: { type: 'us_bank_account', us_bank_account: { last4: '6789' } } };
};
require('../../server/index');
