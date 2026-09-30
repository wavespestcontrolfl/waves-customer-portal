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

  test.each(['Lake Suzy', 'Ft. Ogden', 'FT OGDEN', 'Brownville', 'Southeast Arcadia', 'Pine Level'])(
    'V2 disabled: a DeSoto locality stated with no ZIP or county (%s) is vetoed',
    (city) => {
      const veto = legacyGeographicVeto({
        addressValidation: null,
        v2Extraction: null,
        extracted: { address_line1: '100 Example St', city, state: 'FL' },
      });
      expect(veto).toEqual(expect.objectContaining({ reason: 'desoto_locality' }));
    },
  );

  test('no stated locality and the on-file read failed: held for review', () => {
    expect(legacyGeographicVeto({
      addressValidation: null, v2Extraction: null,
      extracted: { address_line1: null, city: null, zip: null },
      onFile: { lookupFailed: true },
    })).toEqual({ reason: 'on_file_address_unavailable', county: null });
  });

  test('a stated served locality is judged on its own even when the on-file read failed', () => {
    expect(legacyGeographicVeto({
      addressValidation: null, v2Extraction: null,
      extracted: { address_line1: '100 Example St', city: 'Venice', zip: '34285' },
      onFile: { lookupFailed: true },
    })).toBeNull();
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
    expect(veto).toEqual(expect.objectContaining({ reason: 'desoto_locality' }));
  });

  test('extracted DeSoto county with no AV verdict is vetoed', () => {
    const veto = legacyGeographicVeto({
      addressValidation: { status: 'api_unavailable', inServiceArea: null },
      v2Extraction: { property: { service_address: { city: 'Somewhere', county: 'DeSoto' } } },
      extracted: { city: 'Somewhere' },
    });
    expect(veto).toEqual(expect.objectContaining({ reason: 'desoto_locality' }));
    // A non-DeSoto unserved county with no AV verdict is vetoed by county.
    expect(legacyGeographicVeto({
      addressValidation: { status: 'api_unavailable', inServiceArea: null },
      v2Extraction: { property: { service_address: { county: 'Hardee' } } },
      extracted: { city: 'Somewhere' },
    })).toEqual(expect.objectContaining({ reason: 'county_out_of_service_area' }));
    // A non-DeSoto AV verdict is vetoed by the verdict.
    expect(legacyGeographicVeto({
      addressValidation: { status: 'out_of_service_area', inServiceArea: false, county: 'Hardee County' },
      extracted: { city: 'Somewhere' },
    })).toEqual(expect.objectContaining({ reason: 'address_validation_out_of_service_area' }));
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

describe('legacyGeographicVeto: conflicting evidence and on-file address (Codex r2)', () => {
  test('DeSoto ZIP is not laundered by a served-town city', () => {
    expect(legacyGeographicVeto({ extracted: { city: 'Riverview', zip: '34266' } })).not.toBeNull();
  });

  test('a DeSoto AV verdict is not exempted by a Riverview city; only a Hillsborough verdict is', () => {
    expect(legacyGeographicVeto({
      addressValidation: { status: 'out_of_service_area', inServiceArea: false, county: 'DeSoto County' },
      extracted: { city: 'Riverview', zip: '33578' },
    })).not.toBeNull();
    expect(legacyGeographicVeto({
      addressValidation: { status: 'out_of_service_area', inServiceArea: false, county: 'Hardee County' },
      extracted: { city: 'Riverview', zip: '33578' },
    })).not.toBeNull();
    expect(legacyGeographicVeto({
      addressValidation: { status: 'out_of_service_area', inServiceArea: false, county: 'Hillsborough County' },
      extracted: { city: 'Riverview', zip: '33578' },
    })).toBeNull();
  });

  test('known caller who states no address: an on-file Arcadia profile is vetoed', () => {
    expect(legacyGeographicVeto({
      extracted: { appointment_confirmed: true },
      onFile: { city: 'Arcadia', zip: '34266', latitude: null, longitude: null },
    })).toEqual(expect.objectContaining({ reason: 'desoto_locality' }));
    // City/ZIP blank on file but stored coordinates sit in DeSoto with no served ZIP.
    expect(legacyGeographicVeto({
      extracted: {},
      onFile: { city: null, zip: null, latitude: 27.2159, longitude: -81.8584 },
    })).not.toBeNull();
  });

  test('on-file address is ignored when the call states its own locality, and served on-file profiles pass', () => {
    expect(legacyGeographicVeto({
      extracted: { city: 'Bradenton', zip: '34209' },
      onFile: { city: 'Arcadia', zip: '34266' },
    })).toBeNull();
    expect(legacyGeographicVeto({
      extracted: {},
      onFile: { city: 'Myakka City', zip: '34251', latitude: 27.35, longitude: -82.15 },
    })).toBeNull();
    // Sliver: stored coordinates inside the DeSoto rectangle but a served ZIP.
    expect(legacyGeographicVeto({
      extracted: {},
      onFile: { city: null, zip: '34240', latitude: 27.2, longitude: -82.0 },
    })).toBeNull();
    expect(legacyGeographicVeto({ extracted: {}, onFile: null })).toBeNull();
  });
});

describe('legacy booking branch wiring', () => {
  test('only a VALID V2 extraction feeds the veto, and the on-file row is read before the booking branch', () => {
    const callAt = source.indexOf('legacyGeoVeto = legacyGeographicVeto({');
    expect(callAt).toBeGreaterThan(-1);
    const call = source.slice(callAt, callAt + 260);
    expect(call).toContain('v2Extraction: v2CanonicalExtraction');
    expect(call).not.toContain('v2Result?.extraction');
    expect(call).toContain('onFile: onFileGeo');
    expect(source.slice(callAt - 900, callAt)).toContain("db('customers').where({ id: customerId }).first('city', 'zip', 'latitude', 'longitude')");
  });

  test('a failed on-file read fails closed instead of passing as no evidence', () => {
    const callAt = source.indexOf('legacyGeoVeto = legacyGeographicVeto({');
    const catchBlock = source.slice(callAt - 700, callAt);
    expect(catchBlock).toContain('onFileGeo = { lookupFailed: true };');
  });

  test('the geographic veto sits ahead of the booking branch and is not keyed on any V2 mode', () => {
    const vetoAt = source.indexOf('&& legacyGeoVeto) {');
    expect(vetoAt).toBeGreaterThan(-1);
    const bookAt = source.indexOf('// Declared OUTSIDE the try so the catch', vetoAt);
    expect(bookAt).toBeGreaterThan(vetoAt);
    const branchHead = source.slice(source.lastIndexOf('} else if (', vetoAt), vetoAt);
    expect(branchHead).toContain('canCreateAppointmentFromCall');
    expect(branchHead).not.toMatch(/CALL_EXTRACTION_V2_(ENABLED|DRIVES_ROUTING)/);
    const branch = source.slice(vetoAt, bookAt);
    expect(branch).toContain("legacyGeoVeto.reason === 'on_file_address_unavailable'");
    expect(branch).toContain("? 'service_area_unverified'");
    expect(branch).toContain(": 'out_of_service_area'");
    expect(branch).toContain('skippedReason: geoSkipReason');
    expect(branch).toContain('bridgeNeedsConfirmation.push(geoSkipReason)');
    expect(branch).toContain('await fileSkippedBookingCard({');
    expect(branch).not.toContain('db(\'scheduled_services\')');
  });
});
