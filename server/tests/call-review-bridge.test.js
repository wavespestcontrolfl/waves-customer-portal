const { deriveCallReviewBridge, detectRentalSignal, streetCompareKey } = require('../services/call-triage-flags');

describe('streetCompareKey — suffix-insensitive street key', () => {
  test('St vs Street (and case/spacing) collapse together', () => {
    expect(streetCompareKey('123 Main St')).toBe(streetCompareKey('123 Main Street'));
    expect(streetCompareKey('123  MAIN st.')).toBe(streetCompareKey('123 Main Street'));
  });
  test('different house number stays distinct', () => {
    expect(streetCompareKey('123 Main St')).not.toBe(streetCompareKey('125 Main St'));
  });
});

describe('deriveCallReviewBridge — V1/V2 location guard (F3/F4)', () => {
  test('validated_accept, same street but DIFFERENT city → held (not adopted)', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'validated_accept', normalized: { street_line_1: '100 Main St', city: 'Bradenton', state: 'FL', postal_code: '34211' } },
      extracted: { address_line1: '100 Main St', city: 'Sarasota', lead_quality: 'warm' },
    });
    expect(out.normalizedAddress).toBeNull();
    expect(out.needsConfirmation).toContain('address_unverified');
  });

  test('corrected with a different city/ZIP STILL adopts (trusted Google correction)', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'corrected', normalized: { street_line_1: '100 Main St', city: 'Bradenton', state: 'FL', postal_code: '34211' } },
      extracted: { address_line1: '100 Main St', city: 'Sarasota', zip: '34236', lead_quality: 'warm' },
    });
    expect(out.normalizedAddress).toMatchObject({ address_line1: '100 Main St', city: 'Bradenton', zip: '34211' });
    expect(out.needsConfirmation).not.toContain('address_unverified');
  });

  test('V1 street-only (no house number) → held even when Google returns a premise (F4)', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'validated_accept', normalized: { street_line_1: '7620 Charleston Ln', city: 'Sarasota', state: 'FL', postal_code: '34243' } },
      extracted: { address_line1: 'Charleston Ln', city: 'Sarasota', lead_quality: 'warm' },
    });
    expect(out.normalizedAddress).toBeNull();
    expect(out.needsConfirmation).toContain('address_unverified');
  });
});

const NORMALIZED = { street_line_1: '7620 Charleston Ln', city: 'Sarasota', state: 'FL', postal_code: '34243' };

describe('detectRentalSignal (shared by bridge + property writer, works in both modes)', () => {
  test('tenant / property_manager caller relationship', () => {
    expect(detectRentalSignal({ callerRelationship: 'tenant' })).toBe(true);
    expect(detectRentalSignal({ callerRelationship: 'property_manager' })).toBe(true);
    expect(detectRentalSignal({ callerRelationship: 'owner' })).toBe(false);
  });
  test('owner-about-tenants text signal (Raymond call 1)', () => {
    expect(detectRentalSignal({ extracted: { pain_points: 'my tenants are having an ant problem' }, callerRelationship: 'owner' })).toBe(true);
  });
  test('owner-occupied with no rental language', () => {
    expect(detectRentalSignal({ extracted: { call_summary: 'wants maintenance at my house' }, callerRelationship: 'owner' })).toBe(false);
    expect(detectRentalSignal()).toBe(false);
  });
});

describe('deriveCallReviewBridge (address/identity shadow bridge)', () => {
  test('corrected → adopts Google address, no confirmation needed', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'corrected', normalized: NORMALIZED },
      extracted: { address_line1: '7620 Charleston St', city: 'Sarasota', zip: '34232', first_name: 'Elaine', last_name: 'Gall', lead_quality: 'hot' },
    });
    expect(out.normalizedAddress).toEqual({ address_line1: '7620 Charleston Ln', city: 'Sarasota', state: 'FL', zip: '34243' });
    expect(out.needsConfirmation).toEqual([]);
  });

  test('validated_accept → adopts normalized fields, no flags', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'validated_accept', normalized: NORMALIZED },
      extracted: { address_line1: '7620 Charleston Ln', first_name: 'Bob', last_name: 'Jones', lead_quality: 'warm' },
    });
    expect(out.normalizedAddress.zip).toBe('34243');
    expect(out.needsConfirmation).toEqual([]);
  });

  test('validated_accept but a DIFFERENT street than the legacy address → held for review, not adopted', () => {
    // Google validated the V2 address is real, but it is a different street than
    // what V1 extracted — in shadow mode we must NOT overwrite the legacy address.
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'validated_accept', normalized: NORMALIZED }, // 7620 Charleston Ln
      extracted: { address_line1: '123 Main St', city: 'Sarasota', first_name: 'Pat', last_name: 'Doe', lead_quality: 'warm' },
    });
    expect(out.normalizedAddress).toBeNull();
    expect(out.needsConfirmation).toContain('address_unverified');
  });

  test('same house number + shared first token but DIFFERENT street → held, not adopted', () => {
    // "123 Amber Way" (Google) vs "123 Amber Creek Dr" (V1) share house 123 and
    // the token "amber" — that is NOT the same street; must hold for review.
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'validated_accept', normalized: { street_line_1: '123 Amber Way', city: 'Bradenton', state: 'FL', postal_code: '34211' } },
      extracted: { address_line1: '123 Amber Creek Dr', city: 'Bradenton', lead_quality: 'warm' },
    });
    expect(out.normalizedAddress).toBeNull();
    expect(out.needsConfirmation).toContain('address_unverified');
  });

  test('same house number + same street, different suffix (Ln vs Dr) → adopted (ZIP/suffix normalization)', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'corrected', normalized: { street_line_1: '123 Amber Creek Ln', city: 'Bradenton', state: 'FL', postal_code: '34211' } },
      extracted: { address_line1: '123 Amber Creek Dr', city: 'Bradenton', zip: '34210', lead_quality: 'warm' },
    });
    expect(out.normalizedAddress).toMatchObject({ address_line1: '123 Amber Creek Ln', zip: '34211' });
    expect(out.needsConfirmation).not.toContain('address_unverified');
  });

  test.each(['missing_component', 'ambiguous', 'confirm_needed'])(
    '%s with a street given → address_unverified, no address adopted',
    (status) => {
      const out = deriveCallReviewBridge({
        addressValidation: { status },
        extracted: { address_line1: '7620 Charleston St', city: 'Sarasota', first_name: 'Elaine', lead_quality: 'cold' },
      });
      expect(out.normalizedAddress).toBeNull();
      expect(out.needsConfirmation).toContain('address_unverified');
    }
  );

  test('out_of_service_area with a street → out_of_service_area reason', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'out_of_service_area' },
      extracted: { address_line1: '1 Main St', city: 'Tampa', lead_quality: 'cold' },
    });
    expect(out.needsConfirmation).toEqual(['out_of_service_area']);
  });

  test('unverifiable status but NO street (city-only) → not flagged', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'missing_component' },
      extracted: { city: 'Sarasota', first_name: 'Elaine', lead_quality: 'cold' },
    });
    expect(out.needsConfirmation).toEqual([]);
  });

  test('transient AV statuses (api_unavailable / not_attempted) never flag or adopt', () => {
    for (const status of ['api_unavailable', 'not_attempted']) {
      const out = deriveCallReviewBridge({
        addressValidation: { status },
        extracted: { address_line1: '7620 Charleston St', first_name: 'Elaine', last_name: 'Gall', lead_quality: 'hot' },
      });
      expect(out.normalizedAddress).toBeNull();
      expect(out.needsConfirmation).toEqual([]);
    }
  });

  test('caller_not_authorized model flag surfaces (caller arranging for someone else)', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'validated_accept', normalized: NORMALIZED },
      extracted: { address_line1: '7620 Charleston Ln', first_name: 'Elaine', last_name: 'Gall', lead_quality: 'hot' },
      v2TriageFlags: ['caller_not_authorized', 'no_sms_consent_captured'],
    });
    expect(out.needsConfirmation).toEqual(['caller_not_authorized']);
  });

  test('missing surname flagged ONLY on a hot/warm prospect', () => {
    const base = { address_line1: '7620 Charleston Ln', first_name: 'Elaine', last_name: '' };
    expect(deriveCallReviewBridge({ extracted: { ...base, lead_quality: 'hot' } }).needsConfirmation).toContain('missing_last_name');
    expect(deriveCallReviewBridge({ extracted: { ...base, lead_quality: 'warm' } }).needsConfirmation).toContain('missing_last_name');
    expect(deriveCallReviewBridge({ extracted: { ...base, lead_quality: 'cold' } }).needsConfirmation).not.toContain('missing_last_name');
  });

  test('Elaine/Martin call (this incident): unverifiable address + caller-not-owner + no surname all surface', () => {
    const out = deriveCallReviewBridge({
      addressValidation: { status: 'confirm_needed' },
      extracted: { address_line1: '7620 Charleston St', city: 'Sarasota', first_name: 'Elaine', last_name: '', lead_quality: 'hot' },
      v2TriageFlags: ['caller_not_authorized'],
    });
    expect(out.normalizedAddress).toBeNull();
    expect(out.needsConfirmation).toEqual(
      expect.arrayContaining(['address_unverified', 'caller_not_authorized', 'missing_last_name'])
    );
  });

  test('no address validation object at all → still derives identity flags', () => {
    const out = deriveCallReviewBridge({
      extracted: { first_name: 'Elaine', last_name: '', lead_quality: 'hot' },
    });
    expect(out.normalizedAddress).toBeNull();
    expect(out.needsConfirmation).toEqual(['missing_last_name']);
  });

  test('empty input is safe', () => {
    expect(deriveCallReviewBridge()).toEqual({ normalizedAddress: null, needsConfirmation: [] });
    expect(deriveCallReviewBridge({})).toEqual({ normalizedAddress: null, needsConfirmation: [] });
  });

  test.each(['tenant', 'property_manager'])('caller relationship %s → rental_or_tenant_occupied', (rel) => {
    const out = deriveCallReviewBridge({ extracted: { first_name: 'Sam', last_name: 'Lee', lead_quality: 'warm' }, callerRelationship: rel });
    expect(out.needsConfirmation).toContain('rental_or_tenant_occupied');
  });

  test('owner calling about their tenants (Raymond call 1) → rental flag via text', () => {
    const out = deriveCallReviewBridge({
      extracted: { first_name: 'Raymond', last_name: 'Bivona', lead_quality: 'hot', pain_points: 'my tenants are having an ant problem' },
      callerRelationship: 'owner',
    });
    expect(out.needsConfirmation).toContain('rental_or_tenant_occupied');
  });

  test('owner-occupied home, no tenant language → NOT flagged rental', () => {
    const out = deriveCallReviewBridge({
      extracted: { first_name: 'Raymond', last_name: 'Bivona', lead_quality: 'warm', pain_points: 'wants every-other-month maintenance at my house' },
      callerRelationship: 'owner',
    });
    expect(out.needsConfirmation).not.toContain('rental_or_tenant_occupied');
  });
});
