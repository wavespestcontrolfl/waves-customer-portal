// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InlineAutoPayCapture from './InlineAutoPayCapture';

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
    first.unmount();
    // With the tender resolved by the mint, the same replay passes through.
    const ref2 = React.createRef();
    const second = render(
      <InlineAutoPayCapture
        ref={ref2}
        intent={{ ...INTENT, paymentMethodTypes: ['card', 'us_bank_account'], capturedMethodType: 'us_bank_account' }}
        loadStripeSdk={loadStripeSdk}
      />,
    );
    await flush();
    await act(async () => { second.getByRole('checkbox').click(); });
    expect(await ref2.current.confirmSetup()).toEqual({ ok: true, setupIntentId: 'seti_1' });
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
