// The next visit on a report's own service line AT the report's own
// property (same-line-visit.js): the report's live "What's next" line.
const { nextSameLineVisitAtProperty } = require('../services/service-report/same-line-visit');

const HOME = { service_address_line1: '123 Main St', service_address_city: 'Bradenton', service_address_zip: '34209' };
const RENTAL = { service_address_line1: '456 Oak Ave', service_address_city: 'Bradenton', service_address_zip: '34209' };
const REPORT_VISIT = { id: 's1', ...HOME };

// Only the services catalog is ever read here (stamped rows resolve without
// a query).
function knexWithCatalog(services = []) {
  return () => ({ select: () => Promise.resolve(services) });
}

describe('next visit at this property on the same line', () => {
  test('is the first booking on the line that resolves to this property', async () => {
    const rows = [
      { id: 'n1', service_type: 'Lawn Care Visit', ...HOME },
      { id: 'n2', service_type: 'Quarterly Pest Control', ...RENTAL },
      { id: 'n3', service_type: 'Quarterly Pest Control', ...HOME },
    ];
    const next = await nextSameLineVisitAtProperty({ knex: knexWithCatalog(), rows, reportVisit: REPORT_VISIT, serviceLine: 'pest' });
    expect(next).toEqual({ state: 'scheduled', row: rows[2] });
  });

  test("a booking only at another of the customer's properties is none", async () => {
    const next = await nextSameLineVisitAtProperty({
      knex: knexWithCatalog(), rows: [{ id: 'n1', service_type: 'Quarterly Pest Control', ...RENTAL }], reportVisit: REPORT_VISIT, serviceLine: 'pest',
    });
    expect(next).toEqual({ state: 'none' });
  });

  test('an earlier same-line booking with no property, or a report visit with none, is unknown', async () => {
    const rows = [{ id: 'n1', service_type: 'Quarterly Pest Control' }, { id: 'n2', service_type: 'Quarterly Pest Control', ...HOME }];
    await expect(nextSameLineVisitAtProperty({ knex: knexWithCatalog(), rows, reportVisit: REPORT_VISIT, serviceLine: 'pest' }))
      .resolves.toEqual({ state: 'unknown' });
    await expect(nextSameLineVisitAtProperty({ knex: knexWithCatalog(), rows: rows.slice(1), reportVisit: { id: 's1' }, serviceLine: 'pest' }))
      .resolves.toEqual({ state: 'unknown' });
  });

  describe('rodent program (catalog rule, GATE_RODENT_REPORT_REFRESH)', () => {
    const ORIGINAL = process.env.GATE_RODENT_REPORT_REFRESH;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.GATE_RODENT_REPORT_REFRESH;
      else process.env.GATE_RODENT_REPORT_REFRESH = ORIGINAL;
    });
    const exclusion = { id: 'n1', service_type: 'Exclusion Service', service_id: 'svc-excl', ...HOME };
    const catalog = [{ id: 'svc-excl', name: 'Rodent Exclusion', category: 'rodent' }];

    test('an exclusion visit linked to a rodent catalog service counts', async () => {
      process.env.GATE_RODENT_REPORT_REFRESH = 'true';
      await expect(nextSameLineVisitAtProperty({ knex: knexWithCatalog(catalog), rows: [exclusion], reportVisit: REPORT_VISIT, serviceLine: 'rodent' }))
        .resolves.toEqual({ state: 'scheduled', row: exclusion });
    });

    test('without the refresh gate the strict line match stands', async () => {
      delete process.env.GATE_RODENT_REPORT_REFRESH;
      await expect(nextSameLineVisitAtProperty({ knex: knexWithCatalog(catalog), rows: [exclusion], reportVisit: REPORT_VISIT, serviceLine: 'rodent' }))
        .resolves.toEqual({ state: 'none' });
    });
  });
});
