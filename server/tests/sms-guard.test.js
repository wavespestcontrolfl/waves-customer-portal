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
      'Hello Linda, your Waves auto-pay authorization has been cancelled as of May 29. Your saved payment method will not be used for future automatic charges.',
      { messageType: 'autopay_authorization_cancelled', now: new Date('2026-05-29T12:00:00-04:00') },
    );

    expect(result).toEqual({ ok: true });
  });
});
