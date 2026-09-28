import { describe, expect, test } from 'vitest';
import { microdepositDetailFromNextAction, microdepositGuidance, microdepositSavedPhrases } from './microdeposit';

// Fixed future/past instants relative to nothing — guidance derives "passed"
// from the real clock via isInvoiceDueDateOverdue, so build them dynamically.
const DAY = 86400;
const nowSecs = Math.floor(Date.now() / 1000);

describe('microdepositDetailFromNextAction', () => {
  test('normalizes Stripe snake_case into the server 409 detail shape', () => {
    expect(microdepositDetailFromNextAction({
      microdeposit_type: 'descriptor_code',
      hosted_verification_url: 'https://payments.stripe.com/microdeposit/pacs_x',
      arrival_date: 1786690800,
    })).toEqual({
      microdepositType: 'descriptor_code',
      hostedVerificationUrl: 'https://payments.stripe.com/microdeposit/pacs_x',
      arrivalDate: 1786690800,
    });
  });

  test('degrades missing fields to nulls (never throws on empty input)', () => {
    expect(microdepositDetailFromNextAction()).toEqual({
      microdepositType: null,
      hostedVerificationUrl: null,
      arrivalDate: null,
    });
  });
});

describe('microdepositGuidance', () => {
  test('descriptor_code gets the one-deposit SM-code copy', () => {
    const g = microdepositGuidance({ microdepositType: 'descriptor_code' });
    expect(g.depositSentence).toContain('one small deposit');
    expect(g.depositSentence).toContain('SM');
  });

  test('amounts gets the two-deposit copy', () => {
    const g = microdepositGuidance({ microdepositType: 'amounts' });
    expect(g.depositSentence).toContain('two small deposits');
  });

  test('unknown type falls back to neutral copy and a generic window', () => {
    const g = microdepositGuidance({});
    expect(g.depositSentence).toContain('a small deposit (or two)');
    expect(g.windowLabel).toBe('in the next 1–2 business days');
    expect(g.verifyUrl).toBeNull();
  });

  test('future arrival renders "by <date>"; past arrival renders "by now"', () => {
    const future = microdepositGuidance({ arrivalDate: nowSecs + 5 * DAY });
    expect(future.windowLabel).toMatch(/^by [A-Z]/);
    const past = microdepositGuidance({ arrivalDate: nowSecs - 5 * DAY });
    expect(past.windowLabel).toBe('by now');
  });

  test('only Stripe-hosted verification URLs pass; anything else is dropped', () => {
    expect(microdepositGuidance({
      hostedVerificationUrl: 'https://payments.stripe.com/microdeposit/pacs_ok',
    }).verifyUrl).toBe('https://payments.stripe.com/microdeposit/pacs_ok');
    expect(microdepositGuidance({
      hostedVerificationUrl: 'https://evil.example.com/phish',
    }).verifyUrl).toBeNull();
    expect(microdepositGuidance({ hostedVerificationUrl: 42 }).verifyUrl).toBeNull();
  });
});

describe('microdepositSavedPhrases', () => {
  test('names one deposit and its SM code for descriptor_code', () => {
    const p = microdepositSavedPhrases('descriptor_code');
    expect(p.deposits).toBe('one small deposit');
    expect(p.confirmStep).toMatch(/6-character code starting with “SM”/);
  });

  test('names two deposits and their amounts for amounts', () => {
    expect(microdepositSavedPhrases('amounts')).toEqual({
      deposits: 'two small deposits',
      confirmStep: 'confirm the two amounts',
      linkLabel: 'Confirm the deposits here',
      arrival: 'once they arrive',
      actionLabel: 'Confirm the deposits',
    });
  });

  test('the verify link is singular for one deposit and neutral when the type is unknown (Codex r1)', () => {
    expect(microdepositSavedPhrases('descriptor_code')).toMatchObject({ linkLabel: 'Enter the code here', arrival: 'once it arrives' });
    expect(microdepositSavedPhrases(null).linkLabel).not.toMatch(/deposits/);
    expect(microdepositSavedPhrases(null).arrival).toBe('when the deposit information appears');
    // The step itself stays number-neutral when there may be two deposits (Codex r4).
    expect(microdepositSavedPhrases(null).confirmStep).toBe('verify your account');
    // A saved bank row doesn't know Stripe's type: its button stays neutral (Codex r3).
    expect(microdepositSavedPhrases(null).actionLabel).toBe('Verify your account');
    expect(microdepositSavedPhrases('descriptor_code').actionLabel).toBe('Enter the code');
  });

  test('stays true for either kind when the type is unknown', () => {
    for (const type of [null, undefined, 'something_new']) {
      const p = microdepositSavedPhrases(type);
      expect(p.deposits).toBe('a small deposit (or two)');
      expect(p.deposits).not.toMatch(/^two/);
      expect(p.arrival).toBe('when the deposit information appears');
      expect(p.arrival).not.toMatch(/\bit\b|\bthey\b/);
    }
  });
});
