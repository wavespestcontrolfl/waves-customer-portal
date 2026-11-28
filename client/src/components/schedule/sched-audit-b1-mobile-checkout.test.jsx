// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileCheckoutSheet from './MobileCheckoutSheet';
import MobileCardOnFileSheet from './MobileCardOnFileSheet';
import MobilePaymentSheet from './MobilePaymentSheet';
import MobileManualCardSheet from './MobileManualCardSheet';
import MobileItemDiscountPickerSheet from './MobileItemDiscountPickerSheet';
import MobileCashTenderSheet from './MobileCashTenderSheet';
import MobileServicePickerSheet from './MobileServicePickerSheet';
import MarkPrepaidModal from './MarkPrepaidModal';
import NoteBoxPhotos from './NoteBoxPhotos';
import PrepaySwitchSheet from './PrepaySwitchSheet';
import VisitCloseoutSheet from '../admin/VisitCloseoutSheet';
import { FastCompleteFrame, useFastCompleteCloseGuard } from '../tech/FastCompleteParts';
import { reloadHoldNames } from '../../lib/reloadHolds';

const mocks = vi.hoisted(() => ({
  launchTapToPay: vi.fn(),
  getStripe: vi.fn(),
  closeoutBusy: false,
}));

vi.mock('../../lib/tapToPay', () => ({
  launchTapToPay: (...args) => mocks.launchTapToPay(...args),
}));

vi.mock('../../lib/stripeLoader', () => ({
  getStripe: (...args) => mocks.getStripe(...args),
}));

vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: null }),
  chargeableCardOnFile: () => null,
  cardOnFileTitle: () => '',
  isCardExpired: () => false,
}));

vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: () => ({ enabled: false, known: true, retry: vi.fn() }),
  ensureStackingFresh: () => Promise.resolve({ enabled: false, known: true }),
}));

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlag: () => false,
}));

vi.mock('../../hooks/useSpeechDictation', () => ({
  default: () => ({ supported: false, starting: false, listening: false, uploading: false, toggle: vi.fn() }),
}));

vi.mock('../../pages/admin/SchedulePage', () => ({
  CompletionPanel: () => null,
}));

vi.mock('../../hooks/useVisitCloseout', () => ({
  useCloseoutLoad: () => ({
    visit: { id: 'v-1', packet: null },
    services: [{ id: 's-1', serviceType: 'Quarterly Pest', customerName: 'Alex Sample' }],
    draft: { forms: {} },
    error: '',
    setDraft: vi.fn(),
    setError: vi.fn(),
    retry: vi.fn(),
  }),
  useCloseoutSend: () => ({
    busy: mocks.closeoutBusy,
    ready: true,
    result: null,
    submit: vi.fn(),
    revokeSummary: vi.fn(),
  }),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  mocks.launchTapToPay.mockReset();
  mocks.getStripe.mockReset();
  mocks.closeoutBusy = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_SERVICE = {
  id: 'svc-100',
  customerId: 'cust-100',
  customerName: 'Alex Sample',
  serviceType: 'Quarterly Pest Control',
  serviceTypeDisplay: 'Quarterly Pest Control',
  estimatedPrice: 125,
  windowStart: '09:00:00',
  estimatedDuration: 45,
};

describe('Schedule & Dispatch audit Batch 1 — Mobile Checkout, Payment & Fast Complete UI', () => {
  it('P0-3: MobileCheckoutSheet resets minting after Charge succeeds and parses JSON errors cleanly', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const onChargeSuccess = vi.fn();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invoiceId: 'inv-1', invoiceToken: 'tok-1', total: 125 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'Card already charging' }),
      });

    render(<MobileCheckoutSheet service={SAMPLE_SERVICE} desktopVisible onClose={() => {}} onChargeSuccess={onChargeSuccess} />);

    // Pre-tax disclosure shown under Total (P1-20)
    expect(screen.getByText(/Applicable sales tax or estimate deposits are finalized on the invoice/i)).toBeInTheDocument();

    const chargeBtn = screen.getByRole('button', { name: 'Charge $125.00' });
    fireEvent.click(chargeBtn);

    await waitFor(() => expect(onChargeSuccess).toHaveBeenCalledTimes(1));
    // Stepping back from MobilePaymentSheet finds Charge interactive again, not stuck on "Opening payment…"
    await waitFor(() => expect(screen.getByRole('button', { name: 'Charge $125.00' })).not.toBeDisabled());

    // Second attempt gets a JSON error and renders the clean message instead of raw JSON
    fireEvent.click(screen.getByRole('button', { name: 'Charge $125.00' }));
    expect(await screen.findByText('Card already charging')).toBeInTheDocument();
  });

  it('P0-6: MobileCheckoutSheet hides Add Service, Add Item or Discount, and Edit Service Line for technicians', () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
    const onEditServiceLine = vi.fn();
    render(
      <MobileCheckoutSheet
        service={SAMPLE_SERVICE}
        desktopVisible
        onClose={() => {}}
        onEditServiceLine={onEditServiceLine}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Add Service' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Item or Discount' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Quarterly Pest Control'));
    expect(onEditServiceLine).not.toHaveBeenCalled();
  });

  it('P0-4: MobileCardOnFileSheet (legacy checkout path) renders load error + Retry instead of "No cards on file"', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    let cardsAttempt = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/cards')) {
        cardsAttempt += 1;
        if (cardsAttempt === 1) throw new Error('offline');
        return {
          ok: true,
          json: async () => ({
            cards: [{ id: 'pm-1', brand: 'visa', card_brand: 'visa', last_four: '4242', last4: '4242', exp_month: 12, exp_year: 2030, is_default: true }],
          }),
        };
      }
      return { ok: true, json: async () => ({ held: false }) };
    });

    render(
      <MobileCardOnFileSheet
        desktopVisible
        service={SAMPLE_SERVICE}
        invoiceId="inv-1"
        customerId="cust-100"
        customerName="Alex Sample"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText(/Could not load saved payment methods/i)).toBeInTheDocument();
    expect(screen.queryByText(/No cards on file for this customer/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/4242/)).toBeInTheDocument();
    expect(cardsAttempt).toBe(2);
  });

  it('P1-19: useFastCompleteCloseGuard + FastCompleteFrame prompts before discarding typed field edits', () => {
    const onClose = vi.fn();
    function Harness() {
      const { requestClose, frameProps } = useFastCompleteCloseGuard({ onClose });
      return (
        <FastCompleteFrame isMobile={false} titleId="t" onDismiss={requestClose} {...frameProps}>
          <textarea aria-label="Notes" />
          <button type="button" onClick={requestClose}>Close sheet</button>
        </FastCompleteFrame>
      );
    }

    render(<Harness />);
    // Pristine sheet closes in one tap
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Dirty sheet asks before discarding
    fireEvent.input(screen.getByLabelText('Notes'), { target: { value: 'Sprayed eaves' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved visit changes' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard & close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('P1-20: MobileItemDiscountPickerSheet rejects custom percentage discounts above 100%', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValueOnce('150').mockReturnValueOnce('25');
    const onSelect = vi.fn();

    render(<MobileItemDiscountPickerSheet desktopVisible onClose={() => {}} onSelect={onSelect} />);
    const pctBtn = screen.getByText('Variable %').closest('button');
    fireEvent.click(pctBtn);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(pctBtn);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'custom_discount', discount_type: 'percentage', amount: 25 });
    promptSpy.mockRestore();
  });

  it('P1-20: MobileCashTenderSheet clamps the 00 key at 9 digits of cents', () => {
    render(<MobileCashTenderSheet desktopVisible invoiceId="inv-1" amount={100} onClose={() => {}} />);
    const nine = screen.getByRole('button', { name: '9' });
    const doubleZero = screen.getByRole('button', { name: '00' });
    for (let i = 0; i < 8; i += 1) fireEvent.click(nine);
    expect(screen.getByText('$999999.99')).toBeInTheDocument();
    // Adding '00' would exceed 999_999_999 cents and must be ignored
    fireEvent.click(doubleZero);
    expect(screen.getByText('$999999.99')).toBeInTheDocument();
  });

  it('P1-20: MobilePaymentSheet resets Safari Tap-to-Pay charging state on visibility/focus return', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    mocks.launchTapToPay.mockResolvedValue({ inApp: false });

    render(
      <MobilePaymentSheet
        desktopVisible
        service={SAMPLE_SERVICE}
        invoiceId="inv-1"
        invoiceToken="tok-1"
        amount={125}
        onClose={() => {}}
      />,
    );

    const tapBtn = screen.getByRole('button', { name: /Tap to Pay on iPhone/i });
    fireEvent.click(tapBtn);
    expect(await screen.findByRole('button', { name: /Opening Tap to Pay/i })).toBeDisabled();

    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Tap to Pay on iPhone/i })).not.toBeDisabled());
  });

  it('P1-20: MobileManualCardSheet disables Back while a charge is processing', async () => {
    let resolveFinalize;
    const handlers = {};
    const paymentElement = {
      on: (evt, cb) => { handlers[evt] = cb; },
      mount: vi.fn(),
      unmount: vi.fn(),
      destroy: vi.fn(),
    };
    mocks.getStripe.mockResolvedValue({
      elements: () => ({
        create: () => paymentElement,
        submit: async () => ({ error: null }),
      }),
      createPaymentMethod: async () => ({ error: null, paymentMethod: { id: 'pm-1' } }),
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ invoice: { saveRequired: false } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ publishableKey: 'pk_test', clientSecret: 'seti_1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ quoteToken: 'qt-1', base: 125, surcharge: 3.75, total: 128.75 }) })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFinalize = resolve; }));

    const onClose = vi.fn();
    render(<MobileManualCardSheet desktopVisible invoiceToken="tok-1" amount={125} onClose={onClose} />);

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    handlers.ready();
    handlers.change({ complete: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const confirmBtn = await screen.findByRole('button', { name: /Confirm & charge \$128\.75/i });
    fireEvent.click(confirmBtn);

    const backBtn = screen.getByRole('button', { name: 'Back' });
    expect(backBtn).toBeDisabled();
    fireEvent.click(backBtn);
    expect(onClose).not.toHaveBeenCalled();

    resolveFinalize({ ok: false, json: async () => ({ error: 'Declined' }) });
    await waitFor(() => expect(screen.getByText('Declined')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Back' })).not.toBeDisabled();
  });

  it('P2: MobileServicePickerSheet renders load error + Retry instead of "No services"', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ services: [{ id: 's-1', name: 'Mosquito Shield', base_price: 95 }] }) });

    render(<MobileServicePickerSheet desktopVisible onClose={() => {}} onSelect={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load services/i);
    expect(screen.queryByText('No services')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Mosquito Shield')).toBeInTheDocument();
  });

  it('P2: MarkPrepaidModal parses JSON errors cleanly and blocks Close while saving', async () => {
    let resolveSave;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    const onClose = vi.fn();

    render(<MarkPrepaidModal service={SAMPLE_SERVICE} onClose={onClose} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save prepayment' }));

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeBtn).toBeDisabled();
    fireEvent.click(closeBtn);
    expect(onClose).not.toHaveBeenCalled();

    resolveSave({ ok: false, status: 403, text: async () => JSON.stringify({ error: 'Admin access required' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required');
  });

  it('P2: NoteBoxPhotos CaptionEditor locks Save while async onCaption promise is in flight', async () => {
    let resolveSave;
    const onCaption = vi.fn(() => new Promise((resolve) => { resolveSave = resolve; }));
    const palette = { text: '#111', border: '#ddd', card: '#fff', muted: '#666', danger: '#c00', onDanger: '#fff' };

    render(
      <NoteBoxPhotos
        photos={[{ id: 'p-1', url: '/p1.jpg', caption: '' }]}
        palette={palette}
        onAdd={() => {}}
        onRemove={() => {}}
        onCaption={onCaption}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Describe photo 1' }));
    fireEvent.change(screen.getByLabelText('Description for photo 1'), { target: { value: 'Ant trail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
    expect(onCaption).toHaveBeenCalledTimes(1);

    resolveSave(true);
    await waitFor(() => expect(screen.queryByLabelText('Description for photo 1')).not.toBeInTheDocument());
  });

  it('P1-22: VisitCloseoutSheet blocks Close while submit is busy', () => {
    mocks.closeoutBusy = true;
    const onClose = vi.fn();
    render(<VisitCloseoutSheet visitId="v-1" products={[]} onClose={onClose} onSaved={() => {}} />);

    const headerClose = screen.getByRole('button', { name: 'Close visit closeout' });
    const footerClose = screen.getByRole('button', { name: 'Close' });
    expect(headerClose).toBeDisabled();
    expect(footerClose).toBeDisabled();
    fireEvent.click(headerClose);
    fireEvent.click(footerClose);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('P1-19 (Codex): useFastCompleteCloseGuard preserves draft state on Keep editing, tracks chip & product remove clicks, and cancels confirm when blocked', () => {
    const onClose = vi.fn();
    function Harness({ blocked = false }) {
      const [note, setNote] = React.useState('');
      const { requestClose, frameProps } = useFastCompleteCloseGuard({ blocked, onClose });
      return (
        <FastCompleteFrame isMobile={false} titleId="t-chip" onDismiss={requestClose} {...frameProps}>
          <textarea aria-label="Field note" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" aria-pressed="false">Front lawn</button>
          <button type="button" className="tech-product-remove">Remove</button>
          <button type="button" onClick={requestClose}>Close sheet</button>
        </FastCompleteFrame>
      );
    }

    const { rerender } = render(<Harness blocked={false} />);
    fireEvent.change(screen.getByLabelText('Field note'), { target: { value: 'Treated perimeter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    const confirmDialog = screen.getByRole('alertdialog', { name: 'Discard unsaved visit changes' });
    expect(confirmDialog).toBeInTheDocument();
    // Background controls are inert while the discard confirmation is open
    const inertWrapper = confirmDialog.nextElementSibling;
    expect(inertWrapper).toHaveAttribute('aria-hidden', 'true');
    expect(inertWrapper).toHaveAttribute('inert');

    // Keep editing must preserve mounted form state (no remount wipe)
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Field note')).toHaveValue('Treated perimeter');

    // Entering a submitting/blocked state clears the confirmation so Discard cannot close mid-request
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved visit changes' })).toBeInTheDocument();
    rerender(<Harness blocked={true} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Removing a planned product as the FIRST edit also arms the discard guard
    cleanup();
    const onCloseRemove = vi.fn();
    function RemoveHarness() {
      const { requestClose, frameProps } = useFastCompleteCloseGuard({ onClose: onCloseRemove });
      return (
        <FastCompleteFrame isMobile={false} titleId="t-rem" onDismiss={requestClose} {...frameProps}>
          <button type="button" className="tech-product-remove">Remove</button>
          <button type="button" onClick={requestClose}>Close sheet</button>
        </FastCompleteFrame>
      );
    }
    render(<RemoveHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
    expect(onCloseRemove).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved visit changes' })).toBeInTheDocument();
  });

  it('P1-21 (Codex): PrepaySwitchSheet holds reload via predicate while collecting and releases cleanly on unmount', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          eligible: true,
          visitsPerYear: 4,
          coverageCadence: 'quarterly',
          coverageServiceType: 'Quarterly Pest Control',
          prepayTotal: 400,
          regularAnnualTotal: 450,
          discountPercent: 11,
          termStart: '2026-11-27',
          termEnd: '2027-11-27',
          supersedes: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          invoice: { id: 'inv-prepay-1', token: 'tok-prepay-1', total: 400, status: 'sent' },
          voided: [],
        }),
      });

    const { unmount } = render(<PrepaySwitchSheet service={SAMPLE_SERVICE} onClose={() => {}} onSaved={() => {}} />);
    const chargeBtn = await screen.findByRole('button', { name: /Collect \$400\.00 now/i });
    expect(reloadHoldNames()).not.toContain('prepay-switch-collecting');

    fireEvent.click(chargeBtn);
    await waitFor(() => expect(reloadHoldNames()).toContain('prepay-switch-collecting'));

    unmount();
    expect(reloadHoldNames()).not.toContain('prepay-switch-collecting');
  });
});
