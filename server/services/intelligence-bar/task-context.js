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
const PERSON_ACTIONS = 'reply|respond|send|email|text|sms|message|reminder|contact|notify|quote|schedule|reschedule|move|call|remind|cancel|book|archive|delete|merge|pause|reactivate|restore|refund|charge|invoice|credit|change|update|set|edit|mark|make|rename|relabel|forward|resend';
// "send the response to Jhon" / "forward the estimate to Jhon": the thing being
// sent introduces its recipient just as the verb does.
const PERSON_SELECTOR_SOURCE = `(?:${PERSON_ACTIONS})(?:\\s+(?:to|for))?|(?:reply|response|message|text|email|reminder|invoice|estimate|quote|note|details|receipt|link)\\s+(?:to|for)|for|customer|named`;
// Direct read verbs resolve an exact full name ("Show John Smith details")
// without becoming refusal hints: a read that names nobody stays a read.
const READ_SELECTOR_SOURCE = 'show|find|get|look\\s+up|pull\\s+up|open|view|display|check|summarize|read';
const PERSON_REFERENCE = new RegExp(`\\b(?=((?:${PERSON_SELECTOR_SOURCE}))\\s+([\\p{L}'-]+)\\b)`, 'gu');
const AFTER_SINGLE_NAME = new Set(['the', 'a', 'an', 'this', 'that', 'their', 'his', 'her', 'to', 'with', 'using', 'at', 'on', 'and',
  'needs', 'wants', 'has', 'is', 'should', 'would', 'asked', 'address', 'phone', 'email', 'notes', 'note', 'label', 'labels',
  'property', 'properties', 'appointment', 'appointments', 'estimate', 'invoice', 'details', 'inactive', 'active', 'reminder', 'reminders']);
const NON_PERSON_NAMES = new Set(['this', 'that', 'these', 'those', 'current', 'selected', 'viewed', 'open', 'the', 'a', 'an', 'his', 'her', 'their', 'my', 'our', 'each', 'all', 'both', 'next', 'today', 'tomorrow', 'me', 'him', 'them', 'it', 'lawn', 'pest', 'mosquito', 'termite', 'rodent', 'name', 'address', 'phone', 'email', 'notes', 'note', 'labels', 'label', 'customer', 'customers', 'lead', 'leads', 'review', 'reviews', 'stock', 'inventory', 'quantity', 'active', 'inactive', 'status', 'billing', 'type', 'plan', 'frequency', 'autopay', 'balance', 'schedule', 'tags', 'tag', 'preferences', 'details',
  // every update_customer field (tools.js) and the contractions a request may open with
  'first', 'last', 'city', 'state', 'zip', 'waveguard', 'tier', 'pipeline', 'stage', 'source', 'monthly', 'rate', 'mode', 'membership',
  'let', 'what', 'there', 'here', 'who', 'he', 'she', 'how', 'where', 'when', 'to', 'for', 'as', 'from', 'with', 'and', 'or', 'by', 'using',
  'on', 'at', 'in', 'of', 'about', 'regarding', 'via', 'through', 'after', 'before', 'during', 'until', 'since', 'over', 'into', 'off',
  'up', 'out', 'whose', 'whom', 'which', 'if', 'while', 'because', 'so', 'but', 'not', 'no', 'please', 'now', 'later', 'again', 'still', 'also', 'then', 'just', 'only',
  'account', 'accounts', 'profile', 'record', 'records',
  // record nouns that follow an action verb name a thing, never a person
  'appointment', 'appointments', 'property', 'properties', 'estimate', 'estimates', 'invoice', 'invoices', 'product', 'products',
  'call', 'calls', 'visit', 'visits', 'service', 'services', 'reservation', 'treatment', 'treatments', 'quote', 'reminder',
  // communication objects ("send message to this customer") and the pests/lawn work a request names
  'message', 'messages', 'text', 'texts', 'sms', 'reply', 'replies', 'response', 'responses', 'receipt', 'receipts', 'link', 'links',
  'bed', 'bug', 'bugs', 'flea', 'fleas', 'tick', 'ticks', 'ant', 'ants', 'roach', 'roaches', 'cockroach', 'cockroaches', 'spider', 'spiders',
  'wasp', 'wasps', 'rat', 'rats', 'mouse', 'mice', 'fire', 'grub', 'grubs', 'chinch', 'sod', 'weed', 'weeds', 'fungus', 'fertilizer',
  // Schedule surfaces, calendar words and record nouns after "for"/"to" are filters or things, never people.
  'stop', 'stops', 'thread', 'route', 'week', 'month', 'year', 'yesterday',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekday', 'weekdays', 'weekend', 'weekends',
  'january', 'february', 'march', 'july', 'september', 'october', 'november', 'december', 'tonight', 'morning', 'afternoon', 'evening', 'noon', 'midnight',
  'aeration', 'irrigation', 'sprinkler', 'sprinklers', 'wdo', 'termites', 'shrub', 'shrubs', 'tree', 'trees', 'palm', 'palms', 'quarterly', 'monthly', 'annual']);
// Months that are also given names stay person evidence unless a day or year
// follows them: "text May her invoice" must not fall back to the viewed
// customer, while "reschedule this stop for May 12" names a date.
const DATED_MONTH_RE = /\b(april|may|june|august)\s+(?:\d{1,2}(?:st|nd|rd|th)?|\d{4})\b/g;
// "this stop" / "this visit" on the schedule surfaces are the appointment.
const RECORD_KIND_ALIASES = { account: 'customer', stop: 'appointment', visit: 'appointment' };
const recordKind = word => RECORD_KIND_ALIASES[word.toLowerCase()] || word.toLowerCase();
// A set quantifier ("both A and B", "these customers …", "all of these …") is
// never a target: one target per request, so the request asks to clarify.
// Owner decision 2026-09-08: fail closed rather than parse cohorts.
// Any number of qualifiers may sit between the quantifier and the noun ("all
// active residential lawn customers"); a deictic word ends the run, so "all of
// this customer's fields" still names one account. The noun takes every
// customer-reference synonym the resolver understands.
const SET_QUANTIFIER_RE = /\b(?:both|(?:these|those|all|each|every)(?: one)?(?: of)?(?: the| these| those| my| our)?(?: (?!(?:this|that|his|her|their)\b)[a-z-]+)* (?:customer|account|client|profile|record)s?|all of (?:these|those))\b/;
// An independently requested operation starts at "and/then <action>".
const ACTION_CLAUSE_SPLIT = new RegExp(`\\b(?:and|then)\\s+(?:(?:also|then|please)\\s+)*(?=(?:${PERSON_ACTIONS}|revise|add|save|assign|draft|write|post|submit)\\b)`, 'i');
const CONTACT_LITERAL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|(?:\+?1[ .-]*)?(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4}(?!\d)/gi;
// An explicit email or phone recipient is a contact, never a name or a quantifier.
const withoutContacts = clause => clause.replace(CONTACT_LITERAL_RE, ' ');
const setQuantified = prompt => SET_QUANTIFIER_RE.test(normalizeName(withoutContacts(targetClause(prompt))));
const PAGE_REFERENCE_RE = /\b(?:(?:this|that|current|selected|viewed|open)\s+(?:customer|account|property|appointment|stop|visit|estimate|invoice|review|email|call|lead)|his|her|their)\b/i;
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
  const opener = new RegExp(`^(\\s*(?:(?:please|can you|could you|would you|will you)\\s+)*(?:(?:${PERSON_ACTIONS}|set|rename|relabel|add|save)(?:\\s+(?:to|for))?|(?:draft|write|post|submit)\\s+(?:(?:a|the)\\s+)?(?:reply|response)\\s+(?:to|for)|send\\s+(?:a|an)\\s+(?:text|sms|message|reminder|email|reply)\\s+(?:to|for))\\s+)that(?=\\s+(?:customer|account|property|appointment|stop|visit|estimate|invoice|review|email|call|product|lead)\\b)`, 'i');
  return clause.replace(opener, '$1this').split(/\bthat\b/i)[0];
}

const FOR_SELECTOR_RE = /(?:^|\s)for$/;
function explicitSingleNames(prompt, filterWords = null) {
  const clause = withoutContacts(targetClause(prompt));
  const normalized = normalizeName(clause);
  const dated = new Set([...normalized.matchAll(DATED_MONTH_RE)].map(m => m[1]));
  const references = [...normalized.matchAll(PERSON_REFERENCE)]
    .filter(m => m[1] !== 'customer' || !/\b(?:this|that|current|selected|viewed|open)\s+$/.test(normalized.slice(0, m.index)));
  // A verified filter word (see verifiedFilterWords) is a person only when a
  // selector other than "for" names it: a verb, "customer", a possessive or
  // the leading subject.
  const otherEvidence = new Set([
    ...references.filter(m => !FOR_SELECTOR_RE.test(m[1])).map(m => m[2]),
    ...[...clause.matchAll(/\b([\p{L}-]+)[’']s\b/giu)].map(m => normalizeName(m[1])),
    ...(normalized.match(/^([\p{L}'-]+)\s+(?:needs|wants|has|is|should|would|asked)\b/u)?.slice(1, 2) || []),
  ]);
  return [...new Set([...references.map(m => m[2]), ...otherEvidence])]
    .filter(word => !NON_PERSON_NAMES.has(word) && !dated.has(word) && !(filterWords?.has(word) && !otherEvidence.has(word)));
}

function namesRequested(prompt, filterWords = null) {
  // This is a refusal hint, never a fuzzy identity match. A misspelling after
  // an explicit person reference must not fall back to the open customer.
  const references = explicitSingleNames(prompt, filterWords);
  return references.length > 0;
}

// Bare "for <word>" is also how schedule and route reads take a place or a
// technician ("the schedule for Sarasota", "the route for Adam"). A word is a
// filter only when the database verifies it as a customer city or an active
// technician's name AND no customer carries it as a first or last name; an
// unverified or shared word stays a person reference, so a misspelled name
// still fails closed. The row check repeats the predicate so the verdict comes
// from the returned rows themselves.
async function verifiedFilterWords(prompt) {
  const normalized = normalizeName(targetClause(prompt));
  const words = [...new Set([...normalized.matchAll(/\bfor\s+([\p{L}'-]+)\b/gu)].map(m => m[1]))]
    .filter(word => !NON_PERSON_NAMES.has(word));
  if (!words.length) return new Set();
  const technicians = await db('technicians').whereRaw('coalesce(active, true)').select('name');
  const technicianWords = new Set(technicians.flatMap(technician => normalizeName(technician.name).split(' ')));
  const filters = new Set();
  for (const word of words) {
    const rows = await db('customers').whereNull('deleted_at')
      .whereRaw('? = ? OR ? = ? OR ? = ?', [normalizedStoredName('city'), word, normalizedStoredName('first_name'), word, normalizedStoredName('last_name'), word])
      .select('first_name', 'last_name', 'city');
    const person = rows.some(row => normalizeName(row.first_name) === word || normalizeName(row.last_name) === word);
    const city = rows.some(row => normalizeName(row.city) === word);
    if (!person && (city || technicianWords.has(word))) filters.add(word);
  }
  return filters;
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
  return new RegExp(`\\b(?:${PERSON_SELECTOR_SOURCE}|(?:${READ_SELECTOR_SOURCE})(?:\\s+me)?)$`).test(before);
}

async function namedCustomers(prompt) {
  const normalized = normalizeName(withoutContacts(targetClause(prompt)));
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
  const capped = matches.length === CUSTOMER_LOOKUP_LIMIT;
  const singleLookup = !fullNames.length && singleNames.length && !capped;
  const singles = singleLookup ? await db('customers').whereNull('deleted_at').where(function () {
    this.whereIn(normalizedStoredName('first_name'), singleNames).orWhereIn(normalizedStoredName('last_name'), singleNames);
  }).limit(CUSTOMER_LOOKUP_LIMIT).select(columns) : [];
  const accepted = singleLookup ? singles : fullNames;
  // Name evidence that only partly resolved — a customer accepted while some
  // person reference in the request matches nobody, as in "update Jhon Smith
  // and text Alice Owner" — is never a target and no selection survives it.
  // Each reference is the WHOLE name run after its selector ("alice missing"),
  // and it resolves only against a customer whose full name it equals, or,
  // for a bare single name, whose first or last name it is. Sharing a first
  // name resolves nothing, and neither does a longer reference ("alice jones
  // jr"): an unlisted trailing word is refused, never assumed. A token that
  // modifies a non-person noun ("flea" in "flea treatment") is not a person
  // reference, and a request that resolved nobody keeps the plain
  // unresolved-name handling.
  const personReferences = clause => {
    const clauseWords = normalizeName(clause).split(' ');
    return explicitSingleNames(clause).map(token => {
      const start = clauseWords.indexOf(token);
      const run = [token];
      for (let i = start + 1; i < clauseWords.length && run.length < 5 && !NON_PERSON_NAMES.has(clauseWords[i]) && !AFTER_SINGLE_NAME.has(clauseWords[i]); i++) run.push(clauseWords[i]);
      return run;
    }).filter(run => run.length > 1 || !NON_PERSON_NAMES.has(clauseWords[clauseWords.indexOf(run[0]) + 1] || ''));
  };
  const resolvesReference = run => accepted.some(customer => {
    const first = normalizeName(customer.first_name), last = normalizeName(customer.last_name);
    if (run.length === 1) return run[0] === first || run[0] === last;
    const full = `${first} ${last}`.trim().split(' ');
    return full.length === run.length && full.every((word, index) => word === run[index]);
  });
  const partial = accepted.length > 0 && normalized.split(ACTION_CLAUSE_SPLIT).some(clause => {
    const references = personReferences(clause);
    return references.length > 0 && !references.every(resolvesReference);
  });
  // Distinct stated names: a selection may disambiguate duplicate rows of ONE
  // stated name, never choose between two different recipients.
  const stated = singleLookup
    ? new Set(singles.flatMap(customer => singleNames.filter(name => [normalizeName(customer.first_name), normalizeName(customer.last_name)].includes(name))))
    : new Set(fullNames.map(customer => normalizeName(`${customer.first_name || ''} ${customer.last_name || ''}`)));
  // Either shape is evidence that can never yield one target: refuse it whole.
  return { matches: accepted, complete: !capped && singles.length < CUSTOMER_LOOKUP_LIMIT, multiple: partial || stated.size > 1 };
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

// Errors keep the page shape so the resolver never branches on them twice.
async function loadPage(pageData, prompt) {
  let ids = pageIds(pageData);
  if (ids.error) return { ids: {}, records: {}, ...ids };
  const referencedKinds = new Set([...targetClause(prompt, true).matchAll(/\b(?:this|that|current|selected|viewed|open)\s+(customer|account|property|appointment|stop|visit|estimate|invoice|review|email|call|product|lead)\b/gi)]
    .map(match => `${recordKind(match[1])}_id`));
  // A directly referenced available hint takes precedence over unrelated page
  // hints. With no direct customer hint, retain child-owner lookup as before.
  if (referencedKinds.size && [...referencedKinds].every(kind => ids[kind])) {
    ids = Object.fromEntries(Object.entries(ids).filter(([kind]) => referencedKinds.has(kind)));
  }
  const resolved = await readReferences(ids);
  if (resolved.error) return { ids: {}, records: {}, ...resolved };
  const customers = customerIds(resolved.records);
  if (customers.length > 1) return { ids: {}, records: {}, error: 'The viewed records belong to different customers', code: 'context_mismatch' };
  const page = { ids, records: Object.fromEntries(resolved.records.map(r => [r.kind, r])) };
  if (!customers.length) return page;
  const customer = resolved.parents.find(parent => parent.id === customers[0]);
  if (!customer) return { ids: {}, records: {}, error: 'The viewed customer is unavailable', code: 'record_unavailable' };
  page.customer = customerTarget(customer, 'viewed_record');
  return page;
}

function candidateSelection(candidates, prompt, viewedCustomer, complete, cohort, nameHint) {
  if (!complete || cohort) return { target: null, targets: [], ambiguous: true };
  if (candidates.length === 1) return { target: candidates[0], targets: candidates, ambiguous: false };
  if (candidates.length > 1) return { target: null, targets: [], ambiguous: true };
  const pageReference = PAGE_REFERENCE_RE.test(targetClause(prompt));
  const target = !nameHint && pageReference ? viewedCustomer : null;
  return { target: target || null, targets: target ? [target] : [], ambiguous: false };
}

async function resolve({ prompt, pageData, selectedTarget }) {
  // Object(null) is {} — an absent or null selection reads as no customer id.
  // Candidate ids come from PostgreSQL in lowercase; a selection may not.
  const selectedId = String(Object(selectedTarget).customer_id || '').toLowerCase() || null;
  const [page, namedResult, filterWords] = await Promise.all([loadPage(pageData, prompt), namedCustomers(prompt), verifiedFilterWords(prompt)]);
  const named = namedResult.matches;
  const nameHint = namesRequested(prompt, filterWords);
  // A stale page hint cannot block an unrelated task or an explicitly named
  // customer. A request relying on the unavailable viewed record still stops.
  if (page.error && PAGE_REFERENCE_RE.test(targetClause(prompt)) && !named.length) return page;
  const candidates = named.map(c => customerTarget(c, 'current_request_lookup'));
  // A set quantifier, partly resolved name evidence, or two distinct stated
  // recipients never yields a target, and no selection resolves it.
  const cohort = setQuantified(prompt) || namedResult.multiple;
  let selection = candidateSelection(candidates, prompt, page.customer, namedResult.complete, cohort, nameHint);
  if (selectedId) {
    // A selection is bound to this request's own fresh candidates: it is
    // accepted only as one of the rows the request resolved to (duplicate-name
    // disambiguation, the one flow that supplies a selection). A request that
    // named nobody, matched nothing, hit the lookup cap, or asked for a set
    // has no candidate to select, so no stale-selection grammar is
    // load-bearing: an unrecognized phrasing can only over-refuse.
    const selected = named.some(c => c.id === selectedId) && !cohort && namedResult.complete ? await customerById(selectedId) : null;
    if (!selected) {
      // selectable: a fresh customer choice re-resolves this request.
      return { error: 'The selected customer conflicts with the current request', code: 'context_mismatch', selectable: true };
    }
    const target = customerTarget(selected, 'operator_selection');
    selection = { target, targets: [target], ambiguous: false };
  }
  // Only the leading recipient expression establishes a raw contact. A later
  // "text <number>" inside a note or an unresolved person's message is data.
  const recipient = [...targetClause(prompt).matchAll(/^(?:(?:please|can you|could you|would you|will you|i need you to|i'd like you to)\s+)*(?:text|message|sms|email|reply\s+to|respond\s+to|send(?:\s+(?:a|an))?(?:\s+(?:text|sms|message|reminder|email|reply))?\s+to)\s+(?:to\s+)?(.+)/gi)].map(match => match[1]).join('');
  const readRecipient = targetClause(prompt).match(/^(?:(?:please|can you|could you|would you|will you)\s+)*(?:(?:show|read|get|find|look up|check|summarize)\s+(?:(?:the|our)\s+)?(?:customer\s+)?(?:conversation|thread|messages|texts|sms|calls|call history|details|history)\s+(?:with|for|from|to|on)|what\s+(?:did|have)\s+we\s+(?:say|send|said|sent)\s+to(?:\s+(?:the\s+)?customer\s+on)?)\s+(.+)/i)?.[1] || '';
  const reviewClause = targetClause(prompt);
  const [explicitReview] = [...reviewClause.matchAll(/\breview\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map(match => match[1].toLowerCase());
  const reviewReference = explicitReview || (!nameHint
    && /\b(?:this|that|current|selected|viewed|open)\s+review\b/i.test(reviewClause) ? page.ids.review_id : null);
  const requestedRecords = Object.fromEntries([...targetClause(prompt, true).matchAll(/\b(?:this|that|current|selected|viewed|open)\s+(property|appointment|stop|visit|estimate|invoice|review|email|call|product|lead)\b/gi)]
    .map(match => { const kind = `${recordKind(match[1])}_id`; return [kind, page.ids[kind] || null]; }));
  // Explicit current-request child IDs narrow even same-customer operations.
  // Keep all deliberately named records for compound requests; body text never
  // enters this clause and page hints cannot replace the explicit selection.
  const explicitRecords = {};
  // A content noun ends its own action clause. An independently requested
  // operation after "and/then <action>" retains its explicit target IDs.
  const explicitRecordClause = targetClause(prompt, true).split(ACTION_CLAUSE_SPLIT)
    .map(clause => clause.split(/\b(?:notes?|messages?|instructions|comments)\b/i)[0]).join(' and ');
  for (const match of explicitRecordClause.matchAll(/\b(property|appointment|estimate|invoice|review|email|call|product|lead)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)) {
    (explicitRecords[`${match[1].toLowerCase()}_id`] ||= []).push(match[2].toLowerCase());
  }
  for (const [kind, ids] of Object.entries(explicitRecords)) {
    requestedRecords[kind] = ids.filter(id => !Object.hasOwn(requestedRecords, kind) || id === requestedRecords[kind]);
  }
  return { page, candidates, ...selection, requestedRecords, requestPhrase: normalizeName(targetClause(prompt)),
    // An explicitly named customer that did not resolve keeps the request
    // target-specific: broad customer-row readers stay refused until it does.
    namesRequested: nameHint,
    reviewReference: reviewReference || null,
    bulkLeadRequest: !nameHint && /\b(?:all|bulk)\b.*\bleads\b/i.test(targetClause(prompt)),
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

// Writers that act on every stop for a date or technician and carry no record
// identifiers. A customer-scoped task cannot mint an approval for them: the
// stored action would have no references for the confirm-time recheck. An
// explicitly named customer who did not resolve keeps the task customer-scoped
// (as for the broad readers), so a misspelling never widens a request to a
// whole date or technician.
const ROUTE_WIDE_WRITERS = new Set(['optimize_all_routes', 'optimize_tech_route', 'swap_tech_assignments']);

async function validateRecordTarget(params, context = {}, { toolName, forApproval = false } = {}) {
  // A refused cohort or unresolved name stops here too; explicit record IDs
  // inside "both appointment A and appointment B" do not reopen it.
  if (context.ambiguous) return { error: 'Name one customer for this action', code: 'target_clarification_required' };
  const policy = require('./action-policy.json')[toolName];
  if ((context.targets?.length || context.namesRequested) && ROUTE_WIDE_WRITERS.has(toolName)) {
    return { error: 'This action changes every stop for the date or technician. Run it from a request that does not name a customer, or move that customer\'s own stops by id.', code: 'customer_scope_required' };
  }
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
// Readers that list customer rows (names, phones, addresses, balances,
// message bodies) without a customer selector and without consuming the
// task's read scope. Inside a customer-scoped task they would hand every
// matching customer to the model, so they are refused there; the scoped
// readers (query_customers, query_leads, get_schedule_view, search_emails …)
// remain available for the task customer.
const BROAD_CUSTOMER_ROW_READERS = new Set([
  'get_csr_overview', 'get_unanswered_threads', 'list_call_partners',
  'find_duplicates', 'find_overdue_customers', 'get_recent_completions',
  'get_day_summary', 'get_zone_density', 'cancel_and_reschedule_far_out',
  'get_outreach_candidates', 'get_unresponded_reviews', 'search_reviews',
  'get_top_revenue_customers', 'get_outstanding_balances', 'get_ar_aging', 'get_inbox_summary',
  'get_churn_analysis', 'get_revenue_breakdown', 'get_today_briefing', 'get_stock_movements', 'find_similar_estimates',
  'get_email_suppressions', 'get_twilio_failed_messages', 'get_stripe_payment_intents', 'get_payer_ar_aging', 'get_blocked_senders',
  'get_my_route', 'get_payout_details',
]);

// Readers that confine themselves to the task's read scope (readCustomerIds).
// That scope is empty when an explicitly named customer did not resolve, so
// they would read every customer's rows; they fail closed until it resolves.
// Readers with an optional customer selector fail closed the same way when
// the model supplies no selector at all (see hasOwnSelector).
const SCOPED_CUSTOMER_ROW_READERS = new Set(['query_customers', 'query_leads', 'get_stale_leads', 'get_schedule_view',
  'search_emails', 'get_email_thread', 'draft_email_reply', 'match_existing_customer']);
// A customer selector or a record identifier: either one is checked against
// the task's authority further down, so only a selector-free call is broad.
const hasOwnSelector = params => Boolean(params.customer_id || params.customer_name || params.phone)
  || Object.keys(RECORDS).some(kind => params[kind] || params[ALIASES[kind]] || params[COLLECTIONS[kind]]);

// The operator's own past conversations quote every customer verbatim, and a
// stored thread carries no customer association to filter on, so the search
// is refused inside a customer-scoped task rather than narrowed.
const ACTOR_WIDE_READERS = new Set(['search_ib_history']);

const PHONE_KEYED_READERS = new Set(['get_partner_call_history']);
const EMAIL_KEYED_READERS = new Set(['check_email_suppression']);

async function prepareReadInput(params, context, { toolName, schema }) {
  // A refused cohort never widens into an unscoped read; an unresolved
  // explicit name is handled by the scope guards below, which still admit a
  // reader that carries its own selector or record identifier.
  if (context.ambiguous) return { error: 'Name one customer for this record lookup', code: 'target_clarification_required' };
  const input = { ...params };
  if ((context.targets?.length || context.namesRequested) && BROAD_CUSTOMER_ROW_READERS.has(toolName)) {
    return { error: 'This lookup lists every customer. Inside a task for a specific customer, use a reader that takes the task customer (customer detail, scoped customer, lead, schedule or email searches).', code: 'customer_scope_required' };
  }
  if ((context.targets?.length || context.namesRequested) && ACTOR_WIDE_READERS.has(toolName)) {
    return { error: 'Past-conversation search returns verbatim exchanges about any customer and cannot be limited to the task customer, so it is unavailable inside a task for a specific customer.', code: 'customer_scope_required' };
  }
  if (context.namesRequested && !context.targets?.length
    && (SCOPED_CUSTOMER_ROW_READERS.has(toolName) || (schema.properties?.customer_id && !hasOwnSelector(params)))) {
    return { error: 'The named customer did not match anyone on file, so this lookup has no customer scope. Correct the name before reading that customer\'s records.', code: 'customer_scope_required' };
  }
  // Phone-keyed readers without a customer selector: the phone must belong to
  // a task customer, so a model-supplied number cannot read another party.
  if (context.targets?.length && PHONE_KEYED_READERS.has(toolName)) {
    const digits = String(params.phone || '').replace(/\D/g, '').slice(-10);
    const owners = await db('customers').whereIn('id', context.targets.map(target => target.customer_id)).whereNull('deleted_at').select('phone');
    if (!digits || !owners.some(owner => String(owner.phone || '').replace(/\D/g, '').slice(-10) === digits)) {
      return { error: 'Use the task customer\'s own phone number for this call history', code: 'target_clarification_required' };
    }
  }
  if (context.targets?.length && EMAIL_KEYED_READERS.has(toolName)) {
    const email = String(params.email || '').trim().toLowerCase();
    const owners = await db('customers').whereIn('id', context.targets.map(target => target.customer_id)).whereNull('deleted_at').select('email');
    if (!email || !owners.some(owner => String(owner.email || '').trim().toLowerCase() === email)) {
      return { error: 'Use the task customer\'s own email address for this suppression check', code: 'target_clarification_required' };
    }
  }
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

module.exports = { UUID_RE, BROAD_CUSTOMER_ROW_READERS, pageIds, targetClause, resolve, validateRecordTarget, prepareReadInput, customerById, customerTarget, namedCustomers, namesRequested, bulkLeadSelection };
