/**
 * Misting PR 2a follow-ups from the pre-push audit:
 *  P0: the install line carries a durable marker in invoices.line_items and prepay coverage readers exclude it;
 *  (Refill booking and billing ship in misting PR 2c.)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const converter = require('../services/estimate-converter');
const renewals = require('../services/annual-prepay-renewals');
const misting = require('../utils/mosquito-misting-system');
const constants = require('../services/pricing-engine/constants');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PROPERTY = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const INSTALL = 3795 + 5 * 75 + 2 * 45;
const saved = process.env.GATE_MOSQUITO_MISTING;
beforeEach(() => { process.env.GATE_MOSQUITO_MISTING = 'true'; });
afterEach(() => {
  if (saved === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = saved;
});

const estimateData = (misting_ = { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' }, extra = {}) => {
  const input = { ...PROPERTY, services: { ...extra, mosquitoMisting: misting_ } };
  return { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
};

describe('P0: the install line has a durable identity and prepay coverage excludes it', () => {
  test('the line carries kind and service next to description, quantity and unit_price', () => {
    const line = misting.mistingInstallLine({ description: 'Essential system (drum) Installation', amount: INSTALL });
    expect(line).toEqual({
      description: 'Essential system (drum) Installation', quantity: 1, unit_price: INSTALL,
      kind: 'misting_installation', service: 'mosquito_misting_installation',
    });
    expect(misting.isMistingInstallLine(line)).toBe(true);
    expect(misting.isMistingInstallLine({ description: 'Bait Station Setup', quantity: 1, unit_price: 99 })).toBe(false);
    expect(misting.mistingInstallLinesTotal([line, { description: 'x', quantity: 2, unit_price: 10 }])).toBe(INSTALL);
    expect(misting.mistingInstallLinesTotal(JSON.stringify([line]))).toBe(INSTALL);
    expect(misting.mistingInstallLinesTotal('not json')).toBe(0);
    expect(misting.mistingInstallLinesTotal(null)).toBe(0);
  });

  test('every invoice the install enters builds the line through the marker helper, and create() keeps unknown line keys', () => {
    const conv = read('services/estimate-converter.js');
    expect((conv.match(/mistingInstallInvoiceLines\(mistingInstall\)/g) || [])).toHaveLength(2); // prepay + standard
    expect(read('routes/estimate-public.js')).toContain(".mistingInstallInvoiceLines(acceptedMistingInstall)");
    // the invoice writer spreads the whole line (no field whitelist), so kind and service reach line_items
    expect(read('services/invoice.js')).toMatch(/const items = \(lineItems \|\| \[\]\)\.map\(\(item\) => \{[\s\S]{0,200}return \{\s*\.\.\.item,/);
  });

  test('the term coverage basis leaves the install out, like the setup line', () => {
    const conv = read('services/estimate-converter.js');
    expect(conv).toContain('- (prepayRodentSetupAmount + annualPlanSetupFeeAmount + (mistingInstall ? mistingInstall.amount : 0))');
  });

  function fakeConn({ subtotal, lines, claimAmount = null }) {
    return (table) => ({
      where: () => ({
        first: async () => {
          if (table === 'invoices') return { subtotal, total: subtotal, line_items: lines };
          if (table === 'setup_fee_claims') return claimAmount == null ? undefined : { amount: claimAmount };
          return undefined;
        },
      }),
    });
  }
  const term = { prepay_invoice_id: 'inv-1' };

  test('seededVisitPriceForTerm: a misting+pest prepay invoice gap-fills at the plain per-application price (no install share)', async () => {
    const data = estimateData(undefined, { pest: { frequency: 'quarterly' } });
    const install = converter.frozenMistingInstall(data);
    const planAnnual = 708;
    const pestAnnual = 480;
    const lines = [
      { description: 'Annual prepay — Pest Control + Mosquito Misting', quantity: 1, unit_price: planAnnual + pestAnnual },
      misting.mistingInstallLine({ description: install.description, amount: install.amount }),
    ];
    const subtotal = planAnnual + pestAnnual + install.amount;
    const price = await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal, lines }), 16);
    expect(price).toBe(Math.round(((planAnnual + pestAnnual) / 16) * 100) / 100);
    // without the marker the install share would leak into every visit
    const leaked = await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal, lines: lines.map(({ kind, service, ...rest }) => rest) }), 16);
    expect(leaked).toBeGreaterThan(price);
  });

  test('seededVisitPriceForTerm: misting-only prepay reads $59 per application; the stored line_items may be a JSON string', async () => {
    const lines = JSON.stringify([
      { description: 'Annual prepay — Mosquito Misting Service Plan', quantity: 1, unit_price: 708 },
      misting.mistingInstallLine({ description: 'Essential system (drum) Installation', amount: INSTALL }),
    ]);
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal: 708 + INSTALL, lines }), 12)).toBe(59);
  });

  test('seededVisitPriceForTerm: the setup subtraction still works beside the install; a setup claim ledger row wins as before', async () => {
    const lines = [
      { description: 'Annual prepay', quantity: 1, unit_price: 1200 },
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
      misting.mistingInstallLine({ description: 'Essential system (drum) Installation', amount: INSTALL }),
    ];
    const subtotal = 1200 + 99 + INSTALL;
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal, lines }), 12)).toBe(100);
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal, lines, claimAmount: 99 }), 12)).toBe(100);
  });

  test('seededVisitPriceForTerm: a non-misting prepay invoice is byte-identical (subtotal, or subtotal minus the setup line)', async () => {
    const plain = [{ description: 'Annual prepay — Pest Control', quantity: 1, unit_price: 480 }];
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal: 480, lines: plain }), 4)).toBe(120);
    const withSetup = [...plain, { description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 150 }];
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal: 630, lines: withSetup }), 4)).toBe(120);
    expect(await renewals.seededVisitPriceForTerm({}, fakeConn({ subtotal: 480, lines: plain }), 4)).toBeNull();
    expect(await renewals.seededVisitPriceForTerm(term, fakeConn({ subtotal: 480, lines: plain }), 0)).toBeNull();
  });
});

describe('P0 (audit 3): invoice-mode acceptance bills the marked install line', () => {
  // estimate-public pulls a very large module graph; load the pure draft builder lazily with the db mocked above.
  const { buildEstimateInvoiceModeDraft } = require('../routes/estimate-public');
  const base = {
    estimate: { id: 77, monthly_total: 59 },
    recurringSvcList: [{ name: 'Mosquito Misting Service Plan' }],
    recurringFirstVisitAmount: 59,
    effectiveBillingCadence: { frequencyLabel: 'Monthly' },
    selectedFrequency: { label: 'Monthly' },
  };

  test('an install adds one marked line beside the first application and its amount to the total and title', () => {
    const install = { amount: INSTALL, description: 'Essential system (drum) Installation' };
    const draft = buildEstimateInvoiceModeDraft({ ...base, mistingInstall: install });
    const lines = draft.lineItems;
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual(misting.mistingInstallLine({ description: install.description, amount: INSTALL }));
    expect(misting.mistingInstallLinesTotal(lines)).toBe(INSTALL);
    expect(draft.amount).toBe(Math.round((59 + INSTALL) * 100) / 100);
    expect(draft.title).toContain('misting system installation');
  });

  test('no misting: byte-identical to before (no extra line, same amount and title)', () => {
    const plain = buildEstimateInvoiceModeDraft({ ...base });
    const withNull = buildEstimateInvoiceModeDraft({ ...base, mistingInstall: null });
    expect(withNull).toEqual(plain);
    expect(plain.lineItems).toHaveLength(1);
    expect(plain.amount).toBe(59);
    expect(plain.title).not.toContain('installation');
  });

  test('the rodent setup line and the install line can coexist; a one-time acceptance never carries the install', () => {
    const draft = buildEstimateInvoiceModeDraft({ ...base, rodentSetupAmount: 150, mistingInstall: { amount: INSTALL, description: 'X Installation' } });
    expect(draft.lineItems).toHaveLength(3);
    expect(draft.amount).toBe(Math.round((59 + 150 + INSTALL) * 100) / 100);
    const oneTime = buildEstimateInvoiceModeDraft({
      estimate: { id: 78 }, treatAsOneTime: true, effectiveOneTimeTotal: 200, oneTimeList: [], mistingInstall: { amount: INSTALL, description: 'X' },
    });
    expect(oneTime.lineItems.some(misting.isMistingInstallLine)).toBe(false);
  });

  test('the accept handler passes the frozen install into the draft (not for a one-time acceptance)', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toContain("mistingInstall: treatAsOneTime\n            ? null\n            : require('../services/estimate-converter').frozenMistingInstall(acceptedEstDataForPricing),");
  });
});

describe('audit 4: engine-origin install, one prepay total helper, install bell eligibility', () => {
  const engineOnly = (opts = { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' }) => {
    const input = { ...PROPERTY, services: { mosquitoMisting: opts } };
    return { engineResult: generateEstimate(input), engineInputs: input };
  };

  test('frozenMistingInstall: mapped item, raw engine line (engineResult.lineItems), and an itemized proposal line all resolve; same shape', () => {
    const mapped = converter.frozenMistingInstall(estimateData());
    expect(mapped).toMatchObject({ amount: INSTALL, description: 'Essential system (drum) Installation' });
    const raw = converter.frozenMistingInstall(engineOnly());
    expect(raw).toMatchObject({ amount: INSTALL, description: 'Essential system (drum) Installation' });
    expect(converter.frozenMistingInstall(JSON.stringify(engineOnly()))).toEqual(raw);
    const proposal = converter.frozenMistingInstall({
      proposal: {
        enabled: true,
        buildings: [{ lineItems: [
          { service: 'mosquito_misting', description: 'Mosquito Misting Service Plan', unitPrice: 59, quantity: 1, amount: 59 },
          { service: 'mosquito_misting_installation', description: 'Smart system Installation', unitPrice: 5200, quantity: 1, amount: 5200 },
        ] }],
      },
      result: estimateData().result,
    });
    expect(proposal).toMatchObject({ amount: 5200, description: 'Smart system Installation', lines: [{ amount: 5200, description: 'Smart system Installation' }] });
  });

  test('frozenMistingInstall: an unpriced / oversize raw line, a quote-required item and an unpriced proposal install bill nothing', () => {
    expect(converter.frozenMistingInstall(engineOnly({ nozzles: 120 }))).toBeNull();
    const rawLine = engineOnly().engineResult.lineItems.find((l) => l.service === 'mosquito_misting');
    const quoteRequired = { engineResult: { lineItems: [{ ...rawLine, quoteRequired: true }] } };
    expect(converter.frozenMistingInstall(quoteRequired)).toBeNull();
    const zeroInstall = { engineResult: { lineItems: [{ ...rawLine, installation: { price: 0 } }] } };
    expect(converter.frozenMistingInstall(zeroInstall)).toBeNull();
    expect(converter.frozenMistingInstall({ proposal: { enabled: true, buildings: [{ lineItems: [{ service: 'mosquito_misting_installation', description: 'X', unitPrice: 0, quantity: 1, amount: 0 }] }] } })).toBeNull();
    expect(converter.frozenMistingInstall({ engineResult: { lineItems: [{ service: 'pest_control' }] } })).toBeNull();
    expect(converter.frozenMistingInstall(null)).toBeNull();
  });

  test('an engine-origin estimate carries its install through the acceptance invoice builders', () => {
    const data = engineOnly();
    const install = converter.frozenMistingInstall(data);
    const { buildEstimateInvoiceModeDraft } = require('../routes/estimate-public');
    const draft = buildEstimateInvoiceModeDraft({
      estimate: { id: 90, monthly_total: 59 }, recurringSvcList: [{ name: 'Mosquito Misting Service Plan' }], recurringFirstVisitAmount: 59,
      effectiveBillingCadence: { frequencyLabel: 'Monthly' }, selectedFrequency: { label: 'Monthly' }, mistingInstall: install,
    });
    expect(draft.lineItems.some(misting.isMistingInstallLine)).toBe(true);
    expect(draft.amount).toBe(Math.round((59 + INSTALL) * 100) / 100);
    expect(converter.frozenPrepayOneTimeLines(data)).toEqual({ rodentSetup: 0, mistingInstall: INSTALL, mistingInstallDescription: 'Essential system (drum) Installation', total: INSTALL });
  });

  test('frozenPrepayOneTimeLines: misting + pest prepay quote total equals the minted invoice total; no misting is unchanged', () => {
    const data = estimateData(undefined, { pest: { frequency: 'quarterly' } });
    const recurring = data.result.recurring.services;
    const baseAnnual = recurring.reduce((sum, row) => sum + (Number(row.annual) || 0), 0);
    const resolved = converter.resolveAnnualPrepayInvoiceTotal({ baseAnnual, recurringServices: recurring, estimateData: data });
    const lines = converter.frozenPrepayOneTimeLines(data);
    const quote = Math.round((resolved.amount + lines.total) * 100) / 100;
    // the minted invoice: prepay line + marked install line (residential, untaxed)
    const install = converter.frozenMistingInstall(data);
    const invoiceTotal = Math.round((resolved.amount + misting.mistingInstallLinesTotal([misting.mistingInstallLine({ description: install.description, amount: install.amount })])) * 100) / 100;
    expect(quote).toBe(invoiceTotal);
    expect(lines.mistingInstall).toBe(INSTALL);
    const plain = estimateData(undefined, { pest: { frequency: 'quarterly' } });
    const noMisting = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) };
    expect(converter.frozenPrepayOneTimeLines(noMisting)).toEqual({ rodentSetup: 0, mistingInstall: 0, mistingInstallDescription: null, total: 0 });
    expect(plain.result).toBeDefined();
  });

  test('both prepay totals (the accept quote and the operator preview) build from the one helper', () => {
    expect(read('routes/estimate-public.js')).toContain('const acknowledgedOneTime = converter.frozenPrepayOneTimeLines(estData);');
    expect(read('routes/estimate-public.js')).toContain('(resolved.amount + acknowledgedOneTime.total)');
    expect(read('services/estimate-manual-acceptance.js')).toContain('EstimateConverter.frozenPrepayOneTimeLines(data)');
  });

  test('install bell eligibility is an explicit caller flag: public standard and prepay accepts and a manual prepay accept pass it; Mark Won and one-tap do not', () => {
    const conv = read('services/estimate-converter.js');
    expect(conv).toContain('opts.mistingInstallBilled === true && !suppressRecurringConversion');
    const route = read('routes/estimate-public.js');
    expect(route).toContain('mistingInstallBilled: true,');
    expect(route).toContain('mistingInstallBilled: !isCommercialAccept && !holdFirstInvoiceForSiteConfirmation,');
    const manual = read('services/estimate-manual-acceptance.js');
    expect(manual).toContain('...(ctx.annualPrepaySelected ? { mistingInstallBilled: true } : {}),');
    expect(read('services/one-tap-purchase.js')).not.toContain('mistingInstallBilled');
    // the manual-accept post-commit plan dispatches the deferred bell
    expect(read('services/estimate-accept-effects.js')).toContain("['misting_install_schedule', 'mistingInstallNotification'],");
  });

  test('annual-prepay accept: the bell payload is returned deferred; a Mark Won passes no flag so the converter raises none', async () => {
    const NotificationService = require('../services/notification-service');
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 1 });
    try {
      const database = jest.fn(() => ({ insert: async () => [1] }));
      const fx = { run: jest.fn((meta, fn) => fn()) };
      const out = await converter.raiseMistingInstallBell(database, fx, { deferCommercialScheduleNotification: true }, {
        estimateId: 91, customerId: 'c1', customer: { first_name: 'A', last_name: 'B' }, estimateData: engineOnly(), firstPlanDate: null,
      });
      expect(out).toMatchObject({ options: { dedupeKey: 'misting_install_schedule:91', bell: true } });
      expect(out.body).toContain('before the first plan application on the first plan visit');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('audit 5: the customer previews carry the install line the invoices bill', () => {
  test('standard, invoice-mode and prepay previews equal the invoice builders (one helper, one amount)', () => {
    const data = estimateData(undefined, { pest: { frequency: 'quarterly' } });
    const lines = converter.frozenPrepayOneTimeLines(data);
    const { buildEstimateInvoiceModeDraft } = require('../routes/estimate-public');
    const firstApplication = 59;
    // standard: the invoice the accept mints = install + first application
    const standardInvoice = Math.round((lines.mistingInstall + firstApplication) * 100) / 100;
    const standardPreview = Math.round((lines.total + firstApplication) * 100) / 100;
    expect(standardPreview).toBe(standardInvoice);
    // invoice-mode: the draft bills the same install
    const install = converter.frozenMistingInstall(data);
    const draft = buildEstimateInvoiceModeDraft({
      estimate: { id: 5, monthly_total: 59 }, recurringSvcList: [{ name: 'Mosquito Misting Service Plan' }], recurringFirstVisitAmount: firstApplication,
      effectiveBillingCadence: { frequencyLabel: 'Monthly' }, selectedFrequency: { label: 'Monthly' }, mistingInstall: install,
    });
    expect(draft.amount).toBe(standardPreview);
    // prepay: the quote adds the same amount to the coverage total, as the minted invoice does
    const recurring = data.result.recurring.services;
    const baseAnnual = recurring.reduce((sum, row) => sum + (Number(row.annual) || 0), 0);
    const resolved = converter.resolveAnnualPrepayInvoiceTotal({ baseAnnual, recurringServices: recurring, estimateData: data });
    expect(Math.round((resolved.amount + lines.total) * 100) / 100).toBe(Math.round((resolved.amount + install.amount) * 100) / 100);
    expect(lines.mistingInstallDescription).toBe(install.description);
  });

  test('the payload field is built from the helper, labeled by the tier, and omitted when there is no install', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toContain('const previewOneTimeLines = require(\'../services/estimate-converter\').frozenPrepayOneTimeLines(withSupplementedRecurringServices(estData) || estData);');
    expect(src).toContain("const mistingInstallFeeField = previewOneTimeLines.mistingInstall > 0");
    expect(src).toContain("service: 'mosquito_misting_installation',\n        amount: previewOneTimeLines.mistingInstall,");
    expect(src).toContain("label: previewOneTimeLines.mistingInstallDescription || 'Mosquito Misting System Installation',");
    expect((src.match(/\.\.\.mistingInstallFeeField,/g) || [])).toHaveLength(4); // the three fresh bundle shapes + the snapshot return path
    // no misting: the helper reports zero, the conditional yields {} and the payload is unchanged
    const none = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) };
    expect(converter.frozenPrepayOneTimeLines(none).mistingInstall).toBe(0);
  });

  test('the due-today cards, the legacy prepay total and the prepay refresh attribute all carry the install', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toContain('const dueTodayOneTimeLines = !locked');
    expect(src).toContain('const standardSetupDue = Math.round((setupDueToday + rodentSetupDueToday + mistingInstallDueToday) * 100) / 100;');
    expect(src).toContain('Math.round((Math.max(0, prepayResolved.amount) + rodentSetupDueToday + mistingInstallDueToday) * 100) / 100');
    expect(src).toContain('Math.round((annualTotal + rodentSetupDueToday + mistingInstallDueToday) * 100) / 100');
    expect(src).toContain('data-prepay-setup-due="${Math.round((Number(rodentSetupDueToday) + Number(mistingInstallDueToday)) * 100) / 100}"');
    expect(src).toContain('data-misting-install-due="${Number(mistingInstallDueToday)}"');
    // the commercial tax blend still takes only the rodent setup, as the converter does
    expect(src).toContain('taxableOneTimeAmount: rodentSetupDueToday,');
    // the install is not deferred to the first visit
    expect(src).toContain('&& !(mistingInstallDueToday > 0)');
  });

  test('the client previews the install via the same extraInvoiceRows seam and keeps it out of the after-completion extras', () => {
    const client = fs.readFileSync(path.join(__dirname, '..', '..', 'client/src/pages/EstimateViewPage.jsx'), 'utf8');
    expect(client).toContain('pricing?.mistingInstallFee?.amount');
    expect(client).toContain('isMistingInstallBreakdownRow(row)');
  });
});

describe('audit 6: a pre-change send snapshot serves the install preview too', () => {
  const { buildPricingBundle } = require('../routes/estimate-public');
  const snapshotEstimate = (id, data, { withSnapshotFee = false } = {}) => {
    const row = data.result.recurring.services.find((s) => s.service === 'mosquito_misting');
    const oneTimeItems = (data.result.oneTime && data.result.oneTime.items) || [];
    const frequency = {
      key: 'monthly', label: 'Monthly', monthly: 59, annual: 708,
      perServiceTreatments: [{ service: 'mosquito_misting', label: row ? row.name : 'Mosquito Misting Service Plan', perTreatment: 59, displayPrice: 59, visitsPerYear: 12 }],
    };
    return {
      id,
      status: 'sent',
      monthly_total: 59,
      annual_total: 708,
      onetime_total: oneTimeItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0),
      waveguard_tier: 'none',
      estimate_data: {
        ...data,
        sendSnapshot: {
          pricingBundle: {
            frequencies: [frequency],
            source: 'send_snapshot',
            oneTimeBreakdown: { items: oneTimeItems.map((item) => ({ service: item.service, label: item.name, name: item.name, price: item.price, amount: item.price })), total: oneTimeItems.reduce((sum, item) => sum + (Number(item.price) || 0), 0) },
            ...(withSnapshotFee ? { mistingInstallFee: { service: 'mosquito_misting_installation', amount: INSTALL, label: 'stale', waivedWithPrepay: false } } : {}),
          },
        },
      },
    };
  };

  test('a pre-change snapshot (no mistingInstallFee key) for a misting estimate gets the field, and the payment-choice total equals the invoice', async () => {
    const data = estimateData();
    const bundle = await buildPricingBundle(snapshotEstimate('est-snap-misting-1', data));
    expect(bundle.snapshotHit).toBe(true);
    const install = converter.frozenMistingInstall(data);
    expect(bundle.mistingInstallFee).toEqual({
      service: 'mosquito_misting_installation', amount: INSTALL, label: install.description, waivedWithPrepay: false,
    });
    // the up-front rows the client previews (install + first application) equal the invoice the accept mints
    const firstApplication = 59;
    const preview = Math.round((bundle.mistingInstallFee.amount + firstApplication) * 100) / 100;
    expect(preview).toBe(Math.round((install.amount + firstApplication) * 100) / 100);
  });

  test('a snapshot that already carries the field is corrected to the frozen estimate figure', async () => {
    const data = estimateData();
    const bundle = await buildPricingBundle(snapshotEstimate('est-snap-misting-2', data, { withSnapshotFee: true }));
    expect(bundle.mistingInstallFee.label).not.toBe('stale');
    expect(bundle.mistingInstallFee.amount).toBe(INSTALL);
  });

  test('a non-misting snapshot returns no mistingInstallFee and its stored fields untouched', async () => {
    const input = { ...PROPERTY, services: { pest: { frequency: 'quarterly' } } };
    const data = { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
    const estimate = snapshotEstimate('est-snap-pest-1', data);
    estimate.estimate_data.sendSnapshot.pricingBundle.frequencies[0].perServiceTreatments = [{ service: 'pest_control', label: 'Pest Control', perTreatment: 59, displayPrice: 59, visitsPerYear: 12 }];
    const stored = JSON.parse(JSON.stringify(estimate.estimate_data.sendSnapshot.pricingBundle));
    const bundle = await buildPricingBundle(estimate);
    expect(Object.prototype.hasOwnProperty.call(bundle, 'mistingInstallFee')).toBe(false);
    if (bundle.snapshotHit) expect(bundle.frequencies[0].key).toBe(stored.frequencies[0].key);
    // the stored snapshot itself is never written back
    expect(estimate.estimate_data.sendSnapshot.pricingBundle).toEqual(stored);
  });

  test('the snapshot return path attaches the field from the same constant as the fresh path', () => {
    const src = read('routes/estimate-public.js');
    expect(src).toMatch(/\.\.\.snapshotBundle,\s*\/\/ A snapshot frozen before the misting install[\s\S]{0,260}\.\.\.mistingInstallFeeField,\s*source: snapshotBundle\.source/);
  });
});

describe('audit 7: several sold installs bill once each; a refill is due once', () => {
  const twoBuildingProposal = () => ({
    proposal: {
      enabled: true,
      buildings: [
        { name: 'Main house', lineItems: [
          { service: 'mosquito_misting', description: 'Mosquito Misting Service Plan', unitPrice: 59, quantity: 1, amount: 59 },
          { service: 'mosquito_misting_installation', description: 'Main house Installation', unitPrice: 4595, quantity: 1, amount: 4595 },
        ] },
        { name: 'Guest house', lineItems: [
          { service: 'mosquito_misting_installation', description: 'Guest house Installation', unitPrice: 3795, quantity: 1, amount: 3795 },
        ] },
      ],
    },
  });

  test('a two-building proposal: both installs are billed (one marked line each), and the total, quote and invoice agree', () => {
    const data = twoBuildingProposal();
    const install = converter.frozenMistingInstall(data);
    expect(install.amount).toBe(4595 + 3795);
    expect(install.lines).toEqual([
      { amount: 4595, description: 'Main house Installation' },
      { amount: 3795, description: 'Guest house Installation' },
    ]);
    expect(install.description).toBe('Mosquito Misting System Installation (2 systems)');
    const invoiceLines = misting.mistingInstallInvoiceLines(install);
    expect(invoiceLines).toHaveLength(2);
    expect(invoiceLines.every(misting.isMistingInstallLine)).toBe(true);
    expect(misting.mistingInstallLinesTotal(invoiceLines)).toBe(install.amount);
    // quote preview == invoice: the prepay/standard helper and the payload field carry the summed total
    const quote = converter.frozenPrepayOneTimeLines(data);
    expect(quote.mistingInstall).toBe(install.amount);
    expect(quote.mistingInstallDescription).toBe(install.description);
    // invoice-mode draft: one marked line per install, the total includes both
    const { buildEstimateInvoiceModeDraft } = require('../routes/estimate-public');
    const draft = buildEstimateInvoiceModeDraft({
      estimate: { id: 99, monthly_total: 59 }, recurringSvcList: [{ name: 'Mosquito Misting Service Plan' }], recurringFirstVisitAmount: 59,
      effectiveBillingCadence: { frequencyLabel: 'Monthly' }, selectedFrequency: { label: 'Monthly' }, mistingInstall: install,
    });
    expect(draft.lineItems.filter(misting.isMistingInstallLine)).toHaveLength(2);
    expect(draft.amount).toBe(Math.round((59 + install.amount) * 100) / 100);
  });

  test('a single mapped install is unchanged (one line, same amount and label)', () => {
    const install = converter.frozenMistingInstall(estimateData());
    expect(install).toMatchObject({ amount: INSTALL, description: 'Essential system (drum) Installation' });
    expect(install.lines).toHaveLength(1);
    expect(misting.mistingInstallInvoiceLines(install)).toEqual([misting.mistingInstallLine({ description: install.description, amount: INSTALL })]);
    expect(misting.mistingInstallInvoiceLines(null)).toEqual([]);
    // a bare { amount, description } (no lines) still renders as one marked line
    expect(misting.mistingInstallInvoiceLines({ amount: 100, description: 'X Installation' })).toHaveLength(1);
  });

  test('proposal + a mapped item for the same install: the proposal decides and the install is counted once', () => {
    const base = estimateData();
    const data = {
      ...base,
      proposal: {
        enabled: true,
        buildings: [{ lineItems: [{ service: 'mosquito_misting_installation', description: 'Smart system Installation', unitPrice: 5200, quantity: 1, amount: 5200 }] }],
      },
    };
    const install = converter.frozenMistingInstall(data);
    expect(install.amount).toBe(5200);
    expect(install.lines).toHaveLength(1);
    // the same line object listed under two proposal containers is one install
    const shared = { service: 'mosquito_misting_installation', description: 'Shared Installation', unitPrice: 4000, quantity: 1, amount: 4000 };
    const dup = { proposal: { enabled: true, buildings: [{ lineItems: [shared] }], programs: [shared] } };
    expect(converter.frozenMistingInstall(dup).amount).toBe(4000);
  });

  test('the invoice builders emit the install through the multi-line helper', () => {
    const conv = read('services/estimate-converter.js');
    expect((conv.match(/mistingInstallInvoiceLines\(mistingInstall\)/g) || [])).toHaveLength(2);
    const route = read('routes/estimate-public.js');
    expect(route).toContain('.mistingInstallInvoiceLines(mistingInstall)');
    expect(route).toContain('.mistingInstallInvoiceLines(acceptedMistingInstall)');
  });

  describe('a misting refill is one refill application', () => {
    const { lineDueOnRecurringDate, filterAddonLinesForDate, addonRecursAfterAnchor } = require('../routes/admin-schedule')._test;
    const BASE = '2027-03-10';
    const dates = ['2027-04-10', '2027-05-10', '2027-06-10'];
    const storedRefill = { service_key_snapshot: 'mosquito_misting_refill', recurring_pattern: null, estimated_price: 219 };
    const pricedRefill = { serviceKey: 'mosquito_misting_refill', recurringPattern: null, price: 219 };
    const storedBait = { service_key_snapshot: 'rodent_bait', recurring_pattern: null, estimated_price: 30 };

    test('due on the visit it was added to, never on a later monthly visit (stored rows and booking lines)', () => {
      expect(lineDueOnRecurringDate(storedRefill, BASE, BASE)).toBe(true);
      expect(lineDueOnRecurringDate(pricedRefill, BASE, BASE)).toBe(true);
      for (const date of dates) {
        expect(lineDueOnRecurringDate(storedRefill, BASE, date)).toBe(false);
        expect(lineDueOnRecurringDate(pricedRefill, BASE, date)).toBe(false);
        expect(lineDueOnRecurringDate({ ...storedRefill, recurring_pattern: 'monthly' }, BASE, date)).toBe(false);
      }
      expect(addonRecursAfterAnchor(storedRefill)).toBe(false);
      expect(addonRecursAfterAnchor(pricedRefill)).toBe(false);
    });

    test('children and series extensions built from an anchor carrying a refill get none; the anchor keeps it; an ordinary recurring add-on is unchanged', () => {
      const anchorAddons = [storedRefill, storedBait];
      expect(filterAddonLinesForDate(anchorAddons, BASE, BASE)).toEqual([storedRefill, storedBait]);
      for (const date of dates) {
        // every spawn / top-up / auto-extend path filters the parent add-ons through this one function
        expect(filterAddonLinesForDate(anchorAddons, BASE, date)).toEqual([storedBait]);
      }
      expect(lineDueOnRecurringDate(storedBait, BASE, dates[0])).toBe(true);
      const src = read('routes/admin-schedule.js');
      expect((src.match(/filterAddonLinesForDate\(parentAddons/g) || []).length).toBeGreaterThanOrEqual(3);
      expect(src).toContain("|| serviceKey === 'mosquito_misting_refill';");
    });
  });
});

describe('audit 8: the install resolves for an inputs-only estimate and fails closed otherwise', () => {
  const inputsOnly = () => {
    const input = { ...PROPERTY, services: { mosquitoMisting: { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' } } };
    return { engineInputs: input };
  };
  const noInstall = () => {
    const data = estimateData();
    return { ...data, result: { ...data.result, oneTime: { ...(data.result.oneTime || {}), items: [] } } };
  };
  const { withSupplementedRecurringServices } = require('../routes/estimate-public');

  test('an inputs-only misting estimate: the engine replay carries the install into the accepted data, so it resolves and bills', () => {
    const raw = inputsOnly();
    expect(converter.frozenMistingInstall(raw)).toBeNull(); // nothing is stored to read
    const accepted = withSupplementedRecurringServices(raw);
    const install = converter.frozenMistingInstall(accepted);
    expect(install).toMatchObject({ amount: INSTALL, description: 'Essential system (drum) Installation' });
    // standard / prepay lines, the quote helper and the invoice-mode draft all see it
    expect(misting.mistingInstallInvoiceLines(install).every(misting.isMistingInstallLine)).toBe(true);
    expect(converter.frozenPrepayOneTimeLines(accepted).mistingInstall).toBe(INSTALL);
    const { buildEstimateInvoiceModeDraft } = require('../routes/estimate-public');
    const draft = buildEstimateInvoiceModeDraft({
      estimate: { id: 70, monthly_total: 59 }, recurringSvcList: [{ name: 'Mosquito Misting Service Plan' }], recurringFirstVisitAmount: 59,
      effectiveBillingCadence: { frequencyLabel: 'Monthly' }, selectedFrequency: { label: 'Monthly' }, mistingInstall: install,
    });
    expect(draft.amount).toBe(Math.round((59 + INSTALL) * 100) / 100);
    // the accepted data persists in the mapped shape, so a re-read (the converter) resolves it again
    expect(converter.frozenMistingInstall(JSON.parse(JSON.stringify(accepted))).amount).toBe(INSTALL);
    // and it is not refused, raw or supplemented
    expect(mapper.estimateMistingInstallUnresolved(raw)).toBe(false);
    expect(mapper.estimateMistingInstallUnresolved(accepted)).toBe(false);
    expect(mapper.gatedAddOnCustomerRefusal(raw)).toBeNull();
    expect(mapper.gatedAddOnCustomerRefusal(accepted)).toBeNull();
  });

  test('an inputs-only misting estimate raises the install bell on the accepted data', async () => {
    const accepted = withSupplementedRecurringServices(inputsOnly());
    const NotificationService = require('../services/notification-service');
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 1 });
    try {
      const database = jest.fn(() => ({ insert: async () => [1] }));
      const out = await converter.raiseMistingInstallBell(database, { run: jest.fn((meta, fn) => fn()) }, {}, {
        estimateId: 71, customerId: 'c1', customer: { first_name: 'A', last_name: 'B' }, estimateData: accepted,
      });
      expect(out).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][3]).toMatchObject({ dedupeKey: 'misting_install_schedule:71', bell: true });
    } finally { spy.mockRestore(); }
  });

  test('a stored estimate with a priced plan and NO install evidence is refused with the new code (customer and staff), after accept-pending', () => {
    const data = noInstall();
    expect(converter.frozenMistingInstall(data)).toBeNull();
    expect(mapper.estimateMistingInstallUnresolved(data)).toBe(true);
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({
      code: 'MOSQUITO_MISTING_INSTALL_UNRESOLVED', reason: 'mosquito_misting_install_unresolved',
      error: mapper.AREA_ADDONS_GATED_CUSTOMER_MESSAGE,
    });
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toEqual({
      code: 'MOSQUITO_MISTING_INSTALL_UNRESOLVED',
      reason: 'mosquito_misting_install_unresolved',
      message: "This estimate's misting installation amount cannot be read from the stored quote; re-send the estimate so the install is frozen before accepting.",
    });
    // view and staff send are never blocked
    expect(mapper.gatedAddOnCustomerRefusal(data, { allowAcceptPending: true })).toBeNull();
    expect(mapper.gatedAddOnStaffRefusal(data, 'sending', { allowAcceptPending: true })).toBeNull();
    // precedence: the gate-off refusal wins, then accept-pending, then the unresolved install
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_GATED' });
    process.env.GATE_MOSQUITO_MISTING = 'true';
    constants.MOSQUITO_MISTING_CONVERSION_READY = false;
    try { expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' }); } finally { constants.MOSQUITO_MISTING_CONVERSION_READY = true; }
    // a normal estimate (install present), an unpriced oversize layout, no misting, and a one-time-shaped read are unaffected
    expect(mapper.estimateMistingInstallUnresolved(estimateData())).toBe(false);
    expect(mapper.gatedAddOnCustomerRefusal(estimateData())).toBeNull();
    expect(mapper.estimateMistingInstallUnresolved(estimateData({ nozzles: 120 }))).toBe(false);
    const none = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) };
    expect(mapper.estimateMistingInstallUnresolved(none)).toBe(false);
    expect(mapper.estimateMistingInstallUnresolved(null)).toBe(false);
  });

  test('an authored proposal that prices the plan but not the install is refused; one that prices both is not', () => {
    const planOnly = { proposal: { enabled: true, buildings: [{ lineItems: [{ service: 'mosquito_misting', description: 'Mosquito Misting Service Plan', unitPrice: 59, quantity: 1, amount: 59 }] }] } };
    expect(mapper.estimateMistingInstallUnresolved(planOnly)).toBe(true);
    const both = { proposal: { enabled: true, buildings: [{ lineItems: [
      { service: 'mosquito_misting', description: 'Mosquito Misting Service Plan', unitPrice: 59, quantity: 1, amount: 59 },
      { service: 'mosquito_misting_installation', description: 'Smart system Installation', unitPrice: 5200, quantity: 1, amount: 5200 },
    ] }] } };
    expect(mapper.estimateMistingInstallUnresolved(both)).toBe(false);
  });

  test('the accept, slots, card intents, deposits and the staff paths all go through the shared refusals', () => {
    const route = read('routes/estimate-public.js');
    expect((route.match(/gatedAddOnCustomerRefusal\(/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(read('routes/estimate-slots-public.js')).toMatch(/gatedAddOnCustomerRefusal/);
    expect(read('services/estimate-deposits.js')).toContain("reason: 'mosquito_misting_install_unresolved'");
    expect(read('services/estimate-manual-acceptance.js')).toMatch(/gatedAddOnStaffRefusal/);
    const client = fs.readFileSync(path.join(__dirname, '..', '..', 'client/src/pages/EstimateViewPage.jsx'), 'utf8');
    expect(client).toContain("'MOSQUITO_MISTING_INSTALL_UNRESOLVED'");
  });

  test('the frozen catalog migration still creates no add-on link and keeps the refill row dormant; the link is misting PR 2c\'s own migration', () => {
    // 20261023100000 shipped in PR 2a and is frozen: it never links the refill. The link lives in 20261024100000 (PR 2c).
    const migration = require('../models/migrations/20261023100000_mosquito_misting_catalog_rows');
    expect(read('models/migrations/20261023100000_mosquito_misting_catalog_rows.js')).not.toMatch(/linkRefillAddon|service_addons'\)\.insert/);
    const refill = migration.SERVICES.find((row) => row.service_key === 'mosquito_misting_refill');
    expect(refill).toMatchObject({ customer_visible: false, booking_enabled: false, public_quote_selectable: false });
    expect(read('models/migrations/20261024100000_mosquito_misting_refill_addon_link.js')).toMatch(/service_addons/);
  });
});

describe('audit 9: the manual annual-prepay lane accepts a real misting quote', () => {
  const manual = require('../services/estimate-manual-acceptance');
  const withPest = () => estimateData(undefined, { pest: { frequency: 'quarterly' } });

  test('a mapped misting + pest quote: the install row is invoiced on the prepay invoice, so it does not block the manual lane', () => {
    const data = withPest();
    // the quote really carries a positive install row (durable identity), plus the engine one-time total
    const items = data.result.oneTime.items;
    expect(items.some((item) => item.service === 'mosquito_misting_installation' && item.price > 0)).toBe(true);
    const estimate = { id: 'est-manual-1', estimate_data: data, onetime_total: data.result.oneTime.total, annual_total: 1200, monthly_total: 100 };
    expect(manual._private.manualPrepayBlockingOneTimeCharge(estimate)).toBe(false);
    // the prepay converter bills exactly the row the exemption matched, as a marked line
    const install = converter.frozenMistingInstall(data);
    expect(misting.mistingInstallInvoiceLines(install)).toHaveLength(1);
    expect(read('services/estimate-converter.js')).toContain('...mistingInstallInvoiceLines(mistingInstall)],');
  });

  test('matching is by durable identity, never description: a renamed non-install row still blocks, an unpriced install does not exempt', () => {
    const data = withPest();
    const renamed = JSON.parse(JSON.stringify(data));
    renamed.result.oneTime.items = renamed.result.oneTime.items.map((item) => (item.service === 'mosquito_misting_installation'
      ? { ...item, name: 'Smart system Installation' } : item));
    expect(manual._private.manualPrepayBlockingOneTimeCharge({ id: 'e2', estimate_data: renamed, onetime_total: data.result.oneTime.total })).toBe(false);
    // a genuine one-time charge named like an installation but with another service identity still blocks
    const fake = JSON.parse(JSON.stringify(data));
    fake.result.oneTime.items.push({ service: 'flea_treatment', name: 'Mosquito Misting System Installation', price: 249 });
    fake.result.oneTime.total = (Number(fake.result.oneTime.total) || 0) + 249;
    expect(manual._private.manualPrepayBlockingOneTimeCharge({ id: 'e3', estimate_data: fake, onetime_total: fake.result.oneTime.total })).toBe(true);
    // an install the converter cannot resolve (quote-required) is not exempt
    const unpriced = JSON.parse(JSON.stringify(data));
    unpriced.result.oneTime.items = unpriced.result.oneTime.items.map((item) => (item.service === 'mosquito_misting_installation'
      ? { ...item, quoteRequired: true } : item));
    expect(manual._private.manualPrepayBlockingOneTimeCharge({ id: 'e4', estimate_data: unpriced, onetime_total: data.result.oneTime.total })).toBe(true);
  });

  test('a quote with a genuine other one-time item still blocks, with or without the install', () => {
    const data = withPest();
    const withFlea = JSON.parse(JSON.stringify(data));
    withFlea.result.oneTime.items.push({ service: 'flea_treatment', name: 'Flea treatment', price: 249 });
    withFlea.result.oneTime.total = (Number(withFlea.result.oneTime.total) || 0) + 249;
    expect(manual._private.manualPrepayBlockingOneTimeCharge({ id: 'e5', estimate_data: withFlea, onetime_total: withFlea.result.oneTime.total })).toBe(true);
    const fleaOnly = { result: { ...data.result, oneTime: { items: [{ service: 'flea_treatment', name: 'Flea treatment', price: 249 }], total: 249 } } };
    expect(manual._private.manualPrepayBlockingOneTimeCharge({ id: 'e6', estimate_data: fleaOnly, onetime_total: 249 })).toBe(true);
  });

  test('prepayBookingEligibility: a misting quote is eligible and the previewed total is the plan annual plus the install (the invoice the converter mints)', async () => {
    const data = estimateData();
    const recurring = data.result.recurring.services.find((row) => row.service === 'mosquito_misting');
    const estimate = {
      id: 'est-manual-2', status: 'sent', estimate_data: data, onetime_total: data.result.oneTime.total,
      annual_total: recurring.annual, monthly_total: recurring.mo || recurring.monthly,
    };
    const q = { where: () => q, first: async () => null, select: async () => [], whereIn: () => q, whereNull: () => q, orderBy: () => q, limit: () => q, then: (resolve) => resolve([]) };
    const out = await manual.prepayBookingEligibility(estimate, jest.fn(() => q));
    expect(out).toMatchObject({ eligible: true, reason: null });
    expect(out.invoiceTotal).toBe(Math.round((Number(recurring.annual) + INSTALL) * 100) / 100);
    // without the exemption this was ineligible with reason one_time_items; the one-coverage-service rule still applies to a pest + misting pair
    const pair = withPest();
    const pairEstimate = { id: 'est-manual-3', status: 'sent', estimate_data: pair, onetime_total: pair.result.oneTime.total, annual_total: 1200, monthly_total: 100 };
    expect((await manual.prepayBookingEligibility(pairEstimate, jest.fn(() => q))).reason).toBe('multi_service');
  });

  test('a non-misting quote is unchanged', () => {
    const pest = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) };
    expect(manual._private.manualPrepayBlockingOneTimeCharge({ id: 'e7', estimate_data: pest, onetime_total: pest.result.oneTime ? pest.result.oneTime.total : 0 })).toBe(false);
  });
});

describe('audit 10: the per-application basis never mistakes the coverage line for setup', () => {
  const kinds = require('../utils/annual-prepay-line-kinds');
  const COVERAGE_WAIVED = 'WaveGuard Membership — 12 months prepaid (setup fee waived)'; // the converter's real wording
  const coverageLine = (amount, description = COVERAGE_WAIVED, withKind = true) => ({
    description, quantity: 1, unit_price: amount, ...(withKind ? { kind: kinds.ANNUAL_PREPAY_COVERAGE_LINE_KIND } : {}),
  });
  const installLine = (amount = 4260) => misting.mistingInstallLine({ description: 'Essential system (drum) Installation', amount });
  const conn = ({ subtotal, lines, claimAmount = null }) => (table) => ({
    where: () => ({
      first: async () => {
        if (table === 'invoices') return { subtotal, total: subtotal, line_items: lines };
        if (table === 'setup_fee_claims') return claimAmount == null ? undefined : { amount: claimAmount };
        return undefined;
      },
    }),
  });
  const term = { prepay_invoice_id: 'inv-1' };
  const price = (args, visits) => renewals.seededVisitPriceForTerm(term, conn(args), visits);

  test('misting-only prepay ($708 coverage + $4,260 install): $59 per application, with the coverage kind (direct) and without it (legacy)', async () => {
    const withKind = [coverageLine(708), installLine()];
    expect(await price({ subtotal: 4968, lines: withKind }, 12)).toBe(59);
    // the exact failing case: a legacy coverage line whose "(setup fee waived)" wording used to be read as setup
    const legacy = [coverageLine(708, COVERAGE_WAIVED, false), installLine()];
    expect(await price({ subtotal: 4968, lines: legacy }, 12)).toBe(59);
    expect(await price({ subtotal: 4968, lines: JSON.stringify(legacy) }, 12)).toBe(59);
  });

  test('the "(setup fee waived)" coverage wording is never subtracted, whatever else is on the invoice', async () => {
    expect(await price({ subtotal: 708, lines: [coverageLine(708, COVERAGE_WAIVED, false)] }, 12)).toBe(59);
    expect(kinds.looksLikeLegacyCoverageDescription({ description: COVERAGE_WAIVED })).toBe(true);
    expect(kinds.looksLikeLegacyCoverageDescription({ description: 'Pest Control — 12 months prepaid (10% prepay discount)' })).toBe(true);
    expect(kinds.looksLikeLegacyCoverageDescription({ description: 'Bait Station Setup — one-time setup fee' })).toBe(false);
  });

  test('misting + pest prepay: coverage is the pest and misting annual together, the install is excluded', async () => {
    const pestAndMisting = 480 + 708;
    const withKind = [coverageLine(pestAndMisting, 'Pest Control + Mosquito Misting — 12 months prepaid (10% prepay discount)'), installLine()];
    expect(await price({ subtotal: pestAndMisting + 4260, lines: withKind }, 16)).toBe(Math.round((pestAndMisting / 16) * 100) / 100);
    const legacy = [coverageLine(pestAndMisting, 'Pest Control + Mosquito Misting — 12 months prepaid (10% prepay discount)', false), installLine()];
    expect(await price({ subtotal: pestAndMisting + 4260, lines: legacy }, 16)).toBe(Math.round((pestAndMisting / 16) * 100) / 100);
  });

  test('pest-only prepay with the $99 setup is unchanged (legacy scan, ledger claim, and the kinded direct basis all agree)', async () => {
    const setup = { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 };
    const legacy = [coverageLine(1200, 'Pest Control — 12 months prepaid', false), setup];
    expect(await price({ subtotal: 1299, lines: legacy }, 12)).toBe(100);
    expect(await price({ subtotal: 1299, lines: legacy, claimAmount: 99 }, 12)).toBe(100);
    expect(await price({ subtotal: 1299, lines: [coverageLine(1200, 'Pest Control — 12 months prepaid'), setup] }, 12)).toBe(100);
    const rodent = { description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 150 };
    expect(await price({ subtotal: 1350, lines: [coverageLine(1200, 'Rodent Bait — 12 months prepaid', false), rodent] }, 12)).toBe(100);
  });

  test('a legacy invoice without any kinds or coverage wording is unchanged', async () => {
    const lines = [{ description: 'Annual prepay — Pest Control', quantity: 1, unit_price: 480 }];
    expect(await price({ subtotal: 480, lines }, 4)).toBe(120);
    const withSetup = [...lines, { description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 150 }];
    expect(await price({ subtotal: 630, lines: withSetup }, 4)).toBe(120);
    expect(await price({ subtotal: 480, lines: null }, 4)).toBe(120);
    expect(await price({ subtotal: 480, lines: 'not json' }, 4)).toBe(120);
  });

  test('the install is subtracted exactly once even when it equals what is left of the base (no skip shortcut)', async () => {
    const lines = [{ description: 'Annual prepay', quantity: 1, unit_price: 708 }, installLine(708)];
    expect(await price({ subtotal: 1416, lines }, 12)).toBe(59);
  });

  test('the converter mints the coverage line with the durable kind, and the legacy scan skips coverage and marked lines', () => {
    const conv = read('services/estimate-converter.js');
    expect(conv).toContain('kind: ANNUAL_PREPAY_COVERAGE_LINE_KIND,');
    const renewalsSrc = read('services/annual-prepay-renewals.js');
    expect(renewalsSrc).toContain('!isMistingInstallLine(li) && !looksLikeLegacyCoverageDescription(li)');
    expect(renewalsSrc).toContain('const coverageLines = (lines || []).filter(isAnnualPrepayCoverageLine);');
    // the legacy wording the converter builds
    expect(conv).toContain('WaveGuard Membership — 12 months prepaid (setup fee waived)');
  });
});
