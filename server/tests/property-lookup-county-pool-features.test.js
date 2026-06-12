const {
  buildEnrichedProfile,
  _private: routePrivate,
} = require('../routes/property-lookup-v2');
const { _private: aiPrivate } = require('../services/property-lookup/ai-property-lookup');

const {
  classifyPoolCageSize,
  mergePool,
  poolRecordContext,
  poolSource,
} = routePrivate;
const {
  charlottePoolFeatures,
  manateePoolFeatures,
  mergePropertyRecords,
  poolFactsFromFeatures,
  sarasotaPoolFeatures,
  shapeAsPropertyRecord,
} = aiPrivate;

// ── Fixtures captured from live county probes (2026-06-12) ──

// Manatee pao-model-features.php for a 2022 LWR pool home.
const MANATEE_FEATURES = {
  cols: [
    { title: 'Type' }, { title: 'Bldg' }, { title: 'Num' }, { title: 'Description' },
    { title: 'Classification' }, { title: 'YrBlt' }, { title: 'EffYr' }, { title: 'Length' },
    { title: 'Width' }, { title: 'Area' }, { title: 'Units' }, { title: 'Impervious' }, { title: 'Sketched' },
  ],
  rows: [
    ['OBY', '1', '1', 'CAGE 1 STORY', null, '2022', '2022', null, null, '1,066', '1.00', 'NO', 'YES'],
    ['OBY', '1', '2', 'RESIDENTIAL POOL', null, '2022', '2022', null, null, '288', '1.00', 'YES', 'NO'],
    ['OBY', '1', '3', 'SPA-ATTACHED', null, '2022', '2022', null, null, '1', '1.00', 'YES', 'NO'],
    ['OBY', '1', '4', 'POOL DECK GOOD', null, '2022', '2022', null, null, '729', '1.00', 'YES', 'NO'],
  ],
};

// Sarasota detail-page Extra Features grid (heading + bare table, no id).
function sarasotaHtml(rows) {
  return `
<span class="h2" style="margin-top:10px;margin-bottom:18px;">Extra Features</span>
<table class="grid"><thead><tr><th align="center">line #</th><th align="center">Building Number</th><th align="center">Description</th><th align="center">Units</th><th align="center">Unit Type</th><th align="center">Year</th></tr></thead><tbody>${rows}</tbody></table>
<span class="h2" style="margin-bottom:18px;">Values</span>
<table class="grid"><thead><tr><th align="center">Year</th><th align="center">Extra Feature</th></tr></thead><tbody><tr><td>2025</td><td>$1,400</td></tr></tbody></table>`;
}
const SARASOTA_POOL_HTML = sarasotaHtml(`
<tr class="gridrow"><td>1</td><td style="width:130px;">1</td><td>Screened Enclosure</td><td>1066</td><td>SF</td><td>1987</td></tr>
<tr class="gridrow_alternate"><td>2</td><td>1</td><td>Patio - concrete or Pavers</td><td>674</td><td>SF</td><td>1987</td></tr>
<tr class="gridrow"><td>3</td><td>1</td><td>Swimming Pool</td><td>392</td><td>SF</td><td>1987</td></tr>`);
const SARASOTA_NO_POOL_HTML = sarasotaHtml(`
<tr class="gridrow"><td>1</td><td>1</td><td>Privacy Wall Residential</td><td>55</td><td>SF</td><td>2001</td></tr>`);

// Charlotte Show_Parcel Land Improvement Information table (oth=T).
function charlotteHtml(rows) {
  return `
<table class="prctable w3-centered"><caption class="blockcaption">Land Improvement Information</caption>
<thead><tr>
<th class="w3-centered"><strong><a href="/downloads/land improvement codes.xlsx">Code</a></strong></th>
<th class="w3-centered"><strong>Description</strong></th>
<th class="w3-centered"><strong>Size</strong></th>
<th class="w3-centered"><strong>Year Built</strong></th>
<th class="w3-centered"><strong>Year Condition</strong></th>
</tr></thead>
${rows}
</table>`;
}
const CHARLOTTE_POOL_HTML = charlotteHtml(`
<tr><td>0510&nbsp;</td><td>Pool - Gunite (sq. Ft.)  &nbsp;</td><td>392&nbsp;</td><td>1990&nbsp;</td><td>1990&nbsp;</td></tr>
<tr><td>0612&nbsp;</td><td>Screen Cage, 8  - Aluminum Frame - 3 Walls (sq. Ft.)  &nbsp;</td><td>840&nbsp;</td><td>1990&nbsp;</td><td>1990&nbsp;</td></tr>
<tr><td>0703&nbsp;</td><td>Porch/Deck&nbsp;</td><td>120&nbsp;</td><td>1990&nbsp;</td><td>1990&nbsp;</td></tr>`);

describe('poolFactsFromFeatures', () => {
  it('classifies pool, cage, and spa rows; deck/heater rows never count as the pool', () => {
    const facts = poolFactsFromFeatures([
      { description: 'POOL DECK GOOD', sqft: 729 },
      { description: 'POOL HEATER', sqft: null },
      { description: 'RESIDENTIAL POOL', sqft: 288 },
      { description: 'SPA-ATTACHED', sqft: 1 },
    ]);
    expect(facts).toEqual({ hasPool: true, poolAreaSqft: 288, poolCageSqft: null, hasSpa: true });
  });

  it('a POOL ENCLOSURE row is a cage, not a pool', () => {
    const facts = poolFactsFromFeatures([{ description: 'POOL ENCLOSURE', sqft: 500 }]);
    expect(facts.hasPool).toBe(false);
    expect(facts.poolCageSqft).toBe(500);
  });

  it('largest cage wins when multiple enclosure rows exist', () => {
    const facts = poolFactsFromFeatures([
      { description: 'Screened Enclosure', sqft: 300 },
      { description: 'SCREEN CAGE 2 STORY', sqft: 1100 },
    ]);
    expect(facts.poolCageSqft).toBe(1100);
  });

  it('parsed-but-empty features mean NO pool; unparsed features mean UNKNOWN', () => {
    expect(poolFactsFromFeatures([]).hasPool).toBe(false);
    expect(poolFactsFromFeatures(null)).toEqual({});
  });
});

describe('county extractors (live-probe fixtures)', () => {
  it('Manatee: pool 288 sqft + 1,066 sqft cage + spa', () => {
    expect(manateePoolFeatures(MANATEE_FEATURES)).toEqual({
      hasPool: true, poolAreaSqft: 288, poolCageSqft: 1066, hasSpa: true,
      imperviousAreaSf: 1018, // flag-driven: pool 288 + spa 1 + deck 729; cage flagged NO
      hasDetachedGarage: false, detachedGarageSqft: null, hasDock: false,
    });
  });

  it('Manatee: valid empty model = no pool; missing/HTML payload = unknown', () => {
    expect(manateePoolFeatures({ cols: MANATEE_FEATURES.cols, rows: [] }).hasPool).toBe(false);
    expect(manateePoolFeatures(null)).toEqual({});
    expect(manateePoolFeatures({ error: 'nope' })).toEqual({});
  });

  it('Sarasota: Swimming Pool + Screened Enclosure from the Extra Features grid', () => {
    expect(sarasotaPoolFeatures(SARASOTA_POOL_HTML)).toEqual({
      hasPool: true, poolAreaSqft: 392, poolCageSqft: 1066, hasSpa: false,
      imperviousAreaSf: 1066, // keyword fallback: pool 392 + patio 674; enclosure excluded
      hasDetachedGarage: false, detachedGarageSqft: null, hasDock: false,
    });
  });

  it('Sarasota: privacy-wall-only roll = no pool; missing section = unknown', () => {
    const noPool = sarasotaPoolFeatures(SARASOTA_NO_POOL_HTML);
    expect(noPool.hasPool).toBe(false);
    expect(noPool.poolCageSqft).toBeNull();
    expect(sarasotaPoolFeatures('<html><body>no features here</body></html>')).toEqual({});
  });

  it('Sarasota: non-SF units never feed sqft', () => {
    const html = sarasotaHtml('<tr><td>1</td><td>1</td><td>Swimming Pool</td><td>3</td><td>UT</td><td>1990</td></tr>');
    const facts = sarasotaPoolFeatures(html);
    expect(facts.hasPool).toBe(true);
    expect(facts.poolAreaSqft).toBeNull();
  });

  it('Charlotte: Pool - Gunite + Screen Cage from Land Improvement Information', () => {
    expect(charlottePoolFeatures(CHARLOTTE_POOL_HTML)).toEqual({
      hasPool: true, poolAreaSqft: 392, poolCageSqft: 840, hasSpa: false,
      imperviousAreaSf: 512, // keyword fallback: pool 392 + porch/deck 120; screen cage excluded
      hasDetachedGarage: false, detachedGarageSqft: null, hasDock: false,
    });
  });

  it('Charlotte: missing improvement table = unknown', () => {
    expect(charlottePoolFeatures('<table><caption>Building Information</caption></table>')).toEqual({});
  });
});

describe('record shape + merge', () => {
  const COUNTY_SOURCE = 'https://www.manateepao.gov/parcel/?parid=579642409';

  function countyParsed(overrides = {}) {
    return {
      squareFootage: 2200, lotSize: 9000, yearBuilt: 2022, propertyType: 'Single Family',
      source: COUNTY_SOURCE, confidence: 'high', county: 'Manatee',
      formattedAddress: '12071 Forest Park Cir, Bradenton, FL',
      ...overrides,
    };
  }

  it('hasPool is tri-state on the shaped record', () => {
    expect(shapeAsPropertyRecord(countyParsed(), 'x', 'manatee_pao').hasPool).toBeNull();
    expect(shapeAsPropertyRecord(countyParsed({ hasPool: true, poolAreaSqft: 288 }), 'x', 'manatee_pao').hasPool).toBe(true);
    expect(shapeAsPropertyRecord(countyParsed({ hasPool: false }), 'x', 'manatee_pao').hasPool).toBe(false);
  });

  it('null hasPool produces no evidence; true/false produce county evidence', () => {
    const unknown = shapeAsPropertyRecord(countyParsed(), 'x', 'manatee_pao');
    expect(unknown._fieldEvidence.hasPool).toBeUndefined();
    const yes = shapeAsPropertyRecord(countyParsed({ hasPool: true }), 'x', 'manatee_pao');
    expect(yes._fieldEvidence.hasPool[0].sourceType).toBe('county');
    const no = shapeAsPropertyRecord(countyParsed({ hasPool: false }), 'x', 'manatee_pao');
    expect(no._fieldEvidence.hasPool[0].value).toBe(false);
  });

  it('county hasPool survives the merge with county provenance and no verify flag', () => {
    const county = shapeAsPropertyRecord(
      countyParsed({ hasPool: true, poolAreaSqft: 288, poolCageSqft: 1066, hasSpa: true }),
      'x', 'manatee_pao',
    );
    county._source = 'county';
    const ai = shapeAsPropertyRecord({
      squareFootage: 2150, source: 'https://www.zillow.com/homedetails/x/1_zpid/', confidence: 'medium',
    }, 'x', 'openai');

    const merged = mergePropertyRecords([county, ai], 'x');
    expect(merged.hasPool).toBe(true);
    expect(merged.poolAreaSqft).toBe(288);
    expect(merged.poolCageSqft).toBe(1066);
    expect(merged.hasSpa).toBe(true);
    expect(merged._fieldEvidence.hasPool.sourceType).toBe('county');
    expect(merged._fieldEvidence.hasPool.fieldVerify).toBe(false);
  });

  it('a county-parsed FALSE also merges as evidence (not dropped as missing)', () => {
    const county = shapeAsPropertyRecord(countyParsed({ hasPool: false }), 'x', 'manatee_pao');
    county._source = 'county';
    const merged = mergePropertyRecords([county], 'x');
    expect(merged.hasPool).toBe(false);
    expect(merged._fieldEvidence.hasPool.value).toBe(false);
  });
});

describe('route: pool merge, provenance, prompts, cage classification', () => {
  it('mergePool: county-assessed pool is YES regardless of vision', () => {
    expect(mergePool({ hasPool: true }, { pool: 'NO' })).toBe('YES');
    expect(mergePool({ hasPool: false }, { pool: 'YES' })).toBe('POSSIBLE');
    expect(mergePool({ hasPool: null }, { pool: 'YES' })).toBe('POSSIBLE');
    expect(mergePool({ hasPool: null }, { pool: 'NO' })).toBe('NO');
  });

  it('poolSource reflects provenance', () => {
    expect(poolSource({ hasPool: true }, null)).toBe('county');
    expect(poolSource({ hasPool: false, _fieldEvidence: { hasPool: { sourceType: 'verified' } } }, { pool: 'YES' })).toBe('verified');
    expect(poolSource({ hasPool: null }, { pool: 'YES' })).toBe('vision');
    expect(poolSource({ hasPool: null }, { pool: 'NO' })).toBeNull();
    expect(poolSource({ hasPool: false }, { pool: 'NO' })).toBe('county');
  });

  it('poolRecordContext is tri-state and carries county sqft detail', () => {
    expect(poolRecordContext({ hasPool: null })).toBe('UNKNOWN');
    expect(poolRecordContext(undefined)).toBe('UNKNOWN');
    expect(poolRecordContext({ hasPool: false })).toBe('NO (county roll shows no pool)');
    expect(poolRecordContext({ hasPool: true, poolAreaSqft: 288, poolCageSqft: 1066, hasSpa: true }))
      .toBe('YES (county-assessed: 288 sq ft pool, 1066 sq ft screen cage, spa)');
    expect(poolRecordContext({ hasPool: true })).toBe('YES (county-assessed: pool)');
  });

  it('classifyPoolCageSize matches the documented service-burden bands', () => {
    expect(classifyPoolCageSize(299)).toBe('SMALL');
    expect(classifyPoolCageSize(300)).toBe('MEDIUM');
    expect(classifyPoolCageSize(600)).toBe('MEDIUM');
    expect(classifyPoolCageSize(601)).toBe('LARGE');
    expect(classifyPoolCageSize(900)).toBe('LARGE');
    expect(classifyPoolCageSize(901)).toBe('OVERSIZED');
    expect(classifyPoolCageSize(0)).toBeNull();
    expect(classifyPoolCageSize(null)).toBeNull();
  });
});

describe('enriched profile pool integration', () => {
  it('county cage sqft makes poolCageSize deterministic over the vision guess', () => {
    const enriched = buildEnrichedProfile(
      { hasPool: true, poolAreaSqft: 288, poolCageSqft: 1066, hasSpa: true },
      { pool: 'NO', poolCage: 'NO', poolCageSize: 'SMALL', confidenceScore: 80 },
      27.44, -82.39,
    );
    expect(enriched.pool).toBe('YES');
    expect(enriched.poolSource).toBe('county');
    expect(enriched.poolCage).toBe('YES');
    expect(enriched.poolCageSize).toBe('OVERSIZED');
    expect(enriched.poolCageSizeInferred).toBe(false);
    expect(enriched.poolCageSqft).toBe(1066);
    expect(enriched.hasSpa).toBe(true);
  });

  it('without county cage data the vision classification still drives', () => {
    const enriched = buildEnrichedProfile(
      { hasPool: null },
      { pool: 'YES', poolCage: 'YES', poolCageSize: 'MEDIUM', confidenceScore: 80 },
      27.44, -82.39,
    );
    expect(enriched.pool).toBe('POSSIBLE');
    expect(enriched.poolSource).toBe('vision');
    expect(enriched.poolCage).toBe('YES');
    expect(enriched.poolCageSize).toBe('MEDIUM');
  });

  it('pool verify flag: fires on unknown/false records, clears on county-assessed pools', () => {
    const poolFlag = (rc, ai) => buildEnrichedProfile(rc, ai, 27.44, -82.39)
      .fieldVerifyFlags.some((flag) => flag.field === 'pool');
    expect(poolFlag({ hasPool: null }, { pool: 'YES', confidenceScore: 80 })).toBe(true);
    expect(poolFlag({ hasPool: false }, { pool: 'YES', confidenceScore: 80 })).toBe(true);
    expect(poolFlag({ hasPool: true, poolAreaSqft: 288 }, { pool: 'YES', confidenceScore: 80 })).toBe(false);
  });
});
