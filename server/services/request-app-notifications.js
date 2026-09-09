const db = require('../models/db');
const { gateEnvValue } = require('../config/feature-gates');
const { CTA_REQUEST_SOURCES } = require('./cta-service-request');

// Shared by the immediate sender, deferred replay and final App boundary.
// Internal requests and cancelled-account flows must never gain a portal CTA.
async function loadEligibleRequest(customerId, requestId, updatedAt) {
  const request = await db('service_requests').where({ id: requestId, customer_id: customerId }).first();
  if (!request || request.source === 'admin' || CTA_REQUEST_SOURCES.includes(request.source)
    || ['cancellation', 'measurement_review'].includes(request.category)) return null;
  if (!updatedAt || new Date(request.updated_at).getTime() !== new Date(updatedAt).getTime()) return null;
  const customer = await db('customers').where({ id: customerId }).first('active', 'deleted_at');
  return customer?.active && !customer.deleted_at ? request : null;
}

async function send({ customerId, request, received = false }) {
  if (!gateEnvValue('GATE_CUSTOMER_APP_NOTIFICATIONS') || !request?.id) return;
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first('request_channel');
  if (prefs?.request_channel !== 'push') return;
  if (!(await loadEligibleRequest(customerId, request.id, request.updated_at))) return;
  const customer = await db('customers').where({ id: customerId }).first('phone');
  if (!customer?.phone) return;
  const type = received ? 'service_request_received' : 'service_request_updated';
  const body = received ? 'We received your service request. Open the app to view it.'
    : 'There is an update to your service request. Open the app to view its status.';
  const metadata = {
    original_message_type: type, appOnly: true, customer_initiated: received,
    service_request_id: request.id, request_updated_at: new Date(request.updated_at).toISOString(),
    notificationEventKey: `request:${request.id}:${type}:${new Date(request.updated_at).toISOString()}`,
  };
  const result = await require('./messaging/send-customer-message').sendCustomerMessage({
    to: customer.phone, body, channel: 'sms', audience: 'customer', purpose: 'support_resolution',
    customerId, identityTrustLevel: 'phone_matches_customer', customerInitiated: received,
    entryPoint: received ? 'customer_service_request' : 'service_request_status_update', metadata,
  });
  if (result.deferred && result.nextAllowedAt) {
    await db('sms_log').insert({
      customer_id: customerId, to_phone: customer.phone, from_phone: require('../config/twilio-numbers').getOutboundNumber(),
      direction: 'outbound', message_body: body, message_type: type,
      status: 'scheduled', scheduled_for: result.nextAllowedAt,
      metadata: JSON.stringify({ ...metadata, entry_point: 'request_app_deferred',
        replay_purpose: 'support_resolution', customer_id: customerId,
        refresh_customer_phone: true, resolve_from_by_customer: true }),
    });
  }
}

module.exports = { loadEligibleRequest, send };
