/**
 * Estimate loss dispositions (estimator audit 2026-08-29 P0).
 *
 * Pins: the vocabulary is closed and split system/staff; legacy decline
 * labels map to codes (free text → declined_other with the text kept);
 * the expiry rule classifies opened vs never-opened from the view signals
 * the public page already stamps; PATCH validation rejects non-staff codes
 * and only carries competitor fields for declined_competitor.
 */
const {
  DISPOSITIONS,
  STAFF_DISPOSITION_CODES,
  EXPIRED_DISPOSITION_SQL,
  isStaffDispositionCode,
  dispositionGroup,
  dispositionFromDeclineReason,
  expiredDispositionFor,
  staffDispositionUpdates,
} = require('../services/estimate-disposition');

describe('vocabulary', () => {
  test('every code is unique, grouped, and attributed to exactly one author', () => {
    const codes = DISPOSITIONS.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const d of DISPOSITIONS) {
      expect(['lost', 'dead', 'won_elsewhere']).toContain(d.group);
      expect(['system', 'staff', 'customer']).toContain(d.source);
    }
    // System codes are never accepted from a client.
    for (const code of ['expired_unviewed', 'expired_viewed', 'archived_unresolved', 'converted_other_path', 'declined_by_customer']) {
      expect(isStaffDispositionCode(code)).toBe(false);
      expect(STAFF_DISPOSITION_CODES).not.toContain(code);
    }
    expect(dispositionGroup('invalid_lead')).toBe('dead');
    expect(dispositionGroup('converted_other_path')).toBe('won_elsewhere');
    expect(dispositionGroup('nope')).toBeNull();
  });
});

describe('dispositionFromDeclineReason — legacy labels', () => {
  test.each([
    ['Too expensive', 'declined_price'],
    ['  went With Competitor ', 'declined_competitor'],
    ['Not ready', 'declined_timing'],
    ['Service not needed', 'not_needed'],
    ['No response', 'no_response'],
    ['Price, went with Orkin', 'declined_price'], // first keyword hit wins
    ['Moved out of area', 'invalid_lead'],
    ['They hated the color of the truck', 'declined_other'],
  ])('%s → %s', (label, code) => {
    expect(dispositionFromDeclineReason(label)).toBe(code);
  });

  test('empty text is null, not declined_other', () => {
    expect(dispositionFromDeclineReason('')).toBeNull();
    expect(dispositionFromDeclineReason(null)).toBeNull();
  });
});

describe('expiredDispositionFor — opened vs never opened', () => {
  test('no view signal at all → expired_unviewed', () => {
    expect(expiredDispositionFor({ status: 'sent', view_count: 0, last_viewed_at: null, viewed_at: null })).toBe('expired_unviewed');
    expect(expiredDispositionFor({ status: 'sent' })).toBe('expired_unviewed');
  });

  test.each([
    ['view_count', { status: 'sent', view_count: '2' }],
    ['last_viewed_at', { status: 'sent', last_viewed_at: '2026-08-01T00:00:00Z' }],
    ['viewed_at', { status: 'sent', viewed_at: '2026-08-01T00:00:00Z' }],
    ['status viewed', { status: 'viewed', view_count: 0 }],
  ])('any single open signal (%s) → expired_viewed', (_name, row) => {
    expect(expiredDispositionFor(row)).toBe('expired_viewed');
  });

  test('the SQL twin keeps a staff-stamped disposition and checks the same signals', () => {
    expect(EXPIRED_DISPOSITION_SQL).toMatch(/^COALESCE\(disposition,/);
    for (const signal of ['view_count', 'last_viewed_at', 'viewed_at', "status = 'viewed'"]) {
      expect(EXPIRED_DISPOSITION_SQL).toContain(signal);
    }
  });
});

describe('staffDispositionUpdates — PATCH payload', () => {
  test('a normalized staff code lands with source/at and the derived legacy label', () => {
    const { updates, error } = staffDispositionUpdates({ disposition: 'declined_timing' });
    expect(error).toBeUndefined();
    expect(updates).toMatchObject({
      disposition: 'declined_timing',
      disposition_source: 'staff',
      decline_reason: 'Not ready / timing',
      competitor_name: null,
      competitor_price: null,
      disposition_note: null,
    });
    expect(updates.disposition_at).toBeInstanceOf(Date);
  });

  test('competitor fields are carried ONLY for declined_competitor, price normalized', () => {
    const competitor = staffDispositionUpdates({
      disposition: 'declined_competitor', competitorName: '  Ratical ', competitorPrice: '$90.00',
    }).updates;
    expect(competitor).toMatchObject({ competitor_name: 'Ratical', competitor_price: 90 });

    const other = staffDispositionUpdates({
      disposition: 'declined_price', competitorName: 'Ratical', competitorPrice: '90',
    }).updates;
    expect(other).toMatchObject({ competitor_name: null, competitor_price: null });

    expect(staffDispositionUpdates({ disposition: 'declined_competitor', competitorPrice: 'lots' }).updates.competitor_price).toBeNull();
    expect(staffDispositionUpdates({ disposition: 'declined_competitor', competitorPrice: '-5' }).updates.competitor_price).toBeNull();
    // decimal(10,2) range guard — overflow must not become a 500.
    expect(staffDispositionUpdates({ disposition: 'declined_competitor', competitorPrice: '100000000' }).updates.competitor_price).toBeNull();
    expect(staffDispositionUpdates({ disposition: 'declined_competitor', competitorPrice: '1e100' }).updates.competitor_price).toBeNull();
    expect(staffDispositionUpdates({ disposition: 'declined_competitor', competitorPrice: '99999999.99' }).updates.competitor_price).toBe(99999999.99);
  });

  test('legacy declineReason alone maps to a code; unknown text is kept as the note', () => {
    expect(staffDispositionUpdates({ declineReason: 'Went with competitor' }).updates).toMatchObject({
      disposition: 'declined_competitor', decline_reason: 'Went with competitor', disposition_note: null,
    });
    expect(staffDispositionUpdates({ declineReason: 'Spouse said no' }).updates).toMatchObject({
      disposition: 'declined_other', decline_reason: 'Spouse said no', disposition_note: 'Spouse said no',
    });
  });

  test('system codes and garbage are rejected; nothing at all is an error', () => {
    expect(staffDispositionUpdates({ disposition: 'expired_unviewed' }).error).toMatch(/Invalid disposition/);
    expect(staffDispositionUpdates({ disposition: 'banana' }).error).toMatch(/Invalid disposition/);
    expect(staffDispositionUpdates({}).error).toMatch(/required/);
  });

  test('an explicit note wins over the legacy text and is bounded', () => {
    const { updates } = staffDispositionUpdates({
      disposition: 'declined_other', declineReason: 'Other', dispositionNote: ` ${'x'.repeat(3000)} `,
    });
    expect(updates.disposition_note).toHaveLength(2000);
    expect(updates.decline_reason).toBe('Other');
  });
});
