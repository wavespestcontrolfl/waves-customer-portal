/**
 * Owner ruling 2026-09-30: DeSoto County (Arcadia) is not served. The V2
 * enforce gate already vetoes out_of_service_area, but with V2 disabled, or V2
 * in shadow (DRIVES_ROUTING off), the legacy inbound booking condition made no
 * geographic check and would auto-book an Arcadia address. legacyGeographicVeto
 * is the mode-independent hard veto wired ahead of that booking branch.
 *
 * A full processRecording() run cannot be mocked end-to-end (see
 * call-start-before-call-v2-disabled.test.js), so the decision helper is tested
 * behaviorally and the wiring is pinned structurally. Fictitious data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const CallRecordingProcessor = require('../services/call-recording-processor');

const { legacyGeographicVeto } = CallRecordingProcessor._test;
const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

describe('legacyGeographicVeto', () => {
  test('V2 disabled: no AV, no county, an Arcadia address is vetoed by locality', () => {
    const veto = legacyGeographicVeto({
      addressValidation: null,
      v2Extraction: null,
      extracted: { address_line1: '100 Example St', city: 'Arcadia', state: 'FL', zip: '34266' },
    });
    expect(veto).toEqual(expect.objectContaining({ reason: 'desoto_locality' }));
  });

  test('DeSoto ZIP alone (city missing) is vetoed', () => {
    expect(legacyGeographicVeto({ extracted: { zip: '34266-1234' } })).not.toBeNull();
  });

  test('V2 shadow: AV out_of_service_area verdict is vetoed', () => {
    const veto = legacyGeographicVeto({
      addressValidation: { status: 'out_of_service_area', inServiceArea: false, county: 'DeSoto County' },
      v2Extraction: { property: { service_address: { city: 'Arcadia', county: 'DeSoto' } } },
      extracted: { city: 'Arcadia', zip: '34266' },
    });
    expect(veto).toEqual(expect.objectContaining({ reason: 'address_validation_out_of_service_area' }));
  });

  test('extracted DeSoto county with no AV verdict is vetoed', () => {
    const veto = legacyGeographicVeto({
      addressValidation: { status: 'api_unavailable', inServiceArea: null },
      v2Extraction: { property: { service_address: { city: 'Somewhere', county: 'DeSoto' } } },
      extracted: { city: 'Somewhere' },
    });
    expect(veto).toEqual(expect.objectContaining({ reason: 'county_out_of_service_area' }));
  });

  test('a positive AV verdict is final; served addresses are not vetoed', () => {
    expect(legacyGeographicVeto({
      addressValidation: { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' },
      v2Extraction: { property: { service_address: { county: 'DeSoto' } } },
      extracted: { city: 'Bradenton', zip: '34209' },
    })).toBeNull();
    expect(legacyGeographicVeto({ extracted: { city: 'Bradenton', zip: '34209' } })).toBeNull();
    expect(legacyGeographicVeto({
      v2Extraction: { property: { service_address: { county: 'Sarasota' } } },
      extracted: { city: 'North Port', zip: '34286' },
    })).toBeNull();
  });

  test('served south-Hillsborough towns stay bookable in the legacy path', () => {
    expect(legacyGeographicVeto({
      addressValidation: { status: 'out_of_service_area', inServiceArea: false, county: 'Hillsborough County' },
      extracted: { city: 'Riverview', zip: '33578' },
    })).toBeNull();
  });
});

describe('legacy booking branch wiring', () => {
  test('the geographic veto sits ahead of the booking branch and is not keyed on any V2 mode', () => {
    const vetoAt = source.indexOf('legacyGeoVeto = legacyGeographicVeto({');
    expect(vetoAt).toBeGreaterThan(-1);
    const bookAt = source.indexOf('// Declared OUTSIDE the try so the catch', vetoAt);
    expect(bookAt).toBeGreaterThan(vetoAt);
    const branchHead = source.slice(source.lastIndexOf('} else if (', vetoAt), vetoAt);
    expect(branchHead).toContain('canCreateAppointmentFromCall');
    expect(branchHead).not.toMatch(/CALL_EXTRACTION_V2_(ENABLED|DRIVES_ROUTING)/);
    const branch = source.slice(vetoAt, bookAt);
    expect(branch).toContain("skippedReason: 'out_of_service_area'");
    expect(branch).toContain("bridgeNeedsConfirmation.push('out_of_service_area')");
    expect(branch).toContain('await fileSkippedBookingCard({');
    expect(branch).not.toContain('db(\'scheduled_services\')');
  });
});
