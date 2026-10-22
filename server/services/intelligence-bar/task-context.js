/** Current-request entity resolution. History/attachments never select a write
 * target. Page IDs are hints re-read from the DB; explicit current names win.
 */
const db = require('../../models/db');
const { normalizeEmail } = require('../../utils/contact-normalize');
const { ibTargetRulesV2Live } = require('../../config/feature-gates');
const { MAX_LABEL_CHARS } = require('./choice-tools');
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
// The record nouns and their determiners a read verb may carry before naming
// the customer: "show me the latest conversation with", "read the texts from".
const READ_OBJECT_WORDS = 'the|my|our|all|any|recent|latest|last|open|past|full|entire|conversation|conversations|thread|threads|message|messages|text|texts|sms|call|calls|email|emails|history|notes|balance|balances|schedule|appointment|appointments|estimate|estimates|invoice|invoices|record|records|detail|details|activity|log|logs|timeline';
const PERSON_REFERENCE = new RegExp(`\\b(?=((?:${PERSON_SELECTOR_SOURCE}))\\s+([\\p{L}'-]+)\\b)`, 'gu');
const AFTER_SINGLE_NAME = new Set(['the', 'a', 'an', 'this', 'that', 'their', 'his', 'her', 'to', 'with', 'using', 'at', 'on', 'and',
  'needs', 'wants', 'has', 'is', 'should', 'would', 'asked', 'address', 'phone', 'email', 'notes', 'note', 'label', 'labels',
  'property', 'properties', 'appointment', 'appointments', 'estimate', 'invoice', 'details', 'inactive', 'active', 'reminder', 'reminders']);
// Function and temporal words never end a person reference's meaning: a bare
// name before "tomorrow" or "and" is still a stated person, while a token
// before an object noun ("flea" in "flea treatment") only modifies that noun.
const FUNCTION_WORDS = new Set(['this', 'that', 'these', 'those', 'current', 'selected', 'viewed', 'open', 'the', 'a', 'an', 'his', 'her', 'their', 'my', 'our',
  'each', 'all', 'both', 'next', 'today', 'tomorrow', 'me', 'him', 'them', 'it', 'let', 'what', 'there', 'here', 'who', 'he', 'she', 'how', 'where', 'when',
  'to', 'for', 'as', 'from', 'with', 'and', 'or', 'by', 'using', 'on', 'at', 'in', 'of', 'about', 'regarding', 'via', 'through', 'after', 'before', 'during',
  'until', 'since', 'over', 'into', 'off', 'up', 'out', 'whose', 'whom', 'which', 'if', 'while', 'because', 'so', 'but', 'not', 'no', 'please', 'now', 'later',
  'again', 'still', 'also', 'then', 'just', 'only']);
const NON_PERSON_NAMES = new Set(['this', 'that', 'these', 'those', 'current', 'selected', 'viewed', 'open', 'the', 'a', 'an', 'his', 'her', 'their', 'my', 'our', 'each', 'all', 'both', 'next', 'today', 'tomorrow', 'me', 'him', 'them', 'it', 'lawn', 'pest', 'mosquito', 'termite', 'rodent', 'name', 'address', 'phone', 'email', 'notes', 'note', 'labels', 'label', 'customer', 'customers', 'lead', 'leads', 'review', 'reviews', 'stock', 'inventory', 'quantity', 'active', 'inactive', 'status', 'billing', 'type', 'plan', 'frequency', 'autopay', 'balance', 'schedule', 'tags', 'tag', 'preferences', 'details',
  // every update_customer field (tools.js) and the contractions a request may open with
  'first', 'last', 'city', 'state', 'zip', 'waveguard', 'tier', 'pipeline', 'stage', 'source', 'monthly', 'rate', 'mode', 'membership',
  'let', 'what', 'there', 'here', 'who', 'he', 'she', 'how', 'where', 'when', 'to', 'for', 'as', 'from', 'with', 'and', 'or', 'by', 'using',
  'on', 'at', 'in', 'of', 'about', 'regarding', 'via', 'through', 'after', 'before', 'during', 'until', 'since', 'over', 'into', 'off',
  'up', 'out', 'whose', 'whom', 'which', 'if', 'while', 'because', 'so', 'but', 'not', 'no', 'please', 'now', 'later', 'again', 'still', 'also', 'then', 'just', 'only',
  'account', 'accounts', 'profile', 'record', 'records',
  // the record nouns a read verb may carry before naming its customer ("call history of", "text thread between")
  'history', 'conversation', 'conversations', 'thread', 'threads', 'timeline', 'log', 'logs', 'activity',
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
// A numeric count ("2 customers", "three accounts", "a few clients") and a
// bare plural person noun ("update customers") are sets too.
const SET_QUANTIFIER_RE = /\b(?:both|(?:these|those|all|each|every|several|multiple|many|few|couple|dozen|\d+|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|fifty|hundred)(?: one)?(?: of)?(?: the| these| those| my| our)?(?: (?!(?:this|that|his|her|their)\b)[a-z-]+)* (?:customer|account|client|profile|record)s?|all of (?:these|those)|customers|clients)\b/;
// An independently requested operation starts at "and/then <action>".
const ACTION_CLAUSE_SPLIT = new RegExp(`\\b(?:and|then)\\s+(?:(?:also|then|please)\\s+)*(?=(?:${PERSON_ACTIONS}|revise|add|save|assign|draft|write|post|submit)\\b)`, 'i');
const CONTACT_LITERAL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|(?:\+?1[ .-]*)?(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4}(?!\d)/gi;
// An explicit email or phone recipient is a contact, never a name or a quantifier.
const withoutContacts = clause => clause.replace(CONTACT_LITERAL_RE, ' ');
const setQuantified = prompt => SET_QUANTIFIER_RE.test(normalizeName(withoutContacts(targetClause(prompt))));
const PAGE_REFERENCE_RE = /\b(?:(?:this|that|current|selected|viewed|open)\s+(?:customer|account|property|appointment|stop|visit|estimate|invoice|review|email|call|lead)|his|her|their)\b/i;
const CUSTOMER_LOOKUP_LIMIT = 10;
// GATE_IB_TARGET_RULES_V2 (owner 2026-10-20): a same-name lookup lists up to 25
// rows. The fetch asks for one more than it lists, so exactly 25 rows are
// complete and a 26th marks the lookup as capped. Read at call time; off = 10.
const CUSTOMER_LOOKUP_LISTED_V2 = 25;
// The 25-row lookup, choice labels and last-visit reads apply to the owner-direct
// scope only (owner login + GATE_IB_OWNER_DIRECT + the v2 gate); the route passes
// `ownerDirectScope` to resolve(). Every other admin keeps 10 rows (Codex #6369 r10).
const targetRulesV2Scope = scope => scope === true && ibTargetRulesV2Live();
const customerLookupLimit = (scope = true) => (targetRulesV2Scope(scope) ? CUSTOMER_LOOKUP_LISTED_V2 + 1 : CUSTOMER_LOOKUP_LIMIT);

// GATE_IB_TARGET_RULES_V2 (Codex #6369 r9, r17): in the owner-direct scope every typed-target
// parse (names, cities, phones, emails, the "First L., City" reply) reads only the first
// characters of the message: resolve() cuts the prompt once, and typedCustomerIds cuts it again
// for direct callers. A multi-megabyte prompt cannot make the parse materialize every match; the
// owner's target is named at the start of a request. Other admins, and owner-direct off, read
// the whole message as before.
const TYPED_TARGET_SCAN_CHARS = 4000;
const boundedPrompt = prompt => String(prompt ?? '').slice(0, TYPED_TARGET_SCAN_CHARS);

function targetClause(prompt, retainRecordConstraints = false) {
  // Message bodies and replacement values are data, even when they contain
  // another customer's exact name. They never select a recipient/account.
  let clause = String(prompt).split(/[:;\n“”"]|\bwith\s+(?:(?:the|a|this|following)\s+)*(?:text|body|message|content|notes?|instructions|comments)\b|\b(?:notes?|message|instructions|comments)\s+(?:that|mentioning|referencing|containing|with|reading)\b|\b(?:saying|regarding|about)\b/i)[0];
  // A replacement value is data for every contact phrasing: "phone to", "phone number to", "cell to",
  // "mobile number to", "number to", "email address to" (Codex #6369 r21).
  for (const replacement of clause.matchAll(/\b(?:name|address|email(?:\s+address)?|phone(?:\s+number)?|mobile(?:\s+(?:phone|number))?|cell(?:\s+(?:phone|number))?|number|label|notes?|instructions|message|contact)\s+(?:to|as|is|=)\s+/gi)) {
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

// Bare "for <word>" is also how schedule, route and analytics reads take a
// place, a technician, a vendor or a marketing channel ("the schedule for
// Sarasota", "the route for Adam", "expenses for SiteOne", "attribution for
// Facebook"). A word is a filter only when the database verifies it as a
// customer city, an active technician's name, a vendor or expense vendor
// name, a lead source name or channel, or it is a known marketing channel,
// AND no customer carries it as a first or last name; an unverified or
// shared word stays a person reference, so a misspelled name still fails
// closed. The row checks repeat the predicate so the verdict comes from the
// returned rows themselves.
const MARKETING_CHANNEL_WORDS = new Set(['facebook', 'instagram', 'meta', 'google', 'gbp', 'yelp', 'nextdoor', 'tiktok', 'youtube', 'linkedin',
  'referral', 'referrals', 'website', 'organic', 'seo', 'ppc', 'ads', 'adwords', 'thumbtack', 'angi', 'homeadvisor', 'bing']);
async function verifiedFilterWords(prompt) {
  const normalized = normalizeName(targetClause(prompt));
  const words = [...new Set([...normalized.matchAll(/\bfor\s+([\p{L}'-]+)\b/gu)].map(m => m[1]))]
    .filter(word => !NON_PERSON_NAMES.has(word));
  if (!words.length) return new Set();
  const technicians = await db('technicians').whereRaw('coalesce(active, true)').select('name');
  const technicianWords = new Set(technicians.flatMap(technician => normalizeName(technician.name).split(' ')));
  const hasWord = (value, word) => normalizeName(value).split(' ').includes(word);
  const filters = new Set();
  for (const word of words) {
    const pattern = `%${word}%`;
    const [rows, expenseVendors, vendors, sources] = await Promise.all([
      db('customers').whereNull('deleted_at')
        .whereRaw('? = ? OR ? = ? OR ? = ?', [normalizedStoredName('city'), word, normalizedStoredName('first_name'), word, normalizedStoredName('last_name'), word])
        .select('first_name', 'last_name', 'city'),
      db('expenses').whereRaw('? LIKE ?', [normalizedStoredName('vendor_name'), pattern]).select('vendor_name').limit(5),
      db('vendors').whereRaw('? LIKE ?', [normalizedStoredName('name'), pattern]).select('name').limit(5),
      db('lead_sources').whereRaw('? LIKE ? OR ? LIKE ?', [normalizedStoredName('name'), pattern, normalizedStoredName('channel'), pattern]).select('name', 'channel').limit(5),
    ]);
    const person = rows.some(row => normalizeName(row.first_name) === word || normalizeName(row.last_name) === word);
    const verified = rows.some(row => normalizeName(row.city) === word)
      || technicianWords.has(word) || MARKETING_CHANNEL_WORDS.has(word)
      || expenseVendors.some(row => hasWord(row.vendor_name, word))
      || vendors.some(row => hasWord(row.name, word))
      || sources.some(row => hasWord(row.name, word) || hasWord(row.channel, word));
    if (!person && verified) filters.add(word);
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
  // A read may name its customer through a record noun and a preposition
  // ("show me the conversation with", "read the messages from"), not only
  // directly after the verb.
  return new RegExp(`\\b(?:${PERSON_SELECTOR_SOURCE}|(?:${READ_SELECTOR_SOURCE})(?:\\s+me)?(?:\\s+(?:${READ_OBJECT_WORDS}))*(?:\\s+(?:with|from|of|to|between))?)$`).test(before);
}

async function namedCustomers(prompt, ownerDirectScope = false) {
  const lookupLimit = customerLookupLimit(ownerDirectScope);
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
  // phone rides along so a read's name + phone selectors can be checked
  // against the same row before task scope narrows it (Codex r5 P2).
  const columns = ['id', 'first_name', 'last_name', 'phone', 'address_line1', 'city', 'updated_at', db.raw('updated_at::text AS version')];
  const matches = phrases.length ? await db('customers').whereNull('deleted_at')
    .whereIn(normalizedStoredName("concat_ws(' ', first_name, last_name)"), phrases).limit(lookupLimit).select(columns) : [];
  const fullNames = matches.filter(customer => namesTargetCustomer(normalized, customer));
  const capped = matches.length === lookupLimit;
  const singleLookup = !fullNames.length && singleNames.length && !capped;
  const singles = singleLookup ? await db('customers').whereNull('deleted_at').where(function () {
    this.whereIn(normalizedStoredName('first_name'), singleNames).orWhereIn(normalizedStoredName('last_name'), singleNames);
  }).limit(lookupLimit).select(columns) : [];
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
  // Every occurrence of a name token is its own reference ("forward Alice
  // Jones's estimate to Alice Missing" states two people), a run continues
  // through a non-name word that continues a matched customer's own name
  // ("Alice Link Jr" is compared whole against Alice Link), and a bare name
  // is kept before a function or temporal word.
  const acceptedNames = accepted.map(customer => `${normalizeName(customer.first_name)} ${normalizeName(customer.last_name)}`.trim().split(' '));
  const continuesName = run => acceptedNames.some(full => full.length >= run.length && run.every((word, index) => word === full[index]));
  const objectNoun = word => NON_PERSON_NAMES.has(word) && !FUNCTION_WORDS.has(word);
  const personReferences = clause => {
    const clauseWords = normalizeName(clause).split(' ');
    return explicitSingleNames(clause).flatMap(token => clauseWords.flatMap((word, start) => {
      if (word !== token) return [];
      const run = [token];
      for (let i = start + 1; i < clauseWords.length && run.length < 5; i++) {
        const next = clauseWords[i];
        if ((NON_PERSON_NAMES.has(next) || AFTER_SINGLE_NAME.has(next)) && !continuesName([...run, next])) break;
        run.push(next);
      }
      return run.length > 1 || !objectNoun(clauseWords[start + 1] || '') ? [run] : [];
    }));
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
  return { matches: accepted, complete: !capped && singles.length < lookupLimit, multiple: partial || stated.size > 1 };
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

function candidateSelection(candidates, prompt, viewedCustomer, complete, cohort, nameHint, onScreenPick = null) {
  if (!complete || cohort) return { target: null, targets: [], ambiguous: true };
  if (candidates.length === 1) return { target: candidates[0], targets: candidates, ambiguous: false };
  // GATE_IB_TARGET_RULES_V2: the owner is viewing one of several same-name customers
  // and typed that name: the validated on-screen customer is the target, no choices
  // (Codex #6369 r13). Not a pick when the viewed customer is not among the matches.
  if (onScreenPick && candidates.some(candidate => candidate.customer_id === onScreenPick.customer_id)) {
    return { target: onScreenPick, targets: [onScreenPick], ambiguous: false };
  }
  if (candidates.length > 1) return { target: null, targets: [], ambiguous: true };
  const pageReference = PAGE_REFERENCE_RE.test(targetClause(prompt));
  const target = !nameHint && pageReference ? viewedCustomer : null;
  return { target: target || null, targets: target ? [target] : [], ambiguous: false };
}

// GATE_IB_TARGET_RULES_V2 (owner 2026-10-20). The last visit date of each
// listed customer, so the model can tell same-name rows apart and offer them as
// buttons. One grouped read; a failed read leaves the date blank, never fails
// the request.
async function withLastVisit(candidates) {
  if (!candidates.length) return candidates;
  let dates = new Map();
  try {
    // A visit is a completed service record (an office-handoff 'incomplete' row is not; Codex #6369 r2).
    const rows = await db('service_records').whereIn('customer_id', candidates.map(c => c.customer_id)).where('status', 'completed').groupBy('customer_id')
      .select('customer_id', db.raw('MAX(service_date) AS last_visit'));
    dates = new Map(rows.map(row => [String(row.customer_id), row.last_visit]));
  } catch {
    // blank dates
  }
  const day = value => (value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null);
  return candidates.map(c => ({ ...c, last_visit: day(dates.get(String(c.customer_id))) }));
}

// The customers THIS message names: a name the operator typed, or a phone or
// email they typed. GATE_IB_TARGET_RULES_V2 asks it of an owner-direct edit:
// the customer the model found by itself (a call log, a search) is not in this
// list, so that edit keeps its card. A name shared by several customers names
// none of them, unless a city or phone/email in the message narrows it to one.
const MAX_CONTACT_LITERALS = 5;

// A city disambiguates only in explicit syntax right after the typed name:
// "<name> in <City>", "<name> of <City>" or "<name>, <City>". Any other mention of a
// city word (a technician or a zone later in the message) grounds nobody, and neither
// does a word that is part of the name itself (Codex #6369 r8, r10). `marked` is the
// normalized clause with each comma turned into COMMA_TOKEN, so the comma syntax survives
// normalization.
const COMMA_TOKEN = 'qqcomma';
// The text right after this customer's typed name, or null when the name is not typed.
// `marked` is the normalized clause with commas turned into COMMA_TOKEN.
function nameTail(customer, marked) {
  const first = normalizeName(customer.first_name), last = normalizeName(customer.last_name);
  const hay = ` ${marked} `;
  const phrase = [`${first} ${last}`.trim(), first, last].find(name => name && hay.includes(` ${name} `));
  return phrase ? hay.slice(hay.indexOf(` ${phrase} `) + phrase.length + 2) : null;
}

// Words that may follow a city in a request ("... in Venice notes", "... in Venice and ..."). A city
// counts as typed only as a WHOLE phrase: "in Palm Beach Gardens" is not "Palm Beach" (Codex #6369 r23).
const CITY_FOLLOW_WORDS = new Set(['and', 'then', 'to', 'for', 'as', 'with', 'so', 'please', 'notes', 'note', 'phone', 'email', 'address', 'number', 'now', 'today', 'tomorrow', 'instead']);
function cityIsTyped(customer, marked) {
  const tail = nameTail(customer, marked);
  const city = normalizeName(customer.city);
  if (!tail || !city) return false;
  return ['in', 'of', COMMA_TOKEN].some((lead) => {
    if (!tail.startsWith(`${lead} ${city} `)) return false;
    const next = tail.slice(`${lead} ${city} `.length).split(' ')[0];
    return !next || CITY_FOLLOW_WORDS.has(next);
  });
}

// ONE place-qualifier test, used for a name and for a contact alike (Codex #6369 r26). A place
// phrase is a lead word (in / of / at / from / near / around / by / outside / off / on, or a
// comma) followed by a word that could be a place. Not a place: a determiner, a command word, a
// time, a weekday, a month, a number ("at 3pm", "on Tuesday", "in the morning", "from now on"),
// or the typed customer's own name ("notes on Pat Example"). It counts ANYWHERE in the message,
// and a qualifier that resolves to nobody ("in Tampa") is still a qualifier (r15).
const PLACE_LEADS = new Set(['in', 'of', 'at', 'from', 'near', 'around', 'by', 'outside', 'off', 'on', COMMA_TOKEN]);
const NOT_A_PLACE = new Set([
  'the', 'a', 'an', 'my', 'our', 'this', 'that', 'his', 'her', 'their', 'its', 'your', 'these', 'those', 'to', 'and', 'please',
  'now', 'once', 'least', 'most', 'all', 'any', 'each', 'every', 'some', 'no', 'time', 'night', 'noon', 'midnight', 'tonight',
  'today', 'tomorrow', 'yesterday', 'am', 'pm', 'file', 'hold', 'record', 'account', 'screen', 'page', 'list', 'schedule',
  'route', 'calendar', 'invoice', 'estimate', 'qqname',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const couldBeAPlace = word => Boolean(word) && /^\p{L}/u.test(word) && !NOT_A_PLACE.has(word) && !PLACE_LEADS.has(word) && !COMMAND_WORD_RE.test(word);

function placeQualifierPresent(clause, customers = []) {
  let text = ` ${normalizeName(withoutContacts(clause).replace(/,/g, ` ${COMMA_TOKEN} `))} `;
  for (const customer of customers) {
    for (const name of [fullNameKey(customer), normalizeName(customer.first_name), normalizeName(customer.last_name)]) {
      if (name) text = text.split(` ${name} `).join(' qqname ');
    }
  }
  const words = text.trim().split(' ');
  return words.some((word, i) => PLACE_LEADS.has(word) && couldBeAPlace(words[i + 1]));
}

function qualifierTyped(prompt, named) {
  const clause = targetClause(prompt);
  return [...clause.matchAll(CONTACT_LITERAL_RE)].length > 0 || placeQualifierPresent(clause, named);
}

// The distinct phones and emails a clause types, as lookup literals. Collection stops
// at MAX_CONTACT_LITERALS + 1: the caller only needs to know the budget is exceeded
// (Codex #6369 r9), so a clause stuffed with literals is never fully materialized.
function contactLiteralsOf(clause) {
  const found = new Map();
  for (const match of clause.matchAll(CONTACT_LITERAL_RE)) {
    const email = match[0].includes('@');
    const value = email ? normalizeEmail(match[0]) : match[0].replace(/\D/g, '').slice(-10);
    if (value && (email || value.length === 10)) found.set(`${email ? 'e' : 'p'}${value}`, email ? { email: value } : { phone: value });
    if (found.size > MAX_CONTACT_LITERALS) break;
  }
  return [...found.values()];
}

const tenDigits = value => String(value || '').replace(/\D/g, '').slice(-10);

// The ids a typed name (and, narrowed, a typed city) picks out. Fail closed: a name lookup
// that hit its limit has rows we never saw, so the rows we did see cannot show that a name
// or a city picks out one customer. Incomplete name evidence names nobody.
function nameGroundedIds(namedResult, normalized, marked) {
  const ids = new Set();
  if (namedResult.complete === false) return ids;
  const groups = new Map();
  for (const customer of namedResult.matches || []) {
    const first = normalizeName(customer.first_name), last = normalizeName(customer.last_name);
    // Rows found by a bare first or last name share one group: the name alone cannot tell them apart.
    const full = `${first} ${last}`.trim();
    const key = full.includes(' ') && ` ${normalized} `.includes(` ${full} `) ? full : '*bare name';
    groups.set(key, [...(groups.get(key) || []), customer]);
  }
  for (const group of groups.values()) {
    const only = group.length === 1 ? group : group.filter(customer => cityIsTyped(customer, marked));
    if (only.length === 1) ids.add(String(only[0].id));
  }
  return ids;
}

// One lookup per literal, bounded at two rows: a second row proves the phone or email is
// shared, so it names neither account. No combined limit can hide a duplicate behind other
// literals' rows.
async function contactRows(literal) {
  const rows = await db('customers').whereNull('deleted_at').where(function () {
    if (literal.phone) this.whereRaw("right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ?", [literal.phone]);
    else this.whereRaw("lower(coalesce(email, '')) = ?", [literal.email]);
  }).limit(2).select('id', 'phone', 'email', 'first_name', 'last_name');
  return rows.filter(row => (literal.phone ? tenDigits(row.phone) === literal.phone : normalizeEmail(row.email) === literal.email));
}

// The customers the typed contacts name (a literal that names nobody or several names none).
async function resolveContacts(literals) {
  const owners = new Map();
  for (const literal of literals) {
    const found = await contactRows(literal);
    if (found.length === 1) owners.set(String(found[0].id), found[0]);
  }
  return owners;
}

// The customers THIS message points at, for PICKING a target (the clarification, the card): a
// typed name, a city after it, a phone or email, a "First L., City" reply. It grants no direct
// authority: that comes only from directGroundedIds below (Codex #6369 r23).
async function typedCustomerIds(fullPrompt, namedResult) {
  const prompt = boundedPrompt(fullPrompt);
  const clause = targetClause(prompt);
  const normalized = normalizeName(withoutContacts(clause));
  const marked = normalizeName(withoutContacts(clause).replace(/,/g, ` ${COMMA_TOKEN} `));
  const ids = nameGroundedIds(namedResult, normalized, marked);
  // Work budget (Codex #6369 security P2): a message that types more than MAX_CONTACT_LITERALS
  // phones or emails runs no contact lookup at all.
  const literals = contactLiteralsOf(clause);
  const owners = literals.length > MAX_CONTACT_LITERALS ? new Map() : await resolveContacts(literals);
  for (const id of owners.keys()) ids.add(id);
  for (const id of await initialFormIds(prompt)) ids.add(id);
  return [...ids];
}

// Does the message carry ANY qualifier beside the name: a phone, an email, a record id, a
// "First L., City" reply, or city syntax after the name?
function qualifierPresent(bounded, clause, customer) {
  return contactLiteralsOf(clause).length > 0 || RECORD_ID_RE.test(clause) || INITIAL_FORM_RE.test(bounded)
    || placeQualifierPresent(clause, [customer]);
}
const RECORD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// COMPOUND requests: more than one action verb ANYWHERE in the message, whatever separates them
// ("and", "then", "also", a semicolon, a comma, a newline). targetClause cuts everything from a
// replacement field or a separator on, so a later operation's target is invisible to it; a
// compound request grants no direct authority, typed or on-screen (Codex #6369 pre-push audits, r26).
// Verbs inside a replacement value or a note body are data and are not counted: the value after
// "<field> to", a quoted text, or the text after a colon runs up to the next separator that is
// followed by an action verb ("... notes to gate code 5 and change Sam's phone").
// The supported action vocabulary (PERSON_ACTIONS and the add / remove / assign family). Words that are
// just as often nouns (email, text, call, contact, schedule, invoice...) count as verbs only when they
// start an operation: at the start of the message or right after a separator, "and", "then", "also",
// "please" or "to" ("update the contact" has no second operation; "also text Sam" has).
const STRONG_VERBS = ['update', 'change', 'set', 'edit', 'fix', 'add', 'remove', 'move', 'reschedule', 'assign', 'cancel', 'book', 'mark', 'put', 'replace', 'swap', 'switch', 'delete', 'clear',
  'rename', 'relabel', 'merge', 'archive', 'restore', 'reactivate', 'pause', 'refund', 'notify', 'remind', 'forward', 'resend', 'reply', 'respond', 'send', 'make', 'revise', 'save', 'draft', 'write', 'post', 'submit'];
const NOUNISH_VERBS = ['email', 'text', 'sms', 'message', 'reminder', 'contact', 'quote', 'schedule', 'call', 'charge', 'invoice', 'credit'];
const ACTION_VERBS = new Set([...STRONG_VERBS, ...NOUNISH_VERBS]);
const OPERATION_STARTS = new Set(['qqsep', 'and', 'then', 'also', 'please', 'to']);
const VALUE_START_RE = /\b(?:name|address|email(?:\s+address)?|phone(?:\s+number)?|mobile(?:\s+(?:phone|number))?|cell(?:\s+(?:phone|number))?|number|label|notes?|instructions|message|contact)\s+(?:to|as|is|=)\s+|:/i;
const VALUE_END_RE = new RegExp(`(?:[;\\n,]|\\b(?:and|then|also)\\b)\\s*(?:(?:please|also|then)\\s+)*(?=(?:${[...ACTION_VERBS].join('|')})\\b)`, 'i');

function withoutValues(text) {
  let rest = text.replace(/“[^”]*”|"[^"]*"/g, ' ');
  let kept = '';
  for (let i = 0; i < 50 && rest; i++) {
    const start = VALUE_START_RE.exec(rest);
    if (!start) break;
    kept += `${rest.slice(0, start.index)} `;
    const tail = rest.slice(start.index + start[0].length);
    const end = tail.search(VALUE_END_RE);
    rest = end < 0 ? '' : tail.slice(end);
  }
  return kept + rest;
}

// Each typed customer's own name is stripped first ("Mark Smith" is not the verb "mark").
function isCompound(bounded, customers = []) {
  let text = ` ${normalizeName(withoutValues(bounded).replace(/[;,\n]/g, ' qqsep '))} `;
  for (const customer of customers) {
    for (const name of [fullNameKey(customer), normalizeName(customer.first_name), normalizeName(customer.last_name)]) {
      if (name) text = text.split(` ${name} `).join(' qqname ');
    }
  }
  const words = ['qqsep', ...text.trim().split(' ')];
  return words.filter((word, i) => STRONG_VERBS.includes(word) || (NOUNISH_VERBS.includes(word) && OPERATION_STARTS.has(words[i - 1]))).length > 1;
}

// DIRECT (no-card) authority from typed evidence, in two simple cases only (Codex #6369 r23,
// owner ruling 2026-10-22):
//  1. exactly one typed FULL name that resolves to exactly one customer, and nothing else in the
//     message that could be a qualifier;
//  2. no name at all and exactly one contact literal (one phone or one email) that resolves to
//     exactly one customer, with no city, record id or second contact.
// Any other qualifier (a city, phone, email, record id or second name beside a name, two
// contacts, a name that resolves to nobody or to several customers, a set quantifier) grants
// nothing, so the write is carded. Qualifiers still help PICK a target (typedCustomerIds).
async function directGroundedIds(fullPrompt, namedResult, cohort, nameHint) {
  const bounded = boundedPrompt(fullPrompt);
  const clause = targetClause(bounded);
  const [customer, ...others] = namedResult.matches || [];
  if (cohort || namedResult.complete === false || namedResult.multiple || isCompound(bounded, namedResult.matches)) return [];
  if (!customer) return contactOnlyGroundedIds(bounded, clause, nameHint);
  const full = fullNameKey(customer);
  const typedFull = !others.length && full.includes(' ') && ` ${normalizeName(withoutContacts(clause))} `.includes(` ${full} `);
  return typedFull && !qualifierPresent(bounded, clause, customer) ? [String(customer.id)] : [];
}

// The second simple case: one contact literal, no typed name (a name that was requested but
// resolved to nobody is a typed name), and that contact names exactly one customer.
async function contactOnlyGroundedIds(bounded, clause, nameHint) {
  const literals = contactLiteralsOf(clause);
  if (literals.length !== 1 || nameHint || RECORD_ID_RE.test(clause) || INITIAL_FORM_RE.test(bounded) || placeQualifierPresent(clause)) return [];
  const owners = await resolveContacts(literals);
  return owners.size === 1 ? [...owners.keys()] : [];
}

// A choice button the bar offers when "Full Name, City" is over the 40 characters a button
// holds: "First L., City" (first name, last initial, city). The reply is the whole message.
// It names a customer only when exactly one customer fits all three parts.
const INITIAL_FORM_RE = /^\s*([\p{L}'-]+)\s+([\p{L}])\.\s*,\s*([\p{L}][\p{L} .'-]*?)\s*$/u;
// Customers that fit one "First L., City" reply, at most two (a second row proves the
// label is shared). Normalized first name, last-name initial and city. One predicate for
// both directions: initialFormIds resolves a tapped label with it and choiceLabels
// offers a short label only when it passes it.
async function initialFormRows(first, initial, city) {
  return db('customers').whereNull('deleted_at')
    .whereRaw('? = ?', [normalizedStoredName('first_name'), first])
    .whereRaw('? LIKE ?', [normalizedStoredName('last_name'), `${initial}%`])
    .whereRaw('? = ?', [normalizedStoredName('city'), city])
    .limit(2).select('id');
}

// The same predicate as initialFormRows for many (first name, last initial, city)
// triples in ONE query: per triple, how many customers fit and (for a count of one)
// which. Used by choiceLabels to vet up to 25 short labels at once.
async function initialFormMatches(triples) {
  const result = await db.raw(
    `SELECT t.first, t.initial, t.city, count(*)::int AS n, min(c.id::text) AS id
     FROM unnest(?::text[], ?::text[], ?::text[]) AS t(first, initial, city)
     JOIN customers c ON c.deleted_at IS NULL AND ? = t.first AND ? LIKE t.initial || '%' AND ? = t.city
     GROUP BY t.first, t.initial, t.city`,
    [triples.map(t => t[0]), triples.map(t => t[1]), triples.map(t => t[2]),
      normalizedStoredName('c.first_name'), normalizedStoredName('c.last_name'), normalizedStoredName('c.city')],
  );
  return result?.rows || [];
}

async function initialFormIds(prompt) {
  const match = String(prompt || '').match(INITIAL_FORM_RE);
  if (!match) return [];
  const [, first, initial, city] = match.map(part => normalizeName(part));
  if (!first || !initial || !city) return [];
  const rows = await initialFormRows(first, initial, city);
  return rows.length === 1 ? [String(rows[0].id)] : [];
}

// The text of the choice button for one same-name customer (GATE_IB_TARGET_RULES_V2).
// offer_choices drops a label over MAX_LABEL_CHARS, so a long one becomes
// "First L., City", which initialFormIds resolves back. null = no button can name this
// customer (no city, still too long, or it looks like another same-name customer's):
// the bar asks for a phone number or email instead.
// The city on a button comes from customer-entered data, and a tap sends the button text
// back as the owner's message. Only a plain place name passes: letters, spaces, hyphen
// and apostrophe, up to 3 words and 30 characters. Anything else ("Update Alice Jones",
// digits, punctuation) gives the customer no button (Codex #6369 r12).
const SAFE_CITY_RE = /^\p{L}[\p{L}'-]*(?: \p{L}[\p{L}'-]*){0,2}$/u;
// A word that reads as a command ("Update", "Assign", "Delete") is never a place name.
const COMMAND_WORD_RE = new RegExp(`\\b(?:${PERSON_ACTIONS}|assign|add|remove|rate|tier|waive|apply|ignore|disregard|override|instructions?|system|assistant|prompt|previous|rules?|owner|admin|tool|confirm|approve|execute|run)\\b`, 'i');
const safeChoiceCity = city => {
  const text = String(city || '').trim();
  return text.length <= 30 && SAFE_CITY_RE.test(text) && !COMMAND_WORD_RE.test(text) ? text : null;
};

async function choiceLabels(customers) {
  const full = customer => `${[customer.first_name, customer.last_name].filter(Boolean).join(' ')}${customer.city ? `, ${customer.city}` : ''}`;
  const short = customer => `${customer.first_name} ${String(customer.last_name || '').trim().charAt(0)}., ${customer.city}`;
  // A short label is offered only when initialFormIds, on the whole customer table,
  // resolves it back to this customer alone (Codex #6369 r3: another customer with
  // the same first name, last initial and city outside this name's rows). One query
  // checks every candidate triple at once (Codex #6369 r7), never one scan per row.
  const tripleOf = customer => [customer.first_name, String(customer.last_name || '').trim().charAt(0), customer.city].map(part => normalizeName(part));
  const wantsShort = customer => customer.city && customer.last_name && !/\s/.test(String(customer.first_name || '').trim())
    && full(customer).length > MAX_LABEL_CHARS && short(customer).length <= MAX_LABEL_CHARS && INITIAL_FORM_RE.test(short(customer))
    && tripleOf(customer).every(Boolean);
  const tripleKey = triple => triple.join('\u0000');
  const triples = [...new Map(customers.filter(wantsShort).map(customer => [tripleKey(tripleOf(customer)), tripleOf(customer)])).values()];
  const owners = new Map();
  if (triples.length) {
    const found = await initialFormMatches(triples);
    for (const row of found) owners.set(tripleKey([row.first, row.initial, row.city]), row);
  }
  const labels = customers.map((customer) => {
    if (!safeChoiceCity(customer.city)) return null;
    const whole = full(customer);
    if (whole.length <= MAX_LABEL_CHARS) return whole;
    if (!wantsShort(customer)) return null;
    const owner = owners.get(tripleKey(tripleOf(customer)));
    return owner && Number(owner.n) === 1 && String(owner.id) === String(customer.id) ? short(customer) : null;
  });
  // A label that two customers share (same city and name, or the same first name,
  // last initial and city) cannot pick one of them.
  const key = label => normalizeName(label);
  return labels.map(label => (label && labels.filter(other => other && key(other) === key(label)).length === 1 ? label : null));
}

// The one customer a capped name's typed phone or email resolved to, or null (a PICK for the
// card; it grants no authority). The typed name must name that customer too.
async function contactResolvedCustomer(typedIds, prompt) {
  const customer = typedIds?.length === 1 ? await customerById(typedIds[0]) : null;
  return customer && namesTargetCustomer(normalizeName(withoutContacts(targetClause(prompt))), customer) ? customer : null;
}

// Owner-direct scope only: same-name rows carry a button label and a last visit.
// Outside the scope the candidates are returned as they are.
async function labelledCandidates(scope, candidates, named) {
  if (!scope || candidates.length < 2) return candidates;
  const labels = await choiceLabels(named);
  return (await withLastVisit(candidates)).map((candidate, index) => ({ ...candidate, choice_label: labels[index] }));
}

// Typed identity evidence that FAILED takes the on-screen customer's direct authority too (Codex
// #6369 r26). Page grounding stands when the message names nobody, or names exactly the page
// customer (one name resolving to the page customer, no contact, no place phrase, one operation).
// A name that resolves nowhere or elsewhere, a contact, or a place phrase blocks it.
// Every explicit record id in the message must belong to the page customer (Codex #6369 r28). The
// owners are resolved the way the page's own records are (readReferences, the lookup validateRecordTarget
// relies on). An id with no kind word, one that does not resolve, or one owned by someone else fails.
const RECORD_ID_GLOBAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const KINDED_RECORD_ID_RE = /\b(customer|property|appointment|estimate|invoice|review|email|call|product|lead)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
async function recordIdsBelongToPage(bounded, pageCustomerId) {
  const all = [...bounded.matchAll(RECORD_ID_GLOBAL_RE)].map(match => match[0].toLowerCase());
  if (!all.length) return true;
  const refs = {};
  for (const match of bounded.matchAll(KINDED_RECORD_ID_RE)) (refs[`${match[1].toLowerCase()}_id`] ||= []).push(match[2].toLowerCase());
  const kinded = new Set(Object.values(refs).flat());
  if (all.some(id => !kinded.has(id))) return false;
  const resolved = await readReferences(refs);
  return !resolved.error && customerIds(resolved.records).every(id => String(id) === String(pageCustomerId));
}

async function pageGroundingBlocked(fullPrompt, namedResult, cohort, nameHint, pageCustomerId) {
  const bounded = boundedPrompt(fullPrompt);
  // Record ids hold phone-like digit runs; the ids are judged by recordIdsBelongToPage, not as contacts.
  const clause = targetClause(bounded).replace(RECORD_ID_GLOBAL_RE, ' ');
  const matches = namedResult.matches || [];
  const contacts = contactLiteralsOf(clause).length > 0;
  const place = placeQualifierPresent(clause, matches);
  // A compound request takes the page's authority whatever else it says (pre-push audit, r27).
  if (isCompound(bounded, matches) || !(await recordIdsBelongToPage(bounded, pageCustomerId))) return true;
  if (!nameHint && !contacts && !place) return false;
  const exact = !cohort && namedResult.complete !== false && !namedResult.multiple && matches.length === 1
    && String(matches[0].id) === String(pageCustomerId) && !contacts && !place;
  return !exact;
}

// Owner-direct scope only: the customers this message points at (typedCustomerIds, for picking) and
// the one it names in the simplest case (groundedCustomerIds, the only direct authority).
// typedIds is null outside the scope and `typed` is then empty.
async function typedTarget(scope, prompt, namedResult, cohort, nameHint, pageCustomerId, truncated = false) {
  if (!scope) return { typedIds: null, typed: {} };
  const typedIds = await typedCustomerIds(prompt, namedResult);
  // A request longer than the scan budget is only partly read, but the model sees all of it: fail
  // closed, no typed and no page direct authority (pre-push audit, r27).
  const blocked = truncated || await pageGroundingBlocked(prompt, namedResult, cohort, nameHint, pageCustomerId);
  const grounded = truncated ? [] : await directGroundedIds(prompt, namedResult, cohort, nameHint);
  return { typedIds, typed: { typedCustomerIds: typedIds, groundedCustomerIds: grounded, ...(blocked ? { pageGroundingBlocked: true } : {}) } };
}

// resolve() is a short pipeline. `r` is the shared state; each stage owns one
// concern and returns either a finished result (the pipeline stops) or null (the
// next stage runs). The last stage always returns the context.
async function resolveBase({ prompt: fullPrompt, pageData, selectedTarget, ownerDirectScope = false }) {
  const prompt = targetRulesV2Scope(ownerDirectScope) ? boundedPrompt(fullPrompt) : fullPrompt;
  // Object(null) is {} — an absent or null selection reads as no customer id.
  // Candidate ids come from PostgreSQL in lowercase; a selection may not.
  const selectedId = String(Object(selectedTarget).customer_id || '').toLowerCase() || null;
  const [page, namedResult, filterWords] = await Promise.all([loadPage(pageData, prompt), namedCustomers(prompt, ownerDirectScope), verifiedFilterWords(prompt)]);
  return { prompt, ownerDirectScope, selectedId, page, namedResult, named: namedResult.matches, nameHint: namesRequested(prompt, filterWords),
    truncated: prompt.length < String(fullPrompt).length };
}

const singleTarget = (customer, provenance) => {
  const target = customerTarget(customer, provenance);
  return { target, targets: [target], ambiguous: false };
};

// A stale page hint cannot block an unrelated task or an explicitly named
// customer. A request relying on the unavailable viewed record still stops.
const pageErrorStage = r => (r.page.error && PAGE_REFERENCE_RE.test(targetClause(r.prompt)) && !r.named.length ? r.page : null);

// GATE_IB_TARGET_RULES_V2, owner-direct scope: the on-screen customer is the pick among
// several same-name customers only when the message typed nothing that names a customer.
// A typed city, phone or email (one customer or several) is explicit evidence: it beats
// the page, so there is no on-screen pick and the same-name note handles the choice
// (Codex #6369 r13, pre-push audit). A qualifier typed but resolved to nobody ("in Tampa")
// is still typed: no on-screen pick either (Codex #6369 r15).
function sameNamePick(scope, r) {
  const viewed = r.page.customer;
  // Only duplicates of ONE typed name are a same-name ambiguity the page can settle; a bare name
  // that matches different full names never selects the viewed customer (Codex #6369 r20). Any
  // typed qualifier, resolved or not, leaves the clarification (r23: the qualifier-confirms branch
  // is retired).
  return scope && r.sameName && viewed && r.typedIds.length === 0 && !qualifierTyped(r.prompt, r.named) ? viewed : null;
}

// Candidates, whom this message points at (typedCustomerIds, for picking) and the one it names
// in the simplest case (groundedCustomerIds, the only direct authority), and the first selection.
// Are these rows duplicates of ONE typed name: two or more customers with the same
// normalized full name, and no set quantifier or second named customer in the message?
// Two DIFFERENT named customers ("Alice Example and Bob Sample") are a cohort, not a
// same-name ambiguity (Codex #6369 r18).
const fullNameKey = customer => `${normalizeName(customer.first_name)} ${normalizeName(customer.last_name)}`.trim();
const isSameNameGroup = (named, cohort) => !cohort && named.length > 1 && new Set(named.map(fullNameKey)).size === 1;

async function candidatesStage(r) {
  const scope = targetRulesV2Scope(r.ownerDirectScope);
  // A set quantifier, partly resolved name evidence, or two distinct stated
  // recipients never yields a target, and no selection resolves it.
  r.cohort = setQuantified(r.prompt) || r.namedResult.multiple;
  r.sameName = scope && isSameNameGroup(r.named, r.cohort);
  r.candidates = await labelledCandidates(r.sameName, r.named.map(c => customerTarget(c, 'current_request_lookup')), r.named);
  Object.assign(r, await typedTarget(scope, r.prompt, r.namedResult, r.cohort, r.nameHint, r.page.customer?.customer_id || r.page.ids?.customer_id, r.truncated));
  r.selection = candidateSelection(r.candidates, r.prompt, r.page.customer, r.namedResult.complete, r.cohort, r.nameHint, sameNamePick(scope, r));
  return null;
}

// A selection is bound to this request's own fresh candidates: it is accepted only
// as one of the rows the request resolved to (duplicate-name disambiguation, the one
// flow that supplies a selection). A request that named nobody, matched nothing, hit
// the lookup cap, or asked for a set has no candidate to select, so no
// stale-selection grammar is load-bearing: an unrecognized phrasing can only over-refuse.
async function selectionStage(r) {
  if (!r.selectedId) return null;
  const selected = r.named.some(c => c.id === r.selectedId) && !r.cohort && r.namedResult.complete ? await customerById(r.selectedId) : null;
  // selectable: a fresh customer choice re-resolves this request.
  if (!selected) return { error: 'The selected customer conflicts with the current request', code: 'context_mismatch', selectable: true };
  r.selection = singleTarget(selected, 'operator_selection');
  return null;
}

// A lookup at its cap has more rows than it can list, and no listed row can be
// selected, so the rows are never presented as choices. A phone or email that names
// exactly one of them resolves that customer (Codex #6369 r10); otherwise the request
// is answered and closed with the way to identify the customer instead of parked
// behind buttons that all conflict.
async function cappedStage(r) {
  if (r.namedResult.complete || r.cohort || r.selectedId) return null;
  const pick = await contactResolvedCustomer(r.typedIds, r.prompt);
  if (pick) { r.selection = singleTarget(pick, 'current_request_lookup'); return null; }
  return { page: r.page, candidates: [], target: null, targets: [], ambiguous: false,
    error: 'More customers share this name than one lookup can list, so none can be selected here. Identify the customer by phone or email, or start the request from their customer page.',
    code: 'target_clarification_required', requestPhrase: normalizeName(targetClause(r.prompt)), namesRequested: r.nameHint, ...r.typed };
}

// The record ids the message asks for: "this property" style page references, an
// explicit review, and explicit child ids that narrow even same-customer operations.
function requestedRecordFields(prompt, page, nameHint) {
  const reviewClause = targetClause(prompt);
  const [explicitReview] = [...reviewClause.matchAll(/\breview\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map(match => match[1].toLowerCase());
  const reviewReference = explicitReview || (!nameHint
    && /\b(?:this|that|current|selected|viewed|open)\s+review\b/i.test(reviewClause) ? page.ids.review_id : null);
  const requestedRecords = Object.fromEntries([...targetClause(prompt, true).matchAll(/\b(?:this|that|current|selected|viewed|open)\s+(property|appointment|stop|visit|estimate|invoice|review|email|call|product|lead)\b/gi)]
    .map(match => { const kind = `${recordKind(match[1])}_id`; return [kind, page.ids[kind] || null]; }));
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
  return { requestedRecords, reviewReference: reviewReference || null };
}

// Only the leading recipient expression establishes a raw contact. A later
// "text <number>" inside a note or an unresolved person's message is data.
function recipientFields(prompt) {
  const recipient = [...targetClause(prompt).matchAll(/^(?:(?:please|can you|could you|would you|will you|i need you to|i'd like you to)\s+)*(?:text|message|sms|email|reply\s+to|respond\s+to|send(?:\s+(?:a|an))?(?:\s+(?:text|sms|message|reminder|email|reply))?\s+to)\s+(?:to\s+)?(.+)/gi)].map(match => match[1]).join('');
  const readRecipient = targetClause(prompt).match(/^(?:(?:please|can you|could you|would you|will you)\s+)*(?:(?:show|read|get|find|look up|check|summarize)\s+(?:(?:the|our)\s+)?(?:customer\s+)?(?:conversation|thread|messages|texts|sms|calls|call history|details|history)\s+(?:with|for|from|to|on)|what\s+(?:did|have)\s+we\s+(?:say|send|said|sent)\s+to(?:\s+(?:the\s+)?customer\s+on)?)\s+(.+)/i)?.[1] || '';
  return {
    explicitEmails: [...recipient.matchAll(/^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)]
      .map(match => normalizeEmail(match[1])),
    explicitPhones: [...recipient.matchAll(/^((?:\+?1[ .-]*)?(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4})(?!\d)/g)]
      .map(match => match[1].replace(/\D/g, '').slice(-10)),
    explicitReadPhones: [...readRecipient.matchAll(/^((?:\+?1[ .-]*)?(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4})(?!\d)/g)]
      .map(match => match[1].replace(/\D/g, '').slice(-10)),
  };
}

function contextStage(r) {
  const { prompt, page, nameHint } = r;
  return { page, candidates: r.candidates, ...(r.sameName ? { sameName: true } : {}), ...r.selection, ...r.typed, ...requestedRecordFields(prompt, page, nameHint), requestPhrase: normalizeName(targetClause(prompt)),
    // An explicitly named customer that did not resolve keeps the request
    // target-specific: broad customer-row readers stay refused until it does.
    namesRequested: nameHint,
    // A phone or email literal in the target clause identifies one customer
    // even when no send/read recipient grammar captured it.
    contactRequested: [...targetClause(prompt).matchAll(CONTACT_LITERAL_RE)].length > 0,
    bulkLeadRequest: !nameHint && /\b(?:all|bulk)\b.*\bleads\b/i.test(targetClause(prompt)),
    ...recipientFields(prompt) };
}

const RESOLVE_STAGES = [pageErrorStage, candidatesStage, selectionStage, cappedStage, contextStage];

async function resolve(input) {
  const r = await resolveBase(input);
  for (const stage of RESOLVE_STAGES) {
    const result = await stage(r);
    if (result) return result;
  }
  return null;
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

// Per-tool data scope comes from action-policy.json (see scope-policy.js).
// A tool whose scope is missing or invalid is refused here as well as by the
// registry, so no caller can reach an unclassified reader or writer.
const { validScope, scopeOf, UNCLASSIFIED } = require('./scope-policy');
// The outside-write tools (Sentry/Cloudflare/Railway/GitHub/GSC, owner ruling
// 2026-09-28) are declared scope:'none' in action-policy.json because they
// touch no customer RECORD — but their unconfirmed preview does a live
// provider read that returns free text with nothing to do with any customer
// (a Sentry issue title/culprit, a GitHub PR title, a Cloudflare branch
// name). Their read equivalents (get_sentry_top_issues, etc.) are scope
// 'broad' and refused inside a customer-scoped task by readScopeRefusal;
// 'broad' is not a valid WRITE scope (scope-policy.js/its registry test pin
// that), so this refusal is instead an explicit check here, mirroring the
// route_wide branch just below (Codex r3 P1 on #5275).
const { OUTSIDE_WRITE_TOOL_NAMES } = require('./write-gates');

// A request about one customer: a resolved target, an unresolved name, or a
// phone/email literal that identifies the customer.
const customerSpecific = context => Boolean(context.targets?.length || context.namesRequested || context.contactRequested);

// Readers whose appointment selector is not named appointment_id: the
// closeout readers take service_id and the gap reader tests candidate_service_id
// (it loads that appointment's customer preferences, plan holds and location).
// repair_closeout acts on that same service_id, so a customer-scoped task may
// only repair its own customer's visit.
const APPOINTMENT_SELECTORS = { get_closeout_status: 'service_id', repair_closeout: 'service_id', get_stop_details: 'service_id', find_schedule_gaps: 'candidate_service_id' };
// Writers whose customer records ride under role-named ids: both halves of a
// merge are customer records, read as the customer collection (readReferences
// loads and version-stamps every one). The task must own ONE half directly;
// the other is admitted only as an eligible duplicate-queue candidate under
// that exact pairing (see the CUSTOMER_PAIR_SELECTORS use in validateRecordTarget).
const CUSTOMER_PAIR_SELECTORS = { merge_customers: ['winner_customer_id', 'loser_customer_id'] };
const customerPairIds = (params, toolName) => (CUSTOMER_PAIR_SELECTORS[toolName] || []).map(key => params[key]).filter(Boolean);

// Address-bound readers (lookup_property, and find_available_slots inside a
// customer-scoped task) take a model-supplied address. It must be one of the
// task customers' ACTIVE saved properties (the customer address or a service
// property), compared as a full address with the estimator's canonical
// comparer: same street and exact unit, and no conflicting city or ZIP. The
// reader then receives the saved property's own full address, never the
// supplied text, so "123 Main St, Tampa" cannot ride a customer saved at
// "123 Main St, Bradenton" and a bare street line cannot resolve a
// different parcel on a repeated street name. A saved row with neither city
// nor ZIP cannot verify any locality (the comparer treats a missing side as
// compatible), so it never binds; rows carrying both are tried first. Every
// locality component the supplied text carries (city, state, ZIP) must be
// present on the saved row and equal to it: the comparer ignores state and
// a missing side, so "99 Beach Rd, Venice CA" or a ZIP the saved row lacks
// would otherwise bind and be rewritten to the saved parcel.
// Returns the saved row's full address and its stored coordinates (null when
// the row has none).
function unrecognizedStateSegment(text, parsed, suppliedState, cityKey, normalizeState) {
  // A trailing country is not a state segment whether or not a comma precedes
  // it (the parser strips the comma form; "FL 34285 USA" reaches its state
  // read intact and would otherwise leave "FL USA" here).
  const parts = text.replace(/[\s,]+(?:u\.?s\.?a?\.?|united states(?: of america)?)\.?\s*$/i, '').split(',').map(part => part.trim()).filter(Boolean);
  const cityIndex = parts.findIndex(part => cityKey(part) === cityKey(parsed.city));
  if (parts.length < 3 || cityIndex < 1) return false;
  const letters = parts.slice(cityIndex + 1).join(' ').replace(/[^a-z\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  return Boolean(letters) && (!suppliedState || (normalizeState(letters) || '') !== suppliedState);
}

async function bindSavedAddress(supplied, targets) {
  const { sameStreetAddress } = require('../estimator-engine/address-compare');
  const { formatAddress, parseRawAddress, normalizeState } = require('../../utils/address-normalizer');
  const text = String(supplied || '').trim();
  if (!text) return null;
  const parsed = parseRawAddress(text);
  const cityKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const zip5 = value => String(value || '').replace(/\D/g, '').slice(0, 5);
  // A comma-free numbered route or post-directional leaves a bare number or
  // direction in the parsed city; neither is a locality.
  const BARE_DIRECTIONAL = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
  const suppliedCity = /[a-z]{2,}/i.test(parsed.city || '') && !BARE_DIRECTIONAL.has(String(parsed.city).toLowerCase()) ? cityKey(parsed.city) : '';
  const suppliedState = normalizeState(parsed.state || '') || '';
  const suppliedZip = zip5(parsed.zip);
  // The parser drops a state segment it cannot recognise ("ZZ", "Ontario"),
  // which would read as "no state supplied" and let the saved state stand in
  // for it. Any letters left after the city segment that are not the parsed
  // state are an unverifiable locality, so the text binds to nothing.
  if (unrecognizedStateSegment(text, parsed, suppliedState, cityKey, normalizeState)) return null;
  const localityVerified = row => (!suppliedCity || cityKey(row.city) === suppliedCity)
    && (!suppliedState || (normalizeState(row.state || '') || '') === suppliedState)
    && (!suppliedZip || zip5(row.zip) === suppliedZip);
  const ids = targets.map(target => target.customer_id);
  const fields = ['address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude'];
  const [customers, properties] = await Promise.all([
    db('customers').whereIn('id', ids).whereNull('deleted_at').select(fields),
    db('customer_properties').whereIn('customer_id', ids).where('active', true).select(fields),
  ]);
  const coordinate = value => (value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value));
  const present = value => Boolean(String(value || '').trim());
  const saved = [...customers, ...properties]
    .filter(row => present(row.address_line1) && (present(row.city) || present(row.zip)))
    .sort((a, b) => Number(present(b.city) && present(b.zip)) - Number(present(a.city) && present(a.zip)))
    .map(row => ({
      row,
      address: formatAddress({ line1: row.address_line1, line2: row.address_line2, city: row.city, state: row.state, zip: row.zip }),
      lat: coordinate(row.latitude), lng: coordinate(row.longitude),
    }));
  // A bare street line that matches two different saved parcels (the same
  // street and unit in two cities) names neither; the caller must supply the
  // locality. Duplicate rows for one parcel (customer row + property row)
  // are one match.
  const matches = saved.filter(({ row, address }) => localityVerified(row) && sameStreetAddress(text, address, { requireExactUnit: true }));
  const { addressKey } = require('../customer-properties');
  const parcels = new Set(matches.map(({ row }) => addressKey(row)));
  const match = parcels.size === 1 ? matches[0] : null;
  return match ? { address: match.address, lat: match.lat, lng: match.lng } : null;
}

async function validateRecordTarget(params, context = {}, { toolName, forApproval = false } = {}) {
  // Owner-direct (owner ruling 2026-10-01, owner-direct.js): for the owner
  // login the record the bar picks IS the target, so the request-text
  // authority checks below — ambiguous cohort, customer-scoped task vs a
  // route-wide or outside write, a name without its id, a record the request
  // did not name — do not refuse. The data checks stay for everyone: a
  // malformed or missing record (readReferences) and a record that belongs to
  // a different customer than the same call names (relationshipFailure).
  // The flag is set by the route from the live request, never by tool input.
  const direct = context.ownerDirect === true;
  // A refused cohort or unresolved name stops here too; explicit record IDs
  // inside "both appointment A and appointment B" do not reopen it.
  if (context.ambiguous && !direct) return { error: 'Name one customer for this action', code: 'target_clarification_required' };
  // Every caller names the tool; a call without one has no reviewed scope
  // and is refused like an unclassified tool rather than admitted.
  const scope = scopeOf(toolName);
  if (!scope) return UNCLASSIFIED;
  const policy = require('./action-policy.json')[toolName];
  // Route-wide writers act on every stop for a date or technician and carry no
  // record identifiers. A customer-scoped task cannot mint an approval for
  // them: the stored action would have no references for the confirm-time
  // recheck. An explicitly named customer who did not resolve keeps the task
  // customer-scoped (as for the broad readers), so a misspelling never widens
  // a request to a whole date or technician.
  if (scope === 'route_wide' && customerSpecific(context) && !direct) {
    return { error: 'This action changes every stop for the date or technician. Run it from a request that does not name a customer, or move that customer\'s own stops by id.', code: 'customer_scope_required' };
  }
  // Outside-write tools carry no customer selector to check below (their
  // scope is 'none'), so without this they would be silently admitted inside
  // a customer-scoped task even though their preview pulls in unrelated
  // provider text — the same leak readScopeRefusal already blocks for their
  // 'broad' read equivalents.
  if (OUTSIDE_WRITE_TOOL_NAMES.has(toolName) && customerSpecific(context) && !direct) {
    return { error: 'This action reaches an outside service, not this customer\'s records. Run it from a request that does not name a customer.', code: 'customer_scope_required' };
  }
  if (!direct && policy.kind !== 'read' && [['customer_name', 'customer_id'], ['lead_name', 'lead_id']].some(([name, id]) => params[name] && !params[id])) {
    return { error: 'Resolve the named target to its canonical record identifier before proposing this action', code: 'target_clarification_required' };
  }
  const references = { ...params };
  const appointmentSelector = params[APPOINTMENT_SELECTORS[toolName]];
  if (appointmentSelector) references.appointment_id = appointmentSelector;
  if (params.estimate_identifier) references.estimate_id = params.estimate_identifier;
  // resend_receipt (and send_invoice) may name the invoice by number: bind it as
  // the invoice record so a customer-scoped task proves the invoice is its own customer's.
  if (['resend_receipt', 'send_invoice', 'record_payment', 'void_invoice'].includes(toolName) && params.invoice_number && !params.invoice_id) {
    const invoice = await db('invoices').where({ invoice_number: String(params.invoice_number).trim().toUpperCase() }).first('id');
    if (!invoice) return { error: 'A referenced record is unavailable', code: 'record_unavailable' };
    references.invoice_id = invoice.id;
  }
  const pair = customerPairIds(params, toolName);
  if (pair.length) references.customer_ids = [...(Array.isArray(params.customer_ids) ? params.customer_ids : []), ...pair];
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
  // The owner-direct exemption rides on the approval proof (pre-push P1):
  // the confirm-time re-check runs the request-scope refusals above against
  // this proof, and a route-wide or outside write the owner proposed with a
  // customer target would otherwise be refused at Confirm after its approval
  // was consumed. The proof is server-minted and hashed into the stored
  // params, so the flag cannot be added afterwards.
  const accepted = forApproval ? {
    targets: (context.targets || []).map(({ customer_id }) => ({ customer_id })),
    references: records.map(({ kind, id }) => ({ kind, id })),
    actionBinding, recordsBinding,
    ...(direct ? { ownerDirect: true } : {}),
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
  // Pair authority: the task establishes at most ONE customer target, so a
  // merge naming a duplicate pair otherwise always fails missingTarget below
  // — the operator's task could equally be on the stub page (the loser) or
  // the real customer's page (the winner). Admit the OTHER half only when it
  // is a live, eligible duplicate-queue candidate under this EXACT
  // winner/loser pairing — the canonical check customer-dedupe.js owns
  // (never re-derived here). Neither permitted, or the pair ineligible: the
  // missingTarget refusal below stands unchanged.
  const pairSelectors = CUSTOMER_PAIR_SELECTORS[toolName];
  if (pairSelectors) {
    // Canonical lowercase (codex #4348 r5 P2): task targets and record ids
    // are stored lowercase; an uppercase-but-valid UUID pair must reach the
    // eligibility check, not fall through to missingTarget.
    const [winnerId, loserId] = pairSelectors.map(key => (params[key] ? String(params[key]).trim().toLowerCase() : params[key]));
    if (winnerId && loserId && permitted.has(winnerId) !== permitted.has(loserId)) {
      const { duplicatePairEligibility } = require('../customer-dedupe');
      const eligibility = await duplicatePairEligibility(winnerId, loserId);
      if (eligibility.eligible) permitted.add(permitted.has(winnerId) ? loserId : winnerId);
    }
  }
  const missingTarget = !direct && customerIds(records).some(id => !permitted.has(id));
  const unlinkedTarget = !direct && (await Promise.all(records.map(r => unlinkedRecordIsReferenced(r, context)))).some(allowed => !allowed);
  if (missingTarget || unlinkedTarget) return {
    error: 'Choose the target for this action; the current request has not established it',
    code: 'target_clarification_required', candidates: context.candidates || [],
  };
  if (toolName === 'send_sms' && params.phone) {
    const phone = String(params.phone).replace(/\D/g, '').slice(-10);
    const customer = records.find(r => r.kind === 'customer_id');
    const matchesCustomer = customer && String(customer.phone || '').replace(/\D/g, '').slice(-10) === phone;
    if (customer && !matchesCustomer) return { error: 'The message recipient does not match the target customer', code: 'target_relationship_mismatch' };
    if (!customer && !direct && (permitted.size || !context.explicitPhones?.includes(phone))) return { error: 'Select the customer or explicitly provide the recipient number', code: 'target_clarification_required' };
  }
  return accepted;
}

// Resolve name/phone selectors to one of the task's known customers, then pass
// the immutable ID to existing readers. Broad searches without a selector stay
// broad. No fuzzy result or model-selected alternate contact becomes authority.
// The read scope classes are defined once, in scope-policy.js; the guards
// below enforce them. A customer selector or a record identifier is checked
// against the task's authority further down, so only a selector-free call is
// broad. `service_id` is the closeout readers' appointment identifier and
// `candidate_service_id` the gap reader's (both mapped in validateRecordTarget).
const hasRecordReference = params => Object.keys(RECORDS).some(kind => params[kind] || params[ALIASES[kind]] || params[COLLECTIONS[kind]]);
const hasOwnSelector = params => Boolean(params.customer_id || params.customer_name || params.phone || params.service_id || params.candidate_service_id)
  || hasRecordReference(params);
// Record readers whose selector-free mode reads no customer-identifying rows:
// the gap reader without a candidate returns per-technician minute budgets
// only (the executor strips appointment ids). Such a call has nothing to
// inherit from the task customer, so an unresolved name does not close it.
const SELECTOR_FREE_READS_NO_CUSTOMER_ROWS = new Set(['find_schedule_gaps']);

// Scope admission for a read inside a customer-specific request. A request
// about one customer — a resolved target, an unresolved name, or a
// phone/email literal that identifies the customer — never widens into a
// reader that lists every customer; one whose customer did not resolve gives
// the scoped readers an empty read scope, the record readers no customer to
// inherit, and the keyed readers nobody to bind their key to. A scoped
// reader that names a record (an email id for a reply draft) reaches
// validateRecordTarget instead, where the explicitly addressed sender's
// unique unlinked thread is the only thing that admits it; a name or phone
// selector does not reopen a scoped reader.
const SCOPE_REFUSALS = {
  broad: 'This lookup lists every customer. Inside a task for a specific customer, use a reader that takes the task customer (customer detail, scoped customer, lead, schedule or email searches).',
  actor_wide: 'Past-conversation search returns verbatim exchanges about any customer and cannot be limited to the task customer, so it is unavailable inside a task for a specific customer.',
};
function readScopeRefusal(scope, params, context, { toolName, schema }) {
  if (!customerSpecific(context)) return null;
  if (SCOPE_REFUSALS[scope]) return { error: SCOPE_REFUSALS[scope], code: 'customer_scope_required' };
  if (context.targets?.length || SELECTOR_FREE_READS_NO_CUSTOMER_ROWS.has(toolName)) return null;
  if (['phone_keyed', 'email_keyed', 'address_keyed'].includes(scope)) {
    return { error: 'The named customer did not match anyone on file, so this lookup has no customer to verify its phone, email or address against. Correct the name before reading by contact or address.', code: 'customer_scope_required' };
  }
  const selectorFree = scope === 'scoped' ? !hasRecordReference(params) : (scope === 'record' || schema.properties?.customer_id) && !hasOwnSelector(params);
  return selectorFree ? { error: 'The named customer or contact did not match anyone on file, so this lookup has no customer scope. Correct the name or contact before reading that customer\'s records.', code: 'customer_scope_required' } : null;
}

// Keyed readers without a customer selector: the phone or email must belong
// to a task customer, so a model-supplied key cannot read another party's
// call history or suppression state.
const KEYED_READERS = {
  phone_keyed: { field: 'phone', column: 'phone', key: value => String(value || '').replace(/\D/g, '').slice(-10), error: 'Use the task customer\'s own phone number for this call history' },
  email_keyed: { field: 'email', column: 'email', key: normalizeEmail, error: 'Use the task customer\'s own email address for this suppression check' },
};
async function keyedOwnerRefusal(scope, params, context) {
  const keyed = KEYED_READERS[scope];
  if (!keyed) return null;
  const supplied = keyed.key(params[keyed.field]);
  const owners = await db('customers').whereIn('id', context.targets.map(target => target.customer_id)).whereNull('deleted_at').select(keyed.column);
  return supplied && owners.some(owner => keyed.key(owner[keyed.column]) === supplied) ? null : { error: keyed.error, code: 'target_clarification_required' };
}

// Address-bound readers inside a customer-scoped task. lookup_property's
// address must be one of the task customers' own active saved addresses and
// the reader receives that saved address, so a substituted or partial address
// cannot expose or price another property. The slot finder's destination is
// the task customer: supplied coordinates are dropped (the reader resolves
// the customer's own) and a supplied address is bound the same way, carrying
// that property's stored coordinates so a secondary property is searched
// around itself rather than the primary address. Otherwise the neighbouring
// stops it returns would describe whatever location the model chose.
async function bindReadAddress(scope, params, input, context, toolName) {
  const slotSearch = toolName === 'find_available_slots';
  if (slotSearch) {
    delete input.lat;
    delete input.lng;
  }
  if (scope !== 'address_keyed' && !(slotSearch && params.address !== undefined)) return null;
  const bound = await bindSavedAddress(params.address, context.targets);
  if (!bound) {
    return { error: slotSearch ? 'Use the task customer\'s own saved address as the slot-search destination' : 'Use the task customer\'s own saved address for this property lookup', code: 'target_clarification_required' };
  }
  input.address = bound.address;
  if (slotSearch && bound.lat != null && bound.lng != null) Object.assign(input, { lat: bound.lat, lng: bound.lng });
  return null;
}

// Resolve a name or phone selector to one of the task's known customers and
// pass the immutable id to the reader. A current-request phone may establish
// a unique read target only: it stays out of the task's write authority and
// a model substitute is never accepted.
async function resolveCustomerSelector(params, input, context, schema) {
  const digits = value => String(value || '').replace(/\D/g, '').slice(-10);
  const permitted = new Set(context.targets.map(target => target.customer_id));
  const named = params.customer_name ? await namedCustomers(`for ${params.customer_name}`, context.ownerDirect === true) : null;
  // A capped name lookup beside another selector cannot be reconciled with
  // it, so it is refused as a conflict the owner-direct fallback never
  // forwards (Codex r6 P2); alone it stays a scope question.
  if (named?.complete === false) {
    const others = [params.customer_id, params.phone].filter(Boolean).length;
    return others
      ? { error: 'The customer name matches too many customers to check against the customer id or phone on this lookup', code: 'selector_conflict' }
      : { error: 'The customer name lookup is incomplete. Select the task customer by identifier.', code: 'target_clarification_required' };
  }
  const matches = named ? named.matches : await db('customers').whereNull('deleted_at')
    .whereRaw("RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = ?", [digits(params.phone)])
    .select(CUSTOMER_FIELDS);
  const explicitRead = !permitted.size && params.phone && !params.customer_name && context.explicitReadPhones?.includes(digits(params.phone));
  // Two selectors on one call that name different customers (a name plus
  // another customer's id, or a phone another customer carries) are a data
  // conflict, not a scope question: refused for every login with a code the
  // owner-direct fallback never bypasses (Codex r3 on #5563), because the
  // readers resolve customer_id before customer_name and would answer about
  // the id while the owner asked about the name.
  // Every supplied selector must fit ONE matched row (a shared name with
  // customer A's id and customer B's phone fits none), judged before task
  // authority narrows the matches so an empty or unrelated task scope cannot
  // turn the conflict into a bypassable scope refusal (pre-push on r3).
  const suppliedId = params.customer_id ? String(params.customer_id).toLowerCase() : null;
  const fitsEverySelector = customer => (!suppliedId || customer.id === suppliedId)
    && (!params.phone || digits(customer.phone) === digits(params.phone));
  // Any two selectors that no single customer satisfies — a name that
  // matched nobody beside an id, an id beside a phone nobody carries — are a
  // conflict too (Codex r4): the reader would answer about one selector
  // while the operator supplied another it could not reconcile.
  const selectorCount = [params.customer_name, suppliedId, params.phone].filter(Boolean).length;
  const fitting = matches.filter(fitsEverySelector);
  if (selectorCount >= 2 && !fitting.length) {
    return { error: 'The customer name, phone and customer id on this lookup do not name the same customer', code: 'selector_conflict' };
  }
  // Task authority narrows the FITTING rows only: a customer every selector
  // agrees on who sits outside the task is a scope question (bypassable for
  // the owner login), not a conflict.
  const selected = explicitRead ? fitting : fitting.filter(customer => permitted.has(customer.id));
  const customer = selected.length === 1 ? await customerById(selected[0].id) : null;
  if (!customer) return { error: 'Use the resolved task customer for this record lookup', code: 'target_clarification_required' };
  input.customer_id = customer.id;
  delete input.customer_name;
  if (params.phone && schema.properties.phone && customer.phone) input.phone = customer.phone;
  else delete input.phone;
  return { readContext: explicitRead ? { ...context, targets: [customerTarget(customer, 'current_request_read_lookup')] } : context };
}

// A selector-free reader that takes customer_id inherits the single task
// customer; two task customers need an explicit choice.
function inheritTaskCustomer(input, context, schema) {
  if (!schema.properties?.customer_id || input.customer_id || !context.targets?.length) return null;
  if (context.targets.length !== 1) return { error: 'Select one of the task customers for this record lookup', code: 'target_clarification_required' };
  input.customer_id = context.targets[0].customer_id;
  return null;
}

// Owner-direct reads (owner ruling 2026-10-01): the scoped preparation below
// still runs first, so a read that fits the task keeps its bound customer id
// and saved address. Only when it would refuse for request-text authority
// (which customer the request named) does the reader get the call as the
// model made it — the same input the non-platform path executes. A data
// refusal (invalid id, missing record, cross-customer mismatch) stands.
const OWNER_DIRECT_READ_CODES = new Set(['target_clarification_required', 'customer_scope_required']);
async function prepareReadInput(params, context, options) {
  const prepared = await prepareScopedReadInput(params, context, options);
  if (prepared.error && context?.ownerDirect === true && OWNER_DIRECT_READ_CODES.has(prepared.code)) return { input: { ...params }, widened: true };
  return prepared;
}

// A general admin read (read_admin_data) is as narrow as the reviewed row of
// the endpoint it names: a customer or invoice row reads one record, so inside
// a task for a specific customer its id must be that task's customer's own
// (same check, same refusal as every record reader); a broad row keeps the
// tool's `broad` class and is refused there. No customer task: nothing to
// compare against, the read runs as before.
async function prepareCatalogRead(params, context, binding, toolName) {
  if (!customerSpecific(context)) return { input: { ...params } };
  const bag = binding.inPath ? params.params : params.query;
  const raw = bag && typeof bag === 'object' ? bag[binding.param] : undefined;
  if (typeof raw !== 'string' || !UUID_RE.test(raw.trim())) {
    return { error: 'Give the customer or invoice id this read is about, so it can be checked against the customer in this task', code: 'customer_scope_required' };
  }
  const id = raw.trim().toLowerCase();
  const invalid = await validateRecordTarget({ [binding.kind]: id }, context, { toolName });
  if (invalid) return invalid;
  const input = { ...params, [binding.inPath ? 'params' : 'query']: { ...bag, [binding.param]: id } };
  return { input };
}

async function prepareScopedReadInput(params, context, { toolName, schema }) {
  // A refused cohort never widens into an unscoped read; an unresolved
  // explicit name is handled by readScopeRefusal, which still admits a
  // reader that carries its own selector or record identifier.
  if (context.ambiguous) return { error: 'Name one customer for this record lookup', code: 'target_clarification_required' };
  const binding = toolName === 'read_admin_data' ? require('./admin-read-tools').scopeBinding(params) : null;
  if (binding) return prepareCatalogRead(params, context, binding, toolName);
  const policy = require('./action-policy.json')[toolName];
  const scope = validScope(policy) ? policy.scope : null;
  if (!scope) return UNCLASSIFIED;
  const refused = readScopeRefusal(scope, params, context, { toolName, schema });
  if (refused) return refused;
  const input = { ...params };
  if (context.targets?.length) {
    const bound = await keyedOwnerRefusal(scope, params, context) || await bindReadAddress(scope, params, input, context, toolName);
    if (bound) return bound;
  }
  let readContext = context;
  if (schema.properties?.customer_id && (params.customer_name || params.phone)) {
    const resolved = await resolveCustomerSelector(params, input, context, schema);
    if (resolved.error) return resolved;
    readContext = resolved.readContext;
  }
  // A `scoped` reader is already confined to every task customer by the
  // task's read scope (readCustomerIds), so its optional customer_id is a
  // narrower filter the caller may add, never one to inherit: inheriting
  // would refuse a two-customer task that the read scope serves today.
  const inherited = scope === 'scoped' ? null : inheritTaskCustomer(input, context, schema);
  if (inherited) return inherited;
  const invalid = await validateRecordTarget(input, readContext, { toolName });
  return invalid || { input };
}

// Owner-direct task context: whatever resolve() concluded — an unresolved or
// duplicated name, a second person in the request, a stale page record, a
// rejected selection — the request still runs. A uniquely resolved customer
// stays the task target (readers inherit it); nothing else is a target and
// nothing is refused for it. The page ids survive as hints only.
function ownerDirectContext(context = {}) {
  const { error: _error, code: _code, selectable: _selectable, ...rest } = context;
  const targets = Array.isArray(rest.targets) ? rest.targets : [];
  return { ...rest, page: rest.page || { ids: {}, records: {} }, candidates: rest.candidates || [],
    target: rest.target || null, targets, requestedRecords: rest.requestedRecords || {},
    ambiguous: false, ownerDirect: true,
    ...(ibTargetRulesV2Live() && context.typedCustomerIds ? sameNameNote(context) : {}) };
}

// GATE_IB_TARGET_RULES_V2: what the model is told about customers that share
// the name the owner typed. The rows (name, city, last visit) are already in
// `candidates`; the note says what to do with them. offer_choices shows 4
// buttons at most, so a longer list is offered by the most recent visits.
function sameNameNote(context) {
  const rows = Array.isArray(context.candidates) ? context.candidates : [];
  if (context.code === 'target_clarification_required') {
    return { sameNameNote: `More than ${CUSTOMER_LOOKUP_LISTED_V2} customers share the name the owner typed. Ask for a phone number or an email, or ask the owner to open the customer's page. A name or a city cannot pick one customer from a list this long.` };
  }
  if (rows.length < 2 || context.target || context.sameName !== true) return {};
  // A reply that already narrows the name to one (a choice button sends
  // "Full Name, City"; a typed phone or email works the same) is the owner's
  // pick: no second round of choices.
  const typed = new Set((context.typedCustomerIds || []).map(String));
  const picked = rows.filter(row => typed.has(String(row.customer_id)));
  if (picked.length === 1) {
    return { sameNameNote: `The owner's message picks one of the customers who share this name: ${picked[0].label}${safeChoiceCity(picked[0].city) ? `, ${safeChoiceCity(picked[0].city)}` : ''} (customer_id ${picked[0].customer_id}). Use that customer. Do not offer choices again.` };
  }
  // offer_choices needs two buttons at least. With fewer than two usable labels, a
  // button list cannot name the customer: ask for a phone number or email.
  const usable = rows.filter(row => row.choice_label).length;
  if (usable < 2) {
    return { sameNameNote: `${rows.length} customers share the name the owner typed (see candidates: label, city, last_visit). Do not guess. Ask the owner for a phone number or an email to tell them apart.` };
  }
  return { sameNameNote: `${rows.length} customers share the name the owner typed (see candidates: label, city, last_visit). Do not guess and do not ask for a phone number. Call offer_choices with the choice_label of the best matches (4 at most), most recent last_visit first, each label exactly as written: it is the button text, and a tap sends it back as the owner's reply. A row whose choice_label is null (no city, or it looks like another row) cannot be a button: leave it out and ask for its phone number or email instead.${rows.length > 4 ? ' Say how many more share the name and that a phone number or city finds the rest.' : ''}` };
}

// A sender block inside a customer-scoped task may only target the task
// customer's own saved address. A domain-wide filter affects every sender at
// that domain and cannot be bound to one customer, so it is refused there.
async function validateSenderBlock(params, context) {
  if (!context?.targets?.length || context.ownerDirect === true) return null;
  if (String(params.domain || '').trim()) {
    return { error: 'A domain-wide block affects every sender at that domain and cannot be proposed inside a task for a specific customer. Block the customer\'s own address instead.', code: 'target_relationship_mismatch' };
  }
  const email = normalizeEmail(params.email_address);
  const owners = await db('customers').whereIn('id', context.targets.map(target => target.customer_id)).whereNull('deleted_at').select('email');
  if (!email || !owners.some(owner => normalizeEmail(owner.email) === email)) {
    return { error: 'Use the task customer\'s own email address for this block', code: 'target_clarification_required' };
  }
  return null;
}

module.exports = { safeChoiceCity, UUID_RE, pageIds, typedCustomerIds, customerLookupLimit, targetClause, resolve, validateRecordTarget, validateSenderBlock, prepareReadInput, ownerDirectContext, customerById, customerTarget, namedCustomers, namesRequested, bulkLeadSelection };
