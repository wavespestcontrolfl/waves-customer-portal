// Bid kit catalog and status rule (GATE_BID_KIT): the ordered list, the pure status function (including the
// expiry-equals-today edge in America/New_York), the counts, change detection and the tax-ID guard. No database.
const catalog = require('../../shared/bid-kit-catalog.cjs');

const { STATUS, STATUS_ORDER, itemStatus, buildChecklist, summarize, changesSubstance, containsTaxId, looksLikeTaxId, etToday, daysBetween } = catalog;
const TODAY = '2026-10-23';
const doc = (over = {}) => ({ kind: 'document', item_key: 'business_license_copy', has_file: true, value: null, expires_on: null, attested_at: null, ...over });

describe('catalog', () => {
  test('sections come in the order the owner works through them, and the first one is the papers that sank bids', () => {
    expect(catalog.SECTIONS.map((section) => section.key)).toEqual(['sank_bids', 'insurance', 'registration_tax', 'plans_company', 'references', 'facts']);
    expect(catalog.SECTIONS[0].items.map((item) => item.key)).toEqual([
      'business_license_copy', 'cpco_certificate', 'cpco_fulltime_statement', 'employee_id_cards', 'product_list',
    ]);
  });

  test('every item has the fields the page and the job read, with a unique key', () => {
    const keys = catalog.ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of catalog.ITEMS) {
      expect(catalog.KINDS).toContain(item.kind);
      expect(item.label).toBeTruthy();
      expect(item.why).toBeTruthy();
      expect(item.section).toBeTruthy();
      expect(typeof item.expires).toBe('boolean');
      expect(typeof item.perBid).toBe('boolean');
      expect(typeof item.notarized).toBe('boolean');
      expect(item.key.length).toBeLessThanOrEqual(48);
    }
  });

  test('the notarized statement is a new paper for each bid; references are the only kind that takes many', () => {
    expect(catalog.catalogItem('cpco_fulltime_statement')).toMatchObject({ kind: 'document', notarized: true, perBid: true });
    expect(catalog.catalogItem('reference')).toMatchObject({ kind: 'reference', many: true });
    expect(catalog.ITEMS.filter((item) => item.many).map((item) => item.key)).toEqual(['reference']);
  });

  test('the facts section holds the fifteen fact keys, all text facts', () => {
    const facts = catalog.ITEMS.filter((item) => item.section === 'facts');
    expect(facts.map((item) => item.key)).toEqual([
      'legal_name', 'dba_name', 'business_address', 'mailing_address', 'phone', 'email', 'fdacs_license_number', 'office_opened_on',
      'years_in_business', 'nigp_codes', 'naics_codes', 'sam_uei', 'cage_code', 'certified_operator_names', 'employee_count',
    ]);
    expect(facts.every((item) => item.kind === 'fact')).toBe(true);
  });

  test('no catalog item asks for a tax ID or a Social Security number', () => {
    const everything = JSON.stringify(catalog.SECTIONS).toLowerCase();
    expect(everything).not.toMatch(/\bfein\b|\bssn\b|social security/);
    expect(catalog.ITEMS.some((item) => /^(fein|ein|ssn)/.test(item.key))).toBe(false);
  });
});

describe('status', () => {
  // A paper that does not expire (the W-9) needs no expiry date; the license copy does.
  const w9 = (over = {}) => ({ kind: 'document', item_key: 'w9', has_file: true, value: null, expires_on: null, attested_at: null, ...over });
  const SIGNED = '2026-10-01T12:00:00Z';

  test('a document or reference with no file and no value is missing; a fact with no value is missing', () => {
    expect(itemStatus(doc({ has_file: false }), { today: TODAY })).toBe(STATUS.MISSING);
    expect(itemStatus({ kind: 'fact', value: '  ' }, { today: TODAY })).toBe(STATUS.MISSING);
    expect(itemStatus({ kind: 'reference' }, { today: TODAY })).toBe(STATUS.MISSING);
    expect(itemStatus(null, { today: TODAY })).toBe(STATUS.MISSING);
  });

  test('the order is missing, expired, needs_expiry, needs_permission, unattested, expiring, ready', () => {
    expect(STATUS_ORDER).toEqual(['missing', 'expired', 'needs_expiry', 'needs_permission', 'unattested', 'expiring', 'ready']);
  });

  test('a value alone makes a document present; a fact with no value is missing, whatever else the row carries', () => {
    expect(itemStatus(w9({ has_file: false, value: 'On file' }), { today: TODAY })).toBe(STATUS.UNATTESTED);
    // A fact's value is the one the owner typed. Nothing is read from any other table, so a stray number on the row is ignored.
    expect(itemStatus({ kind: 'fact', item_key: 'fdacs_license_number', value: null, credential_number: 'JB000000' }, { today: TODAY })).toBe(STATUS.MISSING);
    expect(itemStatus({ kind: 'fact', item_key: 'fdacs_license_number', value: 'JB000000', attested_at: SIGNED }, { today: TODAY })).toBe(STATUS.READY);
  });

  test('an expiry before today is expired, whatever else is true of the item', () => {
    expect(itemStatus(doc({ expires_on: '2026-10-22' }), { today: TODAY })).toBe(STATUS.EXPIRED);
    expect(itemStatus(doc({ expires_on: '2026-10-22', attested_at: SIGNED }), { today: TODAY })).toBe(STATUS.EXPIRED);
    expect(itemStatus(w9({ expires_on: '2026-10-22' }), { today: TODAY })).toBe(STATUS.EXPIRED); // a date on any item counts
  });

  test('a catalog item that expires and has no expiry date needs one, even when signed off', () => {
    expect(itemStatus(doc(), { today: TODAY })).toBe(STATUS.NEEDS_EXPIRY);
    expect(itemStatus(doc({ attested_at: SIGNED }), { today: TODAY })).toBe(STATUS.NEEDS_EXPIRY);
    for (const item of catalog.ITEMS.filter((entry) => entry.kind === 'document')) {
      expect(itemStatus({ kind: 'document', item_key: item.key, has_file: true }, { today: TODAY })).toBe(item.expires ? STATUS.NEEDS_EXPIRY : STATUS.UNATTESTED);
    }
  });

  test('items that do not expire, and custom rows, are not held to an expiry date', () => {
    expect(itemStatus(w9(), { today: TODAY })).toBe(STATUS.UNATTESTED);
    expect(itemStatus({ kind: 'document', item_key: 'custom', has_file: true }, { today: TODAY })).toBe(STATUS.UNATTESTED);
    expect(itemStatus({ kind: 'fact', item_key: 'phone', value: '941-555-0100', attested_at: SIGNED }, { today: TODAY })).toBe(STATUS.READY);
  });

  test('expiring means complete and signed off, but expiring within 30 days', () => {
    expect(itemStatus(doc({ expires_on: '2026-11-22', attested_at: SIGNED }), { today: TODAY })).toBe(STATUS.EXPIRING); // exactly 30 days
    expect(itemStatus(doc({ expires_on: '2026-11-23', attested_at: SIGNED }), { today: TODAY })).toBe(STATUS.READY); // 31 days
    // Not signed off yet: the open work is the sign-off, so it reads needs sign-off, not expiring.
    expect(itemStatus(doc({ expires_on: '2026-11-22' }), { today: TODAY })).toBe(STATUS.UNATTESTED);
    expect(itemStatus(doc({ expires_on: '2026-11-23' }), { today: TODAY })).toBe(STATUS.UNATTESTED);
  });

  test('first match wins: missing beats expired; expired beats needs permission', () => {
    expect(itemStatus({ kind: 'reference', item_key: 'reference', has_file: false, expires_on: '2026-10-01' }, { today: TODAY })).toBe(STATUS.MISSING);
    expect(itemStatus({ kind: 'reference', item_key: 'reference', details: { entity: 'Sample District' }, expires_on: '2026-10-01' }, { today: TODAY })).toBe(STATUS.EXPIRED);
    expect(itemStatus(doc({ has_file: false, expires_on: '2026-10-01' }), { today: TODAY })).toBe(STATUS.MISSING);
  });

  test('a reference with no permission date needs permission, even when it was signed off', () => {
    const reference = { kind: 'reference', item_key: 'reference', details: { entity: 'Sample District' }, attested_at: SIGNED };
    expect(itemStatus(reference, { today: TODAY })).toBe(STATUS.NEEDS_PERMISSION);
    expect(itemStatus({ ...reference, permission_on: '2026-09-30' }, { today: TODAY })).toBe(STATUS.READY);
    expect(itemStatus({ ...reference, permission_on: '2026-09-30', attested_at: null }, { today: TODAY })).toBe(STATUS.UNATTESTED);
  });

  test('a missing expiry date comes before needs permission, sign-off and expiring', () => {
    expect(itemStatus(doc({ attested_at: null }), { today: TODAY })).toBe(STATUS.NEEDS_EXPIRY);
    expect(itemStatus(doc({ expires_on: '2027-03-01', attested_at: SIGNED }), { today: TODAY })).toBe(STATUS.READY);
  });

  test('the words the page shows, and the plain refusal for each status that blocks a sign-off', () => {
    expect(catalog.STATUS_LABEL.needs_expiry).toBe('Add expiry date');
    expect(Object.keys(catalog.SIGN_OFF_REFUSAL)).toEqual(['missing', 'expired', 'needs_expiry']);
    expect(catalog.SIGN_OFF_REFUSAL.needs_expiry).toBe('Add the expiry date first.');
  });

  describe('expiry equals today, in America/New_York', () => {
    test('an item that expires today is still valid today and expired tomorrow', () => {
      expect(itemStatus(doc({ expires_on: TODAY, attested_at: SIGNED }), { today: TODAY })).toBe(STATUS.EXPIRING);
      expect(itemStatus(doc({ expires_on: TODAY, attested_at: SIGNED }), { today: '2026-10-24' })).toBe(STATUS.EXPIRED);
    });

    test('at 11:30 PM Eastern the UTC date is already tomorrow, but the item is not expired until Eastern midnight', () => {
      const lateEvening = new Date('2026-10-24T03:30:00Z'); // Oct 23, 11:30 PM EDT
      expect(etToday(lateEvening)).toBe('2026-10-23');
      expect(itemStatus(doc({ expires_on: '2026-10-23', attested_at: SIGNED }), { now: lateEvening })).toBe(STATUS.EXPIRING);
      const justAfterMidnight = new Date('2026-10-24T04:00:00Z'); // Oct 24, 12:00 AM EDT
      expect(etToday(justAfterMidnight)).toBe('2026-10-24');
      expect(itemStatus(doc({ expires_on: '2026-10-23', attested_at: SIGNED }), { now: justAfterMidnight })).toBe(STATUS.EXPIRED);
    });

    test('the Eastern day holds across the fall-back change (Nov 1, 2026) and a winter date (EST)', () => {
      expect(etToday(new Date('2026-11-02T04:30:00Z'))).toBe('2026-11-01'); // 11:30 PM EST on Nov 1
      expect(etToday(new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-02');
      expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
    });

    test('a Date at UTC midnight reads as its calendar day', () => {
      expect(itemStatus(doc({ expires_on: new Date('2026-10-23T00:00:00Z'), attested_at: SIGNED }), { today: TODAY })).toBe(STATUS.EXPIRING);
    });
  });
});

describe('counts', () => {
  const rows = [
    { id: 'a', kind: 'document', item_key: 'business_license_copy', has_file: true, expires_on: '2027-06-01', attested_at: '2026-10-01T00:00:00Z' },
    { id: 'b', kind: 'document', item_key: 'cpco_certificate', has_file: true, expires_on: '2026-10-01' },
    { id: 'c', kind: 'document', item_key: 'insurance_certificate', has_file: true, expires_on: '2026-11-10', attested_at: '2026-10-01T00:00:00Z' },
    { id: 'h', kind: 'document', item_key: 'business_tax_receipt', has_file: true },
    { id: 'd', kind: 'reference', item_key: 'reference', details: { entity: 'Sample District' } },
    { id: 'e', kind: 'fact', item_key: 'legal_name', value: 'Example Pest Services LLC', attested_at: '2026-10-01T00:00:00Z' },
    { id: 'f', kind: 'fact', item_key: 'phone', value: '941-555-0100', archived_at: '2026-10-02T00:00:00Z' },
    { id: 'g', kind: 'document', item_key: 'custom', label: 'County vendor letter', has_file: true },
  ];

  test('every catalog item with no row counts once as missing, and an archived row does not count', () => {
    const checklist = buildChecklist(rows, { today: TODAY });
    const { overall, sections } = summarize(checklist);
    expect(overall.total).toBe(catalog.ITEMS.length + 1); // a reference slot becomes a row; one custom row is added
    // ready counts ready AND expiring (both are valid on a bid today); expiring is the separate "expiring soon" count.
    expect(overall).toMatchObject({ ready: 3, expiring: 1, expired: 1, needs_expiry: 1, needs_permission: 1, unattested: 1 });
    expect(overall.missing).toBe(overall.total - 3 - 1 - 1 - 1 - 1);
    expect(sections.sank_bids).toMatchObject({ total: 5, ready: 1, expired: 1, missing: 3 });
    expect(sections.insurance).toMatchObject({ total: 2, ready: 1, expiring: 1, missing: 1 });
    expect(sections.registration_tax).toMatchObject({ total: 5, needs_expiry: 1, missing: 4 });
    expect(sections.references).toMatchObject({ total: 1, needs_permission: 1 });
    expect(sections.facts).toMatchObject({ total: 15, ready: 1, missing: 14 }); // the archived phone row is gone
    expect(sections.other).toMatchObject({ total: 1, unattested: 1 });
  });

  test('overall counts are the sum of the section counts, and the statuses add up to the total', () => {
    const { overall, sections } = summarize(buildChecklist(rows, { today: TODAY }));
    for (const key of Object.keys(overall)) {
      expect(overall[key]).toBe(Object.values(sections).reduce((sum, counts) => sum + counts[key], 0));
    }
    // expiring is part of ready, so every other status plus ready adds up to the total
    expect(catalog.STATUS_ORDER.filter((status) => status !== 'expiring').reduce((sum, status) => sum + overall[status], 0)).toBe(overall.total);
  });

  test('a reference slot shows while there are no references, and more than one reference row is allowed', () => {
    const none = buildChecklist([], { today: TODAY }).find((section) => section.key === 'references');
    expect(none.entries).toHaveLength(1);
    const two = buildChecklist([
      { id: 'r1', kind: 'reference', item_key: 'reference', details: { entity: 'Sample District' } },
      { id: 'r2', kind: 'reference', item_key: 'reference', details: { entity: 'Sample HOA' } },
    ], { today: TODAY }).find((section) => section.key === 'references');
    expect(two.entries.map((entry) => entry.row.id)).toEqual(['r1', 'r2']);
  });
});

describe('what clears a sign-off', () => {
  const row = {
    value: 'POL-0001', file_s3_key: 'x', limits: { glEachOccurrence: 1000000, workersComp: 'statutory' }, details: { entity: 'Sample District' },
    source_document: 'Certificate dated Sep 1', checked_on: '2026-09-01', expires_on: '2027-09-01', permission_on: '2026-09-02',
  };

  test.each([
    ['value', { value: 'POL-0002' }],
    ['file', { file_s3_key: 'y' }],
    ['limits', { limits: { glEachOccurrence: 2000000, workersComp: 'statutory' } }],
    ['details', { details: { entity: 'Other District' } }],
    ['source_document', { source_document: 'Certificate dated Oct 1' }],
    ['checked_on', { checked_on: '2026-10-01' }],
    ['expires_on', { expires_on: '2027-10-01' }],
    ['permission_on', { permission_on: '2026-10-03' }],
  ])('a change to %s counts', (_name, patch) => {
    expect(changesSubstance(row, patch)).toBe(true);
  });

  test('saving the same values again, key order aside, changes nothing', () => {
    expect(changesSubstance(row, {
      value: 'POL-0001', limits: { workersComp: 'statutory', glEachOccurrence: 1000000 }, details: { entity: 'Sample District' },
      source_document: 'Certificate dated Sep 1', checked_on: '2026-09-01', expires_on: new Date('2027-09-01T00:00:00Z'), permission_on: '2026-09-02',
    })).toBe(false);
    expect(changesSubstance({ value: null, limits: null }, { value: '', limits: null })).toBe(false);
  });

  test('a label or a note is not part of what a sign-off covers', () => {
    expect(changesSubstance(row, { label: 'Renamed', notes: 'Call the agent in March' })).toBe(false);
  });
});

describe('tax IDs are never stored', () => {
  test.each([
    '12-3456789', '123-45-6789', 'EIN 12-3456789 on file', 'note: 987-65-4321.',
    'EIN 123456789', 'EIN: 123456789', 'ein 123456789', 'FEIN 123456789', 'TIN: 123456789', 'SSN 123456789', 'tax id 123456789', 'Tax ID: 123456789', 'taxpayer ID: 123456789', 'Taxpayer 123456789',
  ])('%s is refused', (text) => {
    expect(looksLikeTaxId(text)).toBe(true);
    expect(containsTaxId({ nested: [text] })).toBe(true);
  });

  test.each([
    '941-555-0100', '9415550100', '34202-1234', '561710, 561730', 'JB000000', '2026-10-23', 'NIGP 968-45', '1234567890123', 'Example Pest Services LLC',
    'Policy 123456789', 'POL 987654321', '123456789', 'Certificate 123456789 dated Sep 1', 'W-9 on file with the office manager, policy 123456789',
    'EIN is on file with the W-9; policy 123456789', // the label is more than 12 characters before the digits
    'EIN on the W-9 only', 'the tin roof', 'tax identification is on the W-9',
  ])('%s is fine', (text) => {
    expect(looksLikeTaxId(text)).toBe(false);
  });

  test('the label reaches at most 12 characters ahead, and a longer run of digits is not a tax ID', () => {
    expect(looksLikeTaxId('EIN 12345678901')).toBe(false); // eleven digits
    expect(looksLikeTaxId(`SSN${' '.repeat(12)}123456789`)).toBe(true); // 12 characters between the label and the digits
    expect(looksLikeTaxId(`SSN${' '.repeat(13)}123456789`)).toBe(false); // 13
  });

  test('numbers in limits or an annual value are not read as tax IDs', () => {
    expect(containsTaxId({ glEachOccurrence: 123456789, annualValue: 987654321 })).toBe(false);
  });
});
