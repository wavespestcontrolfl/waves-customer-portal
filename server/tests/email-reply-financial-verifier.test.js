const verifier = require('../services/email/email-reply-financial-verifier');

const { verifyEmailReplyAmountsAndStatuses, sentences, factLanguage, financialFactKeys } = verifier;

function contextWith(overrides = {}) {
  const facts = [
    { key: 'outstanding_balance', status: 'present', value: '75.00' },
    { key: 'open_invoice', status: 'present', value: { title: 'Quarterly service', amountDue: 120, status: 'sent' } },
    { key: 'payer_billed_invoice', status: 'absent', value: false },
    { key: 'recent_payment', status: 'present', value: { amount: 50, status: 'failed' } },
    { key: 'pending_estimate', status: 'present', value: { status: 'draft', sentAt: null } },
    { key: 'billing_lane', status: 'present', value: { monthlyBilled: true, monthlyDues: {
      base: 98, surcharge: 2.84, total: 100.84, surcharged: true, basis: 'credit_card_surcharge',
    } } },
  ];
  return { facts: overrides.facts || facts, ...overrides };
}

function verdict(text, context = contextWith()) {
  return verifyEmailReplyAmountsAndStatuses({ text, context });
}

function replaceFact(key, replacement) {
  return contextWith().facts.map((fact) => (fact.key === key ? replacement(fact) : fact));
}

describe('email reply financial verifier', () => {
  test('exports only the partial financial API and has no runtime caller', () => {
    expect(verifier).toEqual({ verifyEmailReplyAmountsAndStatuses, sentences, factLanguage, financialFactKeys });
    expect(verifier.verifyEmailReply).toBeUndefined();
  });

  test('dotted meridiems stay attached to the financial status sentence', () => {
    const text = 'Your $50 payment at 9 a.m. was received.';
    expect(sentences(text)).toEqual(['Your $50 payment at 9 am was received.']);
    expect(verdict(text).violations).toContain('payment_status_unsupported');
  });

  test('shared financial classification limits monthly to billing phrases', () => {
    expect(financialFactKeys('Your monthly appointment is September 15.')).not.toContain('billing_lane');
    expect(financialFactKeys('Your monthly dues are listed.')).toContain('billing_lane');
    expect(financialFactKeys('Your monthly charge is listed.')).toContain('billing_lane');
  });

  test('does not claim to validate dates, scheduling, or reply structure', () => {
    expect(verdict('Your $50 payment failed on February 31, 2099.')).toEqual({ ok: true, violations: [] });
    expect(verdict('<b>Your appointment is confirmed at midnight.</b>')).toEqual({ ok: true, violations: [] });
  });

  test('binds recognized amounts to their named financial fact', () => {
    expect(verdict('Your outstanding balance is $75. Your invoice amount is $120. Your payment was $50.').ok).toBe(true);
    expect(verdict('Your outstanding balance is $50.').violations).toContain('amount_unsupported:$50');
    expect(verdict('Your invoice amount is $75.').violations).toContain('amount_unsupported:$75');
    expect(verdict('Your payment was $120.').violations).toContain('amount_unsupported:$120');
    expect(verdict('The estimate is $999.').violations).toContain('amount_unsupported:$999');
    expect(verdict('The price is $98.').violations).toContain('amount_unsupported:$98');
  });

  test('accepts strict numeric currency forms', () => {
    const facts = replaceFact('outstanding_balance', (fact) => ({ ...fact, value: 1234.56 }));
    expect(verdict('Your outstanding balance is $1,234.56.', contextWith({ facts })).ok).toBe(true);
    expect(verdict('Your outstanding balance is 1,234.56 dollars.', contextWith({ facts })).ok).toBe(true);
    expect(verdict('Your outstanding balance is $1234.56.', contextWith({ facts })).ok).toBe(true);
  });

  test('rejects malformed, signed, written, and magnitude currency forms', () => {
    const cases = [
      '$75.999', '$75.99.9', '$1,20', '1,20 dollars',
      '-$75', '- 75 dollars', '− $75', '$ − 75', '+$75',
      'fifty dollars', '$75k', '$75 million', '75 thousand dollars',
    ];
    for (const amount of cases) {
      expect(verdict(`Your outstanding balance is ${amount}.`).violations)
        .toContain(`amount_unsupported:${amount}`);
    }
    expect(verdict('Your outstanding balance is $75.').ok).toBe(true);
  });

  test('rejects multiple amounts in one sentence', () => {
    expect(verdict('Your balance is $75 and your balance was $75.').violations)
      .toContain('multiple_amounts_unsupported');
    expect(verdict('Your balance is $75. Your invoice amount is $120.').ok).toBe(true);
  });

  test('keeps financial categories separate within a sentence', () => {
    expect(verdict('Your $50 payment applies to the invoice.').violations)
      .toContain('mixed_fact_categories_unsupported');
    expect(verdict('Your $50 payment failed. Your invoice is sent.').ok).toBe(true);
  });

  test('binds monthly dues base, surcharge, and total to assembled fields', () => {
    expect(verdict('Your base monthly dues are $98. The card surcharge is $2.84. Your total monthly charge is $100.84.').ok)
      .toBe(true);
    expect(verdict('Your monthly dues are $100.84.').violations).toContain('amount_unsupported:$100.84');
    expect(verdict('Your total monthly charge is $98.').violations).toContain('amount_unsupported:$98');
    expect(verdict('Your total monthly charge including the card surcharge is $100.84.').violations)
      .toContain('amount_unsupported:$100.84');
  });

  test('withheld dues quotes expose only a strict non-null base', () => {
    const withheld = replaceFact('billing_lane', (fact) => ({ ...fact, value: { ...fact.value, monthlyDues: {
      base: 98, surcharge: 0, total: null, surcharged: false, basis: 'method_unknown',
    } } }));
    expect(verdict('Your monthly dues are $98.', contextWith({ facts: withheld })).ok).toBe(true);
    expect(verdict('Your card surcharge is $0.', contextWith({ facts: withheld })).violations)
      .toContain('amount_unsupported:$0');
    expect(verdict('Your total monthly charge is $100.84.', contextWith({ facts: withheld })).violations)
      .toContain('amount_unsupported:$100.84');
    const missingBase = withheld.map((fact) => (fact.key === 'billing_lane'
      ? { ...fact, value: { ...fact.value, monthlyDues: { ...fact.value.monthlyDues, base: null } } }
      : fact));
    expect(verdict('Your monthly dues are $0.', contextWith({ facts: missingBase })).violations)
      .toContain('amount_unsupported:$0');
  });

  test('accepts an assembled resolved zero-surcharge quote without recomputing it', () => {
    const facts = replaceFact('billing_lane', (fact) => ({ ...fact, value: { ...fact.value, monthlyDues: {
      base: 98, surcharge: 0, total: 98, surcharged: false, basis: 'no_surcharge',
    } } }));
    expect(verdict('Your card surcharge is $0. Your total monthly charge is $98.', contextWith({ facts })).ok).toBe(true);
    const nonMonthly = facts.map((fact) => (fact.key === 'billing_lane'
      ? { ...fact, value: { ...fact.value, monthlyBilled: false } }
      : fact));
    expect(verdict('Your monthly dues are $98.', contextWith({ facts: nonMonthly })).violations)
      .toContain('amount_unsupported:$98');
  });

  test.each(['failed', 'pending', 'processing', 'refunded', 'reversed', 'canceled', 'voided', 'overdue'])(
    'payment state claims match the recorded %s state', (status) => {
      const facts = replaceFact('recent_payment', (fact) => ({ ...fact, value: { ...fact.value, status } }));
      expect(verdict(`Your $50 payment is ${status}.`, contextWith({ facts })).ok).toBe(true);
      const mismatch = status === 'failed' ? 'overdue' : 'failed';
      expect(verdict(`Your $50 payment is ${mismatch}.`, contextWith({ facts })).violations)
        .toContain('payment_status_unsupported');
    },
  );

  test('overdue payment status retains plural handling', () => {
    const facts = replaceFact('recent_payment', (fact) => ({ ...fact, value: { ...fact.value, status: 'overdue' } }));
    expect(verdict('Your payments are overdue.', contextWith({ facts })).ok).toBe(true);
    expect(verdict('Your payments failed.', contextWith({ facts })).violations).toContain('payment_status_unsupported');
  });

  test.each(['succeeded', 'completed', 'paid', 'processed', 'received'])(
    'successful payment wording requires the recorded %s status', (status) => {
      const facts = replaceFact('recent_payment', (fact) => ({ ...fact, value: { ...fact.value, status } }));
      expect(verdict('Your $50 payment was received.', contextWith({ facts })).ok).toBe(true);
      expect(verdict('Your $50 payment was received.').violations).toContain('payment_status_unsupported');
    },
  );

  test('ambiguous matching payments cannot lend a successful status', () => {
    const facts = contextWith().facts.concat({
      key: 'recent_payment', status: 'present', value: { amount: 50, status: 'succeeded' },
    });
    expect(verdict('Your $50 payment was received.', contextWith({ facts })).violations)
      .toContain('payment_status_unsupported');
  });

  test('invoice state claims match the authoritative invoice state', () => {
    expect(verdict('Your invoice is sent.').ok).toBe(true);
    for (const state of ['overdue', 'cancelled', 'paid']) {
      expect(verdict(`Your invoice is ${state}.`).violations).toContain('invoice_status_unsupported');
    }
    const facts = replaceFact('open_invoice', (fact) => ({ ...fact, value: { ...fact.value, status: 'overdue' } }));
    expect(verdict('Your invoices are overdue.', contextWith({ facts })).ok).toBe(true);
    expect(verdict('Your invoices are sent.', contextWith({ facts })).violations).toContain('invoice_status_unsupported');
    expect(verdict('Your paid invoice.').violations).not.toContain('payment_status_unsupported');
    expect(verdict('Your invoice payment failed.').ok).toBe(true);
  });

  test.each([
    ['draft', 'draft'], ['scheduled', 'scheduled'], ['sending', 'sending'], ['send_failed', 'send failed'],
    ['viewed', 'viewed'], ['accepted', 'accepted'], ['declined', 'declined'], ['expired', 'expired'],
  ])('estimate state claims match the recorded %s state', (status, wording) => {
    const facts = replaceFact('pending_estimate', (fact) => ({ ...fact, value: { status, sentAt: '2026-09-09T16:00:00Z' } }));
    expect(verdict(`Your estimates are ${wording}.`, contextWith({ facts })).ok).toBe(true);
    const mismatch = status === 'accepted' ? 'declined' : 'accepted';
    expect(verdict(`Your estimate is ${mismatch}.`, contextWith({ facts })).violations)
      .toContain('estimate_status_unsupported');
  });

  test('sent estimate wording requires sent evidence', () => {
    const viewed = replaceFact('pending_estimate', (fact) => ({ ...fact, value: {
      status: 'viewed', sentAt: '2026-09-09T16:00:00Z',
    } }));
    expect(verdict('We sent your estimate.', contextWith({ facts: viewed })).ok).toBe(true);
    expect(verdict('We sent your estimate.').violations).toContain('estimate_status_unsupported');
  });

  test('rejects negated monetary and financial status claims', () => {
    for (const claim of [
      'Your balance is not $75', 'You do not owe $75', 'Your monthly dues are not $98',
      'Your payment has not been received', 'Your invoice is not overdue', 'Your estimate was not accepted',
    ]) {
      expect(verdict(`${claim}.`).violations).toContain('negated_status_unsupported');
    }
  });

  test('positive and zero balance claims require matching authoritative balance', () => {
    expect(verdict('You have an outstanding balance.').ok).toBe(true);
    expect(verdict('There is a balance due on your account.').ok).toBe(true);
    const zero = replaceFact('outstanding_balance', (fact) => ({ ...fact, value: 0 }));
    expect(verdict('You have an outstanding balance.', contextWith({ facts: zero })).violations)
      .toContain('balance_status_unsupported');
    expect(verdict('Your outstanding balance is $0.', contextWith({ facts: zero })).ok).toBe(true);
    expect(verdict('You have no outstanding balance.', contextWith({ facts: zero })).ok).toBe(true);
    expect(verdict('Your account is paid in full.', contextWith({ facts: zero })).ok).toBe(true);
    expect(verdict('You have no outstanding balance.').violations).toContain('balance_status_unsupported');
    expect(verdict('Your account is paid in full.').violations).toContain('balance_status_unsupported');
    const unavailable = replaceFact('outstanding_balance', (fact) => ({ ...fact, status: 'unavailable', value: null }));
    expect(verdict('There is a balance due on your account.', contextWith({ facts: unavailable })).violations)
      .toContain('balance_status_unsupported');
  });

  test('collection requests require one customer-owned collectible invoice and an explicit clear payer flag', () => {
    for (const request of [
      'Please pay the invoice.', 'You need to pay your invoice.', 'You must pay your invoice.',
      'Please settle your $120 invoice.',
    ]) {
      expect(verdict(request).ok).toBe(true);
    }
    const payerOnly = contextWith().facts.filter((fact) => fact.key !== 'open_invoice').map((fact) => (
      fact.key === 'payer_billed_invoice' ? { ...fact, status: 'present', value: true } : fact
    )).concat({ key: 'open_invoice', status: 'absent', value: null });
    for (const request of ['Please pay the invoice.', 'You need to pay your invoice.', 'You must pay your invoice.']) {
      expect(verdict(request, contextWith({ facts: payerOnly })).violations)
        .toContain('collection_request_unsupported');
    }
    const ambiguous = replaceFact('payer_billed_invoice', (fact) => ({ ...fact, status: 'present', value: true }));
    expect(verdict('Please pay the invoice.', contextWith({ facts: ambiguous })).violations)
      .toContain('collection_request_unsupported');
    const missingFlag = contextWith().facts.filter((fact) => fact.key !== 'payer_billed_invoice');
    expect(verdict('Please pay the invoice.', contextWith({ facts: missingFlag })).violations)
      .toContain('collection_request_unsupported');
  });

  test('collection requests require a positive amount and canonical collectible status', () => {
    for (const value of [{ amountDue: 0, status: 'sent' }, { amountDue: 120, status: 'paid' }]) {
      const facts = replaceFact('open_invoice', (fact) => ({ ...fact, value: { ...fact.value, ...value } }));
      expect(verdict('Please pay the invoice.', contextWith({ facts })).violations)
        .toContain('collection_request_unsupported');
    }
    expect(verdict('Your invoice is available for review.', contextWith({ facts: [] })).ok).toBe(true);
  });
});
