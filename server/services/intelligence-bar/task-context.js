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
  // A lookup at its cap has more rows than it can list, and no listed row can
  // be selected (the selection check above requires a complete lookup), so
  // the rows are never presented as choices. The request is answered and
  // closed with the way to identify the customer instead of parked behind
  // buttons that all conflict.
  if (!namedResult.complete && !cohort && !selectedId) {
    return { page, candidates: [], target: null, targets: [], ambiguous: false,
      error: 'More customers share this name than one lookup can list, so none can be selected here. Identify the customer by phone or email, or start the request from their customer page.',
      code: 'target_clarification_required', requestPhrase: normalizeName(targetClause(prompt)), namesRequested: nameHint };
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
    // A phone or email literal in the target clause identifies one customer
    // even when no send/read recipient grammar captured it.
    contactRequested: [...targetClause(prompt).matchAll(CONTACT_LITERAL_RE)].length > 0,
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

// Per-tool data scope comes from action-policy.json (see scope-policy.js).
// A tool whose scope is missing or invalid is refused here as well as by the
// registry, so no caller can reach an unclassified reader or writer.
const { validScope, scopeOf, UNCLASSIFIED } = require('./scope-policy');

// A request about one customer: a resolved target, an unresolved name, or a
// phone/email literal that identifies the customer.
const customerSpecific = context => Boolean(context.targets?.length || context.namesRequested || context.contactRequested);

// Readers whose appointment selector is not named appointment_id: the
// closeout readers take service_id and the gap reader tests candidate_service_id
// (it loads that appointment's customer preferences, plan holds and location).
const APPOINTMENT_SELECTORS = { get_closeout_status: 'service_id', get_stop_details: 'service_id', find_schedule_gaps: 'candidate_service_id' };
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
  // A refused cohort or unresolved name stops here too; explicit record IDs
  // inside "both appointment A and appointment B" do not reopen it.
  if (context.ambiguous) return { error: 'Name one customer for this action', code: 'target_clarification_required' };
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
  if (scope === 'route_wide' && customerSpecific(context)) {
    return { error: 'This action changes every stop for the date or technician. Run it from a request that does not name a customer, or move that customer\'s own stops by id.', code: 'customer_scope_required' };
  }
  if (policy.kind !== 'read' && [['customer_name', 'customer_id'], ['lead_name', 'lead_id']].some(([name, id]) => params[name] && !params[id])) {
    return { error: 'Resolve the named target to its canonical record identifier before proposing this action', code: 'target_clarification_required' };
  }
  const references = { ...params };
  const appointmentSelector = params[APPOINTMENT_SELECTORS[toolName]];
  if (appointmentSelector) references.appointment_id = appointmentSelector;
  if (params.estimate_identifier) references.estimate_id = params.estimate_identifier;
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
// The single selected customer must carry the supplied phone and match any
// supplied id; anything else is a substitute the task never authorised.
function selectorMismatch(customer, params, digits) {
  if (!customer) return true;
  if (params.phone && digits(customer.phone) !== digits(params.phone)) return true;
  return Boolean(params.customer_id) && String(params.customer_id).toLowerCase() !== customer.id;
}

async function resolveCustomerSelector(params, input, context, schema) {
  const digits = value => String(value || '').replace(/\D/g, '').slice(-10);
  const permitted = new Set(context.targets.map(target => target.customer_id));
  const named = params.customer_name ? await namedCustomers(`for ${params.customer_name}`) : null;
  if (named?.complete === false) return { error: 'The customer name lookup is incomplete. Select the task customer by identifier.', code: 'target_clarification_required' };
  const matches = named ? named.matches : await db('customers').whereNull('deleted_at')
    .whereRaw("RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = ?", [digits(params.phone)])
    .select(CUSTOMER_FIELDS);
  const explicitRead = !permitted.size && params.phone && !params.customer_name && context.explicitReadPhones?.includes(digits(params.phone));
  const selected = explicitRead ? matches : matches.filter(customer => permitted.has(customer.id));
  const customer = selected.length === 1 ? await customerById(selected[0].id) : null;
  if (selectorMismatch(customer, params, digits)) return { error: 'Use the resolved task customer for this record lookup', code: 'target_clarification_required' };
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

async function prepareReadInput(params, context, { toolName, schema }) {
  // A refused cohort never widens into an unscoped read; an unresolved
  // explicit name is handled by readScopeRefusal, which still admits a
  // reader that carries its own selector or record identifier.
  if (context.ambiguous) return { error: 'Name one customer for this record lookup', code: 'target_clarification_required' };
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
  const inherited = inheritTaskCustomer(input, context, schema);
  if (inherited) return inherited;
  const invalid = await validateRecordTarget(input, readContext, { toolName });
  return invalid || { input };
}

// A sender block inside a customer-scoped task may only target the task
// customer's own saved address. A domain-wide filter affects every sender at
// that domain and cannot be bound to one customer, so it is refused there.
async function validateSenderBlock(params, context) {
  if (!context?.targets?.length) return null;
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

module.exports = { UUID_RE, pageIds, targetClause, resolve, validateRecordTarget, validateSenderBlock, prepareReadInput, customerById, customerTarget, namedCustomers, namesRequested, bulkLeadSelection };
