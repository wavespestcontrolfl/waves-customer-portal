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
