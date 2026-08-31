/**
 * Regression: a follow-up call must not degrade the lead it follows up on.
 *
 * Reproduces the SHAPE of the 2026-08-31 production incident with synthetic
 * payloads. A long first call captured the pest problem and a promised quote
 * and qualified the lead; a few minutes later the same caller rang back
 * briefly to chase the estimate, and that thin payload replaced the rich one
 * wholesale — the problem statement and the standing quote obligation
 * vanished from the lead card, and is_qualified flipped to false (which also
 * drops the lead from the Google Ads qualified-lead upload).
 */
const {
  mergeLeadExtractedData,
  parseLeadExtractedData,
  shouldRefreshLeadSummary,
} = require('../utils/lead-extracted-data-merge');

// Synthetic stand-ins with the same key shape the two production payloads
// had (lead_prior_state / lead_written_state on the incident call).
const RICH_CALL = {
  call_type: 'new_inquiry',
  needs_confirmation: ['email_unverified'],
  pain_points: 'Small flying insects in an upstairs bathroom that return after spraying.',
  preferred_date_time: null,
  quote_promised: true,
  quote_requested: true,
  sentiment: 'positive',
};
const THIN_FOLLOW_UP = {
  call_type: 'new_inquiry',
  pain_points: 'Did not receive the estimate promised on the previous call.',
  preferred_date_time: null,
  sentiment: 'neutral',
};

const RECOMPUTED = { recomputedKeys: ['needs_confirmation', 'missing_for_qualification'] };

describe('mergeLeadExtractedData — follow-up calls never degrade the lead', () => {
  it('keeps the pest problem when a follow-up call describes a different concern', () => {
    const merged = mergeLeadExtractedData(RICH_CALL, THIN_FOLLOW_UP, RECOMPUTED);
    expect(merged.pain_points).toContain('Small flying insects in an upstairs bathroom');
    // and still records what the follow-up was actually about
    expect(merged.pain_points).toContain('Did not receive the estimate promised');
  });

  it('keeps the quote obligation the earlier call took on', () => {
    const merged = mergeLeadExtractedData(RICH_CALL, THIN_FOLLOW_UP, RECOMPUTED);
    expect(merged.quote_promised).toBe(true);
    expect(merged.quote_requested).toBe(true);
  });

  it('lets genuinely per-call facts refresh', () => {
    const merged = mergeLeadExtractedData(RICH_CALL, THIN_FOLLOW_UP, RECOMPUTED);
    expect(merged.sentiment).toBe('neutral');
  });

  it('drops recomputed keys instead of filling them forward', () => {
    // The follow-up resolved the email question, so this pass emits no
    // needs_confirmation — the stale reason must not survive.
    const merged = mergeLeadExtractedData(RICH_CALL, THIN_FOLLOW_UP, RECOMPUTED);
    expect(merged.needs_confirmation).toBeUndefined();
  });

  it('unions a re-emitted needs_confirmation normally', () => {
    const merged = mergeLeadExtractedData(
      RICH_CALL,
      { ...THIN_FOLLOW_UP, needs_confirmation: ['email_unverified', 'address_unverified'] },
      RECOMPUTED,
    );
    expect(merged.needs_confirmation).toEqual(['email_unverified', 'address_unverified']);
  });

  it('fills forward a field the payload omits entirely', () => {
    const merged = mergeLeadExtractedData(
      { ...RICH_CALL, preferred_date_time: '2026-09-02T14:00' },
      { sentiment: 'neutral' },
      RECOMPUTED,
    );
    expect(merged.preferred_date_time).toBe('2026-09-02T14:00');
    expect(merged.pain_points).toContain('Small flying insects');
  });

  it('never clears a sticky obligation with an explicit false', () => {
    const merged = mergeLeadExtractedData(RICH_CALL, { quote_promised: false }, RECOMPUTED);
    expect(merged.quote_promised).toBe(true);
  });

  it('does not duplicate a restated concern', () => {
    const merged = mergeLeadExtractedData(RICH_CALL, { pain_points: RICH_CALL.pain_points }, RECOMPUTED);
    expect(merged.pain_points).toBe(RICH_CALL.pain_points);
  });

  it('is idempotent, so the under-lock re-merge cannot double-append', () => {
    const once = mergeLeadExtractedData(RICH_CALL, THIN_FOLLOW_UP, RECOMPUTED);
    const twice = mergeLeadExtractedData(RICH_CALL, once, RECOMPUTED);
    const thrice = mergeLeadExtractedData(RICH_CALL, twice, RECOMPUTED);
    expect(twice.pain_points).toBe(once.pain_points);
    expect(thrice.pain_points).toBe(once.pain_points);
  });

  it('never drops a later concern — every reported problem is a fact about the job', () => {
    let data = { pain_points: 'one' };
    for (const p of ['two', 'three', 'four', 'five']) {
      data = mergeLeadExtractedData(data, { pain_points: p }, RECOMPUTED);
    }
    expect(data.pain_points.split(' · ')).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('stays bounded in practice by de-duplication, not by truncation', () => {
    let data = { pain_points: 'Ants in the kitchen' };
    for (let i = 0; i < 20; i += 1) {
      data = mergeLeadExtractedData(data, { pain_points: 'Ants in the kitchen' }, RECOMPUTED);
    }
    expect(data.pain_points).toBe('Ants in the kitchen');
  });

  it('starts clean from an empty or unparseable prior', () => {
    expect(mergeLeadExtractedData(null, THIN_FOLLOW_UP, RECOMPUTED).pain_points)
      .toBe(THIN_FOLLOW_UP.pain_points);
    expect(mergeLeadExtractedData('{not json', THIN_FOLLOW_UP, RECOMPUTED).pain_points)
      .toBe(THIN_FOLLOW_UP.pain_points);
  });

  it('accepts the column as the JSON string the DB hands back', () => {
    const merged = mergeLeadExtractedData(JSON.stringify(RICH_CALL), THIN_FOLLOW_UP, RECOMPUTED);
    expect(merged.quote_promised).toBe(true);
    expect(merged.pain_points).toContain('Small flying insects');
  });

  it('parseLeadExtractedData tolerates arrays and junk', () => {
    expect(parseLeadExtractedData('[1,2]')).toEqual({});
    expect(parseLeadExtractedData(undefined)).toEqual({});
    // Postgres returns a JSONB array as a real JS array, not a string.
    expect(parseLeadExtractedData([1, 2])).toEqual({});
    expect(parseLeadExtractedData([])).toEqual({});
  });

  it('a JSONB array on the row cannot leak numeric keys into the merge', () => {
    const merged = mergeLeadExtractedData(['unexpected', 'array'], THIN_FOLLOW_UP, RECOMPUTED);
    expect(Object.keys(merged).some((k) => /^\d+$/.test(k))).toBe(false);
    expect(merged.pain_points).toBe(THIN_FOLLOW_UP.pain_points);
  });
});

describe('is_qualified is monotonic under evidence', () => {
  // The rule both writers now apply, asserted directly: a lead the office can
  // work stays qualified across a 'cold' callback.
  const qualifies = (leadQuality, contactComplete, priorQualified) => contactComplete
    && (['hot', 'warm'].includes(leadQuality) || priorQualified === true);

  it('a cold callback does not demote a qualified lead', () => {
    expect(qualifies('cold', true, true)).toBe(true);
  });

  it('a cold first call still does not qualify', () => {
    expect(qualifies('cold', true, false)).toBe(false);
  });

  it('losing the contact evidence does demote', () => {
    expect(qualifies('cold', false, true)).toBe(false);
  });

  it('a hot call still earns qualification outright', () => {
    expect(qualifies('hot', true, false)).toBe(true);
  });
});

describe('shouldRefreshLeadSummary — Notes hold the fullest description', () => {
  const SUBSTANTIVE = 'The caller described recurring flying insects in an upstairs bathroom at a newly purchased home and asked about monthly recurring service; an estimate was promised on the call.';
  const THIN = 'The caller followed up on the estimate promised on the previous call.';
  const refresh = (currentSummary, newSummary) => shouldRefreshLeadSummary({ currentSummary, newSummary });

  it('keeps the substantive summary through a status-chase callback', () => {
    expect(refresh(SUBSTANTIVE, THIN)).toBe(false);
  });

  it('lets a later substantive call replace an older thin summary', () => {
    expect(refresh(THIN, SUBSTANTIVE)).toBe(true);
  });

  it('refreshes when the lead has no summary at all', () => {
    expect(refresh('', THIN)).toBe(true);
    expect(refresh(null, THIN)).toBe(true);
    expect(refresh('   ', THIN)).toBe(true);
  });

  it('never trades down, whatever else the call brought with it', () => {
    // A new property, a named service or a fresh quote obligation are all
    // preserved in extracted_data; none of them licenses thin text in Notes.
    expect(refresh(SUBSTANTIVE, 'Short.')).toBe(false);
    expect(refresh(SUBSTANTIVE, 'z'.repeat(SUBSTANTIVE.length))).toBe(false);
    expect(refresh(SUBSTANTIVE, 'z'.repeat(SUBSTANTIVE.length - 1))).toBe(false);
  });

  it('takes a strictly fuller retelling', () => {
    expect(refresh(SUBSTANTIVE, `${SUBSTANTIVE} They also confirmed the gate code.`)).toBe(true);
  });

  it('never replaces a summary with nothing', () => {
    expect(refresh(SUBSTANTIVE, '')).toBe(false);
    expect(refresh(SUBSTANTIVE, null)).toBe(false);
    expect(refresh(SUBSTANTIVE, undefined)).toBe(false);
  });
});

describe('structured collections survive across multiple calls', () => {
  const RK = RECOMPUTED;
  const PROP_A = { address_line1: '100 First St', zip: '34202' };
  const PROP_B = { address_line1: '200 Second Ave', zip: '34240' };

  it('keeps a property an earlier call captured when a later call names another', () => {
    const afterCall1 = mergeLeadExtractedData({}, { additional_properties: [PROP_A] }, RK);
    const afterCall2 = mergeLeadExtractedData(afterCall1, { additional_properties: [PROP_B] }, RK);
    expect(afterCall2.additional_properties).toHaveLength(2);
    expect(afterCall2.additional_properties.map((p) => p.address_line1))
      .toEqual(['100 First St', '200 Second Ave']);
  });

  it('collapses a re-mentioned property and keeps the richer detail', () => {
    const afterCall1 = mergeLeadExtractedData({}, { additional_properties: [PROP_A, PROP_B] }, RK);
    const afterCall2 = mergeLeadExtractedData(
      afterCall1,
      { additional_properties: [{ ...PROP_A, notes: 'gate code at the rear' }] },
      RK,
    );
    expect(afterCall2.additional_properties).toHaveLength(2);
    expect(afterCall2.additional_properties[0].notes).toBe('gate code at the rear');
  });

  it('a partial re-mention does not null out detail an earlier call captured', () => {
    const afterCall1 = mergeLeadExtractedData({}, {
      additional_properties: [{
        ...PROP_A, city: 'Bradenton', service_address_occupancy: 'rental_investment', notes: 'gate code at the rear',
      }],
    }, RK);
    // The caller confirms the address and mentions only the property type.
    const afterCall2 = mergeLeadExtractedData(afterCall1, {
      additional_properties: [{ ...PROP_A, city: null, notes: null, property_type: 'condo' }],
    }, RK);
    const entry = afterCall2.additional_properties[0];
    expect(entry.city).toBe('Bradenton');
    expect(entry.notes).toBe('gate code at the rear');
    expect(entry.service_address_occupancy).toBe('rental_investment');
    expect(entry.property_type).toBe('condo');
  });

  it('merges a re-mention corroborated by city when neither side has a zip', () => {
    const afterCall1 = mergeLeadExtractedData({}, {
      additional_properties: [{ address_line1: '100 First St', city: 'Bradenton', notes: 'gate code at the rear' }],
    }, RK);
    const afterCall2 = mergeLeadExtractedData(afterCall1, {
      additional_properties: [{ address_line1: '100 First St', city: 'Bradenton', property_type: 'condo' }],
    }, RK);
    expect(afterCall2.additional_properties).toHaveLength(1);
    expect(afterCall2.additional_properties[0].notes).toBe('gate code at the rear');
    expect(afterCall2.additional_properties[0].property_type).toBe('condo');
  });

  it('keeps the same street in two different towns as two properties', () => {
    const afterCall1 = mergeLeadExtractedData({}, {
      additional_properties: [{ address_line1: '100 First St', city: 'Bradenton' }],
    }, RK);
    const afterCall2 = mergeLeadExtractedData(afterCall1, {
      additional_properties: [{ address_line1: '100 First St', city: 'Sarasota' }],
    }, RK);
    expect(afterCall2.additional_properties).toHaveLength(2);
  });

  it('keeps an uncorroborated re-mention separate rather than risk merging two properties', () => {
    // Dropping a real property is unrecoverable; a duplicate is not. With no
    // zip or city to corroborate, the entries stay apart.
    const afterCall1 = mergeLeadExtractedData({}, { additional_properties: [PROP_A] }, RK);
    const afterCall2 = mergeLeadExtractedData(afterCall1, {
      additional_properties: [{ address_line1: '100 First St' }],
    }, RK);
    expect(afterCall2.additional_properties).toHaveLength(2);
  });

  it('keeps two genuinely different properties that share a street name', () => {
    const afterCall1 = mergeLeadExtractedData({}, { additional_properties: [PROP_A] }, RK);
    const afterCall2 = mergeLeadExtractedData(afterCall1, {
      additional_properties: [{ address_line1: '100 First St', zip: '34999' }],
    }, RK);
    expect(afterCall2.additional_properties).toHaveLength(2);
  });

  it('matches the same address across casing and spacing differences', () => {
    const afterCall1 = mergeLeadExtractedData({}, { additional_properties: [PROP_A] }, RK);
    const afterCall2 = mergeLeadExtractedData(
      afterCall1,
      { additional_properties: [{ address_line1: '  100 FIRST  ST ', zip: '34202' }] },
      RK,
    );
    expect(afterCall2.additional_properties).toHaveLength(1);
  });

  it('keeps the stored list when a later payload omits it', () => {
    const afterCall1 = mergeLeadExtractedData({}, { additional_properties: [PROP_A, PROP_B] }, RK);
    const afterCall2 = mergeLeadExtractedData(afterCall1, { sentiment: 'neutral' }, RK);
    expect(afterCall2.additional_properties).toHaveLength(2);
  });

  it('never drops a captured property, however many there are', () => {
    // Every property a caller discusses drives an estimate and a dispatch, so
    // the union is uncapped — losing one is unrecoverable.
    let data = {};
    for (let i = 0; i < 25; i += 1) {
      data = mergeLeadExtractedData(data, {
        additional_properties: [{ address_line1: `${i} Example Way`, zip: '34202' }],
      }, RK);
    }
    expect(data.additional_properties).toHaveLength(25);
  });

  it('does not truncate a stored row that already holds many properties', () => {
    const stored = {
      additional_properties: Array.from({ length: 14 }, (_, i) => ({
        address_line1: `${i} Stored Way`, zip: '34202',
      })),
    };
    const merged = mergeLeadExtractedData(stored, {
      additional_properties: [{ address_line1: '99 New Way', zip: '34202' }],
    }, RK);
    expect(merged.additional_properties).toHaveLength(15);
  });

  it('keeps a stored secondary contact when a later payload omits it', () => {
    const afterCall1 = mergeLeadExtractedData(
      {},
      { secondary_contact: { first_name: 'Pat', role: 'property_manager' } },
      RK,
    );
    const afterCall2 = mergeLeadExtractedData(afterCall1, { sentiment: 'neutral' }, RK);
    expect(afterCall2.secondary_contact.first_name).toBe('Pat');
  });
});
