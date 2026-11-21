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
 * connection) and requires the classifier modules only when it runs, so the strip
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

// The service line of a visit day, from the platform's one classifier (the estimator's
// serviceKeysFromText through newsletter-audience-profiles' linesFromScheduledServices,
// which also folds palm and commercial keys into the six sellable lines). `types` is every
// service name recorded on that day. Exactly one line across the whole set is that line;
// none, or more than one, has none: the block prints no label then. The classifier reads
// a service name only to pick a line; the name itself is never kept or shown.
function serviceLineOf(types) {
  const { linesFromScheduledServices } = require('../newsletter-audience-profiles');
  const lines = new Set();
  for (const name of Array.isArray(types) ? types : [types]) {
    // The helper skips terminal statuses (a finished visit is not live coverage),
    // so the row is handed over as a live recurring one: only its text is read.
    for (const line of linesFromScheduledServices([{ service_type: name, status: 'confirmed', is_recurring: true }]).lines) lines.add(line);
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
function addressIsHome(address, home) {
  const { visitAtCustomerHome } = require('../stamped-address');
  return visitAtCustomerHome({
    service_address_line1: address.address_line1, service_address_line2: address.address_line2,
    service_address_city: address.city, service_address_zip: address.zip,
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
  if (stamp.property_id) return true;
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
  return stamps.every((stamp) => appointmentAtHome(stamp, home, homePropertyId));
}

// One reader's facts from its row, or null when the customer is commercial, the last
// finished visit is over a year old, or it was at another address than this home.
function homeFromRow(row, today) {
  // The platform's own commercial test (the residential-only emails read it too).
  const { isCommercialAccount } = require('../self-booking-plan-sync');
  if (isCommercialAccount({ property_type: row.property_type, waveguard_tier: row.waveguard_tier })) return null;
  const lastDate = dateOnlyString(row.last_date);
  if (!lastDate) return null;
  if (dayNumber(today) - dayNumber(lastDate) > MAX_LAST_VISIT_AGE_DAYS) return null;
  if (!lastVisitIsAtHome(row)) return null;
  return {
    customerId: row.customer_id,
    // The address these facts were read for: the sender mails a block only to this address.
    address: String(row.reader_address ?? '').trim().toLowerCase(),
    lastVisit: { date: lastDate, line: serviceLineOf(row.last_types) },
    // "Member since": the Waves app's own date (customers.member_since), not the first
    // record, which begins in August 2025 for customers who joined before.
    sinceDate: dateOnlyString(row.member_since),
  };
}

// The per-chunk read. A reader gets a row only when its link, address and
// household are unambiguous: the subscriber's address is the one this customer has
// on file; no other live customer has it; no sibling profile shares the account
// (COALESCE(account_id, id) is account-properties.js accountPropertyIds' key); the
// customer is the owner, not a property manager or a tenant (customers.contact_role);
// and there is at most one saved property EVER, active, lived-in and the customer's
// own (relationship NULL or own_home: not a client's or a family member's home).
// One property ever, not one active: the last visit is read over the customer's whole
// history, so a visit to a retired second property must not stand as this home's.
// family_occupied stays out on purpose: that home's payer can be another person.
const FACTS_SQL = (idList) => `
SELECT ns.id AS subscriber_id, c.id AS customer_id, c.member_since, c.property_type, c.waveguard_tier,
       LOWER(TRIM(ns.email)) AS reader_address, v.last_date, t.last_types, t.last_stamps,
       c.address_line1 AS home_line1, c.address_line2 AS home_line2, c.city AS home_city, c.zip AS home_zip,
       (SELECT p.id FROM customer_properties p WHERE p.customer_id = c.id LIMIT 1) AS home_property_id
FROM newsletter_subscribers ns
JOIN customers c ON c.id = ns.customer_id
JOIN LATERAL (
  SELECT MAX(r.service_date) AS last_date
  FROM service_records r
  WHERE r.customer_id = c.id AND COALESCE(r.status, 'completed') = 'completed' AND r.service_date <= CAST(? AS date)
) v ON v.last_date IS NOT NULL
JOIN LATERAL (
  SELECT array_agg(DISTINCT r.service_type) AS last_types,
         COALESCE(json_agg(json_build_object(
           'property_id', ss.property_id, 'address_line1', ss.service_address_line1, 'address_line2', ss.service_address_line2,
           'city', ss.service_address_city, 'zip', ss.service_address_zip,
           'estimate_property_id', e.property_id, 'estimate_address', e.address)) FILTER (WHERE ss.id IS NOT NULL), '[]'::json) AS last_stamps
  FROM service_records r
  LEFT JOIN scheduled_services ss ON ss.id = r.scheduled_service_id
  LEFT JOIN estimates e ON e.id = ss.source_estimate_id
  WHERE r.customer_id = c.id AND COALESCE(r.status, 'completed') = 'completed' AND r.service_date = v.last_date
) t ON true
WHERE ns.id IN (${idList})
  AND c.deleted_at IS NULL AND c.active IS DISTINCT FROM false
  AND TRIM(COALESCE(c.email, '')) <> '' AND LOWER(TRIM(ns.email)) = LOWER(TRIM(c.email))
  AND NOT EXISTS (SELECT 1 FROM customers o WHERE o.id <> c.id AND o.deleted_at IS NULL
                  AND LOWER(TRIM(o.email)) = LOWER(TRIM(c.email)))
  AND NOT EXISTS (SELECT 1 FROM customers o WHERE o.id <> c.id AND o.deleted_at IS NULL AND o.active IS DISTINCT FROM false
                  AND COALESCE(o.account_id, o.id) = COALESCE(c.account_id, c.id))
  AND COALESCE(c.contact_role, 'owner') = 'owner'
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
