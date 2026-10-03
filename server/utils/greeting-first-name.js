'use strict';

/**
 * The first name a customer-facing estimate greeting should use.
 *
 * Estimate rows carry only a composed `customer_name` ("First Last"). A
 * customer can exist with a blank first_name and a populated last_name (the
 * call booker's last-name-only path), and the composed name for that customer
 * is just the surname. Taking the first token of `customer_name` greets them
 * "Hi <Surname>". When the linked customer row is known, its first_name is the
 * authoritative answer: blank first_name means no first name to greet with.
 *
 * Rules (greetingFirstToken):
 *   - No customer row known (unlinked estimate / lookup failed): the first
 *     token of customer_name, exactly as every renderer did before.
 *   - Customer row known, first_name present: the first token of customer_name
 *     (unchanged; an operator-edited estimate name keeps winning).
 *   - Customer row known, first_name blank: '' when the estimate name starts
 *     with the customer's surname (the token IS the surname). If the estimate
 *     name was typed with a different leading word, that word is kept. When
 *     the surname is not on the row, a one-word name is treated as the
 *     surname.
 *
 * Callers apply their own fallback ('there') so surfaces that want null/''
 * keep their shape. greetingFirstName() applies 'there' for the common case.
 */

const FALLBACK = 'there';

function clean(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

function nameTokens(value) {
  return clean(value).split(' ').filter(Boolean);
}

function greetingFirstToken({ customerName, customer } = {}) {
  const tokens = nameTokens(customerName);
  const token = tokens[0] || '';
  if (!customer || typeof customer !== 'object') return token;
  if (clean(customer.first_name)) return token;
  // The customer has no first name on file.
  const surname = clean(customer.last_name).toLowerCase();
  if (!token) return '';
  // Surname unknown (column not selected / blank): a one-word estimate name
  // for a customer with no first name is the surname, not a first name.
  if (!surname) return tokens.length === 1 ? '' : token;
  const leading = tokens.slice(0, nameTokens(surname).length).join(' ').toLowerCase();
  return leading === surname ? '' : token;
}

function greetingFirstName(args) {
  return greetingFirstToken(args) || FALLBACK;
}

// The linked customer's name fields, or null when the estimate is unlinked or
// the lookup fails (callers then keep the legacy customer_name token).
async function loadGreetingCustomer(database, customerId) {
  if (!customerId || !database) return null;
  try {
    const row = await database('customers').where({ id: customerId }).first('first_name', 'last_name');
    return row || null;
  } catch {
    return null;
  }
}

// Estimate-row convenience. Uses a customer row already in hand
// (opts.customer) before querying by estimate.customer_id.
async function estimateGreetingFirstToken(database, estimate, opts = {}) {
  const customer = opts.customer !== undefined
    ? opts.customer
    : await loadGreetingCustomer(database, estimate?.customer_id);
  return greetingFirstToken({ customerName: opts.customerName ?? estimate?.customer_name, customer });
}

async function estimateGreetingFirstName(database, estimate, opts = {}) {
  return (await estimateGreetingFirstToken(database, estimate, opts)) || FALLBACK;
}

// Service-report payloads (report-data.js buildReportV1Data) carry the
// customer's own first name as `customerFirstName` (null when blank) next to
// the composed `customerName`. When the key is present it is authoritative:
// blank means no first name, so the greeting falls back ('there') instead of
// reading the surname off the composed name. A payload without the key (older
// frozen payloads) keeps the first token of customerName, or, when the caller
// has the customer row in hand, the same blank-first-name rule as estimates.
function reportGreetingFirstToken(data, customer) {
  if (data && Object.prototype.hasOwnProperty.call(data, 'customerFirstName')) {
    return nameTokens(data.customerFirstName)[0] || '';
  }
  const row = customer && typeof customer === 'object' && 'first_name' in customer ? customer : null;
  return greetingFirstToken({ customerName: data?.customerName, customer: row });
}

module.exports = {
  FALLBACK,
  greetingFirstToken,
  greetingFirstName,
  reportGreetingFirstToken,
  loadGreetingCustomer,
  estimateGreetingFirstToken,
  estimateGreetingFirstName,
};
