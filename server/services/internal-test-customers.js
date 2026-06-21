// Internal / test customer names (lowercased "first last") excluded from
// business metrics so the owner's test accounts never inflate the numbers.
// Single source of truth shared by the IB dashboard tools (excludeInternal*),
// the MRR breakdown, and the MRR snapshot — so the headline tile, the live
// trend, and the stored monthly snapshots all measure the SAME population.
// Empty list ⇒ every exclusion is a no-op.
const INTERNAL_TEST_CUSTOMERS = ['adam martinez'];

module.exports = { INTERNAL_TEST_CUSTOMERS };
