// knowledge_base.category values whose EVERY row is written for customers.
//
// knowledge_base has no audience/visibility column: category is admin free text
// (Claudeopedia's create()/normalizeCategory() just slugifies whatever string an
// admin passes). Production categories checked read-only on 2026-09-25 and again
// 2026-10-02: 'chemicals' rows carry wholesale supplier prices, 'protocols'
// holds staff routing rules and the job-scoring formula, 'product'/'seasonal'
// are internal outcome analytics, 'pricing', 'business-strategy', 'operations',
// 'credentials' and 'integrations' are internal, and even 'agronomics' and
// 'facts' mix customer facts with internal system notes. No category is
// customer-safe as a whole, so this allowlist is EMPTY (fail closed): customer-
// facing facts come from label-verified products_catalog rows, the service
// library and the species catalog. Add a category only once its every row is
// written for customers.
//
// Used by services/estimate-ai-context.js (public estimate assistant) and by
// services/knowledge/wiki-qa.js for customer-facing callers when
// GATE_KB_CUSTOMER_AUDIENCE is on. A closed allowlist, never a denylist.
const KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES = [];

module.exports = { KNOWLEDGE_BASE_CUSTOMER_SAFE_CATEGORIES };
