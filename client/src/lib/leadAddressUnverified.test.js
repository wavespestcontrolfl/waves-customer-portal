import { describe, expect, it } from 'vitest';
import { leadAddressUnverified, leadAddressUnverifiedNotice } from './leadAddressUnverified';

const flag = {
  source: 'county_roll',
  reason: 'The Sample county roll could not match house number 1260 on EXAMPLE ST.',
  county: 'Sample',
  house_number: '1260',
  street_exists: true,
  nearest_numbers: ['1251', '1254', '1255'],
};

describe('leadAddressUnverified', () => {
  it('reads the flag from jsonb and from a JSON string', () => {
    expect(leadAddressUnverified({ extracted_data: { address_unverified: flag } })).toEqual({
      reason: flag.reason, county: 'Sample', houseNumber: '1260', nearestNumbers: ['1251', '1254', '1255'],
    });
    expect(leadAddressUnverified({ extracted_data: JSON.stringify({ address_unverified: flag }) })?.houseNumber).toBe('1260');
  });

  it('hides the flag once the lead address no longer matches the one the roll judged', () => {
    const stamped = { ...flag, address_line1: '1260 Example St', zip: '34219' };
    expect(leadAddressUnverified({ address: '1260 EXAMPLE ST., Parrish, FL 34219', zip: '34219', extracted_data: { address_unverified: stamped } })).not.toBeNull();
    expect(leadAddressUnverified({ address: '1260 Example St', extracted_data: { address_unverified: stamped } })).not.toBeNull();
    expect(leadAddressUnverified({ address: '1250 Example St, Parrish, FL 34219', zip: '34219', extracted_data: { address_unverified: stamped } })).toBeNull();
    expect(leadAddressUnverified({ address: '1260 Example St', zip: '34221', extracted_data: { address_unverified: stamped } })).toBeNull();
    // A unit added inline is the same audited house number.
    expect(leadAddressUnverified({ address: '1260 Example St Apt 4, Parrish, FL 34219', zip: '34219', extracted_data: { address_unverified: stamped } })).not.toBeNull();
    // A five-digit house number is not the ZIP when the lead's zip column is empty.
    const bigNumber = { ...flag, address_line1: '12345 Example St', zip: '34219' };
    expect(leadAddressUnverified({ address: '12345 Example St, Parrish, FL 34219', extracted_data: { address_unverified: bigNumber } })).not.toBeNull();
    expect(leadAddressUnverified({ address: '12345 Example St, Parrish, FL 34221', extracted_data: { address_unverified: bigNumber } })).toBeNull();
    // A city change alone (ZIP-less lead) retires it too.
    const cityStamped = { ...flag, address_line1: '1260 Example St', city: 'Parrish' };
    expect(leadAddressUnverified({ address: '1260 Example St, Bradenton, FL', extracted_data: { address_unverified: cityStamped } })).toBeNull();
    expect(leadAddressUnverified({ address: '1260 Example St', city: 'Parrish', extracted_data: { address_unverified: cityStamped } })).not.toBeNull();
    // An older flag with no stamped address still shows.
    expect(leadAddressUnverified({ address: '1250 Example St', extracted_data: { address_unverified: flag } })).not.toBeNull();
  });

  it('is null for an unflagged, malformed, or missing lead', () => {
    expect(leadAddressUnverified({ extracted_data: {} })).toBeNull();
    expect(leadAddressUnverified({ extracted_data: { address_unverified: { county: 'Sample' } } })).toBeNull();
    expect(leadAddressUnverified({ extracted_data: '{not json' })).toBeNull();
    expect(leadAddressUnverified(null)).toBeNull();
  });

  it('shows the audit\'s own reason, then what to do — never a paraphrase', () => {
    expect(leadAddressUnverifiedNotice({ extracted_data: { address_unverified: flag } })).toBe(
      'Address unverified — The Sample county roll could not match house number 1260 on EXAMPLE ST. Confirm the address on the callback before sending an estimate.',
    );
    // A snap to a neighbour where BOTH numbers exist is a different ask and
    // must reach the card as written.
    const snapped = 'Typed house number 1260, but the property record below describes 1250 — the geocoder snapped to a nearby premise. Both numbers exist on the Sample county roll — confirm which property is the customer\'s before pricing';
    expect(leadAddressUnverifiedNotice({ extracted_data: { address_unverified: { reason: snapped } } })).toBe(
      `Address unverified — ${snapped}. Confirm the address on the callback before sending an estimate.`,
    );
    expect(leadAddressUnverifiedNotice({ extracted_data: { address_unverified: { reason: '  spaced   out  ' } } })).toBe(
      'Address unverified — spaced out. Confirm the address on the callback before sending an estimate.',
    );
    expect(leadAddressUnverifiedNotice({ extracted_data: {} })).toBeNull();
  });
});
