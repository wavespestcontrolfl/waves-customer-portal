/**
 * Public-safe grounding for Google review replies.
 *
 * A reply is PUBLIC. The owner ruling (2026-08-27) is that the review itself
 * is the primary source and customer history may contribute only a small set
 * of DERIVED, public-safe facts with explicit provenance — never raw calls,
 * SMS, private NPS feedback, or technician notes. Nothing in this module
 * reads those tables, so the drafting prompt cannot leak what it never sees;
 * the verifier (drafter.js) is defense in depth, not the privacy boundary.
 *
 * Output shape (everything the drafter and verifier are allowed to know):
 *   {
 *     version, reviewId,
 *     review:  { firstName, rating, text, hasText, wordCount,
 *                mentionedTechNames, topics }            // source: review
 *     account: null | { relationship, tenure, serviceCategories, city }
 *                                                        // source: account
 *     provenance: { <fact>: 'review' | 'account' }
 *     allow: { names: [...], cities: [...], digits: [...] }  // verifier allowlist
 *   }
 */

const db = require('../../models/db');
const logger = require('../logger');
const { WAVES_LOCATIONS } = require('../../config/locations');

const GROUNDING_VERSION = 'grounding-v1';

// Public labels only — never product names, rates, or protocol detail.
const SERVICE_CATEGORY_MATCHERS = [
  { label: 'mosquito control', re: /mosquito|no[-_\s]?see[-_\s]?um|midge/i },
  { label: 'termite protection', re: /termite|wdo|bait_station|bond/i },
  { label: 'rodent control', re: /rodent|rat\b|rats\b|mouse|mice|exclusion|trapping/i },
  { label: 'lawn care', re: /lawn|turf|grass|weed|fertil|fungicide|chinch|sod|irrigation/i },
  { label: 'tree and shrub care', re: /tree|shrub|ornamental|palm|hedge|landscape/i },
  { label: 'pest control', re: /pest|bug|roach|ant\b|ants\b|spider|quarterly|bi[-_]?monthly|monthly|flea|tick|wasp|silverfish|earwig|general/i },
];

// Cities we serve — a customer's city is only ever surfaced when it is one
// of these (a typo'd or out-of-area city would otherwise become a public
// claim about where we work).
const SERVED_CITIES = [
  'Sarasota', 'Bradenton', 'Lakewood Ranch', 'Venice', 'Parrish', 'Palmetto',
  'Nokomis', 'Osprey', 'North Port', 'Englewood', 'Ellenton', 'Myakka City',
  'Siesta Key', 'Longboat Key', 'Anna Maria', 'Holmes Beach', 'Bradenton Beach',
  'University Park', 'Port Charlotte', 'Punta Gorda', 'Ruskin', 'Sun City Center',
  'Apollo Beach', 'Wimauma', 'Riverview', 'Laurel',
];

// Topics the reviewer raised, detected from THEIR words only. These steer
// which sentence the reply acknowledges; the drafter may reference a topic
// only because the reviewer wrote about it.
const TOPIC_MATCHERS = [
  { key: 'technician', re: /\b(technician|tech|guy|gentleman|young man|crew|team member|employee)\b/i },
  { key: 'responsiveness', re: /\b(quick|quickly|fast|prompt|promptly|same[-\s]day|next[-\s]day|on time|responsive|right away|showed up|came out)\b/i },
  { key: 'communication', re: /\b(explain|explained|answered|communicat|walked (me|us) through|informative|knowledgeable|professional|courteous|polite|friendly)\b/i },
  { key: 'results', re: /\b(gone|no more|haven'?t seen|disappeared|under control|took care of|solved|fixed|worked|results|difference)\b/i },
  { key: 'loyalty', re: /\b(years?|for a long time|always|every time|loyal|since|again and again|keep using|continue)\b/i },
  { key: 'price', re: /\b(price|priced|pricing|affordable|reasonable|value|cost|cheap|expensive|worth)\b/i },
  { key: 'recommend', re: /\b(recommend|recommended|highly recommend)\b/i },
  { key: 'lawn', re: /\b(lawn|grass|turf|yard|weeds?|fertiliz\w*)\b/i },
  { key: 'mosquito', re: /\b(mosquito|mosquitoes|no[-\s]?see[-\s]?ums?)\b/i },
  { key: 'termite', re: /\b(termites?|wdo|swarm\w*)\b/i },
  { key: 'rodent', re: /\b(rodents?|rats?|mice|mouse|attic)\b/i },
  { key: 'pest', re: /\b(pests?|bugs?|roach\w*|ants?|spiders?|wasps?|fleas?|ticks?|silverfish|palmetto bugs?)\b/i },
];

function reviewerFirstName(reviewerName) {
  const raw = String(reviewerName || '').trim();
  if (!raw) return null;
  const first = raw.split(/\s+/)[0].replace(/[^A-Za-z'\-]/g, '');
  // "A Google User", single initials, ALL-CAPS handles, and non-alphabetic
  // handles get no greeting-by-name.
  if (first.length < 2 || first.length > 14) return null;
  if (/^(a|an|the|google|user|local|guide)$/i.test(first)) return null;
  if (first === first.toUpperCase() && first.length > 3) return null;
  return first[0].toUpperCase() + first.slice(1);
}

function detectTopics(text) {
  if (!text) return [];
  return TOPIC_MATCHERS.filter((t) => t.re.test(text)).map((t) => t.key);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Technician first names the REVIEWER wrote. Only these may appear in the
// reply (owner ruling: technician names only when present in the review).
function mentionedTechNames(text, techFirstNames) {
  if (!text) return [];
  const found = [];
  for (const name of techFirstNames) {
    if (name.length < 3) continue;
    if (new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(text)) found.push(name);
  }
  return found;
}

function serviceCategoriesFrom(serviceTypes) {
  const labels = new Set();
  for (const st of serviceTypes) {
    for (const m of SERVICE_CATEGORY_MATCHERS) {
      if (m.re.test(String(st || ''))) { labels.add(m.label); break; }
    }
  }
  return [...labels];
}

function tenureBucket(sinceDate, now = new Date()) {
  if (!sinceDate) return null;
  const since = new Date(sinceDate);
  if (Number.isNaN(since.getTime())) return null;
  const days = (now.getTime() - since.getTime()) / 86400000;
  if (days < 90) return 'new';
  if (days < 365) return 'established';
  return 'long_term';
}

function servedCity(city) {
  const c = String(city || '').trim();
  if (!c) return null;
  const hit = SERVED_CITIES.find((s) => s.toLowerCase() === c.toLowerCase());
  return hit || null;
}

async function loadActiveTechFirstNames(conn = db) {
  try {
    // technicians has `name` (full), not first_name — the first token is the
    // name a reviewer would write.
    const rows = await conn('technicians').where({ active: true }).select('name');
    return [...new Set(rows.map((r) => String(r.name || '').trim().split(/\s+/)[0]).filter(Boolean))];
  } catch (err) {
    logger.warn(`[review-grounding] technicians read failed: ${err.message}`);
    return [];
  }
}

// Derived account facts. Reads ONLY: customers (city, member_since,
// created_at) and completed scheduled_services (service_type, count). No
// notes, no findings, no comms, no money.
async function loadAccountFacts(customerId, conn = db) {
  if (!customerId) return null;
  const customer = await conn('customers').where({ id: customerId }).first('id', 'city', 'member_since', 'created_at');
  if (!customer) return null;
  const visits = await conn('scheduled_services')
    .where({ customer_id: customerId, status: 'completed' })
    .select('service_type');
  const completed = visits.length;
  const relationship = completed === 0 ? null : completed === 1 ? 'first_visit' : 'recurring';
  return {
    relationship,
    tenure: tenureBucket(customer.member_since || customer.created_at),
    serviceCategories: serviceCategoriesFrom(visits.map((v) => v.service_type)),
    city: servedCity(customer.city),
  };
}

/**
 * Build the grounding pack for one google_reviews row.
 * @param {object} review google_reviews row
 * @param {{conn?: object, techFirstNames?: string[]}} [opts]
 */
async function buildReplyGrounding(review, { conn = db, techFirstNames = null } = {}) {
  const text = String(review.review_text || '').trim();
  const techNames = techFirstNames || await loadActiveTechFirstNames(conn);
  const loc = WAVES_LOCATIONS.find((l) => l.id === review.location_id) || WAVES_LOCATIONS[0];
  const firstName = reviewerFirstName(review.reviewer_name);
  const mentioned = mentionedTechNames(text, techNames);
  const rating = Number(review.star_rating) || 0;

  let account = null;
  if (review.customer_id) {
    try {
      account = await loadAccountFacts(review.customer_id, conn);
    } catch (err) {
      // Grounding is optional: a failed account read degrades to review-only.
      logger.warn(`[review-grounding] account facts failed for review ${review.id}: ${err.message}`);
      account = null;
    }
  }

  const provenance = {
    firstName: 'review', rating: 'review', text: 'review', mentionedTechNames: 'review', topics: 'review',
  };
  if (account) {
    for (const k of ['relationship', 'tenure', 'serviceCategories', 'city']) provenance[k] = 'account';
  }

  const locationWords = [loc.name, loc.area || '', 'Southwest Florida', 'Florida', 'SWFL']
    .flatMap((s) => String(s).split(/\s*\/\s*/))
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    version: GROUNDING_VERSION,
    reviewId: review.id,
    locationId: loc.id,
    locationName: loc.name,
    review: {
      firstName,
      rating,
      text,
      hasText: text.length > 0,
      wordCount: text ? text.split(/\s+/).length : 0,
      mentionedTechNames: mentioned,
      topics: detectTopics(text),
    },
    account,
    provenance,
    allow: {
      // Names the reply may contain: the reviewer's first name and any tech
      // name the reviewer wrote. Every other active tech name is forbidden.
      names: [firstName, ...mentioned].filter(Boolean),
      forbiddenNames: techNames.filter((n) => !mentioned.includes(n) && n.length >= 3 && n !== firstName),
      cities: [...new Set([...locationWords, ...(account?.city ? [account.city] : [])])],
      // Digit strings the reply may contain: only what the reviewer typed.
      digits: (text.match(/\d+/g) || []),
    },
  };
}

module.exports = {
  GROUNDING_VERSION,
  SERVED_CITIES,
  buildReplyGrounding,
  loadActiveTechFirstNames,
  // exported for tests
  reviewerFirstName,
  detectTopics,
  mentionedTechNames,
  serviceCategoriesFrom,
  tenureBucket,
  servedCity,
};
