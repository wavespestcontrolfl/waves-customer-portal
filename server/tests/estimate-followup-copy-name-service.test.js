/**
 * GATE_ESTIMATE_EMAILS_NAME_SERVICE, engine copy (owner 2026-11-21): quotedServiceName names the quoted service from
 * CLOSED sources only, and followupEmailVars uses it (plus a lawn + pest pack) only while the gate is on.
 * Synthetic estimates only.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The one-time predicate lives in a 30k-line route module; the copy module falls back to the same totals rule.
jest.mock('../routes/estimate-public', () => ({
  isStructuralOneTimeOnlyEstimate: (_data, est) => (Number(est.monthly_total) || 0) <= 0 && (Number(est.annual_total) || 0) <= 0
    && (Number(est.onetime_total) || 0) > 0,
}));

const {
  quotedServiceName,
  neutralFollowupEmailVars,
  followupEmailVars,
  RECURRING_TERMS_LANES,
  _private: { PACKS, LAWN_PEST_PACK, RECURRING_TERMS_BENEFIT, NO_GUARANTEE_BENEFIT },
} = require('../services/estimate-followup-copy');
const { closedServiceKeys, recurringRowServiceKeys } = require('../services/estimate-service-lines');

function recurring(...services) {
  return {
    id: 'e-rec', monthly_total: 90, annual_total: 1080, onetime_total: 0,
    estimate_data: { result: { recurring: { services: services.map((service) => ({ service, mo: 30 })) } } },
  };
}
function boxes(inputs, totals = {}) {
  return { id: 'e-box', monthly_total: 0, annual_total: 0, onetime_total: 0, estimate_data: { inputs }, ...totals };
}
const ONE_TIME = { monthly_total: 0, annual_total: 0, onetime_total: 150 };

let saved;
beforeEach(() => { saved = process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE; });
afterEach(() => {
  if (saved === undefined) delete process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE;
  else process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE = saved;
});
const gateOn = () => { process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE = 'true'; };
const gateOff = () => { delete process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE; };

describe('closedServiceKeys', () => {
  test('recurring rows win over ticked boxes', () => {
    const est = recurring('Pest Control');
    est.estimate_data.inputs = { svcLawn: true };
    expect(closedServiceKeys(est)).toEqual(['pest']);
  });

  test('ticked boxes name the lanes of an estimate with no recurring rows', () => {
    expect(closedServiceKeys(boxes({ svcLawn: true, svcPest: true }))).toEqual(['pest', 'lawn']);
  });

  test('free text and a stored service_interest name nothing', () => {
    const est = {
      id: 'e-text', service_interest: 'Pest Control and Lawn Care', notes: 'We want ants gone', description: 'rodent',
      estimate_data: { inputs: { leadServiceInterest: 'mosquito' } },
    };
    expect(closedServiceKeys(est)).toEqual([]);
  });

  test('a commercial manual line names a commercial lane', () => {
    const est = { id: 'e-com', estimate_data: { manualQuoteLines: [{ service: 'commercial_pest', quoteRequired: true }] } };
    expect(closedServiceKeys(est)).toEqual(['commercial_pest']);
  });
});

describe('recurringRowServiceKeys', () => {
  test('names only the stored recurring rows', () => {
    expect(recurringRowServiceKeys(recurring('Pest Control', 'Lawn Care'))).toEqual(['pest', 'lawn']);
    expect(recurringRowServiceKeys(boxes({ svcPest: true, svcLawn: true }))).toEqual([]);
    expect(recurringRowServiceKeys({ id: 'x' })).toEqual([]);
  });
});

describe('neutralFollowupEmailVars', () => {
  test('is the property-generic pack with no recurring promises', () => {
    const vars = neutralFollowupEmailVars();
    expect(vars.service_label).toBe(PACKS.unknown.label);
    expect(vars.category_included).toBe(PACKS.unknown.included);
    expect(vars.faq_terms).toBe('');
    expect(vars.category_benefit).toBe(NO_GUARANTEE_BENEFIT);
  });
});

describe('quotedServiceName', () => {
  test.each([
    ['one recurring service', recurring('Pest Control'), 'pest control'],
    ['a lawn estimate', recurring('Lawn Care'), 'lawn care'],
    ['two recurring services, lawn first', recurring('Pest Control', 'Lawn Care'), 'lawn care and pest control'],
    ['pest and mosquito', recurring('Mosquito', 'Pest Control'), 'pest control and mosquito protection'],
    ['three recurring services', recurring('Pest Control', 'Lawn Care', 'Mosquito'), PACKS.bundle.label],
    ['a commercial line', { id: 'c', estimate_data: { manualQuoteLines: [{ service: 'commercial_pest', quoteRequired: true }] } }, PACKS.commercial.label],
  ])('%s', (_name, est, expected) => {
    expect(quotedServiceName(est)).toBe(expected);
  });

  test('a one-time-only estimate with one pest, lawn or mosquito box is named one-time', () => {
    expect(quotedServiceName(boxes({ svcOnetimePest: true }, ONE_TIME))).toBe('one-time pest control');
    expect(quotedServiceName(boxes({ svcOnetimeLawn: true }, ONE_TIME))).toBe('one-time lawn care');
    expect(quotedServiceName(boxes({ svcOnetimeMosquito: true }, ONE_TIME))).toBe('one-time mosquito protection');
  });

  test('any other one-time estimate keeps today\'s label', () => {
    expect(quotedServiceName(boxes({ svcTrenching: true }, ONE_TIME))).toBe(PACKS.one_time.label);
    expect(quotedServiceName(boxes({ svcOnetimePest: true, svcOnetimeLawn: true }, ONE_TIME))).toBe(PACKS.one_time.label);
  });

  test('an estimate with no closed key keeps today\'s label, whatever the free text says', () => {
    const est = {
      id: 'e-text', monthly_total: 40, service_interest: 'Lawn Care', notes: 'We want a quote',
      estimate_data: { inputs: {} },
    };
    expect(quotedServiceName(est)).toBe(PACKS[followupCategory(est)].label);
    // "want" reads as ant in the free-text match: that text must not name pest control
    expect(quotedServiceName(est)).not.toBe('pest control');
  });

  test('a stored service_interest is ignored when a closed source names another service', () => {
    const est = { ...recurring('Lawn Care'), service_interest: 'Mosquito, Pest Control and Termite' };
    expect(quotedServiceName(est)).toBe('lawn care');
  });
});

function followupCategory(est) {
  return require('../services/estimate-followup-copy').copyCategoryForEstimate(est);
}

describe('followupEmailVars', () => {
  const samples = [
    recurring('Pest Control'),
    recurring('Pest Control', 'Lawn Care'),
    boxes({ svcOnetimePest: true }, ONE_TIME),
    { id: 'blank', estimate_data: {} },
    { id: 'c', estimate_data: { manualQuoteLines: [{ service: 'commercial_pest', quoteRequired: true }] } },
  ];

  test.each(samples.map((s) => [s.id, s]))('gate off: %s returns what the pack gives today', (_id, est) => {
    gateOff();
    const pack = PACKS[followupCategory(est)];
    const vars = followupEmailVars(est);
    expect(vars.service_label).toBe(pack.label);
    expect(vars.category_headline).toBe(pack.headline);
    expect(vars.category_included).toBe(pack.included);
    expect(vars.faq_terms).toBe(pack.faq.terms);
    expect(vars.category_benefit).toBe(pack.benefit);
  });

  test('gate off: a recurring lawn + pest estimate still gets the bundle pack', () => {
    gateOff();
    const vars = followupEmailVars(recurring('Pest Control', 'Lawn Care'));
    expect(vars.service_label).toBe(PACKS.bundle.label);
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
  });

  test('gate on: a recurring lawn + pest estimate gets the owner words', () => {
    gateOn();
    const vars = followupEmailVars(recurring('Pest Control', 'Lawn Care'));
    expect(vars).toMatchObject({
      service_label: 'lawn care and pest control',
      category_headline: 'Your lawn care and pest control plan is ready',
      category_included: 'Pest control: exterior and interior protection on a recurring schedule, with free callbacks between visits. Lawn care: feeding, weed control, and fungus watch built for your turf type. One team does both.',
      category_benefit: RECURRING_TERMS_BENEFIT,
      category_hook: PACKS.bundle.hook,
      category_question: PACKS.bundle.question,
      category_process: PACKS.bundle.process,
      faq_start: PACKS.bundle.faq.start,
      faq_terms: PACKS.pest.faq.terms,
      faq_between_visits: PACKS.pest.faq.betweenVisits,
      faq_price: PACKS.bundle.faq.price,
      report_video_preview: '',
      report_video_url: '',
      report_video_caption: '',
    });
  });

  test('the lawn + pest pack stays out of PACKS and out of RECURRING_TERMS_LANES', () => {
    expect(PACKS.lawn_pest).toBeUndefined();
    expect(RECURRING_TERMS_LANES).not.toContain('lawn_pest');
    expect(LAWN_PEST_PACK.benefit).toBe(RECURRING_TERMS_BENEFIT);
  });

  test('gate on: lawn + pest + mosquito is the bundle pack with the bundle name', () => {
    gateOn();
    const vars = followupEmailVars(recurring('Pest Control', 'Lawn Care', 'Mosquito'));
    expect(vars.service_label).toBe(PACKS.bundle.label);
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
  });

  test('gate on: a one-time lawn + pest job does not get the lawn + pest pack', () => {
    gateOn();
    const vars = followupEmailVars(boxes({ svcOnetimePest: true, svcOnetimeLawn: true }, ONE_TIME));
    expect(vars.category_headline).toBe(PACKS.one_time.headline);
    expect(vars.faq_terms).toBe('');
    expect(vars.faq_between_visits).toBe('');
  });

  test('gate on: lawn + pest ticked boxes with a termite word in free text name both but keep the neutral bundle terms', () => {
    gateOn();
    const est = boxes({ svcPest: true, svcLawn: true }, { monthly_total: 90, notes: 'termite damage seen' });
    const vars = followupEmailVars(est);
    expect(vars.service_label).toBe('lawn care and pest control');
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
    expect(vars.category_benefit).toBe(NO_GUARANTEE_BENEFIT);
    expect(vars.faq_terms).toBe('');
  });

  test('gate on: a recurring pest + one-time lawn with no stored recurring rows gets bundle terms, no plan promises', () => {
    gateOn();
    // the ticked boxes fold the one-time lawn and the recurring pest into the same two lanes
    const est = boxes({ svcPest: true, svcOnetimeLawn: true }, { monthly_total: 40, onetime_total: 120 });
    const vars = followupEmailVars(est);
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
    expect(vars.category_benefit).toBe(PACKS.bundle.benefit);
    expect(vars.faq_terms).toBe('');
    expect(vars.faq_between_visits).toBe('');
    expect(vars.category_included).not.toContain('free callbacks');
  });

  test('gate on: a termite estimate keeps no guarantee and gets no contract claim', () => {
    gateOn();
    const vars = followupEmailVars(recurring('Termite Bait Monitoring'));
    expect(vars.service_label).toBe('termite protection');
    expect(vars.category_benefit).toBe(NO_GUARANTEE_BENEFIT);
    expect(vars.faq_terms).toBe('');
  });

  test('gate on: a single service keeps its own pack words and names itself', () => {
    gateOn();
    const vars = followupEmailVars(recurring('Pest Control'));
    expect(vars.service_label).toBe('pest control');
    expect(vars.category_headline).toBe(PACKS.pest.headline);
  });
});
