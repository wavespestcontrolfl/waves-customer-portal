/** Current-request entity resolution. History/attachments never select a write
 * target. Page IDs are hints re-read from the DB; explicit current names win.
 */
const db = require('../../models/db');
const { normalizeEmail } = require('../../utils/contact-normalize');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CUSTOMER_FIELDS = ['id', 'first_name', 'last_name', 'address_line1', 'city', 'phone', 'updated_at', 'deleted_at'];
const RECORDS = {
  customer_id: { table: 'customers', fields: CUSTOMER_FIELDS },
  property_id: { table: 'customer_properties', fields: ['id', 'customer_id', 'address_line1', 'label', 'active', 'updated_at'] },
  appointment_id: { table: 'scheduled_services', fields: ['id', 'customer_id', 'property_id', 'service_address_line1', 'updated_at'] },
  estimate_id: { table: 'estimates', fields: ['id', 'customer_id', 'customer_name', 'property_id', 'updated_at'] },
  invoice_id: { table: 'invoices', fields: ['id', 'customer_id', 'updated_at'] },
  product_id: { table: 'products_catalog', fields: ['id', 'name', 'updated_at'] },
  lead_id: { table: 'leads', fields: ['id', 'customer_id', 'first_name', 'last_name', 'updated_at', 'deleted_at'] },
  email_id: { table: 'emails', fields: ['id', 'customer_id', 'lead_id', 'from_address', 'gmail_thread_id', 'updated_at'] },
  call_id: { table: 'call_log', fields: ['id', 'customer_id', 'updated_at'] },
  review_id: { table: 'google_reviews', fields: ['id', 'customer_id', 'reviewer_name', 'missing_since', 'dismissed', 'updated_at'] },
};
const COLLECTIONS = { customer_id: 'customer_ids', appointment_id: 'service_ids', lead_id: 'lead_ids' };
const ALIASES = { customer_id: 'customerId', property_id: 'propertyId', appointment_id: 'appointmentId', estimate_id: 'estimateId', invoice_id: 'invoiceId', product_id: 'productId', lead_id: 'leadId', email_id: 'emailId', call_id: 'callId', review_id: 'reviewId' };
const normalizeName = value => String(value || '').toLowerCase().replace(/[’']/g, "'").replace(/'s\b/g, '')
  .replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
// Overlapping selectors matter: "update customer Jhon" must still inspect
// "customer Jhon" after seeing "update customer".
const PERSON_ACTIONS = 'reply|respond|send|email|text|sms|message|reminder|contact|notify|quote|schedule|reschedule|move|call|remind|cancel|book|archive|delete|merge|pause|reactivate|restore|refund|charge|invoice|credit|change|update';
const PERSON_SELECTOR_SOURCE = `(?:${PERSON_ACTIONS})(?:\\s+(?:to|for))?|for|customer|named|both|these customers|all of these`;
const PERSON_REFERENCE = new RegExp(`\\b(?=((?:${PERSON_SELECTOR_SOURCE}))\\s+([\\p{L}'-]+)\\b)`, 'gu');
const AFTER_SINGLE_NAME = new Set(['the', 'a', 'an', 'this', 'that', 'their', 'his', 'her', 'to', 'with', 'using', 'at', 'on', 'and',
  'needs', 'wants', 'has', 'is', 'should', 'would', 'asked', 'address', 'phone', 'email', 'notes', 'note', 'label', 'labels',
  'property', 'properties', 'appointment', 'appointments', 'estimate', 'invoice', 'details', 'inactive', 'active', 'reminder', 'reminders']);
const NON_PERSON_NAMES = new Set(['this', 'that', 'current', 'selected', 'viewed', 'open', 'the', 'a', 'an', 'his', 'her', 'their', 'my', 'our', 'each', 'all', 'both', 'next', 'today', 'tomorrow', 'me', 'him', 'them', 'it', 'lawn', 'pest', 'mosquito', 'termite', 'rodent', 'name', 'address', 'phone', 'email', 'notes', 'note', 'labels', 'label', 'customer', 'customers', 'lead', 'leads', 'review', 'reviews', 'stock', 'inventory', 'quantity', 'active', 'inactive', 'to', 'as', 'from', 'with', 'and', 'or', 'by', 'using']);
const PAGE_REFERENCE_RE = /\b(?:(?:this|that|current|selected|viewed|open)\s+(?:customer|account|property|appointment|estimate|invoice|review|email|call|lead)|his|her|their)\b/i;
const CUSTOMER_LOOKUP_LIMIT = 10;

function targetClause(prompt, retainRecordConstraints = false) {
  // Message bodies and replacement values are data, even when they contain
  // another customer's exact name. They never select a recipient/account.
  let clause = String(prompt).split(/[:;\n“”"]|\bwith\s+(?:(?:the|a|this|following)\s+)*(?:text|body|message|content|notes?|instructions|comments)\b|\b(?:notes?|message|instructions|comments)\s+(?:that|mentioning|referencing|containing|with|reading)\b|\b(?:saying|regarding|about)\b/i)[0];
  for (const replacement of clause.matchAll(/\b(?:name|address|email|phone|label|notes?|instructions|message|contact)\s+(?:to|as|is|=)\s+/gi)) {
    const action = [...clause.slice(0, replacement.index).matchAll(new RegExp(`\\b(?:${PERSON_ACTIONS}|change|set|rename|relabel|add|save|draft|write|post|submit)\\b`, 'gi'))].at(-1)?.[0];
    if (/^(?:change|update|set|rename|relabel|add|save)$/i.test(action || '')) {
      clause = clause.slice(0, replacement.index);
      break;
    }
  }
  // A deictic child-record constraint may only narrow already established
  // authority. Retain it in compound requests even when recipient parsing
  // stops at "that"; never use this view to grant customer/review authority.
  if (retainRecordConstraints) return clause;
  // After an explicit communication recipient, the requested message is
  // content: e.g. 'a reminder to call' cannot name a new customer 'call'.
  clause = clause.replace(/^(\s*(?:please\s+)?(?:text|sms|message|email|send|notify|tell)\s+(?:this|that|current|selected|viewed|open)\s+(?:customer|account))\s+(?:a|an|the)\s+(?:reminder|message|text|sms|email)\b.*$/i, '$1');
  const opener = new RegExp(`^(\\s*(?:(?:please|can you|could you|would you|will you)\\s+)*(?:(?:${PERSON_ACTIONS}|set|rename|relabel|add|save)(?:\\s+(?:to|for))?|(?:draft|write|post|submit)\\s+(?:(?:a|the)\\s+)?(?:reply|response)\\s+(?:to|for)|send\\s+(?:a|an)\\s+(?:text|sms|message|reminder|email|reply)\\s+(?:to|for))\\s+)that(?=\\s+(?:customer|account|property|appointment|estimate|invoice|review|email|call|product|lead)\\b)`, 'i');
  return clause.replace(opener, '$1this').split(/\bthat\b/i)[0];
}

function explicitSingleNames(prompt) {
  const clause = targetClause(prompt);
  const normalized = normalizeName(clause);
  return [...new Set([
    ...[...normalized.matchAll(PERSON_REFERENCE)]
      .filter(m => m[1] !== 'customer' || !/\b(?:this|that|current|selected|viewed|open)\s+$/.test(normalized.slice(0, m.index)))
      .map(m => m[2]),
    ...[...clause.matchAll(/\b([\p{L}-]+)[’']s\b/giu)].map(m => normalizeName(m[1])),
    ...(normalized.match(/^([\p{L}'-]+)\s+(?:needs|wants|has|is|should|would|asked)\b/u)?.slice(1, 2) || []),
  ])].filter(word => !NON_PERSON_NAMES.has(word));
}

function namesRequested(prompt) {
  // This is a refusal hint, never a fuzzy identity match. A misspelling after
  // an explicit person reference must not fall back to the open customer.
  const references = explicitSingleNames(prompt);
  return references.length > 0;
}

function pageIds(pageData = {}) {
  const query = new URLSearchParams(typeof pageData.search === 'string' ? pageData.search.slice(0, 2000) : '');
  const ids = {};
  for (const [key, alias] of Object.entries(ALIASES)) {
    const id = pageData[key] || pageData[alias] || query.get(alias) || query.get(key)
      || (key === 'review_id' ? query.get('review') : null);
    if (id !== undefined && id !== null && id !== '') {
      if (!UUID_RE.test(String(id))) return { error: 'The viewed record identifier is invalid', code: 'invalid_page_context' };
      ids[key] = String(id).toLowerCase();
    }
  }
  return ids;
}

async function customerById(id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return db('customers').where({ id }).whereNull('deleted_at')
    .first([...CUSTOMER_FIELDS, db.raw('updated_at::text AS version')]);
}

function customerTarget(customer, provenance) {
  return { customer_id: customer.id, label: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    address: customer.address_line1 || null, city: customer.city || null, version: customer.version || null,
    provenance, href: `/admin/customers?customerId=${encodeURIComponent(customer.id)}` };
}

function namesTargetCustomer(clause, customer) {
  const name = normalizeName(customer.customer_name || [customer.first_name, customer.last_name].filter(Boolean).join(' '));
  if (!name) return false;
  const offset = ` ${clause} `.indexOf(` ${name} `);
  if (offset < 0) return false;
  const before = clause.slice(0, offset).trim();
  if (!before || before === 'please') return true;
  return new RegExp(`\\b(?:${PERSON_SELECTOR_SOURCE})(?:\\s+both)?$`).test(before)
    || /\b(?:both|these customers|all of these)$/.test(before)
    || (/\b(?:both|these customers|all of these)\b/.test(clause) && /\band$/.test(before));
}

async function namedCustomers(prompt) {
  const normalized = normalizeName(targetClause(prompt));
  const words = normalized.split(' ').slice(0, 300);
  const phrases = [];
  for (let length = 2; length <= 5; length++) {
    for (let start = 0; start + length <= words.length; start++) phrases.push(words.slice(start, start + length).join(' '));
  }
  // A single-name request must be explicit and an EXACT unique match,
  // never the first fuzzy result or a name mentioned by an old assistant turn.
  const singleNames = explicitSingleNames(prompt).filter(name => words.some((word, i) => word === name
    && (!words[i + 1] || AFTER_SINGLE_NAME.has(words[i + 1]))));
  if (!phrases.length && !singleNames.length) return { matches: [], complete: true };
  const columns = ['id', 'first_name', 'last_name', 'address_line1', 'city', 'updated_at', db.raw('updated_at::text AS version')];
  const matches = phrases.length ? await db('customers').whereNull('deleted_at')
    .whereIn(normalizedStoredName("concat_ws(' ', first_name, last_name)"), phrases).limit(CUSTOMER_LOOKUP_LIMIT).select(columns) : [];
  const fullNames = matches.filter(customer => namesTargetCustomer(normalized, customer));
  if (fullNames.length || !singleNames.length || matches.length === CUSTOMER_LOOKUP_LIMIT) {
    return { matches: fullNames, complete: matches.length < CUSTOMER_LOOKUP_LIMIT };
  }
  const singles = await db('customers').whereNull('deleted_at').where(function () {
    this.whereIn(normalizedStoredName('first_name'), singleNames).orWhereIn(normalizedStoredName('last_name'), singleNames);
  }).limit(CUSTOMER_LOOKUP_LIMIT).select(columns);
  return { matches: singles, complete: singles.length < CUSTOMER_LOOKUP_LIMIT };
}

// Callers supply only the fixed customer/lead/estimate column expressions below.
// Match the current-request normalizer, including punctuation and whitespace.
function normalizedStoredName(expression) {
  return db.raw(`btrim(regexp_replace(regexp_replace(regexp_replace(replace(lower(coalesce(${expression}, '')), ?, ?), ?, '', 'g'), ?, ' ', 'g'), ?, ' ', 'g'))`,
    ["’", "'", "'s(?![abcdefghijklmnopqrstuvwxyz0123456789_])", "[^[:alnum:][:space:]'-]", '[[:space:]]+']);
}

// Shared whitelist reader for page context and read/write relationships. It
// accepts record IDs only; callers cannot choose a table or query expression.
async function readReferences(input) {
  const references = Object.entries(RECORDS).flatMap(([kind, definition]) => {
    const values = [input[kind], input[ALIASES[kind]], input[COLLECTIONS[kind]]].flat().filter(Boolean);
    return [...new Set(values)].map(id => ({ kind, id, definition }));
  });
  if (references.some(r => !UUID_RE.test(String(r.id)))) return { error: 'A valid record identifier is required', code: 'invalid_target' };
  const groups = new Map();
  for (const reference of references) {
    if (!groups.has(reference.kind)) groups.set(reference.kind, []);
    groups.get(reference.kind).push(reference);
  }
  const batches = await Promise.all([...groups].map(async ([kind, group]) => {
    const { definition } = group[0];
    const fields = kind === 'customer_id' ? [...definition.fields, db.raw('updated_at::text AS version')] : definition.fields;
    const rows = await db(definition.table).whereIn('id', group.map(r => r.id)).select(fields);
    return [kind, new Map(rows.map(row => [String(row.id).toLowerCase(), row]))];
  }));
  const byKind = new Map(batches);
  // Preserve input order and missing-row slots: approval hashes depend on both.
  const records = references.map(({ kind, id }) => {
    const row = byKind.get(kind).get(String(id).toLowerCase());
    return row && { ...row, kind };
  });
  if (records.some(r => !r || r.active === false || r.deleted_at || r.missing_since || r.dismissed || r.reviewer_name === '_stats')) return { error: 'A referenced record is unavailable', code: 'record_unavailable' };
  const linkedEmails = records.filter(record => record.kind === 'email_id' && record.lead_id);
  if (linkedEmails.length) {
    const leads = await db('leads').whereIn('id', [...new Set(linkedEmails.map(record => record.lead_id))]).select('id', 'customer_id', 'deleted_at');
    const byId = new Map(leads.map(lead => [lead.id, lead]));
    for (const email of linkedEmails) {
      const lead = byId.get(email.lead_id);
      if (!lead || lead.deleted_at || (lead.customer_id && email.customer_id && lead.customer_id !== email.customer_id)) {
        return { error: 'The email ownership is unavailable or changed', code: 'record_unavailable' };
      }
      email.customer_id = email.customer_id || lead.customer_id;
    }
  }
  const parentIds = customerIds(records);
  const directParents = byKind.get('customer_id') || new Map();
  const missingParents = parentIds.filter(id => !directParents.has(id));
  const parents = [...directParents.values(), ...(missingParents.length ? await db('customers').whereIn('id', missingParents).whereNull('deleted_at')
    .select([...CUSTOMER_FIELDS, db.raw('updated_at::text AS version')]) : [])];
  if (parents.length !== parentIds.length || parents.some(parent => parent.deleted_at)) {
    return { error: 'A referenced customer is unavailable', code: 'record_unavailable' };
  }
  return { records, parents };
}

function customerIds(records) {
  return [...new Set(records.map(r => r.kind === 'customer_id' ? r.id : r.customer_id).filter(Boolean))];
}

async function loadPage(pageData, prompt) {
  let ids = pageIds(pageData);
  if (ids.error) return ids;
  const referencedKinds = new Set([...targetClause(prompt, true).matchAll(/\b(?:this|that|current|selected|viewed|open)\s+(customer|account|property|appointment|estimate|invoice|review|email|call|product|lead)\b/gi)]
    .map(match => `${match[1].toLowerCase() === 'account' ? 'customer' : match[1].toLowerCase()}_id`));
  // A directly referenced available hint takes precedence over unrelated page
  // hints. With no direct customer hint, retain child-owner lookup as before.
  if (referencedKinds.size && [...referencedKinds].every(kind => ids[kind])) {
    ids = Object.fromEntries(Object.entries(ids).filter(([kind]) => referencedKinds.has(kind)));
  }
  const resolved = await readReferences(ids);
  if (resolved.error) return resolved;
  const customers = customerIds(resolved.records);
  if (customers.length > 1) return { error: 'The viewed records belong to different customers', code: 'context_mismatch' };
  const page = { ids, records: Object.fromEntries(resolved.records.map(r => [r.kind, r])) };
  if (!customers.length) return page;
  const customer = resolved.parents.find(parent => parent.id === customers[0]);
  if (!customer) return { error: 'The viewed customer is unavailable', code: 'record_unavailable' };
  page.customer = customerTarget(customer, 'viewed_record');
  return page;
}

function candidateSelection(candidates, prompt, viewedCustomer, complete) {
  if (!complete) return { target: null, targets: [], ambiguous: true };
  const labels = candidates.map(c => normalizeName(c.label));
  const requestedSet = targetClause(prompt).split(/\b(?:both|these customers|all of these)\s+/i)[1];
  if (requestedSet) {
    const members = requestedSet.split(/\s+and\s+|\s*,\s*/i).filter(Boolean)
      .map(member => normalizeName(member).replace(/^(?:(?:(?:the\s+)?customer|named)\s+)+/, ''));
    const namesMembers = members.some(member => labels.some(label => member === label || member.startsWith(`${label} `)));
    // A valid subset cannot stand in for the complete requested cohort.
    const resolved = members.map((member, index) => labels.filter(label => member === label
      || (index === members.length - 1 && member.startsWith(`${label} `)
        && AFTER_SINGLE_NAME.has(member.slice(label.length + 1).split(' ')[0]))));
    if (namesMembers && (members.length < 2 || resolved.some(matches => matches.length !== 1))) {
      return { target: null, targets: [], ambiguous: true };
    }
  }
  const namedSet = candidates.length > 1 && new Set(labels).size === candidates.length
    && /\b(?:both|these customers|all of these)\b/i.test(prompt)
    && labels.every(label => normalizeName(prompt).includes(label));
  if (namedSet) return { target: null, targets: candidates, ambiguous: false };
  if (candidates.length === 1) return { target: candidates[0], targets: candidates, ambiguous: false };
  if (candidates.length > 1) return { target: null, targets: [], ambiguous: true };
  const pageReference = PAGE_REFERENCE_RE.test(targetClause(prompt));
  const target = !namesRequested(prompt) && pageReference ? viewedCustomer : null;
  return { target: target || null, targets: target ? [target] : [], ambiguous: false };
}

async function resolve({ prompt, pageData, selectedTarget }) {
  const [viewed, namedResult] = await Promise.all([loadPage(pageData, prompt), namedCustomers(prompt)]);
  const named = namedResult.matches;
  // A stale page hint cannot block an unrelated task or an explicitly named
  // customer. A request relying on the unavailable viewed record still stops.
  if (viewed.error && PAGE_REFERENCE_RE.test(targetClause(prompt)) && !named.length && !selectedTarget?.customer_id) return viewed;
  const page = viewed.error ? { ids: {}, records: {} } : viewed;
  const candidates = named.map(c => customerTarget(c, 'current_request_lookup'));
  let selection = candidateSelection(candidates, prompt, page.customer, namedResult.complete);
  if (selectedTarget?.customer_id) {
    const selected = await customerById(selectedTarget.customer_id);
    if (!selected || ((namesRequested(prompt) || named.length || !namedResult.complete) && !named.some(c => c.id === selected.id))
      || (selection.ambiguous && /\b(?:both|these customers|all of these)\b/i.test(targetClause(prompt)))) {
      return { error: 'The selected customer conflicts with the current request', code: 'context_mismatch' };
    }
    const target = customerTarget(selected, 'operator_selection');
    if (selection.targets.length < 2) selection = { target, targets: [target], ambiguous: false };
  }
  // Only the leading recipient expression establishes a raw contact. A later
  // "text <number>" inside a note or an unresolved person's message is data.
  const recipient = targetClause(prompt).match(/^(?:(?:please|can you|could you|would you|will you|i need you to|i'd like you to)\s+)*(?:text|message|sms|email|reply\s+to|respond\s+to|send(?:\s+(?:a|an))?(?:\s+(?:text|sms|message|reminder|email|reply))?\s+to)\s+(?:to\s+)?(.+)/i)?.[1] || '';
  const readRecipient = targetClause(prompt).match(/^(?:(?:please|can you|could you|would you|will you)\s+)*(?:(?:show|read|get|find|look up|check|summarize)\s+(?:(?:the|our)\s+)?(?:customer\s+)?(?:conversation|thread|messages|texts|sms|calls|call history|details|history)\s+(?:with|for|from|to|on)|what\s+(?:did|have)\s+we\s+(?:say|send|said|sent)\s+to(?:\s+(?:the\s+)?customer\s+on)?)\s+(.+)/i)?.[1] || '';
  const reviewClause = targetClause(prompt);
  const explicitReview = reviewClause.match(/\breview\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1];
  const reviewReference = explicitReview || (!namesRequested(prompt)
    && /\b(?:this|that|current|selected|viewed|open)\s+review\b/i.test(reviewClause) ? page.ids.review_id : null);
  const requestedRecords = Object.fromEntries([...targetClause(prompt, true).matchAll(/\b(?:this|that|current|selected|viewed|open)\s+(property|appointment|estimate|invoice|review|email|call|product|lead)\b/gi)]
    .map(match => { const kind = `${match[1].toLowerCase()}_id`; return [kind, page.ids[kind] || null]; }));
  // Explicit current-request child IDs narrow even same-customer operations.
  // Keep all deliberately named records for compound requests; body text never
  // enters this clause and page hints cannot replace the explicit selection.
  const explicitRecords = {};
  // A content noun ends its own action clause. An independently requested
  // operation after "and/then <action>" retains its explicit target IDs.
  const explicitRecordClause = targetClause(prompt, true)
    .split(new RegExp(`\\b(?:and|then)\\s+(?=(?:${PERSON_ACTIONS}|revise|change|set|rename|relabel|add|save|assign|draft|write|post|submit)\\b)`, 'i'))
    .map(clause => clause.split(/\b(?:notes?|messages?|instructions|comments)\b/i)[0]).join(' and ');
  for (const match of explicitRecordClause.matchAll(/\b(property|appointment|estimate|invoice|review|email|call|product|lead)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)) {
    (explicitRecords[`${match[1].toLowerCase()}_id`] ||= []).push(match[2].toLowerCase());
  }
  for (const [kind, ids] of Object.entries(explicitRecords)) {
    requestedRecords[kind] = Object.hasOwn(requestedRecords, kind) ? ids.filter(id => id === requestedRecords[kind]) : ids;
  }
  return { page, candidates, ...selection, requestedRecords, requestPhrase: normalizeName(targetClause(prompt)),
    reviewReference: reviewReference?.toLowerCase() || null,
    bulkLeadRequest: !namesRequested(prompt) && /\b(?:all|bulk)\b.*\bleads\b/i.test(targetClause(prompt)),
    explicitEmails: [...recipient.matchAll(/^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)]
      .map(match => normalizeEmail(match[1])),
    explicitPhones: [...recipient.matchAll(/^((?:\+?1[ .-]*)?(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4})(?!\d)/g)]
      .map(match => match[1].replace(/\D/g, '').slice(-10)),
    explicitReadPhones: [...readRecipient.matchAll(/^((?:\+?1[ .-]*)?(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4})(?!\d)/g)]
      .map(match => match[1].replace(/\D/g, '').slice(-10)) };
}

async function unlinkedRecordIsReferenced(record, context) {
  if (Object.hasOwn(context.requestedRecords || {}, record.kind) && ![context.requestedRecords[record.kind]].flat().includes(record.id)) return false;
  const { targets = [], requestPhrase = '', explicitEmails = [] } = context;
  if (record.kind === 'email_id' && !targets.length && explicitEmails.includes(normalizeEmail(record.from_address))
    && !Object.hasOwn(context.requestedRecords || {}, 'email_id')) {
    const threads = await db('emails').whereRaw('lower(btrim(from_address)) = ?', [normalizeEmail(record.from_address)])
      .distinct(db.raw("coalesce(nullif(gmail_thread_id, ''), id::text) as thread_key")).limit(2);
    return threads.length === 1 && threads[0].thread_key === (record.gmail_thread_id || record.id);
  }
  if (record.customer_id) return true;
  const ids = context.page?.ids || {};
  if (record.kind === 'review_id') return targets.length === 0 && context.reviewReference === record.id;
  if (['call_id', 'appointment_id'].includes(record.kind)) return targets.length === 0 && [context.requestedRecords?.[record.kind]].flat().includes(record.id);
  if (!['lead_id', 'email_id', 'estimate_id'].includes(record.kind)) return true;
  const noun = record.kind.replace(/_id$/, '');
  if (ids[record.kind] === record.id && new RegExp(`\\b(?:this|that|current|selected|viewed|open)\\s+${noun}\\b`).test(requestPhrase)) return true;
  if (record.kind === 'email_id') return explicitEmails.includes(normalizeEmail(record.from_address));
  if (!namesTargetCustomer(requestPhrase, record)) return false;
  const table = record.kind === 'lead_id' ? 'leads' : 'estimates';
  const nameSql = record.kind === 'lead_id' ? "concat_ws(' ', first_name, last_name)" : 'customer_name';
  const fullName = record.customer_name || [record.first_name, record.last_name].filter(Boolean).join(' ');
  // Both expressions are selected from this fixed whitelist. Request data and
  // regex patterns remain bound values. Count linked and unlinked duplicates
  // across statuses; the supplied record ID must never break a name tie.
  const matches = db(table).whereRaw('? = ?', [normalizedStoredName(nameSql), normalizeName(fullName)]);
  if (table === 'leads') matches.whereNull('deleted_at');
  const candidates = await matches.select('id').limit(2);
  return candidates.length === 1 && candidates[0].id === record.id;
}

function relationshipFailure(records, params, toolName) {
  const intendedCustomer = String(params.customer_id || params.customerId || '').toLowerCase();
  const intendedProperty = String(params.property_id || params.propertyId || '').toLowerCase();
  const crossCustomer = records.some(r => r.customer_id && intendedCustomer && r.customer_id !== intendedCustomer);
  const crossProperty = records.some(r => r.property_id && intendedProperty && r.property_id !== intendedProperty
    && !(toolName === 'switch_appointment_property' && r.kind === 'appointment_id'));
  if (crossCustomer || crossProperty) return { error: 'The referenced record belongs to a different customer or service property', code: 'target_relationship_mismatch' };
  return null;
}

function bulkLeadSelection(toolName, records, params) {
  return require('./pending-actions').paramsHash(toolName, {
    records: records.map(record => `${record.kind}:${record.id}`).sort(),
    current_status: params.current_status, older_than_days: params.older_than_days ?? null,
    exactSet: params._expect_full_set === true,
  });
}

async function validateRecordTarget(params, context = {}, { toolName, forApproval = false } = {}) {
  const policy = require('./action-policy.json')[toolName];
  if (policy && policy.kind !== 'read' && [['customer_name', 'customer_id'], ['lead_name', 'lead_id']].some(([name, id]) => params[name] && !params[id])) {
    return { error: 'Resolve the named target to its canonical record identifier before proposing this action', code: 'target_clarification_required' };
  }
  const references = { ...params };
  if (['get_closeout_status', 'get_stop_details'].includes(toolName) && params.service_id) references.appointment_id = params.service_id;
  if (params.estimate_identifier) references.estimate_id = params.estimate_identifier;
  const resolved = await readReferences(references);
  if (resolved.error) return resolved;
  const { records } = resolved;
  const relationship = relationshipFailure(records, params, toolName);
  if (relationship) return relationship;
  // Approval storage keeps exact IDs and fingerprints, never the prompt,
  // candidates, addresses, or raw-contact lookup evidence. The same fresh
  // validation below authorizes this one action before that proof is minted.
  const { _ib_task_context, ...boundParams } = params;
  const hash = require('./pending-actions').paramsHash;
  const actionBinding = hash(toolName, boundParams);
  const recordsBinding = hash('ib-target-records', records);
  const accepted = forApproval ? {
    targets: (context.targets || []).map(({ customer_id }) => ({ customer_id })),
    references: records.map(({ kind, id }) => ({ kind, id })),
    actionBinding, recordsBinding,
  } : null;
  if (context.actionBinding) {
    return context.actionBinding === actionBinding && context.recordsBinding === recordsBinding ? accepted
      : { error: 'The approved action or target records changed. Review a fresh proposal.', code: 'target_changed' };
  }
  if (context.bulkLeadRequest && !context.targets?.length
    && context.bulkLeadSelection === bulkLeadSelection(toolName, records, params)) {
    return accepted; // Server dry-run cohort, scoped only to this approved action.
  }
  const permitted = new Set((context.targets || []).map(t => t.customer_id));
  if (toolName === 'send_email_reply' && !permitted.size) {
    for (const record of records) {
      if (record.kind === 'email_id' && context.explicitEmails?.includes(normalizeEmail(record.from_address))) permitted.add(record.customer_id);
    }
  }
  const missingTarget = customerIds(records).some(id => !permitted.has(id));
  const unlinkedTarget = (await Promise.all(records.map(r => unlinkedRecordIsReferenced(r, context)))).some(allowed => !allowed);
  if (missingTarget || unlinkedTarget) return {
    error: 'Choose the target for this action; the current request has not established it',
    code: 'target_clarification_required', candidates: context.candidates || [],
  };
  if (toolName === 'send_sms' && params.phone) {
    const phone = String(params.phone).replace(/\D/g, '').slice(-10);
    const customer = records.find(r => r.kind === 'customer_id');
    const matchesCustomer = customer && String(customer.phone || '').replace(/\D/g, '').slice(-10) === phone;
    if (customer && !matchesCustomer) return { error: 'The message recipient does not match the target customer', code: 'target_relationship_mismatch' };
    if (!customer && (permitted.size || !context.explicitPhones?.includes(phone))) return { error: 'Select the customer or explicitly provide the recipient number', code: 'target_clarification_required' };
  }
  return accepted;
}

// Resolve name/phone selectors to one of the task's known customers, then pass
// the immutable ID to existing readers. Broad searches without a selector stay
// broad. No fuzzy result or model-selected alternate contact becomes authority.
async function prepareReadInput(params, context, { toolName, schema }) {
  const input = { ...params };
  let readContext = context;
  if (schema.properties?.customer_id && (params.customer_name || params.phone)) {
    const permitted = new Set(context.targets.map(target => target.customer_id));
    const named = params.customer_name ? await namedCustomers(`for ${params.customer_name}`) : null;
    if (named?.complete === false) return { error: 'The customer name lookup is incomplete. Select the task customer by identifier.', code: 'target_clarification_required' };
    const matches = named ? named.matches : await db('customers').whereNull('deleted_at')
        .whereRaw("RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = ?", [String(params.phone).replace(/\D/g, '').slice(-10)])
        .select(CUSTOMER_FIELDS);
    // A current-request phone may establish a unique read target only. Keep
    // it out of the task's write authority and never accept a model substitute.
    const explicitRead = !permitted.size && params.phone && !params.customer_name
      && context.explicitReadPhones?.includes(String(params.phone).replace(/\D/g, '').slice(-10));
    const selected = explicitRead ? matches : matches.filter(customer => permitted.has(customer.id));
    const customer = selected.length === 1 ? await customerById(selected[0].id) : null;
    const phoneMatches = !params.phone || (customer && String(customer.phone || '').replace(/\D/g, '').slice(-10) === String(params.phone).replace(/\D/g, '').slice(-10));
    if (!customer || !phoneMatches || (params.customer_id && String(params.customer_id).toLowerCase() !== customer.id)) {
      return { error: 'Use the resolved task customer for this record lookup', code: 'target_clarification_required' };
    }
    input.customer_id = customer.id;
    if (explicitRead) readContext = { ...context, targets: [customerTarget(customer, 'current_request_read_lookup')] };
    delete input.customer_name;
    if (params.phone && schema.properties.phone && customer.phone) input.phone = customer.phone;
    else delete input.phone;
  }
  if (schema.properties?.customer_id && !input.customer_id && context.targets?.length) {
    if (context.targets.length !== 1) {
      return { error: 'Select one of the task customers for this record lookup', code: 'target_clarification_required' };
    }
    input.customer_id = context.targets[0].customer_id;
  }
  const invalid = await validateRecordTarget(input, readContext, { toolName });
  return invalid || { input };
}

module.exports = { UUID_RE, pageIds, resolve, validateRecordTarget, prepareReadInput, customerById, customerTarget, namedCustomers, namesRequested, bulkLeadSelection };
