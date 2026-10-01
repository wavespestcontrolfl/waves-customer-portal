// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InlineAutoPayCapture from './InlineAutoPayCapture';
import { AFTER_VISIT_CARD_CONSENT_TEXT, CARD_CONSENT_TEXT } from '../../lib/paymentMethodConsentText';

afterEach(() => cleanup());

const flush = () => act(() => Promise.resolve());

function makeStripeStub() {
  const calls = { elementsCreated: 0, mounts: 0 };
  const StripeCtor = vi.fn(() => ({
    elements: vi.fn(() => {
      calls.elementsCreated += 1;
      return {
        create: vi.fn(() => ({
          mount: vi.fn(() => { calls.mounts += 1; }),
          on: vi.fn(),
        })),
      };
    }),
    retrieveSetupIntent: vi.fn(),
    confirmSetup: vi.fn(),
  }));
  return { StripeCtor, calls };
}

const INTENT = { clientSecret: 'seti_secret_1', publishableKey: 'pk_test_1' };

describe('InlineAutoPayCapture Payment Element lifecycle', () => {
  // Regression: SecureAppointmentPage passes `intent` as an inline object
  // literal, so its identity changes on EVERY parent render (capture-state
  // emits, the busy flip during save). If the mount effect keys on identity
  // instead of values, each re-render replaces the filled Payment Element
  // with an empty one and confirmSetup fails "Your card number is
  // incomplete" — which is exactly what happened to every /secure/:token
  // customer through 2026-07-29.
  it('does NOT remount when the intent prop is a new object with the same values', async () => {
    const { StripeCtor, calls } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));

    const { rerender } = render(
      <InlineAutoPayCapture intent={{ ...INTENT }} loadStripeSdk={loadStripeSdk} />,
    );
    await flush();
    expect(calls.mounts).toBe(1);

    // Same values, fresh identity — mimics a parent re-render with an inline
    // literal (ready emit, agreed emit, busy flip).
    rerender(<InlineAutoPayCapture intent={{ ...INTENT }} loadStripeSdk={loadStripeSdk} busy />);
    await flush();
    rerender(<InlineAutoPayCapture intent={{ ...INTENT }} loadStripeSdk={loadStripeSdk} />);
    await flush();

    expect(calls.mounts).toBe(1);
    expect(calls.elementsCreated).toBe(1);
  });

  it('DOES remount when the clientSecret actually changes', async () => {
    const { StripeCtor, calls } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));

    const { rerender } = render(
      <InlineAutoPayCapture intent={{ ...INTENT }} loadStripeSdk={loadStripeSdk} />,
    );
    await flush();
    expect(calls.mounts).toBe(1);

    rerender(
      <InlineAutoPayCapture
        intent={{ clientSecret: 'seti_secret_2', publishableKey: 'pk_test_1' }}
        loadStripeSdk={loadStripeSdk}
      />,
    );
    await flush();

    expect(calls.mounts).toBe(2);
  });
});

// GATE_ACCEPT_ACH_CAPTURE: when the intent allows us_bank_account and the
// customer picks the bank tab, the rendered authorization must be the ACH
// text (the server snapshots the ACH consent for a bank method) and the
// checkbox must re-arm — a card consent tick must never carry over to a
// bank debit authorization.
describe('InlineAutoPayCapture tender-aware consent', () => {
  function makeTenderStub() {
    const handlers = {};
    const StripeCtor = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => ({
          mount: vi.fn(),
          on: vi.fn((event, handler) => { handlers[event] = handler; }),
        })),
      })),
      retrieveSetupIntent: vi.fn(),
      confirmSetup: vi.fn(),
    }));
    return { StripeCtor, handlers };
  }

  it('switches to the ACH authorization when the Payment Element reports us_bank_account', async () => {
    const { StripeCtor, handlers } = makeTenderStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const onStateChange = vi.fn();
    const { getByText, getByRole, queryByText } = render(
      <InlineAutoPayCapture
        intent={{ ...INTENT, paymentMethodTypes: ['card', 'us_bank_account'] }}
        loadStripeSdk={loadStripeSdk}
        onStateChange={onStateChange}
      />,
    );
    await flush();
    expect(getByText(/charge this card after each completed service/)).toBeInTheDocument();

    const checkbox = getByRole('checkbox');
    await act(async () => { checkbox.click(); });
    expect(checkbox).toBeChecked();

    await act(async () => { handlers.change({ value: { type: 'us_bank_account' } }); });
    expect(getByText(/debit this bank account after each completed service/)).toBeInTheDocument();
    expect(queryByText(/charge this card after each completed service/)).toBeNull();
    expect(checkbox).not.toBeChecked();
    // The parent's summary + confirm label follow the tender via the emit.
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ methodType: 'us_bank_account', agreed: false }));

    await act(async () => { getByText('View full terms').click(); });
    expect(getByText(/initiate electronic ACH debits/)).toBeInTheDocument();
  });

  it('initializes to the captured tender on a succeeded replay so the ACH consent renders without a change event', async () => {
    const { StripeCtor } = makeTenderStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText } = render(
      <InlineAutoPayCapture
        intent={{ ...INTENT, paymentMethodTypes: ['card', 'us_bank_account'], capturedMethodType: 'us_bank_account' }}
        loadStripeSdk={loadStripeSdk}
      />,
    );
    await flush();
    expect(getByText(/debit this bank account after each completed service/)).toBeInTheDocument();
  });

  it('fails closed on a bank-capable succeeded replay whose captured tender is unknown', async () => {
    const handlers = {};
    const StripeCtor = vi.fn(() => ({
      elements: vi.fn(() => ({ create: vi.fn(() => ({ mount: vi.fn(), on: vi.fn((e, h) => { handlers[e] = h; }) })) })),
      retrieveSetupIntent: vi.fn(async () => ({ setupIntent: { id: 'seti_1', status: 'succeeded', payment_method_types: ['card', 'us_bank_account'] } })),
      confirmSetup: vi.fn(),
    }));
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const ref = React.createRef();
    const first = render(
      <InlineAutoPayCapture
        ref={ref}
        intent={{ ...INTENT, paymentMethodTypes: ['card', 'us_bank_account'] }}
        loadStripeSdk={loadStripeSdk}
        onReplace={vi.fn()}
      />,
    );
    await flush();
    await act(async () => { handlers.ready(); });
    // Consent must be ticked at confirm time (Codex r2: the tender is
    // locked to the one the box was ticked for).
    expect((await ref.current.confirmSetup()).error).toMatch(/authorization box/);
    await act(async () => { first.getByRole('checkbox').click(); });
    const result = await ref.current.confirmSetup();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refresh this page/);
    // The stale replay is not a dead end: the replace action appears.
    expect(first.getByText('Use a different payment method')).toBeInTheDocument();
    first.unmount();
    // With the tender resolved by the mint, the same replay passes through
    // on the server-named intent — no Payment Element, no retrieve.
    const ref2 = React.createRef();
    const second = render(
      <InlineAutoPayCapture
        ref={ref2}
        intent={{ ...INTENT, setupIntentId: 'seti_1', paymentMethodTypes: ['card', 'us_bank_account'], capturedMethodType: 'us_bank_account' }}
        loadStripeSdk={loadStripeSdk}
      />,
    );
    await flush();
    await act(async () => { second.getByRole('checkbox').click(); });
    // The tender the consent was rendered for rides the result (the page attests it).
    expect(await ref2.current.confirmSetup()).toEqual({ ok: true, setupIntentId: 'seti_1', methodType: 'us_bank_account' });
  });

  // "Use a different payment method" (customer report 2026-09-08): a
  // succeeded replay renders as a saved-method panel with a way out, instead
  // of a Payment Element on a finished intent that could only re-hand the
  // customer the first tender they saved.
  describe('succeeded replay → saved-method panel + replace', () => {
    const REPLAY = { ...INTENT, setupIntentId: 'seti_1', paymentMethodTypes: ['card', 'us_bank_account'], capturedMethodType: 'card' };

    it('mounts no Payment Element, reports ready, and hands the saved intent to confirm', async () => {
      const { StripeCtor, calls } = makeStripeStub();
      const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
      const onStateChange = vi.fn();
      const ref = React.createRef();
      const { getByText, getByRole } = render(
        <InlineAutoPayCapture ref={ref} intent={REPLAY} loadStripeSdk={loadStripeSdk} onStateChange={onStateChange} onReplace={vi.fn()} />,
      );
      await flush();
      expect(calls.mounts).toBe(0);
      expect(loadStripeSdk).not.toHaveBeenCalled();
      expect(getByText(/Your card is already saved for this plan/)).toBeInTheDocument();
      expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true, agreed: false, methodType: 'card' }));
      await act(async () => { getByRole('checkbox').click(); });
      expect(await ref.current.confirmSetup()).toEqual({ ok: true, setupIntentId: 'seti_1', methodType: 'card' });
    });

    it('offers "Use a different payment method" and passes the saved intent id to onReplace', async () => {
      const { StripeCtor } = makeStripeStub();
      const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
      const onReplace = vi.fn(async () => true);
      const { getByText } = render(
        <InlineAutoPayCapture intent={REPLAY} loadStripeSdk={loadStripeSdk} onReplace={onReplace} />,
      );
      await flush();
      await act(async () => { getByText('Use a different payment method').click(); });
      expect(onReplace).toHaveBeenCalledWith('seti_1');
    });

    it('surfaces a failed switch instead of leaving the customer stuck', async () => {
      const { StripeCtor } = makeStripeStub();
      const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
      const onReplace = vi.fn(async () => false);
      const { getByText, getByRole } = render(
        <InlineAutoPayCapture intent={REPLAY} loadStripeSdk={loadStripeSdk} onReplace={onReplace} />,
      );
      await flush();
      await act(async () => { getByText('Use a different payment method').click(); });
      expect(getByRole('alert')).toHaveTextContent(/could not switch your payment method/);
      expect(getByText('Use a different payment method')).not.toBeDisabled();
    });

    // A caller that resolves the tender but does not name the intent (the
    // /secure page shape before #4144) must keep the Payment Element path —
    // the replay panel can only hand back an id it was given (pre-push
    // Codex P1 r2).
    it('keeps the element path when the caller omits setupIntentId', async () => {
      const { StripeCtor, calls } = makeStripeStub();
      const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
      const { queryByText } = render(
        <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card', 'us_bank_account'], capturedMethodType: 'card' }} loadStripeSdk={loadStripeSdk} onReplace={vi.fn()} />,
      );
      await flush();
      expect(calls.mounts).toBe(1);
      expect(queryByText(/already saved for this plan/)).toBeNull();
    });

    it('hides the replace action when the parent offers none', async () => {
      const { StripeCtor } = makeStripeStub();
      const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
      const { queryByText } = render(<InlineAutoPayCapture intent={REPLAY} loadStripeSdk={loadStripeSdk} />);
      await flush();
      expect(queryByText('Use a different payment method')).toBeNull();
    });
  });

  it('keeps the card copy when the intent is card-only', async () => {
    const { StripeCtor, handlers } = makeTenderStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText } = render(
      <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card'] }} loadStripeSdk={loadStripeSdk} />,
    );
    await flush();
    await act(async () => { handlers.change({ value: { type: 'card' } }); });
    expect(getByText(/your card is charged that service’s amount automatically/)).toBeInTheDocument();
    expect(getByText(/remove your card anytime/)).toBeInTheDocument();
  });
});

// GATE_PAF_EXISTING_CUSTOMERS (PR-B): an existing customer on the
// pay-after-first-visit card rail agrees to the after_visit_card (v12)
// authorization — the same variant the accept records.
describe('InlineAutoPayCapture afterVisit consent', () => {
  const termsText = (container) => container.textContent;

  it('renders the after_visit_card full terms when afterVisit is set (card)', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText } = render(
      <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card'] }} loadStripeSdk={loadStripeSdk} afterVisit />,
    );
    await flush();
    await act(async () => { getByText('View full terms').click(); });
    expect(getByText(/after my first service visit is completed/)).toBeInTheDocument();
    expect(getByText(/Nothing is charged today\./)).toBeInTheDocument();
  });

  it('paused Auto Pay: says the card is kept and a pay link follows each service, and never promises a charge', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText, queryByText } = render(
      <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card'] }} loadStripeSdk={loadStripeSdk} paused />,
    );
    await flush();
    expect(getByText('Card on file — nothing charged today')).toBeInTheDocument();
    expect(getByText(/Your Auto Pay is paused, so we keep this card on file and send you a pay link after each completed service\./)).toBeInTheDocument();
    expect(getByText('I authorize Waves to save this card on file and charge it for future invoices as agreed — cancel anytime.')).toBeInTheDocument();
    expect(queryByText(/is charged that service/)).toBeNull();
  });

  it('r7: when the first invoice goes out at confirm (setup-only / timing denied), the held and Auto Pay copy say so', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const held = render(
      <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card'] }} loadStripeSdk={loadStripeSdk} paused firstInvoiceNow />,
    );
    await flush();
    expect(held.getByText(/^Your first invoice is sent when you confirm, with a link to pay it\. Your Auto Pay is paused/)).toBeInTheDocument();
    held.unmount();
    const plain = render(
      <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card'] }} loadStripeSdk={loadStripeSdk} firstInvoiceNow />,
    );
    await flush();
    expect(plain.getByText(/^Your first invoice is sent when you confirm, with a link to pay it\. After each completed service/)).toBeInTheDocument();
  });

  it('r9: a held customer saving a BANK account is told "Bank account on file", never "Card on file"', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText, queryByText } = render(
      <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card', 'us_bank_account'], capturedMethodType: 'us_bank_account', replay: true }} loadStripeSdk={loadStripeSdk} paused />,
    );
    await flush();
    expect(getByText('Bank account on file — nothing charged today')).toBeInTheDocument();
    expect(queryByText('Card on file — nothing charged today')).toBeNull();
  });

  it('explicit Auto Pay off: same held shape as paused with neutral wording (no "paused" claim, no automatic-charge promise)', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText, queryByText } = render(
      <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card'] }} loadStripeSdk={loadStripeSdk} autopayOff />,
    );
    await flush();
    expect(getByText('Card on file — nothing charged today')).toBeInTheDocument();
    expect(getByText(/We keep this card on file and send you a pay link after each completed service\./)).toBeInTheDocument();
    expect(queryByText(/paused/)).toBeNull();
    expect(queryByText(/is charged that service/)).toBeNull();
  });

  it('keeps the base card terms when afterVisit is not set (gate off byte-identical)', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText, queryByText, container } = render(
      <InlineAutoPayCapture intent={{ ...INTENT, paymentMethodTypes: ['card'] }} loadStripeSdk={loadStripeSdk} />,
    );
    await flush();
    await act(async () => { getByText('View full terms').click(); });
    expect(queryByText(/after my first service visit is completed/)).toBeNull();
    expect(termsText(container)).toContain('By checking this box');
  });
});

// GATE_PAF_SETUP_FEE (pay-after-first-visit PR-C): the monthly-tier setup fee is
// billed WITH the first visit, so the capture says so and the card consent the
// customer ticks (and the accept records as `after_visit_card`) is the
// after-first-visit variant — never the base "after each completed service" text.
describe('InlineAutoPayCapture afterVisitSetup (setup fee billed with the first visit)', () => {
  it('names the first visit + one-time setup fee and shows the after_visit_card consent text', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText, queryByText } = render(
      <InlineAutoPayCapture intent={{ ...INTENT }} loadStripeSdk={loadStripeSdk} afterVisitSetup />,
    );
    await flush();
    expect(getByText(/After your first visit is completed, your card is charged for that visit and your one-time setup fee/)).toBeInTheDocument();
    expect(getByText(/charge this card after my first visit is completed \(that visit plus my one-time setup fee\)/)).toBeInTheDocument();
    await act(async () => { getByText('View full terms').click(); });
    expect(getByText(AFTER_VISIT_CARD_CONSENT_TEXT)).toBeInTheDocument();
    expect(queryByText(CARD_CONSENT_TEXT)).toBeNull();
  });

  it('a checked box is cleared when the rendered authorization switches to the setup-fee variant', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByRole, rerender } = render(
      <InlineAutoPayCapture intent={{ ...INTENT }} loadStripeSdk={loadStripeSdk} />,
    );
    await flush();
    await act(async () => { getByRole('checkbox').click(); });
    expect(getByRole('checkbox')).toBeChecked();
    rerender(<InlineAutoPayCapture intent={{ ...INTENT }} loadStripeSdk={loadStripeSdk} afterVisitSetup />);
    await flush();
    expect(getByRole('checkbox')).not.toBeChecked();
  });

  it('default (flag absent): today\'s copy and base consent text', async () => {
    const { StripeCtor } = makeStripeStub();
    const loadStripeSdk = vi.fn(() => Promise.resolve(StripeCtor));
    const { getByText, queryByText } = render(
      <InlineAutoPayCapture intent={{ ...INTENT }} loadStripeSdk={loadStripeSdk} />,
    );
    await flush();
    expect(getByText(/charge this card after each completed service/)).toBeInTheDocument();
    expect(queryByText(/one-time setup fee/)).toBeNull();
    await act(async () => { getByText('View full terms').click(); });
    expect(getByText(CARD_CONSENT_TEXT)).toBeInTheDocument();
  });
});
