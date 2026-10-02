// Every portal request that captures a saved-payment-method consent attests
// the consent text version THIS bundle renders beside the checkbox (codex
// #5434 r1 P1): the mint, the save, and the consent_accepted retries on
// Auto Pay enable / set-default. Requests that capture nothing keep their
// exact bodies.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_VERSION, consentAttestation, isConsentVersionStale } from '../lib/paymentMethodConsentText';

const clearNativeBadge = vi.fn(async () => {});
vi.mock('../native/nativeBadge', () => ({ clearNativeBadge: (...args) => clearNativeBadge(...args) }));

describe('api consent-version attestation', () => {
  let api; let calls;
  beforeEach(async () => {
    vi.resetModules();
    calls = [];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push({ url: String(url).replace(/^.*\/api/, ''), body: opts.body ? JSON.parse(opts.body) : null, method: opts.method || 'GET' });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    ({ default: api } = await import('./api.js'));
    api.setTokens('access-1', 'refresh-1');
  });

  it('consentAttestation is the bundle constant, and the stale code is recognizable', () => {
    expect(consentAttestation()).toEqual({ consentTextVersion: CONSENT_VERSION });
    expect(CONSENT_VERSION).toMatch(/^v\d+_\d{4}-\d{2}-\d{2}$/);
    expect(isConsentVersionStale({ code: 'CONSENT_VERSION_STALE' })).toBe(true);
    expect(isConsentVersionStale({ code: 'consent_required' })).toBe(false);
    expect(isConsentVersionStale(undefined)).toBe(false);
  });

  it('the add-method mint and save both attest', async () => {
    await api.createSetupIntent('card_or_bank');
    await api.saveStripeCard('pm_1', 'si_1');
    expect(calls).toEqual([
      { url: '/billing/cards/setup-intent', method: 'POST', body: { paymentMethodType: 'card_or_bank', consentTextVersion: CONSENT_VERSION } },
      { url: '/billing/cards', method: 'POST', body: { paymentMethodId: 'pm_1', setupIntentId: 'si_1', consentTextVersion: CONSENT_VERSION } },
    ]);
  });

  it('a consent_accepted retry attests; a plain Auto Pay change or default swap does not', async () => {
    await api.updateAutopay({ autopay_enabled: false });
    await api.updateAutopay({ autopay_enabled: true, autopay_payment_method_id: 'pm-row', consent_accepted: true });
    await api.setDefaultCard('pm-row');
    await api.setDefaultCard('pm-row', { consent_accepted: true });
    expect(calls.map((c) => c.body)).toEqual([
      { autopay_enabled: false },
      { autopay_enabled: true, autopay_payment_method_id: 'pm-row', consent_accepted: true, consentTextVersion: CONSENT_VERSION },
      null,
      { consent_accepted: true, consentTextVersion: CONSENT_VERSION },
    ]);
  });
});
