/**
 * GATE_ESTIMATE_EMAILS_NAME_SERVICE, engine copy (owner 2026-11-21): quotedServiceName names a service only on narrow
 * proof (a pure recurring lawn + pest plan, one recurring pest or lawn lane, a one-time-only estimate with one ticked box)
 * and is null otherwise; followupEmailVars uses it (plus a lawn + pest pack and a mixed-estimate rule) only while the gate
 * is on. Synthetic estimates only.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The one-time predicate lives in a 30k-line route module; the copy module falls back to the same totals rule.
jest.mock('../routes/estimate-public', () => ({
  isStructuralOneTimeOnlyEstimate: (_data, est) => (Number(est.monthly_total) || 0) <= 0 && (Number(est.annual_total) || 0) <= 0
    && (Number(est.onetime_total) || 0) > 0,
}));

const {
  quotedServiceName,
  followupEmailVars,
  RECURRING_TERMS_LANES,
  _private: { PACKS, LAWN_PEST_PACK, RECURRING_TERMS_BENEFIT, NO_GUARANTEE_BENEFIT },
} = require('../services/estimate-followup-copy');
const {
  recurringRowServiceKeys, oneTimeLineKeys, tickedBoxServiceKeys, estimateHasAuthoredProposal,
} = require('../services/estimate-service-lines');

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
const TRENCHING = { service: 'termite_trenching', name: 'Termite trenching', price: 800 };
function withOneTime(est, ...items) {
  est.estimate_data.result.oneTime = { items };
  est.onetime_total = items.reduce((sum, item) => sum + item.price, 0);
  return est;
}
const RECURRING_PROMISES = /callback|cancel|re-service|commitment|contract|money-back/i;

let saved;
beforeEach(() => { saved = process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE; });
afterEach(() => {
  if (saved === undefined) delete process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE;
  else process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE = saved;
});
const gateOn = () => { process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE = 'true'; };
const gateOff = () => { delete process.env.GATE_ESTIMATE_EMAILS_NAME_SERVICE; };
const followupCategory = (est) => require('../services/estimate-followup-copy').copyCategoryForEstimate(est);

// An authored commercial proposal that still retains a residential pest row.
const COMMERCIAL_PROPOSAL = {
  id: 'prop', monthly_total: 300, annual_total: 3600, onetime_total: 0,
  estimate_data: {
    proposal: { enabled: true },
    manualQuoteLines: [{ service: 'commercial_pest', quoteRequired: true }],
    result: { recurring: { services: [{ service: 'Pest Control', mo: 30 }] } },
  },
};
// The public quote wizard keeps residential service ids in engineResult.lineItems, with no recurring rows and no svc boxes.
const WIZARD = {
  id: 'wiz', monthly_total: 60, annual_total: 720, onetime_total: 0,
  estimate_data: { engineResult: { lineItems: [{ service: 'lawn_care', monthly: 60 }] }, inputs: {} },
};

describe('the closed readers', () => {
  test('recurringRowServiceKeys names only the stored recurring rows', () => {
    expect(recurringRowServiceKeys(recurring('Pest Control', 'Lawn Care'))).toEqual(['pest', 'lawn']);
    expect(recurringRowServiceKeys(boxes({ svcPest: true, svcLawn: true }))).toEqual([]);
    expect(recurringRowServiceKeys({ id: 'x' })).toEqual([]);
  });

  test('tickedBoxServiceKeys reads the boxes and never free text or service_interest', () => {
    expect(tickedBoxServiceKeys(boxes({ svcOnetimePest: true }))).toEqual(['pest']);
    expect(tickedBoxServiceKeys({ id: 'x', service_interest: 'Pest Control', notes: 'We want ants gone', estimate_data: {} })).toEqual([]);
  });

  test('oneTimeLineKeys reads the one-time lines a recurring estimate carries', () => {
    expect(oneTimeLineKeys(withOneTime(recurring('Pest Control'), TRENCHING))).toEqual(['termite']);
    expect(oneTimeLineKeys(recurring('Pest Control'))).toEqual([]);
  });

  test('estimateHasAuthoredProposal needs an enabled proposal', () => {
    expect(estimateHasAuthoredProposal(COMMERCIAL_PROPOSAL)).toBe(true);
    expect(estimateHasAuthoredProposal({ estimate_data: { proposal: { enabled: false } } })).toBe(false);
    expect(estimateHasAuthoredProposal(recurring('Pest Control'))).toBe(false);
  });
});

describe('quotedServiceName', () => {
  test.each([
    ['one recurring pest lane', recurring('Pest Control'), 'pest control'],
    ['one recurring lawn lane', recurring('Lawn Care'), 'lawn care'],
    ['a pure recurring lawn + pest plan', recurring('Pest Control', 'Lawn Care'), 'lawn care and pest control'],
    ['a stored service_interest that names other services', { ...recurring('Lawn Care'), service_interest: 'Mosquito, Pest Control and Termite' }, 'lawn care'],
    ['a one-time-only pest box', boxes({ svcOnetimePest: true }, ONE_TIME), 'one-time pest control'],
    ['a one-time-only lawn box', boxes({ svcOnetimeLawn: true }, ONE_TIME), 'one-time lawn care'],
    ['a one-time-only mosquito box', boxes({ svcOnetimeMosquito: true }, ONE_TIME), 'one-time mosquito protection'],
  ])('%s is named', (_name, est, expected) => {
    expect(quotedServiceName(est)).toBe(expected);
  });

  test.each([
    ['pest and mosquito', recurring('Mosquito', 'Pest Control')],
    ['three recurring services', recurring('Pest Control', 'Lawn Care', 'Mosquito')],
    ['a recurring mosquito lane', recurring('Mosquito')],
    ['a recurring termite lane', recurring('Termite Bait Monitoring')],
    ['a commercial manual line', { id: 'c', estimate_data: { manualQuoteLines: [{ service: 'commercial_pest', quoteRequired: true }] } }],
    ['a recurring pest plan plus a one-time trenching job', withOneTime(recurring('Pest Control'), TRENCHING)],
    ['a lawn + pest plan plus a one-time line', withOneTime(recurring('Pest Control', 'Lawn Care'), TRENCHING)],
    ['one-time trenching', boxes({ svcTrenching: true }, ONE_TIME)],
    ['two one-time boxes', boxes({ svcOnetimePest: true, svcOnetimeLawn: true }, ONE_TIME)],
    ['ticked boxes on a recurring estimate with no stored rows', boxes({ svcPest: true }, { monthly_total: 40 })],
    ['a quote-wizard estimate', WIZARD],
    ['an authored commercial proposal that retains a residential pest row', COMMERCIAL_PROPOSAL],
    ['an authored proposal over a recurring pest row', { ...recurring('Pest Control'), estimate_data: { proposal: { enabled: true }, result: { recurring: { services: [{ service: 'Pest Control', mo: 30 }] } } } }],
    ['free text and a stored service_interest only', { id: 't', monthly_total: 40, service_interest: 'Pest Control', notes: 'We want a quote', estimate_data: { inputs: {} } }],
  ])('%s is not named', (_name, est) => {
    expect(quotedServiceName(est)).toBeNull();
  });
});

describe('followupEmailVars', () => {
  const samples = [
    recurring('Pest Control'),
    recurring('Pest Control', 'Lawn Care'),
    withOneTime(recurring('Pest Control'), TRENCHING),
    boxes({ svcOnetimePest: true }, ONE_TIME),
    { id: 'blank', estimate_data: {} },
    COMMERCIAL_PROPOSAL,
    WIZARD,
  ];

  test.each(samples.map((s) => [s.id, s]))('gate off: %s returns what the pack gives today', (_id, est) => {
    gateOff();
    const pack = PACKS[followupCategory(est)];
    const vars = followupEmailVars(est);
    expect(vars.service_label).toBe(pack.label);
    expect(vars.category_headline).toBe(pack.headline);
    expect(vars.category_included).toBe(pack.included);
    expect(vars.faq_terms).toBe(pack.faq.terms);
    expect(vars.faq_between_visits).toBe(pack.faq.betweenVisits);
    expect(vars.category_benefit).toBe(pack.benefit);
  });

  test('gate off: a recurring lawn + pest estimate still gets the bundle pack', () => {
    gateOff();
    const vars = followupEmailVars(recurring('Pest Control', 'Lawn Care'));
    expect(vars.service_label).toBe(PACKS.bundle.label);
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
  });

  test('gate on: a pure recurring lawn + pest plan gets the owner words', () => {
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

  test('gate on: a recurring pest plan names itself and keeps the pest pack', () => {
    gateOn();
    const vars = followupEmailVars(recurring('Pest Control'));
    expect(vars.service_label).toBe('pest control');
    expect(vars.category_headline).toBe(PACKS.pest.headline);
  });

  test('gate on: a recurring pest plan plus one-time trenching is bundle-neutral with no recurring wording anywhere', () => {
    gateOn();
    const vars = followupEmailVars(withOneTime(recurring('Pest Control'), TRENCHING));
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
    expect(vars.category_benefit).toBe(NO_GUARANTEE_BENEFIT);
    expect(vars.faq_terms).toBe('');
    expect(vars.faq_between_visits).toBe('');
    Object.values(vars).forEach((value) => expect(String(value)).not.toMatch(RECURRING_PROMISES));
    gateOff();
    // gate off is today's output: the pest pack, with its recurring wording
    expect(followupEmailVars(withOneTime(recurring('Pest Control'), TRENCHING)).category_headline).toBe(PACKS.pest.headline);
  });

  test('gate on: a recurring lawn + pest plan plus one-time trenching is not the combined pack and has no guarantee line', () => {
    gateOn();
    const vars = followupEmailVars(withOneTime(recurring('Pest Control', 'Lawn Care'), TRENCHING));
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
    expect(vars.category_benefit).toBe(NO_GUARANTEE_BENEFIT);
    Object.values(vars).forEach((value) => expect(String(value)).not.toMatch(RECURRING_PROMISES));
  });

  test('gate on: a recurring lawn + pest plan plus a one-time pest line is bundle-neutral too', () => {
    gateOn();
    const vars = followupEmailVars(withOneTime(recurring('Pest Control', 'Lawn Care'), { service: 'one_time_pest', name: 'One-time pest treatment', price: 150 }));
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
    expect(vars.faq_terms).toBe('');
  });

  test('gate on: a recurring pest + one-time lawn with no stored recurring rows gets bundle terms, no plan promises', () => {
    gateOn();
    const vars = followupEmailVars(boxes({ svcPest: true, svcOnetimeLawn: true }, { monthly_total: 40, onetime_total: 120 }));
    expect(vars.category_headline).toBe(PACKS.bundle.headline);
    expect(vars.faq_terms).toBe('');
    expect(vars.category_included).not.toContain('free callbacks');
  });

  test('gate on: an authored commercial proposal keeps today\'s label and pack', () => {
    gateOn();
    const vars = followupEmailVars(COMMERCIAL_PROPOSAL);
    expect(vars.service_label).toBe(PACKS.commercial.label);
    expect(vars.category_headline).toBe(PACKS.commercial.headline);
  });

  test('gate on: a termite estimate keeps no guarantee and no contract claim', () => {
    gateOn();
    const vars = followupEmailVars(recurring('Termite Bait Monitoring'));
    expect(vars.service_label).toBe('termite protection');
    expect(vars.category_benefit).toBe(NO_GUARANTEE_BENEFIT);
    expect(vars.faq_terms).toBe('');
  });
});
