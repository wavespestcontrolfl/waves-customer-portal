/**
 * Satellite structure-attachment → townhome/condo detection.
 *
 * New construction in master-planned SWFL communities (e.g. an attached villa
 * in a Toll Brothers community) is often absent from the FDOR cadastral roll,
 * the county PAO, AND the listing sites, so propertyType used to default
 * silently to "Single Family" from an unknown source. The satellite vision
 * pass now reports structureAttachment; when the record's type is weak AND the
 * read is confident, that surfaces a townhome/condo as satellite evidence with
 * a verify nudge — never overriding authoritative data, and never repricing on
 * a low-confidence / divergent guess (townhome/condo is a discount).
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { _private: routePrivate, buildEnrichedProfile } = require('../routes/property-lookup-v2');

const {
  propertyTypeFromAttachment,
  recordPropertyTypeIsWeak,
  buildFieldVerifyFlags,
  mergeAiAnalyses,
  applySatelliteAttachmentType,
  applyParcelTurfBound,
} = routePrivate;

beforeEach(() => jest.clearAllMocks());

// A thin AI web-search record like the failing Lucaya Dr lookup: a value is
// present but it came from a weak/unknown source.
function weakAiRecord(overrides = {}) {
  return {
    formattedAddress: '17742 Lucaya Dr, Bradenton, FL 34202',
    propertyType: 'Single Family',
    squareFootage: null,
    lotSize: null,
    stories: null,
    _source: 'ai',
    _aiProviders: ['claude', 'openai', 'gemini'],
    _fieldEvidence: {
      propertyType: {
        value: 'Single Family',
        confidence: 'low',
        sourceType: 'unknown',
        sourceLabel: 'a weak source',
        fieldVerify: true,
        score: 20,
      },
    },
    ...overrides,
  };
}

// A merged-vision-shaped analysis: mergeAiAnalyses stamps both the blended
// confidenceScore and the field-level _structureAttachmentConfidence the
// pricing guard actually reads.
function mergedAi(attachment, conf, extra = {}) {
  return {
    structureAttachment: attachment,
    confidenceScore: conf,
    _structureAttachmentConfidence: conf,
    ...extra,
  };
}

describe('propertyTypeFromAttachment', () => {
  test('maps the attached enums to estimator types the pricing normalizer understands', () => {
    expect(propertyTypeFromAttachment({ structureAttachment: 'ATTACHED_END' })).toBe('Townhome');
    expect(propertyTypeFromAttachment({ structureAttachment: 'ATTACHED_INTERIOR' })).toBe('Interior Townhome');
    expect(propertyTypeFromAttachment({ structureAttachment: 'STACKED' })).toBe('Condo');
  });

  test('is case-insensitive and returns null for detached/unknown/missing', () => {
    expect(propertyTypeFromAttachment({ structureAttachment: 'attached_end' })).toBe('Townhome');
    expect(propertyTypeFromAttachment({ structureAttachment: 'DETACHED' })).toBeNull();
    expect(propertyTypeFromAttachment({ structureAttachment: 'UNKNOWN' })).toBeNull();
    expect(propertyTypeFromAttachment({})).toBeNull();
    expect(propertyTypeFromAttachment(null)).toBeNull();
  });
});

describe('recordPropertyTypeIsWeak', () => {
  test('missing record, missing type, and no evidence trail are all weak', () => {
    expect(recordPropertyTypeIsWeak(null)).toBe(true);
    expect(recordPropertyTypeIsWeak({ propertyType: '' })).toBe(true);
    expect(recordPropertyTypeIsWeak({ propertyType: 'Single Family' })).toBe(true); // no evidence
  });

  test('unknown/generic source or a field-verify flag are weak', () => {
    expect(recordPropertyTypeIsWeak({ propertyType: 'Single Family', _fieldEvidence: { propertyType: { sourceType: 'unknown' } } })).toBe(true);
    expect(recordPropertyTypeIsWeak({ propertyType: 'Single Family', _fieldEvidence: { propertyType: { sourceType: 'generic' } } })).toBe(true);
    expect(recordPropertyTypeIsWeak({ propertyType: 'Single Family', _fieldEvidence: { propertyType: { sourceType: 'county', fieldVerify: true } } })).toBe(true);
  });

  test('authoritative county/cadastral/verified values are NOT weak', () => {
    expect(recordPropertyTypeIsWeak({ propertyType: 'Single Family', _fieldEvidence: { propertyType: { sourceType: 'county', fieldVerify: false } } })).toBe(false);
    expect(recordPropertyTypeIsWeak({ propertyType: 'Townhome', _fieldEvidence: { propertyType: { sourceType: 'verified', fieldVerify: false } } })).toBe(false);
  });
});

describe('buildEnrichedProfile — satellite attachment fallback', () => {
  test('weak record + confident ATTACHED_END surfaces a townhome as satellite evidence with a verify nudge', () => {
    const rc = weakAiRecord();
    const profile = buildEnrichedProfile(rc, mergedAi('ATTACHED_END', 75), 27.4, -82.4);

    expect(profile.propertyType).toBe('Townhome');
    // Mutated onto the record so flags + pricing + the response all agree.
    expect(rc.propertyType).toBe('Townhome');
    expect(rc._fieldEvidence.propertyType.sourceType).toBe('satellite');
    expect(rc._fieldEvidence.propertyType.fieldVerify).toBe(true);
    expect(rc._propertyTypeSource).toBe('satellite');
    expect(rc._dataQuality).toBeTruthy();
  });

  test('does NOT override an authoritative county propertyType', () => {
    const rc = weakAiRecord({
      propertyType: 'Single Family',
      _fieldEvidence: { propertyType: { sourceType: 'county', fieldVerify: false, score: 100 } },
    });
    const profile = buildEnrichedProfile(rc, mergedAi('ATTACHED_END', 90), 27.4, -82.4);

    expect(profile.propertyType).toBe('Single Family');
    expect(rc._propertyTypeSource).toBeUndefined();
  });

  test('detached/unknown attachment leaves the default untouched', () => {
    const rc = weakAiRecord();
    const profile = buildEnrichedProfile(rc, mergedAi('DETACHED', 80), 27.4, -82.4);
    expect(profile.propertyType).toBe('Single Family');
    expect(rc._propertyTypeSource).toBeUndefined();
  });
});

describe('confidence gate (codex P2/P1) — never reprice on a shaky read', () => {
  test('low field-level confidence does NOT change the priced type (stays Single Family)', () => {
    const rc = weakAiRecord();
    const profile = buildEnrichedProfile(rc, mergedAi('ATTACHED_END', 50), 27.4, -82.4);
    expect(profile.propertyType).toBe('Single Family');
    expect(rc._propertyTypeSource).toBeUndefined();
  });

  test('missing field-level confidence does NOT change the priced type', () => {
    const rc = weakAiRecord();
    const profile = buildEnrichedProfile(rc, { structureAttachment: 'STACKED' }, 27.4, -82.4);
    expect(profile.propertyType).toBe('Single Family');
    expect(rc._propertyTypeSource).toBeUndefined();
  });

  test('cross-provider divergence on structureAttachment blocks the change even at high confidence', () => {
    const rc = weakAiRecord();
    const ai = mergedAi('ATTACHED_END', 85, { aiDivergences: [{ field: 'structureAttachment', primary: 'claude' }] });
    const profile = buildEnrichedProfile(rc, ai, 27.4, -82.4);
    expect(profile.propertyType).toBe('Single Family');
    expect(rc._propertyTypeSource).toBeUndefined();
  });

  // The codex P1: a lone low-confidence provider's gap-filled attachment must
  // not average its way past the bar via two high-confidence providers that
  // omitted the field.
  test('gap-filled attachment from a single low-confidence provider is NOT applied', () => {
    const merged = mergeAiAnalyses([
      { provider: 'claude', analysis: { confidenceScore: 85 } },
      { provider: 'openai', analysis: { confidenceScore: 85 } },
      { provider: 'gemini', analysis: { structureAttachment: 'ATTACHED_END', confidenceScore: 40 } },
    ]);
    expect(merged.structureAttachment).toBe('ATTACHED_END'); // gap-filled
    expect(merged.confidenceScore).toBeGreaterThanOrEqual(70); // blended avg clears the bar...
    expect(merged._structureAttachmentConfidence).toBe(40); // ...but the actual read does not

    const rc = weakAiRecord();
    applySatelliteAttachmentType(rc, merged);
    expect(rc._propertyTypeSource).toBeUndefined();
  });

  test('consensus high-confidence attachment IS applied end-to-end through the merge', () => {
    const merged = mergeAiAnalyses([
      { provider: 'claude', analysis: { structureAttachment: 'ATTACHED_END', confidenceScore: 80 } },
      { provider: 'openai', analysis: { structureAttachment: 'ATTACHED_END', confidenceScore: 75 } },
      { provider: 'gemini', analysis: { confidenceScore: 60 } },
    ]);
    expect(merged._structureAttachmentConfidence).toBe(80);
    const rc = weakAiRecord();
    expect(applySatelliteAttachmentType(rc, merged)).toBe('Townhome');
  });
});

describe('buildFieldVerifyFlags — townhome nudge', () => {
  test('a satellite-sourced propertyType gets a townhome-specific confirm message', () => {
    const rc = weakAiRecord();
    const ai = mergedAi('ATTACHED_INTERIOR', 75);
    buildEnrichedProfile(rc, ai, 27.4, -82.4); // applies the satellite evidence
    const flags = buildFieldVerifyFlags(rc, ai);
    const typeFlag = flags.find((f) => f.field === 'propertyType');
    expect(typeFlag).toBeTruthy();
    expect(typeFlag.reason).toMatch(/confirm townhome vs single-family/i);
    expect(typeFlag.reason).toMatch(/interior row unit/i);
  });
});

describe('ordering: reclassify before the turf cap (codex P1 regression)', () => {
  // applyParcelTurfBound skips townhome/condo. If the satellite reclassify ran
  // AFTER the cap, a weak "Single Family" attached unit would have its turf
  // clamped to its small parcel and be underpriced. The route applies the
  // attachment type FIRST; this pins that the cap then leaves turf alone.
  test('attached unit with turf above parcel area is NOT clamped once reclassified first', () => {
    const rc = weakAiRecord({ _parcel: { polygonAreaSqft: 2000 } });
    const ai = mergedAi('ATTACHED_END', 75, { estimatedTurfSf: 6000 });

    applySatelliteAttachmentType(rc, ai); // route order: BEFORE the cap
    applyParcelTurfBound(ai, rc);

    expect(rc.propertyType).toBe('Townhome');
    expect(ai.estimatedTurfSf).toBe(6000); // untouched — cap skipped townhome
    expect(ai.turfCappedToParcel).toBeUndefined();
  });

  test('a detached single-family unit above parcel area still gets clamped', () => {
    const rc = weakAiRecord({ _parcel: { polygonAreaSqft: 2000 } });
    const ai = mergedAi('DETACHED', 80, { estimatedTurfSf: 6000 });

    applySatelliteAttachmentType(rc, ai);
    applyParcelTurfBound(ai, rc);

    expect(rc.propertyType).toBe('Single Family');
    expect(ai.estimatedTurfSf).toBe(2000); // clamped to parcel
    expect(ai.turfCappedToParcel).toBe(true);
  });

  test('applySatelliteAttachmentType is idempotent (no re-apply after the route call)', () => {
    const rc = weakAiRecord();
    const ai = mergedAi('ATTACHED_END', 75);
    expect(applySatelliteAttachmentType(rc, ai)).toBe('Townhome');
    expect(applySatelliteAttachmentType(rc, ai)).toBeNull(); // already satellite-sourced
  });
});

describe('mergeAiAnalyses — structureAttachment', () => {
  test('carries the field through and lets a higher-confidence provider win', () => {
    const merged = mergeAiAnalyses([
      { provider: 'claude', analysis: { structureAttachment: 'DETACHED', confidenceScore: 60 } },
      { provider: 'gemini', analysis: { structureAttachment: 'ATTACHED_END', confidenceScore: 85 } },
    ]);
    expect(merged.structureAttachment).toBe('ATTACHED_END');
    expect(merged._structureAttachmentConfidence).toBe(85);
  });

  test('fills the field from a secondary provider when the primary omitted it', () => {
    const merged = mergeAiAnalyses([
      { provider: 'claude', analysis: { confidenceScore: 70 } },
      { provider: 'openai', analysis: { structureAttachment: 'STACKED', confidenceScore: 40 } },
    ]);
    expect(merged.structureAttachment).toBe('STACKED');
    expect(merged._structureAttachmentConfidence).toBe(40);
  });
});
