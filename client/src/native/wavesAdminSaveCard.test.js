// @vitest-environment jsdom

// The staff half of the Tap to Pay card save at the table: the Waves Admin app calls
// window.wavesAdminSaveCardHandoff from the customer hand-off, and the staff page mints
// the save-card link under the staff sign-in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

import { adminFetch } from '../lib/adminFetch';
import { registerSaveCardRelay } from './wavesAdminSaveCard';

const ARGS = {
  secureToken: 'tok_secure',
  consentTextVersion: 'v12_2026-09-30',
  agreed: true,
  feeDisclosedAmount: 25,
  disclosureVersion: 'sticky_v1',
};

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function installApp() {
  window.webkit = { messageHandlers: { wavesAdmin: { postMessage: vi.fn() } } };
}

beforeEach(() => {
  adminFetch.mockReset();
});

afterEach(() => {
  delete window.webkit;
  delete window.wavesAdminSaveCardHandoff;
});

describe('registerSaveCardRelay', () => {
  it('defines nothing in a browser', () => {
    const cleanup = registerSaveCardRelay();
    expect(window.wavesAdminSaveCardHandoff).toBeUndefined();
    expect(() => cleanup()).not.toThrow();
  });

  it('defines the relay in the app and removes it on cleanup', () => {
    installApp();
    const cleanup = registerSaveCardRelay();
    expect(typeof window.wavesAdminSaveCardHandoff).toBe('function');
    cleanup();
    expect(window.wavesAdminSaveCardHandoff).toBeUndefined();
  });

  it('maps the app args to the mint body and returns the deep link', async () => {
    installApp();
    registerSaveCardRelay();
    adminFetch.mockResolvedValue(reply(200, { token: 't', deep_link: 'wavespay://save-card?t=abc', jti: 'j', expires_at: 'x' }));
    const out = await window.wavesAdminSaveCardHandoff(ARGS);
    expect(adminFetch).toHaveBeenCalledWith('/stripe/terminal/save-card-handoff', {
      method: 'POST',
      body: {
        secure_token: 'tok_secure',
        consent_text_version: 'v12_2026-09-30',
        agreed: true,
        fee_disclosed_amount: 25,
        disclosure_version: 'sticky_v1',
      },
    });
    expect(out).toEqual({ deep_link: 'wavespay://save-card?t=abc' });
  });

  it('omits a fee and a disclosure version the page did not have, and never sends agreed unless exactly true', async () => {
    installApp();
    registerSaveCardRelay();
    adminFetch.mockResolvedValue(reply(200, { deep_link: 'wavespay://save-card?t=abc' }));
    await window.wavesAdminSaveCardHandoff({ ...ARGS, feeDisclosedAmount: null, disclosureVersion: null, agreed: 'yes' });
    const { body } = adminFetch.mock.calls[0][1];
    expect(body.agreed).toBe(false);
    expect(body.fee_disclosed_amount).toBeUndefined();
    expect(body.disclosure_version).toBeUndefined();
  });

  it('says the card tap is not on yet when the mint answers 404 (gate off)', async () => {
    installApp();
    registerSaveCardRelay();
    adminFetch.mockResolvedValue(reply(404, { error: 'Not found' }));
    const out = await window.wavesAdminSaveCardHandoff(ARGS);
    expect(out).toEqual({ message: expect.stringMatching(/not turned on yet/i) });
  });

  it('passes the server text for a 409 or 400 refusal', async () => {
    installApp();
    registerSaveCardRelay();
    adminFetch.mockResolvedValueOnce(reply(409, { error: 'This card request is no longer open.', code: 'request_not_pending' }));
    expect(await window.wavesAdminSaveCardHandoff(ARGS)).toEqual({ message: 'This card request is no longer open.' });
    adminFetch.mockResolvedValueOnce(reply(400, { error: 'The customer must agree before the card is saved', code: 'consent_required' }));
    expect(await window.wavesAdminSaveCardHandoff(ARGS)).toEqual({ message: 'The customer must agree before the card is saved' });
  });

  it('gives a plain retry message for a sign-in refusal, a server error, an odd body or no connection', async () => {
    installApp();
    registerSaveCardRelay();
    for (const answer of [reply(401, { error: 'Unauthorized' }), reply(403, { error: 'Admin only' }), reply(500, { error: 'Handoff mint failed' }), reply(409, {}), reply(200, {})]) {
      adminFetch.mockResolvedValueOnce(answer);
      expect(await window.wavesAdminSaveCardHandoff(ARGS)).toEqual({ message: expect.stringMatching(/hand the phone back and try again/i) });
    }
    adminFetch.mockRejectedValueOnce(new TypeError('offline'));
    expect(await window.wavesAdminSaveCardHandoff(ARGS)).toEqual({ message: expect.stringMatching(/try again/i) });
  });
});
