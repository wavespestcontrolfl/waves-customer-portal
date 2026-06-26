const { validateOutbound } = require('../services/sms-guard');

describe('sms-guard outbound validation', () => {
  test('blocks WaveGuard auto-pay pre-charge reminder copy', () => {
    const result = validateOutbound(
      'Hello Linda! Your WaveGuard auto-pay will process on June 1. Need to update your card or pause? Log into your Waves Customer Portal at portal.wavespestcontrol.com.',
      { messageType: 'autopay_pre_charge', now: new Date('2026-05-29T12:00:00-04:00') },
    );

    expect(result).toEqual({
      ok: false,
      reason: 'blocked-autopay-pre-charge-waveguard',
    });
  });

  test('allows other autopay notices without the blocked pre-charge wording', () => {
    const result = validateOutbound(
      'Hello Linda! Your payment of $129 still did not go through. We will try again in a few days, or you can update your card here: portal.wavespestcontrol.com.',
      { messageType: 'autopay_retry_failed', now: new Date('2026-05-29T12:00:00-04:00') },
    );

    expect(result).toEqual({ ok: true });
  });

  describe('month names no longer block sends', () => {
    const NOW = new Date('2026-06-16T12:00:00-04:00'); // June
    const APRIL_BODY =
      'Hello Mike, our notes show Adam visited your property back in April while you were building your pool and set up a future date for service.';

    test('allows a month >1 calendar month from today on an automated template send', () => {
      // The stale-month guard has been removed; a month name that used to be
      // rejected as a stale render now passes.
      const result = validateOutbound(APRIL_BODY, {
        messageType: 'service_complete',
        now: NOW,
      });
      expect(result).toEqual({ ok: true });
    });

    test('allows a month name on an AI-drafted send', () => {
      const result = validateOutbound(APRIL_BODY, {
        messageType: 'ai_assistant',
        now: NOW,
      });
      expect(result).toEqual({ ok: true });
    });

    test('still catches broken-render and unsubbed-variable even with a month name present', () => {
      expect(
        validateOutbound('Hi {first_name}, see you in April.', { now: NOW }),
      ).toEqual({ ok: false, reason: 'unsubstituted-variable:{first_name}' });

      expect(
        validateOutbound('Hi undefined, see you in April.', { now: NOW }),
      ).toEqual({ ok: false, reason: 'broken-render:undefined' });
    });
  });
});
