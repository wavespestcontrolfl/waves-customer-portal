/**
 * Pest Insider "Your home": the per-reader facts and the token helpers.
 *
 * The shared issue body (render.js) carries two tokens that stand alone just
 * before the sign-off: {{pi-home}} in the HTML and {{pi-home-text}} in the
 * plain text. They are two tokens because a SendGrid substitution is one
 * literal token -> one value applied to every part (the quiz tokens work the
 * same way, newsletter-quiz.js). The sender fills them per reader with that
 * customer's block (render.js homeBlock), or with '' for a reader without
 * one. Every other surface that shows a stored body (archive, RSS feed,
 * touchpoint log, the owner's FYI copy) strips them, so the block never
 * reaches the shared body, the archive or a copy a reader did not get.
 *
 * This file is a leaf: it loads no database layer (loadHomeFacts is handed its
 * connection) and requires the address and property helpers only when it runs, so the strip
 * helpers can be required from newsletter-draft.js and newsletter-proof.js
 * without a load-order risk.
 */
'use strict';

const { dateOnlyString } = require('../../utils/date-only');
const { etDateString } = require('../../utils/datetime-et');

const HOME_TOKEN = '{{pi-home}}';
const HOME_TEXT_TOKEN = '{{pi-home-text}}';

// "Last visit" older than this shows no block: the customer is not a current one.
const MAX_LAST_VISIT_AGE_DAYS = 365;
// Readers per query: each id is a bound parameter, so a long audience is read in
// slices (newsletter-sender sends 500 per batch).
const CHUNK = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The two exact spellings are the only tokens, case-sensitive, no inner spaces. A SendGrid
// substitution is a literal match, so a spelling the sender cannot fill (`{{ PI-Home }}`)
// must never be hidden by a preview or the send check: it stays visible as plain text on
// every surface instead of being mailed as a raw placeholder after a clean-looking proof.
const hasHomeToken = (content) => {
  const text = String(content || '');
  return text.includes(HOME_TOKEN) || text.includes(HOME_TEXT_TOKEN);
};

// Both tokens removed; what is left is the issue exactly as it reads with no block.
// (Neither token is a prefix of the other: `{{pi-home}}` needs its closing braces.)
const neutralizeHomeTokens = (content) => String(content || '').split(HOME_TEXT_TOKEN).join('').split(HOME_TOKEN).join('');

// The service line of a visit day, from the service catalog (the `services` table). A
// finished record freezes its catalog key at completion (service_data.completedServiceKey),
// and the catalog gives that key one category. A record with no key (a visit before the
// keys) counts only when its name is one catalog name, letter for letter. A service name
// is never read for words: "Core Aeration" holds "rat", and the placeholder appointment
// holds the company's own "Pest Control". `categories` is every category of that day.
// Exactly one line across the day is that line; none, or more than one, has none: the
// block prints no label then. Specialty and inspection work has no line of its own.
const CATEGORY_LINE = new Map([
  ['pest_control', 'pest'], ['lawn_care', 'lawn'], ['mosquito', 'mosquito'],
  ['termite', 'termite'], ['rodent', 'rodent'], ['tree_shrub', 'tree_shrub'],
]);
function serviceLineOf(categories) {
  const lines = new Set();
  for (const category of Array.isArray(categories) ? categories : [categories]) {
    const line = CATEGORY_LINE.get(String(category ?? '').trim().toLowerCase());
    if (line) lines.add(line);
  }
  return lines.size === 1 ? [...lines][0] : null;
}

const dayNumber = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

// "Is this address the customer's home?", by the portal's one unit-aware rule for readers that
// speak about the home itself (stamped-address.js visitAtCustomerHome: the pet-named text, Away
// Watch). A unit on one side only is another premise; an address with no street is the home.
// inheritUnit false is for an address that is already complete (a finished report's frozen
// address): it never borrows the home's unit, so "100 Main St" is not "100 Main St Apt 4".
function addressIsHome(address, home, { inheritUnit = true } = {}) {
  const { visitAtCustomerHome, premiseStampConflicts } = require('../stamped-address');
  // visitAtCustomerHome reads a street it cannot key as "unknown, so no conflict". Here an
  // address that names a street must be matched: with no usable street on either side
  // nothing confirms it is the home.
  const { streetKey } = require('../customer-properties');
  const named = String(address.address_line1 ?? '').trim();
  if (named && !(streetKey(named) && streetKey(home.address_line1))) return false;
  // An address with a unit, city or ZIP and no street still names a place: those parts are
  // compared on the home's own street (a saved property, a frozen report address and an
  // appointment stamp alike). An address with no part at all says nothing.
  const partial = !named && [address.address_line2, address.city, address.zip].some((part) => String(part ?? '').trim());
  if (!named && !partial) return true;
  const located = named ? address : { ...address, address_line1: home.address_line1 };
  if (!inheritUnit) {
    const stamp = (a) => ({ service_address_line1: a.address_line1, service_address_line2: a.address_line2, service_address_city: a.city, service_address_zip: a.zip });
    return !premiseStampConflicts(stamp(located), stamp(home));
  }
  return visitAtCustomerHome({
    service_address_line1: located.address_line1, service_address_line2: located.address_line2,
    service_address_city: located.city, service_address_zip: located.zip,
    address_line1: home.address_line1, address_line2: home.address_line2, city: home.city, zip: home.zip,
  });
}

// One appointment's place. Its own property pointer and address stamp (migration
// 20260709000001) come first; an appointment with no location of its own takes its source
// estimate's (customer-properties.js propertyRemovalDependents reads a visit the same way);
// with none of these it was at the customer's address on file.
function appointmentAtHome(stamp, home, homePropertyId) {
  const elsewhere = (propertyId) => Boolean(propertyId) && String(propertyId) !== homePropertyId;
  if (elsewhere(stamp.property_id)) return false;
  if (String(stamp.address_line1 ?? '').trim()) return addressIsHome(stamp, home);
  // A stamp with a unit, city or ZIP but no street still names a place (addressIsHome): a
  // stamp for Apt 4 is not a visit to the home's Apt 3.
  if (!addressIsHome(stamp, home)) return false;
  if (stamp.property_id) return true;
  // A live quote-wizard draft is rewritten for the customer's next quote, at any address, so
  // it cannot say where an older appointment was (recurring-appointment-seeder.js
  // sourceEstimateForScope). It is this appointment's only location evidence: no block.
  if (stamp.estimate_live_draft === true) return false;
  if (elsewhere(stamp.estimate_property_id)) return false;
  if (!String(stamp.estimate_address ?? '').trim()) return true;
  const quoted = require('../estimate-property-linkage').parseEstimateAddress(stamp.estimate_address);
  return Boolean(quoted) && addressIsHome(quoted, home);
}

// True when every appointment behind the last day's records was at this home. An
// appointment can be booked at another address than the one on file, and a visit there
// is not a visit to "your home". A record with no appointment predates the link.
function lastVisitIsAtHome(row) {
  const stamps = Array.isArray(row.last_stamps) ? row.last_stamps : [];
  const home = { address_line1: row.home_line1, address_line2: row.home_line2, city: row.home_city, zip: row.home_zip };
  const homePropertyId = String(row.home_property_id ?? '');
  // The address each finished report froze at completion (service_data.reportIdentitySnapshot,
  // the one the customer's report shows). A customer who moved since has the old home there.
  const frozen = Array.isArray(row.last_frozen) ? row.last_frozen : [];
  // The frozen address is the report's effective one (it already took the customer's unit of
  // that day), so it is compared as it stands.
  const frozenAtHome = (a) => addressIsHome({ address_line1: a?.line1, address_line2: a?.line2, city: a?.city, zip: a?.zip }, home, { inheritUnit: false });
  // The one saved property must be this home too. Its address can differ from the customer's
  // (customer-properties.js recordCallProperty keeps an existing customer address when it
  // makes the first property), and an appointment may carry only the property pointer.
  if (row.home_property && !addressIsHome(row.home_property, home)) return false;
  return frozen.every(frozenAtHome) && stamps.every((stamp) => appointmentAtHome(stamp, home, homePropertyId));
}

// One reader's facts from its row, or null when the customer is commercial, the last
// finished visit is over a year old, or it was at another address than this home.
function homeFromRow(row, today) {
  // The platform's own commercial test (the residential-only emails read it too).
  const { isCommercialAccount } = require('../self-booking-plan-sync');
  if (isCommercialAccount({ property_type: row.property_type, waveguard_tier: row.waveguard_tier })) return null;
  // The saved-property residence rule's classifier (customer-properties.js isResidenceProperty):
  // an office, a warehouse or a storefront is commercial too, whatever its occupancy says.
  const { normalizePropertyType } = require('../pricing-engine/commercial-helpers');
  if ([row.property_type, row.home_property?.property_type].some((type) => normalizePropertyType(type) === 'commercial')) return null;
  const lastDate = dateOnlyString(row.last_date);
  if (!lastDate) return null;
  if (dayNumber(today) - dayNumber(lastDate) > MAX_LAST_VISIT_AGE_DAYS) return null;
  if (!lastVisitIsAtHome(row)) return null;
  return {
    customerId: row.customer_id,
    // The address these facts were read for: the sender mails a block only to this address.
    address: String(row.reader_address ?? '').trim().toLowerCase(),
    lastVisit: { date: lastDate, line: serviceLineOf(row.last_categories) },
    // "Member since": the Waves app's own date (customers.member_since), not the first
    // record, which begins in August 2025 for customers who joined before.
    sinceDate: dateOnlyString(row.member_since),
  };
}

// The per-chunk read. A reader gets a row only when its link, address and
// household are unambiguous: the subscriber's address is the one this customer has
// on file; no other live customer has that mailbox as its own address, a service
// contact's or its billing address (any Gmail spelling); no sibling profile shares the account
// (COALESCE(account_id, id) is account-properties.js accountPropertyIds' key); the
// customer is the owner, not a property manager or a tenant (customers.contact_role);
// staff have not marked the customer multi-home (customers.has_multi_home: a second
// premises that never got a customer_properties row); the customer has a street on file;
// and there is at most one saved property EVER, active, lived-in and the customer's
// own (relationship NULL or own_home: not a client's or a family member's home).
// One property ever, not one active: the last visit is read over the customer's whole
// history, so a visit to a retired second property must not stand as this home's.
// family_occupied stays out on purpose: that home's payer can be another person.
// One key for one mailbox, whatever its Gmail spelling: the newsletter sender's own key
// (customer-comms-lock.js GOOGLE_MAILBOX_SQL.key, its MAILBOX_KEY_SQL).
const mailboxKeySql = (expr) => require('../../utils/customer-comms-lock').GOOGLE_MAILBOX_SQL.key(expr);
// The customers columns that can hold an address of the customer's: the ownership list
// (CUSTOMER_EMAIL_COLUMNS) without billing_email, which is on notification_prefs
// (newsletter-confirm.js customerEmailFields reads it the same way).
const otherCustomerMailboxColumns = () => require('../../utils/customer-comms-lock').CUSTOMER_EMAIL_COLUMNS
  .filter((column) => column !== 'billing_email');

// Every live customer's mailboxes, computed once per read (a correlated scan would key every
// customer again for each reader; newsletter-sender.js withMailboxCustomers has the same shape).
const FACTS_SQL = (idList) => `
WITH mailbox_owners AS MATERIALIZED (
  SELECT ${mailboxKeySql('a.address')} AS mailbox_key, o.id AS customer_id
  FROM customers o
  CROSS JOIN LATERAL (VALUES ${otherCustomerMailboxColumns().map((column) => `(o.${column})`).join(', ')}) AS a(address)
  WHERE o.deleted_at IS NULL AND TRIM(COALESCE(a.address, '')) <> ''
  UNION ALL
  SELECT ${mailboxKeySql('np.billing_email')} AS mailbox_key, o.id AS customer_id
  FROM notification_prefs np JOIN customers o ON o.id = np.customer_id
  WHERE o.deleted_at IS NULL AND TRIM(COALESCE(np.billing_email, '')) <> ''
)
SELECT ns.id AS subscriber_id, c.id AS customer_id, c.member_since, c.property_type, c.waveguard_tier,
       LOWER(TRIM(ns.email)) AS reader_address, v.last_date, t.last_categories, t.last_stamps, t.last_frozen,
       c.address_line1 AS home_line1, c.address_line2 AS home_line2, c.city AS home_city, c.zip AS home_zip,
       (SELECT p.id FROM customer_properties p WHERE p.customer_id = c.id LIMIT 1) AS home_property_id,
       (SELECT json_build_object('address_line1', p.address_line1, 'address_line2', p.address_line2, 'city', p.city, 'zip', p.zip,
                                 'property_type', p.property_type)
        FROM customer_properties p WHERE p.customer_id = c.id LIMIT 1) AS home_property
FROM newsletter_subscribers ns
JOIN customers c ON c.id = ns.customer_id
JOIN LATERAL (
  SELECT MAX(r.service_date) AS last_date
  FROM service_records r
  WHERE r.customer_id = c.id AND COALESCE(r.status, 'completed') = 'completed' AND r.service_date <= CAST(? AS date)
) v ON v.last_date IS NOT NULL
JOIN LATERAL (
  SELECT array_agg(DISTINCT sv.category) FILTER (WHERE sv.category IS NOT NULL) AS last_categories,
         COALESCE(json_agg(json_build_object(
           'property_id', ss.property_id, 'address_line1', ss.service_address_line1, 'address_line2', ss.service_address_line2,
           'city', ss.service_address_city, 'zip', ss.service_address_zip,
           'estimate_property_id', e.property_id, 'estimate_address', e.address,
           'estimate_live_draft', (e.source = 'quote_wizard' AND e.status = 'draft' AND e.archived_at IS NULL)))
           FILTER (WHERE ss.id IS NOT NULL), '[]'::json) AS last_stamps,
         COALESCE(json_agg(r.service_data->'reportIdentitySnapshot'->'address')
           FILTER (WHERE jsonb_typeof(r.service_data->'reportIdentitySnapshot'->'address') = 'object'), '[]'::json) AS last_frozen
  FROM service_records r
  LEFT JOIN scheduled_services ss ON ss.id = r.scheduled_service_id
  LEFT JOIN estimates e ON e.id = ss.source_estimate_id
  LEFT JOIN LATERAL (
    SELECT CASE WHEN COUNT(DISTINCT s.category) = 1 THEN MIN(s.category) END AS category
    FROM services s
    WHERE s.service_key = NULLIF(TRIM(r.service_data->>'completedServiceKey'), '')
       OR (NULLIF(TRIM(r.service_data->>'completedServiceKey'), '') IS NULL AND LOWER(TRIM(s.name)) = LOWER(TRIM(r.service_type)))
  ) sv ON true
  WHERE r.customer_id = c.id AND COALESCE(r.status, 'completed') = 'completed' AND r.service_date = v.last_date
) t ON true
WHERE ns.id IN (${idList})
  AND c.deleted_at IS NULL AND c.active IS DISTINCT FROM false
  AND TRIM(COALESCE(c.email, '')) <> '' AND LOWER(TRIM(ns.email)) = LOWER(TRIM(c.email))
  AND NOT EXISTS (SELECT 1 FROM mailbox_owners w WHERE w.mailbox_key = ${mailboxKeySql('c.email')} AND w.customer_id <> c.id)
  AND NOT EXISTS (SELECT 1 FROM customers o WHERE o.id <> c.id AND o.deleted_at IS NULL AND o.active IS DISTINCT FROM false
                  AND COALESCE(o.account_id, o.id) = COALESCE(c.account_id, c.id))
  AND COALESCE(c.contact_role, 'owner') = 'owner'
  AND c.has_multi_home IS NOT TRUE
  AND TRIM(COALESCE(c.address_line1, '')) <> ''
  AND (SELECT COUNT(*) FROM customer_properties p WHERE p.customer_id = c.id) <= 1
  AND NOT EXISTS (SELECT 1 FROM customer_properties p WHERE p.customer_id = c.id
                  AND (p.active IS NOT TRUE
                       OR p.occupancy_type IS NULL OR p.occupancy_type NOT IN ('owner_occupied', 'seasonal')
                       OR COALESCE(p.relationship, 'own_home') <> 'own_home'
                       OR LOWER(COALESCE(p.property_type, '')) IN ('commercial', 'business')))`;

/**
 * One batched read of the readers' current customers' finished visits, from
 * service_records (what the Waves app shows as the customer's visits: status
 * 'completed' or NULL, dated on or before today in Eastern time).
 * Returns Map<subscriberId, { customerId, address, lastVisit: { date, line }, sinceDate }>.
 * The link and the address are the database's now. A reader whose customer is
 * archived or inactive, shares its address or account with another customer, has
 * several saved properties or a rental, family or commercial one, or whose last
 * finished visit is over a year old, has no entry. It may throw: the caller fails closed.
 * @param {Function} conn  knex or a transaction
 * @param {(number|string)[]} subscriberIds  newsletter_subscribers ids
 * @param {Date} [now]
 */
async function loadHomeFacts(conn, subscriberIds, now = new Date()) {
  const ids = Array.from(new Set((subscriberIds || []).filter((id) => id !== null && id !== undefined)));
  const facts = new Map();
  const today = etDateString(now);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const result = await conn.raw(FACTS_SQL(slice.map(() => '?').join(', ')), [today, ...slice]);
    for (const row of result?.rows || []) {
      const home = homeFromRow(row, today);
      if (home) facts.set(row.subscriber_id, home);
    }
  }
  return facts;
}

module.exports = { HOME_TOKEN, HOME_TEXT_TOKEN, hasHomeToken, neutralizeHomeTokens, loadHomeFacts, serviceLineOf };
