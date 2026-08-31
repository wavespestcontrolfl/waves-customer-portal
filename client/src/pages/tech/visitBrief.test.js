import { describe, expect, it } from 'vitest';
import {
  fmtMoney,
  prepaidLine,
  quotedLineLabel,
  shortAddress,
  smsHref,
  stopAccessIndicator,
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
  it('names annual-prepay coverage without a number (stamp amount is non-authoritative)', () => {
    expect(prepaidLine({ prepaidAmount: 999, prepaidMethod: 'annual_prepay_invoice' })).toBe('Annual prepay on file');
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
    expect(quotedLineLabel({ price: 300 })).toBe('$300 one-time');
    expect(quotedLineLabel({})).toBe(null);
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
