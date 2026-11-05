// knowledge_base.category values a TECHNICIAN may read, and the one projection
// every technician knowledge read goes through (owner ruling 2026-11-04: no
// vendor prices, no business or coworker data on a technician's screen).
//
// A closed allowlist, never a denylist: knowledge_base has no audience column
// and 'category' is admin free text, so a category the list does not name is
// out of reach for a technician. Names come from the code that writes rows:
// the daily sync (services/knowledge-base.js) writes 'chemicals' (one product
// page per active product), 'protocols' (the program pages) and 'pricing'; the
// wiki compiler's category list (services/knowledge/wiki-compiler.js) is
// services, products, protocols, compliance, equipment, pricing, customers,
// pests, turf, operations, competitive, business-strategy. The 2026-10-02
// production read in customer-safe-categories.js adds product, seasonal,
// agronomics, facts, credentials and integrations. Left OUT on purpose:
// pricing (COGS, price floors, tier discounts), business-strategy, operations,
// competitive, customers, services (dispatch rules with prices), credentials,
// integrations, techs (wiki/techs/technician-profiles.md holds coworkers'
// performance numbers), and product/seasonal/agronomics/facts (outcome
// analytics and internal system notes mixed with field notes).
//
// Rows in an allowed category still pass through stripPriceTokensFromText: a
// product page written before the sync dropped its "Best Price" line keeps it
// until the next 3:30 AM sync rewrites the row, and a free-text article can
// quote a dollar figure.
const { stripPriceTokensFromText } = require('../protocol-reader');
const { isTechnicianRequest } = require('../technician-visit-scope');

const TECHNICIAN_KNOWLEDGE_CATEGORIES = Object.freeze([
  'protocols', 'chemicals', 'products', 'compliance', 'equipment', 'pests', 'turf',
]);

const ALLOWED = new Set(TECHNICIAN_KNOWLEDGE_CATEGORIES);

// The audience marker a route puts on the context it hands to WikiQA. The
// source keeps a technician on the staff side of the customer-audience gate.
// Null for an admin, so an admin call keeps its exact context.
const TECHNICIAN_AUDIENCE = 'technician';

const knowledgeAudience = (req) => (isTechnicianRequest(req)
  ? { audience: TECHNICIAN_AUDIENCE, source: 'tech_field' }
  : null);
const isTechnicianAudience = (context) => context?.audience === TECHNICIAN_AUDIENCE;

// "Best Price: $X (<vendor>)" lines written by the sync before the owner's
// 2026-11-04 ruling; the price-token strip alone would leave the vendor name.
const VENDOR_PRICE_LINE = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?best price(?:\*\*)?[ \t]*:.*(?:\r?\n|$)/gim;

function technicianText(value) {
  if (typeof value !== 'string') return value;
  return stripPriceTokensFromText(value.replace(VENDOR_PRICE_LINE, ''));
}

const TEXT_FIELDS = ['title', 'summary', 'content', 'snippet'];

// One row for a technician: null when its category is not a field category,
// else the row with vendor price lines and dollar tokens removed from its text
// fields. A row with no category field is withheld (fail closed).
function technicianKnowledgeRow(row) {
  if (!row || !ALLOWED.has(row.category)) return null;
  const out = { ...row };
  for (const field of TEXT_FIELDS) {
    if (field in out) out[field] = technicianText(out[field]);
  }
  return out;
}

const technicianKnowledgeRows = (rows) => (rows || []).map(technicianKnowledgeRow).filter(Boolean);

module.exports = {
  TECHNICIAN_KNOWLEDGE_CATEGORIES,
  TECHNICIAN_AUDIENCE,
  knowledgeAudience,
  isTechnicianAudience,
  technicianText,
  technicianKnowledgeRow,
  technicianKnowledgeRows,
};
