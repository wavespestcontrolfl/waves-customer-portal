const { deriveCallReviewBridge } = require('../services/call-triage-flags');

const NORMALIZED = { street_line_1: '7620 Charleston Ln', city: 'Sarasota', state: 'FL', postal_code: '34243' };

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
