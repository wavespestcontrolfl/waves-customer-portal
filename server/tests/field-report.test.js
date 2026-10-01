const {
  aggregate,
  formatMarkdown,
  parseArgs,
  resolveCategory,
  resolveCounty,
  resolveWindow,
  REPORT_COUNTIES,
  FIELD_REPORT_QUERY,
} = require('../../ops/agents/field-report');
const { INTERNAL_TEST_CUSTOMERS, INTERNAL_TEST_CUSTOMER_IDS } = require('../../server/services/internal-test-customers');

// Exercise the real exclusion list's own entries rather than hardcoding a
// literal name/id copy in this file (no customer/account identifiers as
// fixture text — see AGENTS.md).
const [SOME_INTERNAL_TEST_NAME] = INTERNAL_TEST_CUSTOMERS;
const [SOME_INTERNAL_TEST_ID] = INTERNAL_TEST_CUSTOMER_IDS;

describe('field-report county resolution', () => {
  test.each([
    ['34292', null, 'Sarasota'], // Venice
    ['34203', null, 'Manatee'], // Bradenton
    ['33954', null, 'Charlotte'], // Port Charlotte
    ['34219', null, 'Manatee'], // Parrish
  ])('zip %s resolves to %s', (zip, city, expected) => {
    expect(resolveCounty({ zip, city })).toBe(expected);
  });

  test('a ZIP shared between two of the three counties is unresolved by ZIP alone', () => {
    // 34228 (Longboat Key) is listed under both Manatee and Sarasota in
    // SERVICE_AREA_COUNTY_ZIPS — must not guess either way, and "longboat
    // key" is deliberately absent from the city fallback too.
    expect(resolveCounty({ zip: '34228', city: 'Longboat Key' })).toBeNull();
  });

  test('falls back to a whole-county city when the ZIP is missing/unrecognized', () => {
    expect(resolveCounty({ zip: '00000', city: 'Venice' })).toBe('Sarasota');
    expect(resolveCounty({ zip: '', city: 'Port Charlotte' })).toBe('Charlotte');
  });

  test('a straddling city is never guessed even with no zip', () => {
    expect(resolveCounty({ zip: '', city: 'Lakewood Ranch' })).toBeNull();
    expect(resolveCounty({ zip: '', city: 'Englewood' })).toBeNull();
  });

  test('a county outside Sarasota/Manatee/Charlotte is unresolved', () => {
    expect(resolveCounty({ zip: '33901', city: 'Fort Myers' })).toBeNull(); // Lee County
    expect(resolveCounty({ zip: '34102', city: 'Naples' })).toBeNull(); // Collier County
  });

  test('city match is case/whitespace insensitive', () => {
    expect(resolveCounty({ zip: '', city: '  VENICE ' })).toBe('Sarasota');
  });
});

describe('field-report category resolution', () => {
  test('uses the stamped category snapshot verbatim when present', () => {
    expect(resolveCategory({ categorySnapshot: 'termite', serviceType: 'Quarterly Pest Control' })).toBe('termite');
  });

  test.each([
    ['WaveGuard Mosquito Treatment', 'mosquito'],
    ['Termite Bait Stations', 'termite'],
    ['WDO Inspection (Real Estate)', 'inspection'], // catalog files WDO under inspection
    ['Rodent Exclusion', 'rodent'],
    ['Pest & Rodent Control', 'rodent'], // rodent keyword checked before the generic pest catch
    ['Lawn Care Visit #3', 'lawn_care'],
    ['Tree & Shrub Care', 'tree_shrub'],
    ['Termite Inspection (Standalone)', 'inspection'], // inspection labels checked first (catalog: inspection)
    ['Rodent Inspection Service', 'inspection'],
    ['Plant Health Program', 'other'], // "ant" only as a whole word
    ['Ant Treatment', 'pest_control'],
    ['Fire Ant Treatment', 'specialty'],
    ['Flea & Tick Yard Treatment', 'specialty'],
    ['Bee / Wasp Nest Removal', 'specialty'],
    ['Mud Dauber Nest Removal', 'specialty'],
    ['Wildlife Trapping Service', 'specialty'],
    ['Bed Bug Treatment', 'specialty'],
    ['Tick Control Service', 'specialty'],
    ['WaveGuard Initial Setup', 'specialty'],
    ['Waves Pest Control Appointment', 'specialty'],
    ['Palmetto Roach Knockdown', 'pest_control'],
    ['Palm Tree Nutrition', 'tree_shrub'],
    ['Core Aeration Service', 'lawn_care'],
    ['Annual Home Inspection', 'inspection'],
    ['Quarterly Pest Control', 'pest_control'],
    ['General Pest Treatment', 'pest_control'],
  ])('falls back to keyword match on service_type: %s -> %s', (serviceType, expected) => {
    expect(resolveCategory({ categorySnapshot: null, serviceType })).toBe(expected);
  });

  test('unrecognized free text falls back to other', () => {
    expect(resolveCategory({ categorySnapshot: null, serviceType: 'Miscellaneous Follow-up' })).toBe('other');
  });

  test('a blank/whitespace snapshot is treated as absent', () => {
    expect(resolveCategory({ categorySnapshot: '  ', serviceType: 'Quarterly Pest Control' })).toBe('pest_control');
  });
});

describe('field-report window validation', () => {
  test('accepts a valid from/to window', () => {
    expect(resolveWindow({ from: '2026-04-01', to: '2026-07-01' })).toEqual({ fromStr: '2026-04-01', toStr: '2026-07-01' });
  });

  test('rejects a malformed date', () => {
    expect(() => resolveWindow({ from: '2026-13-01', to: '2026-07-01' })).toThrow(/--from/);
    expect(() => resolveWindow({ from: '2026-04-01', to: 'not-a-date' })).toThrow(/--to/);
  });

  test('rejects from >= to', () => {
    expect(() => resolveWindow({ from: '2026-07-01', to: '2026-04-01' })).toThrow(/must be before/);
    expect(() => resolveWindow({ from: '2026-04-01', to: '2026-04-01' })).toThrow(/must be before/);
  });
});

describe('field-report parseArgs', () => {
  test('parses --key=value and bare flags', () => {
    expect(parseArgs(['--from=2026-04-01', '--to=2026-07-01', '--json'])).toEqual({
      from: '2026-04-01',
      to: '2026-07-01',
      json: true,
    });
  });

  test('parses --key value (space-separated) form too', () => {
    expect(parseArgs(['--from', '2026-04-01', '--to', '2026-07-01'])).toEqual({
      from: '2026-04-01',
      to: '2026-07-01',
    });
  });
});

describe('field-report SQL — service-address-first geography (no live DB in this sandbox)', () => {
  // A visit's OWN saved service address must win over the customer's
  // current home address (second property, or a customer who moved since
  // the visit) — codex pre-push r2 caught this defaulting to c.zip/c.city
  // alone, matching serviceLocationSelects in
  // server/services/scheduling/day-stops.js. No dev DB is available in this
  // sandbox to run the real query (waves-db skill §5: report blocked rather
  // than fake it), so this pins the query text itself; a real run should
  // re-verify against a preview/dev Postgres branch when one is available.
  test('takes zip AND city from one source: the visit address when either is set, else the customer', () => {
    const guard = /CASE WHEN ss\.service_address_zip IS NOT NULL OR ss\.service_address_city IS NOT NULL/gi;
    expect(FIELD_REPORT_QUERY.match(guard)).toHaveLength(2);
    expect(FIELD_REPORT_QUERY).toMatch(/THEN ss\.service_address_zip ELSE c\.zip END AS zip/i);
    expect(FIELD_REPORT_QUERY).toMatch(/THEN ss\.service_address_city ELSE c\.city END AS city/i);
    expect(FIELD_REPORT_QUERY).not.toMatch(/COALESCE\(ss\.service_address_/i);
  });

  test('a snapshot-less visit linked to the catalog uses the catalog category', () => {
    expect(FIELD_REPORT_QUERY).toMatch(/COALESCE\(ss\.service_category_snapshot, svc\.category\) AS service_category_snapshot/);
    expect(FIELD_REPORT_QUERY).toMatch(/LEFT JOIN services svc ON svc\.id = ss\.service_id/);
  });

  test('a customer-declined closeout is treated like an incomplete one', () => {
    expect(FIELD_REPORT_QUERY).toMatch(/sr\.structured_notes->>'visitOutcome' = 'customer_declined'/);
    expect(FIELD_REPORT_QUERY).toMatch(/COALESCE\(sr\.structured_notes->>'visitOutcome', ''\) <> 'customer_declined'/);
  });

  test('an incomplete closeout counts only once a genuinely performed record exists', () => {
    expect(FIELD_REPORT_QUERY).toMatch(/NOT EXISTS \(SELECT 1 FROM service_records sr[\s\S]*?sr\.status = 'incomplete'/i);
    expect(FIELD_REPORT_QUERY).toMatch(/OR EXISTS \(SELECT 1 FROM service_records sr[\s\S]*?sr\.status = 'completed'/i);
  });
});

function row({ month, zip, city, categorySnapshot, serviceType, customerId, customerName }) {
  return {
    serviceMonth: month,
    zip,
    city,
    categorySnapshot: categorySnapshot ?? null,
    serviceType: serviceType ?? 'Quarterly Pest Control',
    customerId: customerId ?? `${month}-${zip}-${Math.random()}`,
    customerName: customerName ?? 'Jamie Rivera',
  };
}

describe('field-report aggregate — small-cell suppression', () => {
  test('a county x month x category cell under minCell is suppressed, at/above it is shown exactly', () => {
    const rows = [];
    // 9 termite visits in Sarasota in 2026-07: below default minCell (10).
    for (let i = 0; i < 9; i++) rows.push(row({ month: '2026-07', zip: '34292', categorySnapshot: 'termite', customerId: `t${i}` }));
    // 10 pest_control visits in Sarasota in 2026-07: exactly at minCell.
    for (let i = 0; i < 10; i++) rows.push(row({ month: '2026-07', zip: '34292', categorySnapshot: 'pest_control', customerId: `p${i}` }));

    const summary = aggregate(rows, { minCell: 10 });
    const july = summary.byCounty.Sarasota.months.find((m) => m.month === '2026-07');
    expect(july.categories.termite.suppressed).toBe(true);
    expect(july.categories.termite.display).toBe('<10');
    expect(july.categories.termite.count).toBeNull();
    expect(july.categories.pest_control.suppressed).toBe(false);
    expect(july.categories.pest_control.display).toBe('10');
    expect(july.categories.pest_control.count).toBe(10);
  });

  test('the top-level totalCompleted and excludedInternal rollups are suppressed too, not just per-cell counts', () => {
    // A one-visit window must never print an exact "1" just because it's a
    // top-level rollup that bypassed cell() (codex pre-push r1, #D5).
    const rows = [row({ month: '2026-07', zip: '34292', categorySnapshot: 'pest_control' })];
    const summary = aggregate(rows, { minCell: 10 });
    expect(summary.totalCompleted.suppressed).toBe(true);
    expect(summary.totalCompleted.display).toBe('<10');
    expect(summary.excludedInternal.display).toBe('0'); // a true zero is never suppressed
  });

  test('a custom --min-cell threshold is honored', () => {
    const rows = [row({ month: '2026-07', zip: '34292', categorySnapshot: 'termite' }), row({ month: '2026-07', zip: '34292', categorySnapshot: 'termite' })];
    const summary = aggregate(rows, { minCell: 2 });
    const july = summary.byCounty.Sarasota.months.find((m) => m.month === '2026-07');
    expect(july.categories.termite.suppressed).toBe(false);
    expect(july.categories.termite.display).toBe('2');
  });

  test('county and unresolved-geography totals are independently suppressed', () => {
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(row({ month: '2026-07', zip: '34292', categorySnapshot: 'termite', customerId: `s${i}` }));
    for (let i = 0; i < 12; i++) rows.push(row({ month: '2026-07', zip: '33901', categorySnapshot: 'pest_control', customerId: `f${i}` })); // Lee County -> unresolved

    const summary = aggregate(rows, { minCell: 10 });
    expect(summary.byCounty.Sarasota.total.suppressed).toBe(true);
    expect(summary.byCounty.Sarasota.total.display).toBe('<10');
    expect(summary.unresolvedGeography.suppressed).toBe(false);
    expect(summary.unresolvedGeography.display).toBe('12');
  });
});

describe('field-report aggregate — exclusions', () => {
  test('internal/test customer name is excluded from aggregation and counted separately', () => {
    const rows = [
      row({ month: '2026-07', zip: '34292', categorySnapshot: 'pest_control', customerName: SOME_INTERNAL_TEST_NAME }),
      row({ month: '2026-07', zip: '34292', categorySnapshot: 'pest_control', customerName: 'Jamie Rivera' }),
    ];
    const summary = aggregate(rows, { minCell: 1 });
    expect(summary.excludedInternal.count).toBe(1);
    const july = summary.byCounty.Sarasota.months.find((m) => m.month === '2026-07');
    expect(july.categories.pest_control.display).toBe('1');
  });

  test('internal test customer id is excluded even with a different name', () => {
    const rows = [
      row({
        month: '2026-07', zip: '34292', categorySnapshot: 'pest_control', customerName: 'Someone Else',
        customerId: SOME_INTERNAL_TEST_ID,
      }),
    ];
    const summary = aggregate(rows, { minCell: 1 });
    expect(summary.excludedInternal.count).toBe(1);
    expect(summary.totalCompleted.count).toBe(0); // excluded before the headline count
  });

  test('a customer outside the three counties never appears in any county table', () => {
    const rows = [row({ month: '2026-07', zip: '33901', city: 'Fort Myers', categorySnapshot: 'pest_control' })];
    const summary = aggregate(rows, { minCell: 1 });
    for (const county of REPORT_COUNTIES) {
      expect(summary.byCounty[county].total.count).toBe(0);
    }
    expect(summary.unresolvedGeography.count).toBe(1);
  });
});

describe('field-report aggregate — ET month boundaries', () => {
  test('rows are bucketed strictly by the pre-computed service_month string, never re-derived from a Date', () => {
    // scheduled_date is a plain DATE column; SQL produces service_month via
    // to_char, so aggregate() must treat it as an opaque string key — a
    // boundary date like the first of a month must land in that month, not
    // slip to the prior month the way a naive Date/timezone conversion
    // could (the exact trap the waves-db skill documents for timestamptz
    // columns, which this report deliberately avoids by never constructing
    // a JS Date from scheduled_date).
    const rows = [
      row({ month: '2026-04', zip: '34292', categorySnapshot: 'pest_control' }), // window start (inclusive)
      row({ month: '2026-06', zip: '34292', categorySnapshot: 'pest_control' }), // last full month
      row({ month: '2026-07', zip: '34292', categorySnapshot: 'pest_control' }), // would only appear if the DB's exclusive --to boundary let it through
    ];
    const summary = aggregate(rows, { minCell: 1 });
    expect(summary.months).toEqual(['2026-04', '2026-06', '2026-07']);
    const aprilRow = summary.byCounty.Sarasota.months.find((m) => m.month === '2026-04');
    const juneRow = summary.byCounty.Sarasota.months.find((m) => m.month === '2026-06');
    expect(aprilRow.categories.pest_control.count).toBe(1);
    expect(juneRow.categories.pest_control.count).toBe(1);
  });

  test('an empty row set produces an empty, well-formed summary', () => {
    const summary = aggregate([], { minCell: 10 });
    expect(summary.months).toEqual([]);
    expect(summary.totalCompleted.display).toBe('0');
    for (const county of REPORT_COUNTIES) {
      expect(summary.byCounty[county].months).toEqual([]);
      expect(summary.byCounty[county].total.display).toBe('0');
    }
  });
});

describe('field-report formatMarkdown', () => {
  test('renders the draft/unapproved banner and per-county tables', () => {
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(row({ month: '2026-07', zip: '34292', categorySnapshot: 'pest_control', customerId: `p${i}` }));
    const summary = aggregate(rows, { minCell: 10 });
    const md = formatMarkdown(summary, { from: '2026-04-01', to: '2026-07-01' });
    expect(md).toMatch(/DRAFT — unapproved/);
    expect(md).toMatch(/nothing here is published or shared until the owner approves/i);
    expect(md).toMatch(/### Sarasota County/);
    expect(md).toMatch(/### Manatee County/);
    expect(md).toMatch(/### Charlotte County/);
    expect(md).toMatch(/\|\s*2026-07\s*\|/);
    expect(md).toMatch(/12/); // the shown (non-suppressed) count
  });

  test('never renders a customer name, street, or zip', () => {
    const rows = [row({ month: '2026-07', zip: '34292', categorySnapshot: 'pest_control', customerName: 'Jamie Rivera' })];
    const summary = aggregate(rows, { minCell: 1 });
    const md = formatMarkdown(summary, { from: '2026-04-01', to: '2026-07-01' });
    expect(md).not.toMatch(/Jamie/);
    expect(md).not.toMatch(/Rivera/);
    expect(md).not.toMatch(/34292/);
  });
});

describe('field-report county and option edge cases', () => {
  const { resolveCounty, resolveMinCell } = require('../../ops/agents/field-report');
  test('a ZIP another county list also claims (33921: Charlotte and Lee) is excluded', () => {
    expect(resolveCounty({ zip: '33921' })).toBeNull();
    expect(resolveCounty({ zip: '33921', city: 'Punta Gorda' })).toBeNull();
  });
  test('--min-cell: default when absent; positive integer when present; bare or junk rejected', () => {
    expect(resolveMinCell({})).toBe(10);
    expect(resolveMinCell({ 'min-cell': '5' })).toBe(5);
    expect(() => resolveMinCell({ 'min-cell': true })).toThrow(/positive integer/);
    expect(() => resolveMinCell({ 'min-cell': '0' })).toThrow(/positive integer/);
    expect(() => resolveMinCell({ 'min-cell': 'abc' })).toThrow(/positive integer/);
  });
});
