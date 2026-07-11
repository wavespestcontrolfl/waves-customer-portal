// Internal / test customer names (lowercased "first last") excluded from
// business metrics so the owner's test accounts never inflate the numbers.
// Single source of truth shared by the IB dashboard tools (excludeInternal*),
// the MRR breakdown, and the MRR snapshot — so the headline tile, the live
// trend, and the stored monthly snapshots all measure the SAME population.
// Empty list ⇒ every exclusion is a no-op.
const INTERNAL_TEST_CUSTOMERS = ['adam martinez'];

// Internal / demo customer IDs suppressed from ADMIN NOTIFICATIONS (the bell)
// — not from data or metrics. The App Store review demo account generates
// real bounce alerts and junk service-request bells on every review cycle.
const INTERNAL_TEST_CUSTOMER_IDS = [
  '3274944a-f509-413c-9dee-a8b0cdb16493', // App Review demo (appreview+demo@wavespestcontrol.com)
];

function isInternalTestCustomerId(id) {
  return !!id && INTERNAL_TEST_CUSTOMER_IDS.includes(String(id));
}

module.exports = { INTERNAL_TEST_CUSTOMERS, INTERNAL_TEST_CUSTOMER_IDS, isInternalTestCustomerId };
