const defaultDb = require('../models/db');
const { etDateString } = require('../utils/datetime-et');

function isPaused(customer, now = new Date()) {
  if (!customer?.autopay_paused_until) return false;
  const pausedUntil = String(
    customer.autopay_paused_until instanceof Date
      ? customer.autopay_paused_until.toISOString()
      : customer.autopay_paused_until
  ).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(pausedUntil) && pausedUntil >= etDateString(now);
}

function isChargeableAutopayMethod(method) {
  return !!method
    && method.processor === 'stripe'
    && method.is_default === true
    && method.autopay_enabled === true
    && !!method.stripe_payment_method_id;
}

async function getChargeableAutopayMethod(customer, knex) {
  if (!customer?.id) return false;

  try {
    return await knex('payment_methods')
      .where({
        customer_id: customer.id,
        processor: 'stripe',
        is_default: true,
        autopay_enabled: true,
      })
      .first('id', 'processor', 'method_type', 'stripe_payment_method_id', 'is_default', 'autopay_enabled');
  } catch {
    return null;
  }
}

async function customerOnAutopay(customer, options = {}) {
  const knex = options.db || defaultDb;
  if (!customer) return false;
  if (customer.autopay_enabled === false) return false;
  if (isPaused(customer, options.now)) return false;

  const paymentMethod = await getChargeableAutopayMethod(customer, knex);
  if (!isChargeableAutopayMethod(paymentMethod)) return false;

  if (customer.ach_status && customer.ach_status !== 'active') {
    return paymentMethod.method_type === 'card';
  }

  return true;
}

module.exports = {
  customerOnAutopay,
  isChargeableAutopayMethod,
  isPaused,
};
