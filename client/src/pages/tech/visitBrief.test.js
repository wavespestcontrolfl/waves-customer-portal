import { describe, expect, it } from 'vitest';
import {
  fmtMoney,
  lawnGateLabels,
  prepaidLine,
  quotedLineLabel,
  quotedTermsLabel,
  shortAddress,
  smsHref,
  stopAccessIndicator,
  stopCollectSummary,
  telHref,
  visitMoneySummary,
} from './visitBrief';

describe('fmtMoney', () => {
  it('formats and trims .00; refuses non-numbers', () => {
    expect(fmtMoney(115)).toBe('$115');
    expect(fmtMoney(99.5)).toBe('$99.50');
    expect(fmtMoney('bad')).toBe(null);
    expect(fmtMoney(null)).toBe(null);
  });
});

describe('shortAddress', () => {
  it('keeps the street portion before the first comma', () => {
    expect(shortAddress('123 Palm Ave, Bradenton, FL 34205')).toBe('123 Palm Ave');
    expect(shortAddress('123 Palm Ave')).toBe('123 Palm Ave');
    expect(shortAddress('')).toBe(null);
    expect(shortAddress(null)).toBe(null);
  });
});

describe('tel/sms hrefs', () => {
  it('sanitizes to digits with an optional leading +', () => {
    expect(telHref('(941) 555-0100')).toBe('tel:9415550100');
    expect(smsHref('+1 941-555-0100')).toBe('sms:+19415550100');
  });
  it('refuses missing or obviously-not-a-phone values', () => {
    expect(telHref(null)).toBe(null);
    expect(telHref('ext 12')).toBe(null);
    expect(smsHref('')).toBe(null);
  });
});

describe('visitMoneySummary', () => {
  const withPrediction = (kind, amount) => ({ billingLane: { prediction: { kind, amount } } });

  it('collect-needed ONLY for kind invoice with a positive amount', () => {
    expect(visitMoneySummary(withPrediction('invoice', 95)).collectNeeded).toBe(true);
    expect(visitMoneySummary(withPrediction('invoice', 0)).collectNeeded).toBe(false);
    for (const kind of ['auto_charge', 'payer', 'prepaid', 'covered_membership', 'covered_annual', 'no_charge']) {
      expect(visitMoneySummary(withPrediction(kind, 95)).collectNeeded).toBe(false);
    }
  });

  it('per-kind headlines', () => {
    expect(visitMoneySummary(withPrediction('invoice', 95)).headline).toBe('Collect $95 today');
    expect(visitMoneySummary(withPrediction('invoice', 0)).headline).toBe('No charge today');
    expect(visitMoneySummary(withPrediction('auto_charge', 120)).headline).toBe('$120 auto-charges on completion');
    expect(visitMoneySummary(withPrediction('payer', 120)).headline).toBe('Billed to payer — do not collect');
    expect(visitMoneySummary(withPrediction('prepaid', 0)).headline).toBe('Prepaid — nothing to collect');
    expect(visitMoneySummary(withPrediction('covered_membership', 0)).headline).toBe('Covered by plan — nothing to collect');
    expect(visitMoneySummary(withPrediction('covered_annual', 0)).headline).toBe('Covered by annual plan — nothing to collect');
    expect(visitMoneySummary(withPrediction('no_charge', 0)).headline).toBe('No charge');
  });

  it('missing billingLane (older payload) fails toward NOT flagging', () => {
    const summary = visitMoneySummary({ estimatedPrice: 115 });
    expect(summary.headline).toBe(null);
    expect(summary.collectNeeded).toBe(false);
  });

  it('unknown prediction kinds get no headline (never invented copy)', () => {
    expect(visitMoneySummary(withPrediction('future_kind', 40)).headline).toBe(null);
  });

  it('passes the attached invoice through the canonical helper (amountDue nets credit)', () => {
    const summary = visitMoneySummary({
      billingLane: { prediction: { kind: 'invoice', amount: 100 } },
      checkoutInvoiceId: 'inv-1',
      checkoutInvoiceStatus: 'sent',
      checkoutInvoiceTotal: 120,
      checkoutInvoiceCreditApplied: 20,
      checkoutInvoiceLines: [{ description: 'Quarterly Pest Control', amount: 120 }],
    });
    expect(summary.invoice.amountDue).toBe(100);
    expect(summary.invoice.lines).toEqual([{ description: 'Quarterly Pest Control', amount: 120 }]);
    expect(summary.note).toBe('Collected when the visit is completed.');
  });
});

describe('prepaidLine', () => {
  it('names annual-prepay coverage ONLY when the term-validated prediction confirms it', () => {
    expect(prepaidLine({
      prepaidAmount: 999,
      prepaidMethod: 'annual_prepay_invoice',
      billingLane: { prediction: { kind: 'covered_annual', amount: 0 } },
    })).toBe('Annual prepay on file');
    // A stale stamp (refund/void/expired term → prediction 'invoice')
    // must never claim coverage next to a Collect headline.
    expect(prepaidLine({
      prepaidAmount: 999,
      prepaidMethod: 'annual_prepay_invoice',
      billingLane: { prediction: { kind: 'invoice', amount: 150 } },
    })).toBe(null);
    expect(prepaidLine({ prepaidAmount: 999, prepaidMethod: 'annual_prepay_invoice' })).toBe(null);
  });
  it('shows the recorded prepayment amount and method', () => {
    expect(prepaidLine({ prepaidAmount: 115, prepaidMethod: 'card' })).toBe('Prepaid $115 (card)');
    expect(prepaidLine({ prepaidAmount: 115 })).toBe('Prepaid $115');
  });
  it('null when nothing was prepaid', () => {
    expect(prepaidLine({})).toBe(null);
    expect(prepaidLine({ prepaidAmount: 0 })).toBe(null);
  });
});

describe('quotedLineLabel', () => {
  it('per-application wins, then monthly, then accepted one-time, then price', () => {
    expect(quotedLineLabel({ perApplicationPrice: 55, monthlyPrice: 110, price: 660 })).toBe('$55 /application');
    expect(quotedLineLabel({ monthlyPrice: 110, price: 660 })).toBe('$110 /mo');
    expect(quotedLineLabel({ acceptedOneTimePrice: 250, price: 300 })).toBe('$250 one-time');
    expect(quotedLineLabel({})).toBe(null);
  });

  it('bare price gets the one-time unit ONLY with one-time provenance (source/cadence)', () => {
    // Discounted/legacy recurring lines withhold per-application provenance
    // but still return their recurring price — never label those one-time.
    expect(quotedLineLabel({ price: 115, source: 'recurring', cadence: 'quarterly' })).toBe('$115');
    expect(quotedLineLabel({ price: 300 })).toBe('$300');
    expect(quotedLineLabel({ price: 300, source: 'one_time' })).toBe('$300 one-time');
    expect(quotedLineLabel({ price: 300, cadence: 'one_time' })).toBe('$300 one-time');
  });

  it('a fully-discounted acceptedOneTimePrice of 0 shows $0 one-time, never the gross price', () => {
    expect(quotedLineLabel({ acceptedOneTimePrice: 0, price: 300, cadence: 'one_time' })).toBe('$0 one-time');
  });
});

describe('quotedTermsLabel', () => {
  it('unit-aware terms when every recurring line proves its unit', () => {
    expect(quotedTermsLabel({
      linked: true,
      quotedTotal: 220,
      onetimeTotal: 99,
      lines: [
        { name: 'Pest', cadence: 'quarterly', perApplicationPrice: 121 },
        { name: 'Mosquito', cadence: 'monthly', monthlyPrice: 89 },
      ],
    })).toBe('$121/application + $89/mo + $99 one-time');
  });

  it('falls back to the legacy total when a recurring line has no proven unit', () => {
    expect(quotedTermsLabel({
      linked: true,
      quotedTotal: 450,
      lines: [{ name: 'Legacy plan', cadence: 'quarterly', price: 115 }],
    })).toBe('$450');
    expect(quotedTermsLabel({ linked: false })).toBe(null);
    expect(quotedTermsLabel(null)).toBe(null);
  });
});

describe('lawnGateLabels', () => {
  it('renders every structured gate in operational wording', () => {
    expect(lawnGateLabels({
      premiumTier: true,
      maxTempF: 90,
      soilKGatePpmBelow: 80,
      blockInOrdinanceZones: ['north_port'],
      annualMaxApps: 3,
    })).toEqual([
      'premium plan only',
      'skip above 90°F',
      'soil K below 80 ppm',
      'not in north port',
      'max 3 apps/year',
    ]);
  });

  it('skips bookkeeping keys, keeps triggers, degrades unknown keys to key:value', () => {
    expect(lawnGateLabels({
      trigger: 'armyworm_threshold_3_per_sqft',
      gateProduct: 'SpeedZone',
      annualCounter: 'celsius_oz_per_1000',
      someFutureGate: 42,
    })).toEqual(['armyworm threshold 3 per sqft', 'some future gate: 42']);
    expect(lawnGateLabels(null)).toEqual([]);
  });

  it('renders every application-limit violation message, deduped against the mirrored trigger', () => {
    expect(lawnGateLabels({
      trigger: 'Annual max reached for Celsius WG',
      applicationLimits: [
        { severity: 'block', type: 'annual_max', message: 'Annual max reached for Celsius WG' },
        { severity: 'warn', type: 'min_interval', message: 'Applied 5 days ago — 7-day minimum interval' },
      ],
    })).toEqual([
      'Annual max reached for Celsius WG',
      'Applied 5 days ago — 7-day minimum interval',
    ]);
  });
});

describe('stopCollectSummary', () => {
  const withPrediction = (id, kind, amount) => ({ id, billingLane: { prediction: { kind, amount } } });
  const stopOf = (...services) => ({ services });

  it('aggregates across every member — a prepaid primary must not hide a sibling due', () => {
    const out = stopCollectSummary(stopOf(
      withPrediction('a', 'prepaid', 0),
      withPrediction('b', 'invoice', 95),
      withPrediction('c', 'invoice', 30),
    ));
    expect(out).toEqual({ collectNeeded: true, amount: 125 });
  });

  it('no collect-kind member → no chip', () => {
    expect(stopCollectSummary(stopOf(
      withPrediction('a', 'auto_charge', 120),
      withPrediction('b', 'covered_membership', 0),
    ))).toEqual({ collectNeeded: false, amount: null });
    expect(stopCollectSummary(null)).toEqual({ collectNeeded: false, amount: null });
  });
});

describe('stopAccessIndicator', () => {
  it('counts alerts and flags chemical / no-card types', () => {
    const out = stopAccessIndicator([
      { type: 'gate', text: 'Gate code on file' },
      { type: 'chemical', text: 'Chemical sensitivity' },
      'Plain string alert',
    ]);
    expect(out).toEqual({ hasAlerts: true, count: 3, hasChemical: true, hasNoCard: false });
    expect(stopAccessIndicator([{ type: 'no_card_on_file', text: 'NO CARD ON FILE' }]).hasNoCard).toBe(true);
    expect(stopAccessIndicator([]).hasAlerts).toBe(false);
    expect(stopAccessIndicator(null).hasAlerts).toBe(false);
  });
});
