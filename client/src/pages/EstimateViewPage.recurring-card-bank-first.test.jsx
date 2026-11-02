// @vitest-environment jsdom
// Bank first (owner 2026-11-01, option A): the estimate page's Auto Pay capture
// modal (RecurringCardModal) creates its Payment Element with US bank account
// first and starts on bank when the intent offers it — heading, body copy,
// consent text and save button match the first tab at mount, no change event.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created = [];
vi.mock('../lib/stripeLoader', () => ({
  loadStripeSdk: vi.fn(async () => () => ({
    elements: () => ({
      create: (type, opts) => {
        created.push({ type, opts });
        return { mount: vi.fn(), update: vi.fn(), on: vi.fn() };
      },
    }),
    retrieveSetupIntent: vi.fn(),
    confirmSetup: vi.fn(),
  })),
}));

import { RecurringCardModal } from './EstimateViewPage';
import { ACH_CONSENT_TEXT, CARD_CONSENT_TEXT } from '../lib/paymentMethodConsentText';

const flush = () => act(() => Promise.resolve());
const INTENT = { clientSecret: 'seti_secret_1', publishableKey: 'pk_test_1' };

beforeEach(() => { created.length = 0; window.scrollTo = vi.fn(); });
afterEach(() => cleanup());

describe('RecurringCardModal bank first', () => {
  it('bank offered: bank-first element order; bank copy, ACH consent and save button at mount', async () => {
    const { container } = render(
      <RecurringCardModal intent={{ ...INTENT, paymentMethodTypes: ['card', 'us_bank_account'] }} onSuccess={vi.fn()} onCancel={vi.fn()} />,
    );
    await flush();
    expect(created[0].type).toBe('payment');
    expect(created[0].opts.paymentMethodOrder).toEqual(['us_bank_account', 'card']);
    expect(screen.getByRole('button', { name: 'Agree & save bank account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agree & save card' })).toBeNull();
    expect(container.textContent).toContain(ACH_CONSENT_TEXT);
    expect(container.textContent).not.toContain(CARD_CONSENT_TEXT);
    expect(container.textContent).toContain('Save your bank account to confirm your recurring plan');
  });

  it('bank NOT offered: card copy, card consent and card save button at mount', async () => {
    const { container } = render(
      <RecurringCardModal intent={{ ...INTENT, paymentMethodTypes: ['card'] }} onSuccess={vi.fn()} onCancel={vi.fn()} />,
    );
    await flush();
    expect(screen.getByRole('button', { name: 'Agree & save card' })).toBeInTheDocument();
    expect(container.textContent).toContain(CARD_CONSENT_TEXT);
    expect(container.textContent).not.toContain(ACH_CONSENT_TEXT);
  });

  it('a replay keeps its captured tender', async () => {
    render(
      <RecurringCardModal
        intent={{ ...INTENT, setupIntentId: 'seti_1', paymentMethodTypes: ['card', 'us_bank_account'], capturedMethodType: 'card' }}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
        onReplace={vi.fn()}
      />,
    );
    await flush();
    expect(screen.getByRole('button', { name: 'Agree & continue with saved card' })).toBeInTheDocument();
    expect(created).toHaveLength(0);
  });
});
