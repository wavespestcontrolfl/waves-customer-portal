// A table-keyed fake knex for the shared new-sod resolver (lawn-new-sod-visit.js).
// It answers exactly the reads the resolver and the single-premises proof make, by
// table name, so a test states the visit's facts and nothing else. Synthetic data only.

const HOME = { address_line1: '100 Example Court', address_line2: null, city: 'Bradenton', zip: '34201' };

// One visit at the customer's primary home: its stamp matches the primary address.
function visitFacts(over = {}) {
  return {
    prefs: { sod_laid_on: '2026-10-01' },
    customer: { ...HOME, has_multi_home: false },
    record: { service_date: '2026-10-05', scheduled_service_id: 'ss-1', customer_id: 'c1' },
    appointment: {
      id: 'ss-1', customer_id: 'c1', scheduled_date: '2026-10-05', property_id: null, source_estimate_id: null,
      service_address_line1: HOME.address_line1, service_address_line2: null, service_address_city: HOME.city, service_address_zip: HOME.zip,
    },
    properties: [], // customer_properties rows (the single-premises proof reads all of them)
    propertyById: {}, // id -> customer_properties row (a property_id link)
    estimateById: {}, // id -> { address }
    otherAppointments: [], // distinct stamp/link rows the single-premises proof scans
    throwOn: null, // a table name whose read throws
    ...over,
  };
}

function fakeKnex(facts = visitFacts()) {
  const calls = [];
  const knex = (table) => {
    calls.push(table);
    let whereArg = null;
    const q = {};
    const guard = () => { if (facts.throwOn === table) throw new Error('connection reset'); };
    q.where = (a, b) => { whereArg = a && typeof a === 'object' ? a : { [a]: b }; return q; };
    q.leftJoin = () => q;
    q.join = () => q;
    q.select = () => q;
    q.distinct = () => q;
    q.columnInfo = async () => ({ service_address_line1: true, service_address_line2: true, service_address_city: true, service_address_zip: true, property_id: true, source_estimate_id: true });
    q.first = async () => {
      guard();
      switch (table) {
        case 'property_preferences': return facts.prefs;
        case 'service_records as sr': return facts.record;
        case 'scheduled_services as ss': return facts.appointment;
        case 'customers as c': return facts.customer;
        case 'customer_properties': return facts.propertyById[whereArg && whereArg.id] ?? null;
        case 'estimates': return facts.estimateById[whereArg && whereArg.id] ?? null;
        default: return null;
      }
    };
    q.then = (resolve, reject) => {
      let rows = [];
      try {
        guard();
        if (table === 'customer_properties') rows = facts.properties;
        else if (table === 'scheduled_services') rows = facts.otherAppointments;
      } catch (e) { return Promise.reject(e).then(resolve, reject); }
      return Promise.resolve(rows).then(resolve, reject);
    };
    return q;
  };
  knex.raw = (sql) => sql;
  knex.calls = calls;
  return knex;
}

module.exports = { HOME, visitFacts, fakeKnex };
