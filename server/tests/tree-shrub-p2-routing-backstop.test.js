/**
 * T&S audit 2026-07-18 P2 wave — routing, retired-cadence backstop, and
 * catalog-key linkage pins.
 *
 * 1. Service-line routing: "Tree & Shrub Fertilization" completed as a LAWN
 *    record (fertil/weed tokens outranked tree tokens) and "Ornamental …"
 *    routed to PEST — both skipped the typed T&S flow entirely. Tree/shrub
 *    tokens now win unless a real lawn-surface token is present. Palm
 *    precedence is untouched (owner ruling: palm stays its own line).
 * 2. Accept backstop: the retired 9-visit Enhanced / 12-visit Premium tiers
 *    must not be bookable from a stale estimate (lawn got this backstop;
 *    T&S had none).
 * 3. remainingUnitCatalogKey: restamped T&S rows pass their catalog key
 *    through so converted rows link service_id.
 */

const { detectServiceLine } = require('../services/service-report/service-line-configs');
const { detectServiceCategory } = require('../utils/service-normalizer');
const {
  recurringTreeShrubRowAtRetiredCadence,
  retiredTreeShrubRequoteNeeded,
  rewriteTreeShrubRecurringServices,
  treeShrubTierCatalogStamp,
} = require('../routes/estimate-public');
const { remainingUnitCatalogKey } = require('../services/estimate-converter');

describe('service-line routing — tree/shrub tokens beat fertil/weed', () => {
  test.each([
    ['Tree & Shrub Fertilization', 'tree_shrub'],
    ['Tree & Shrub Weed & Feed', 'tree_shrub'],
    ['Ornamental Care Program', 'tree_shrub'],
    ['Bi-Monthly Tree & Shrub Care Service', 'tree_shrub'],
    ['Quarterly Tree & Shrub Care Service', 'tree_shrub'],
  ])('%s routes tree_shrub', (name, expected) => {
    expect(detectServiceLine(name)).toBe(expected);
    expect(detectServiceCategory(name)).toBe(expected);
  });

  test.each([
    ['Lawn Fertilization', 'lawn'],
    ['Weed Control Service', 'lawn'],
    ['Lawn + Tree & Shrub', 'lawn'], // combined stays lawn-primary (combo profile owns the T&S companion)
    ['Sod Replacement', 'lawn'],
    ['Lawn Care Visit', 'lawn'],
  ])('%s stays lawn', (name, expected) => {
    expect(detectServiceLine(name)).toBe(expected);
    expect(detectServiceCategory(name)).toBe(expected);
  });

  test('palm precedence untouched (owner ruling: palm_treatment stays its own line)', () => {
    expect(detectServiceLine('Palm Injection Service')).toBe('palm');
    expect(detectServiceLine('Palm Tree Nutritional Treatment Service')).toBe('palm');
    expect(detectServiceLine('Palmetto Bug Treatment')).toBe('pest');
  });

  test('mosquito/termite names carrying tree tokens keep their own lines', () => {
    expect(detectServiceLine('Mosquito Barrier')).toBe('mosquito');
    expect(detectServiceCategory('Tree Line Mosquito Treatment')).toBe('mosquito');
    expect(detectServiceCategory('Termite Bait Station Check')).toBe('termite');
  });
});

describe('recurringTreeShrubRowAtRetiredCadence — premium-only backstop (9x un-retired 2026-07-23)', () => {
  const estData = (svc) => ({ recurring: { services: [svc] } });

  test('restamped Enhanced selection (tree_shrub_6week key) is a live cadence', () => {
    expect(recurringTreeShrubRowAtRetiredCadence(estData({
      name: 'Every 6 Weeks Tree & Shrub Care Service', serviceKey: 'tree_shrub_6week', visitsPerYear: 9,
    }))).toBe(false);
  });

  test('9-visit rows pass; 12-visit Premium rows stay retired', () => {
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Enhanced', visitsPerYear: 9 }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Premium', visitsPerYear: 12 }))).toBe(true);
  });

  test('6-week wording without a visit count passes; 12-visit wording stays retired', () => {
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Every 6 Weeks Tree & Shrub Care Service' }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Premium (12 visits)' }))).toBe(true);
  });

  test('current 6x Standard and 4x Light rows pass', () => {
    expect(recurringTreeShrubRowAtRetiredCadence(estData({
      name: 'Bi-Monthly Tree & Shrub Care Service', serviceKey: 'tree_shrub_program', visitsPerYear: 6,
    }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({
      name: 'Quarterly Tree & Shrub Care Service', serviceKey: 'tree_shrub_quarterly', visitsPerYear: 4,
    }))).toBe(false);
  });

  test('legacy cadence-less T&S rows and non-T&S rows pass (converter defaults them to the current program)', () => {
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care' }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Quarterly Pest Control', visitsPerYear: 4 }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Palm Injection Service', visitsPerYear: 2 }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(null)).toBe(false);
  });

  test('explicit cadence FIELDS are checked — a crafted monthly/custom row cannot slip through (codex P2 r1)', () => {
    // frequency/frequencyKey/recurringPattern are the FIRST fields the
    // converter reads; a count-less, text-less row could encode the retired
    // 12x Premium cadence there.
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care', frequency: 'monthly' }))).toBe(true);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care', recurringPattern: 'custom' }))).toBe(true);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care', frequencyKey: 'semiannual' }))).toBe(true);
    // The two live tiers' field cadences still pass.
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Bi-Monthly Tree & Shrub Care Service', frequency: 'bi_monthly', visitsPerYear: 6 }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Quarterly Tree & Shrub Care Service', frequency: 'quarterly', visitsPerYear: 4 }))).toBe(false);
  });

  test('every converter visit-count alias is checked (codex P2 r2)', () => {
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care', appsPerYear: 9 }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care', apps: 12 }))).toBe(true);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care', treatmentsPerYear: 9 }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care', appsPerYear: 4 }))).toBe(false);
    expect(recurringTreeShrubRowAtRetiredCadence(estData({ name: 'Tree & Shrub Care', apps: 6 }))).toBe(false);
  });
});

describe('retiredTreeShrubRequoteNeeded — shared quote gate (deposit mirror contract, codex P1 r4)', () => {
  // /data (canAccept), /deposit-intent, and /recurring-card-intent read the
  // shared quote requirement — the retired condition must live there, not
  // only in the accept-time 409, or a stale estimate collects a deposit the
  // accept then rejects.
  test('an enhanced-only ladder keeps self-serve accept (9x live again 2026-07-23)', () => {
    expect(retiredTreeShrubRequoteNeeded({
      results: { ts: [{ key: 'enhanced', ann: 900 }] },
      recurring: { services: [{ name: 'Every 6 Weeks Tree & Shrub Care Service' }] },
    })).toBe(false);
  });

  test('a selectable current tier keeps self-serve accept', () => {
    expect(retiredTreeShrubRequoteNeeded({
      results: { ts: [{ key: 'light' }, { key: 'standard' }, { key: 'enhanced' }] },
      recurring: { services: [{ name: 'Every 6 Weeks Tree & Shrub Care Service' }] },
    })).toBe(false);
  });

  test('a Premium-only (12x) ladder requotes too (codex P1 r5)', () => {
    expect(retiredTreeShrubRequoteNeeded({
      results: { ts: [{ key: 'premium', ann: 1100 }] },
      recurring: { services: [{ name: 'Tree & Shrub Care' }] },
    })).toBe(true);
    expect(retiredTreeShrubRequoteNeeded({
      results: { ts: [{ name: '12x Premium Tree & Shrub' }] },
      recurring: { services: [{ name: 'Tree & Shrub Care' }] },
    })).toBe(true);
  });

  test('no tier rows: explicit retired-cadence row requotes; cadence-less and non-T&S stay self-serve', () => {
    expect(retiredTreeShrubRequoteNeeded({
      recurring: { services: [{ name: 'Tree & Shrub Care', frequency: 'monthly' }] },
    })).toBe(true);
    expect(retiredTreeShrubRequoteNeeded({
      recurring: { services: [{ name: 'Tree & Shrub Care' }] },
    })).toBe(false);
    expect(retiredTreeShrubRequoteNeeded({
      recurring: { services: [{ name: 'Quarterly Pest Control' }] },
    })).toBe(false);
    expect(retiredTreeShrubRequoteNeeded(null)).toBe(false);
  });
});

describe('treeShrubTierCatalogStamp — adopted reservation rows get the tier catalog identity', () => {
  const CATALOG_ID = 'cat-uuid-1';
  const fakeTrx = (table) => ({
    where: () => ({
      first: async () => (table === 'services' ? { id: CATALOG_ID, name: 'Quarterly Tree & Shrub Care Service' } : null),
    }),
  });
  const lightTierCard = { serviceCategory: 'tree_shrub', key: 'light', visitsPerYear: 4, billingFrequencyKey: 'monthly' };

  test('non-T&S rows are never stamped (split bundle: the adopted slot can be the pest visit)', async () => {
    expect(await treeShrubTierCatalogStamp(fakeTrx, {
      selectedFrequency: lightTierCard,
      rowServiceType: 'Quarterly Pest Control',
    })).toBeNull();
  });

  test('directly-selected T&S tier card stamps name + service_id', async () => {
    const stamp = await treeShrubTierCatalogStamp(fakeTrx, {
      selectedFrequency: lightTierCard,
      rowServiceType: 'Tree & Shrub',
    });
    expect(stamp.service_type).toBe('Quarterly Tree & Shrub Care Service');
    expect(stamp.service_id).toBe(CATALOG_ID);
  });

  test('split bundle: tier chosen via serviceCadences rides the accepted estimate data (codex P2 r5)', async () => {
    // selectedFrequency is the pest card; the restamped T&S recurring row
    // carries the tier's catalog key + name.
    const stamp = await treeShrubTierCatalogStamp(fakeTrx, {
      selectedFrequency: { serviceCategory: 'pest_control', key: 'quarterly' },
      estData: {
        recurring: {
          services: [
            { name: 'Quarterly Pest Control', serviceKey: 'pest_control' },
            { name: 'Quarterly Tree & Shrub Care Service', serviceKey: 'tree_shrub_quarterly' },
          ],
        },
      },
      rowServiceType: 'Tree & Shrub',
    });
    expect(stamp.service_type).toBe('Quarterly Tree & Shrub Care Service');
    expect(stamp.service_id).toBe(CATALOG_ID);
  });

  test('no tier selection anywhere returns null (legacy accepts unchanged)', async () => {
    expect(await treeShrubTierCatalogStamp(fakeTrx, {
      selectedFrequency: null,
      estData: { recurring: { services: [{ name: 'Tree & Shrub Care' }] } },
      rowServiceType: 'Tree & Shrub',
    })).toBeNull();
  });
});

describe('rewriteTreeShrubRecurringServices — palm rows are never tier-rewritten', () => {
  const frequency = { key: 'standard', monthly: 51.75, annual: 621, perTreatment: 103.5, visitsPerYear: 6, billingFrequencyKey: 'monthly' };

  test('key-only palm_injection rows survive (underscore defeats \\bpalm\\b — codex P2 r1)', () => {
    const palmRow = { serviceKey: 'palm_injection', mo: 45 };
    const { services, changed } = rewriteTreeShrubRecurringServices([palmRow], frequency);
    expect(services[0]).toBe(palmRow);
    expect(changed).toBe(false);
  });

  test('named palm rows survive; real T&S rows are restamped', () => {
    const palmRow = { name: 'Palm Injection Service', mo: 45 };
    const tsRow = { name: 'Tree & Shrub Care', mo: 40 };
    const { services, changed } = rewriteTreeShrubRecurringServices([palmRow, tsRow], frequency);
    expect(services[0]).toBe(palmRow);
    expect(services[1].serviceKey).toBe('tree_shrub_program');
    expect(services[1].name).toBe('Bi-Monthly Tree & Shrub Care Service');
    expect(changed).toBe(true);
  });
});

describe('remainingUnitCatalogKey — converted T&S rows link their catalog row', () => {
  test('restamped tier keys pass through', () => {
    expect(remainingUnitCatalogKey({ serviceKey: 'tree_shrub_program' })).toBe('tree_shrub_program');
    expect(remainingUnitCatalogKey({ service_key: 'tree_shrub_quarterly' })).toBe('tree_shrub_quarterly');
    expect(remainingUnitCatalogKey({ serviceKey: 'tree_shrub_6week' })).toBe('tree_shrub_6week');
  });

  test('non-T&S and unknown keys stay name-resolved (no lookup-warn noise)', () => {
    expect(remainingUnitCatalogKey({ serviceKey: 'pest_control' })).toBeNull();
    expect(remainingUnitCatalogKey({ serviceKey: 'lawn_care_bimonthly' })).toBeNull();
    expect(remainingUnitCatalogKey({ serviceKey: 'tree_shrub' })).toBeNull();
    expect(remainingUnitCatalogKey({})).toBeNull();
  });
});
