/** Current-request entity resolution. History/attachments never select a write
 * target. Page IDs are hints re-read from the DB; explicit current names win.
 */
const db = require('../../models/db');
const { UUID_RE } = require('./tasks');
const { normalizeEmail } = require('../../utils/contact-normalize');

const CUSTOMER_FIELDS = ['id', 'first_name', 'last_name', 'address_line1', 'city', 'phone', 'updated_at', 'deleted_at'];
const RECORDS = {
  customer_id: { table: 'customers', fields: CUSTOMER_FIELDS },
  property_id: { table: 'customer_properties', fields: ['id', 'customer_id', 'address_line1', 'label', 'active', 'updated_at'] },
  appointment_id: { table: 'scheduled_services', fields: ['id', 'customer_id', 'property_id', 'service_address_line1', 'updated_at'] },
  estimate_id: { table: 'estimates', fields: ['id', 'customer_id', 'customer_name', 'property_id', 'updated_at'] },
  invoice_id: { table: 'invoices', fields: ['id', 'customer_id', 'updated_at'] },
  product_id: { table: 'products_catalog', fields: ['id', 'name', 'updated_at'] },
  lead_id: { table: 'leads', fields: ['id', 'customer_id', 'first_name', 'last_name', 'updated_at', 'deleted_at'] },
  email_id: { table: 'emails', fields: ['id', 'customer_id', 'lead_id', 'from_address', 'updated_at'] },
};
const COLLECTIONS = { customer_id: 'customer_ids', appointment_id: 'service_ids', lead_id: 'lead_ids' };
const ALIASES = { customer_id: 'customerId', property_id: 'propertyId', appointment_id: 'appointmentId', estimate_id: 'estimateId', invoice_id: 'invoiceId', product_id: 'productId', lead_id: 'leadId', email_id: 'emailId' };
const normalizeName = value => String(value || '').toLowerCase().replace(/[’']/g, "'").replace(/'s\b/g, '')
  .replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
const PERSON_REFERENCE = /\b(?:for|customer|named|change|update|email|text|message|contact|quote|send|notify|schedule)\s+([\p{L}'-]+)\b/gu;
const AFTER_GIVEN_NAME = new Set(['the', 'a', 'an', 'this', 'that', 'their', 'his', 'her', 'to', 'with', 'at', 'on', 'and',
  'needs', 'wants', 'has', 'is', 'should', 'would', 'asked', 'address', 'phone', 'email', 'notes', 'note', 'label', 'labels',
  'property', 'properties', 'appointment', 'appointments', 'estimate', 'invoice', 'details', 'inactive', 'active']);

function targetClause(prompt) {
  // Message bodies and replacement values are data, even when they contain
  // another customer's exact name. They never select the recipient/account.
  return String(prompt).split(/[:;\n]|\b(?:that|saying|regarding|about)\b|\b(?:name|address|email|phone|label|notes?|instructions|message|contact)\s+(?:to|as|is|=)\s+/i)[0];
}

function explicitFirstNames(prompt) {
  const clause = targetClause(prompt);
  const normalized = normalizeName(clause);
  return [...new Set([
    ...[...normalized.matchAll(PERSON_REFERENCE)]
      .filter(m => !m[0].startsWith('customer ') || !/\b(?:this|that|current|selected|viewed|open)\s+$/.test(normalized.slice(0, m.index)))
      .map(m => m[1]),
    ...[...clause.matchAll(/\b([\p{L}-]+)[’']s\b/giu)].map(m => normalizeName(m[1])),
    ...(normalized.match(/^([\p{L}'-]+)\s+(?:needs|wants|has|is|should|would|asked)\b/u)?.slice(1, 2) || []),
  ])];
}

function namesRequested(prompt) {
  // This is a refusal hint, never a fuzzy identity match. A misspelling after
  // an explicit person reference must not fall back to the open customer.
  const references = explicitFirstNames(prompt);
  const nonNames = new Set(['this', 'that', 'the', 'a', 'an', 'his', 'her', 'their', 'my', 'our', 'each', 'all', 'both', 'next', 'today', 'tomorrow', 'me', 'him', 'them', 'it', 'lawn', 'pest', 'mosquito', 'termite', 'rodent', 'name', 'address', 'phone', 'email', 'notes', 'note', 'labels', 'label', 'customer', 'customers', 'stock', 'inventory', 'quantity', 'active', 'inactive', 'to', 'as', 'from', 'with', 'and', 'or', 'by', 'using']);
  return references.some(word => !nonNames.has(word));
}

function pageIds(pageData = {}) {
  const query = new URLSearchParams(typeof pageData.search === 'string' ? pageData.search.slice(0, 2000) : '');
  const ids = {};
  for (const [key, alias] of Object.entries(ALIASES)) {
    const id = pageData[key] || pageData[alias] || query.get(alias) || query.get(key);
    if (id !== undefined && id !== null && id !== '') {
      if (!UUID_RE.test(String(id))) return { error: 'The viewed record identifier is invalid', code: 'invalid_page_context' };
      ids[key] = String(id);
    }
  }
  return ids;
}

async function customerById(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return db('customers').where({ id }).whereNull('deleted_at')
    .first(CUSTOMER_FIELDS);
}

function customerTarget(customer, provenance) {
  return { customer_id: customer.id, label: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    address: customer.address_line1 || null, city: customer.city || null, version: customer.updated_at || null,
    provenance, href: `/admin/customers?customerId=${encodeURIComponent(customer.id)}` };
}

function namesTargetCustomer(clause, customer) {
  const name = normalizeName([customer.first_name, customer.last_name].filter(Boolean).join(' '));
  const offset = ` ${clause} `.indexOf(` ${name} `);
  if (offset < 0) return false;
  const before = clause.slice(0, offset).trim();
  if (!before || before === 'please') return true;
  return /\b(?:for|customer|named|change|update|email|text|message|quote|notify|schedule|send to)(?:\s+both)?$/.test(before)
    || (/\bboth\b/.test(clause) && /\band$/.test(before));
}

async function namedCustomers(prompt) {
  const normalized = normalizeName(targetClause(prompt));
  const words = normalized.split(' ').slice(0, 300);
  const phrases = [];
  for (let length = 2; length <= 5; length++) {
    for (let start = 0; start + length <= words.length; start++) phrases.push(words.slice(start, start + length).join(' '));
  }
  // A first-name-only request must be explicit and an EXACT unique match,
  // never the first fuzzy result or a name mentioned by an old assistant turn.
  const firstNames = explicitFirstNames(prompt).filter(name => words.some((word, i) => word === name
    && (!words[i + 1] || AFTER_GIVEN_NAME.has(words[i + 1]))));
  if (!phrases.length && !firstNames.length) return [];
  const columns = ['id', 'first_name', 'last_name', 'address_line1', 'city', 'updated_at'];
  const matches = phrases.length ? await db('customers').whereNull('deleted_at')
    .whereIn(db.raw("lower(concat_ws(' ', first_name, last_name))"), phrases).limit(10).select(columns) : [];
  const fullNames = matches.filter(customer => namesTargetCustomer(normalized, customer));
  if (fullNames.length || !firstNames.length) return fullNames;
  return db('customers').whereNull('deleted_at').whereIn(db.raw('lower(first_name)'), firstNames).limit(10).select(columns);
}

// Shared whitelist reader for page context and mutation relationships. It
// accepts record IDs only; callers cannot choose a table or query expression.
async function readReferences(input) {
  const references = Object.entries(RECORDS).flatMap(([kind, definition]) => {
    const values = [input[kind], input[ALIASES[kind]], input[COLLECTIONS[kind]]].flat().filter(Boolean);
    return [...new Set(values)].map(id => ({ kind, id, definition }));
  });
  if (references.some(r => !UUID_RE.test(String(r.id)))) return { error: 'A valid record identifier is required', code: 'invalid_target' };
  const records = await Promise.all(references.map(async ({ kind, id, definition }) => {
    const row = await db(definition.table).where('id', id).first(definition.fields);
    return row && { ...row, kind };
  }));
  if (records.some(r => !r || r.active === false || r.deleted_at)) return { error: 'A referenced record is unavailable', code: 'record_unavailable' };
  return { records };
}

function customerIds(records) {
  return [...new Set(records.map(r => r.kind === 'customer_id' ? r.id : r.customer_id).filter(Boolean))];
}

async function loadPage(pageData) {
  const ids = pageIds(pageData);
  if (ids.error) return ids;
  const resolved = await readReferences(ids);
  if (resolved.error) return resolved;
  const customers = customerIds(resolved.records);
  if (customers.length > 1) return { error: 'The viewed records belong to different customers', code: 'context_mismatch' };
  const page = { ids, records: Object.fromEntries(resolved.records.map(r => [r.kind, r])) };
  if (!customers.length) return page;
  const customer = await customerById(customers[0]);
  if (!customer) return { error: 'The viewed customer is unavailable', code: 'record_unavailable' };
  page.customer = customerTarget(customer, 'viewed_record');
  return page;
}

function candidateSelection(candidates, prompt, viewedCustomer) {
  const labels = candidates.map(c => normalizeName(c.label));
  const namedSet = candidates.length > 1 && new Set(labels).size === candidates.length
    && /\b(?:both|these customers|all of these)\b/i.test(prompt)
    && labels.every(label => normalizeName(prompt).includes(label));
  if (namedSet) return { target: null, targets: candidates, ambiguous: false };
  if (candidates.length === 1) return { target: candidates[0], targets: candidates, ambiguous: false };
  if (candidates.length > 1) return { target: null, targets: [], ambiguous: true };
  const pageReference = /\b(?:(?:this|that|current|selected|viewed|open)\s+(?:customer|account|property|appointment|estimate|invoice)|his|her|their)\b/i.test(prompt);
  const target = !namesRequested(prompt) && pageReference ? viewedCustomer : null;
  return { target: target || null, targets: target ? [target] : [], ambiguous: false };
}

async function resolve({ prompt, pageData, selectedTarget }) {
  const page = await loadPage(pageData);
  if (page.error) return page;
  const named = await namedCustomers(prompt);
  const candidates = named.map(c => customerTarget(c, 'current_request_lookup'));
  let selection = candidateSelection(candidates, prompt, page.customer);
  if (selectedTarget?.customer_id) {
    const selected = await customerById(selectedTarget.customer_id);
    if (!selected || (named.length && !named.some(c => c.id === selected.id))) {
      return { error: 'The selected customer conflicts with the current request', code: 'context_mismatch' };
    }
    const target = customerTarget(selected, 'operator_selection');
    selection = { target, targets: [target], ambiguous: false };
  }
  return { page, candidates, ...selection, requestPhrase: normalizeName(prompt),
    explicitEmails: (targetClause(prompt).match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []).map(normalizeEmail),
    explicitPhones: (prompt.match(/\+?[\d() .-]{10,}/g) || []).map(p => p.replace(/\D/g, '').slice(-10)) };
}

function unlinkedRecordIsReferenced(record, context) {
  if (record.customer_id) return true;
  if (!['lead_id', 'email_id', 'estimate_id'].includes(record.kind)) return true;
  if (context.page?.ids?.[record.kind] === record.id) return true;
  if (record.kind === 'email_id') return context.explicitEmails?.includes(normalizeEmail(record.from_address)) || false;
  const name = normalizeName(record.customer_name || [record.first_name, record.last_name].filter(Boolean).join(' '));
  return ['lead_id', 'estimate_id'].includes(record.kind) && name && ` ${context.requestPhrase} `.includes(` ${name} `);
}

function relationshipFailure(records, params, toolName) {
  const intendedCustomer = params.customer_id || params.customerId;
  const intendedProperty = params.property_id || params.propertyId;
  const crossCustomer = records.some(r => r.customer_id && intendedCustomer && r.customer_id !== intendedCustomer);
  const crossProperty = records.some(r => r.property_id && intendedProperty && r.property_id !== intendedProperty
    && !(toolName === 'switch_appointment_property' && r.kind === 'appointment_id'));
  if (crossCustomer || crossProperty) return { error: 'The referenced record belongs to a different customer or service property', code: 'target_relationship_mismatch' };
  return null;
}

async function validateMutationTarget(params, context = {}, { toolName } = {}) {
  const references = { ...params };
  if (params.estimate_identifier) references.estimate_id = params.estimate_identifier;
  const resolved = await readReferences(references);
  if (resolved.error) return resolved;
  const { records } = resolved;
  const relationship = relationshipFailure(records, params, toolName);
  if (relationship) return relationship;
  const permitted = new Set((context.targets || []).map(t => t.customer_id));
  if (toolName === 'send_email_reply') {
    for (const record of records) {
      if (record.kind === 'email_id' && context.explicitEmails?.includes(normalizeEmail(record.from_address))) permitted.add(record.customer_id);
    }
  }
  const missingTarget = customerIds(records).some(id => !permitted.has(id));
  const unlinkedTarget = records.some(r => !unlinkedRecordIsReferenced(r, context));
  if (missingTarget || unlinkedTarget) return {
    error: 'Choose the target for this action; the current request has not established it',
    code: 'target_clarification_required', candidates: context.candidates || [],
  };
  if (toolName === 'send_sms' && params.phone) {
    const phone = String(params.phone).replace(/\D/g, '').slice(-10);
    const customer = records.find(r => r.kind === 'customer_id');
    const matchesCustomer = customer && String(customer.phone || '').replace(/\D/g, '').slice(-10) === phone;
    if (customer && !matchesCustomer) return { error: 'The message recipient does not match the target customer', code: 'target_relationship_mismatch' };
    if (!customer && !context.explicitPhones?.includes(phone)) return { error: 'Select the customer or explicitly provide the recipient number', code: 'target_clarification_required' };
  }
  return null;
}

module.exports = { pageIds, resolve, validateMutationTarget, customerById, customerTarget, namedCustomers, namesRequested };
