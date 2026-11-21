// @vitest-environment jsdom
// Customer soft exit — the "Not ready yet?" sheet. Three exits: a change
// request (note required), a still-deciding signal, and a reason-tagged
// decline (chip required; "Other" needs a note; competitor gets name + price
// fields). The tap on "I'm still deciding" is the signal (one POST); the
// step after it asks what would help, and only Send talks to the server
// again. The words are owner-approved (2026-11-21, estimate page changes).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateViewPage, { SoftExitSheet, SOFT_EXIT_REASONS, SOFT_EXIT_DECIDING_REASONS } from './EstimateViewPage';
import { setGlassDefault } from '../lib/estimate-glass-copy';

vi.mock('react-router-dom', () => ({ useParams: () => ({ token: 'not-ready-token' }) }));
vi.mock('../lib/stripeLoader', () => ({ loadStripeSdk: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setGlassDefault(false);
});

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
  vi.stubGlobal('fetch', fetchMock);
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1);
  return { url, method: init.method, body: JSON.parse(init.body) };
}

describe('SoftExitSheet', () => {
  it('opens on the chooser with the approved words, the three exits and no server call', () => {
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Not ready yet?' })).toBeInTheDocument();
    expect(screen.getByText('Tell us where you are. Nothing here sends you a message.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change something/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /still deciding/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /isn’t for me/i })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const openDecidingStep = async (props = {}) => {
    const onDeclined = vi.fn();
    const onClose = vi.fn();
    render(<SoftExitSheet token="tok" expiresAt="2026-09-15T04:00:00.000Z" onClose={onClose} onDeclined={onDeclined} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /still deciding/i }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'What would help you decide?' })).toBeInTheDocument());
    return { onClose, onDeclined };
  };

  it('the tap on "still deciding" is the signal: one POST with no reason, then the five reasons, Send and Skip', async () => {
    await openDecidingStep();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall()).toEqual({ url: expect.stringMatching(/\/estimates\/tok\/change-request$/), method: 'POST', body: { kind: 'still_deciding' } });
    expect(SOFT_EXIT_DECIDING_REASONS.map((r) => r.label)).toEqual([
      'A lower price', 'Talking to a person first', 'Comparing other quotes', 'Not the right time yet', 'Something else',
    ]);
    for (const { label } of SOFT_EXIT_DECIDING_REASONS) expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
  });

  it('Skip sends nothing more and closes with the unchanged words; Done never declines', async () => {
    const { onClose, onDeclined } = await openDecidingStep();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByRole('dialog', { name: 'No rush' })).toBeInTheDocument();
    expect(screen.getByText(/^Take your time — this estimate stays open through September 1[45]\. Questions\? Call \(941\) 297-5749\.$/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDeclined).not.toHaveBeenCalled();
  });

  it('Send posts the picked reason once and closes with the same words as Skip', async () => {
    await openDecidingStep({ canCall: true });
    fireEvent.click(screen.getByRole('button', { name: 'Comparing other quotes' }));
    fireEvent.click(screen.getByRole('button', { name: 'A lower price' }));
    expect(screen.getByRole('button', { name: 'A lower price' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Comparing other quotes' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'No rush' })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastCall()).toEqual({ url: expect.stringMatching(/\/estimates\/tok\/change-request$/), method: 'POST', body: { kind: 'still_deciding', reason: 'price' } });
    expect(screen.getByText(/^Take your time — this estimate stays open through September 1[45]\. Questions\? Call \(941\) 297-5749\.$/)).toBeInTheDocument();
  });

  it('"Talking to a person first" on an estimate with a phone: "We will call you" and the open-through date', async () => {
    await openDecidingStep({ canCall: true });
    fireEvent.click(screen.getByRole('button', { name: 'Talking to a person first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'We will call you' })).toBeInTheDocument());
    expect(lastCall().body).toEqual({ kind: 'still_deciding', reason: 'person' });
    expect(screen.getByText(/^This estimate stays open through September 1[45]\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/Take your time/)).not.toBeInTheDocument();
  });

  it('"Talking to a person first" with no phone on the estimate promises no call and gives our number', async () => {
    await openDecidingStep();
    fireEvent.click(screen.getByRole('button', { name: 'Talking to a person first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'No rush' })).toBeInTheDocument());
    expect(lastCall().body).toEqual({ kind: 'still_deciding', reason: 'person' });
    expect(screen.getByText(/Questions\? Call \(941\) 297-5749\./)).toBeInTheDocument();
    expect(screen.queryByText(/We will call you/)).not.toBeInTheDocument();
  });

  it('a reason that fails to send shows the error and stays on the step, with no call promised', async () => {
    await openDecidingStep({ canCall: true });
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Too many requests. Please call our office and we’ll get you sorted.' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Talking to a person first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Too many requests/));
    expect(screen.getByRole('dialog', { name: 'What would help you decide?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('a failed tap stays on the chooser: no reasons step without the signal', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /still deciding/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Not ready yet?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('a change request needs a note and sends topics + note', async () => {
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /change something/i }));
    const submit = screen.getByRole('button', { name: 'Request a revised estimate' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'The price' }));
    fireEvent.change(screen.getByLabelText('What should be different?'), { target: { value: 'Drop mosquito, keep pest.' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/send an updated estimate/i)).toBeInTheDocument());
    expect(lastCall()).toMatchObject({ method: 'POST', body: { kind: 'change', topics: ['price'], note: 'Drop mosquito, keep pest.' } });
  });

  it('a decline needs a reason; competitor reveals name + price; the commit PUTs /decline and reloads on Done', async () => {
    const onDeclined = vi.fn();
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={onDeclined} />);
    fireEvent.click(screen.getByRole('button', { name: /isn’t for me/i }));
    const submit = screen.getByRole('button', { name: 'Close this estimate' });
    expect(submit).toBeDisabled();
    for (const { label } of SOFT_EXIT_REASONS) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    expect(screen.queryByLabelText('Who did you go with?')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Going with someone else' }));
    fireEvent.change(screen.getByLabelText('Who did you go with?'), { target: { value: 'Bugs-R-Us' } });
    fireEvent.change(screen.getByLabelText('Their price'), { target: { value: '39' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/closed this estimate/i)).toBeInTheDocument());
    expect(lastCall()).toMatchObject({
      url: expect.stringMatching(/\/estimates\/tok\/decline$/),
      method: 'PUT',
      body: { reason: 'competitor', competitorName: 'Bugs-R-Us', competitorPrice: '39' },
    });
    expect(onDeclined).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDeclined).toHaveBeenCalledTimes(1);
  });

  it('"Something else" stays disabled until a note is typed', () => {
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /isn’t for me/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Something else' }));
    const submit = screen.getByRole('button', { name: 'Close this estimate' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Tell us a little more'), { target: { value: 'moving' } });
    expect(submit).toBeEnabled();
  });

  it('surfaces the server error and stays on the step', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Tell us a little more so we can do better next time.' }) });
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /isn’t for me/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Too expensive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close this estimate' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/little more/));
    expect(screen.getByRole('button', { name: 'Close this estimate' })).toBeInTheDocument();
  });

  it('text typed in one branch never crosses into the other', () => {
    render(<SoftExitSheet token="tok" onClose={vi.fn()} onDeclined={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /change something/i }));
    fireEvent.change(screen.getByLabelText('What should be different?'), { target: { value: 'drop mosquito' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: /isn’t for me/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Something else' }));
    expect(screen.getByLabelText('Tell us a little more')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Close this estimate' })).toBeDisabled();
  });

  it('withholds the change branch when the server says the estimate cannot park one', () => {
    render(<SoftExitSheet token="tok" changeEligible={false} onClose={vi.fn()} onDeclined={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /change something/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /still deciding/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /isn’t for me/i })).toBeInTheDocument();
  });

  it('moves focus into the sheet and closes on Escape through the shared focus manager', () => {
    const onClose = vi.fn();
    render(<SoftExitSheet token="tok" onClose={onClose} onDeclined={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Not ready yet?' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('estimate page: the "Not ready yet?" link', () => {
  const LINK = 'Not ready yet? Tell us why';
  const frequency = {
    key: 'quarterly', label: 'Quarterly', monthly: 39, annual: 468, perVisit: 117, perTreatment: 117, visitsPerYear: 4,
    perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control', displayPrice: 117, perTreatment: 117, visitsPerYear: 4, monthly: 39 }],
    included: [{ key: 'pest_control', label: 'Pest Control', detail: null }], addOns: [],
  };
  const payload = (extra = {}) => ({
    glassDefault: true,
    estimate: {
      customerFirstName: 'Casey', address: '1 Plan Way, Sarasota, FL 34236', serviceCategory: 'pest_control',
      acceptance: { mode: 'standard_slot_pick' }, defaultServiceMode: 'recurring', isOneTimeOnly: false,
      showOneTimeOption: false, billByInvoice: false, membership: null, intelligence: null, askToken: 'ask-token',
      expiresAt: '2026-09-15T04:00:00.000Z',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, reviewBeforeBooking: false },
    pricing: {
      services: [{
        key: 'pest_control', label: 'Pest Control', isRecurring: true, isPest: true, waveGuardTierEligible: true,
        defaultFrequencyKey: 'quarterly', copy: { priceWording: {} }, frequencies: [frequency],
      }],
      waveGuardTier: 'Bronze', askChips: [], defaultServiceMode: 'recurring', frequencies: [frequency],
      renderFlags: {}, oneTimeBreakdown: { total: 0, items: [] },
    },
    ...extra,
  });
  const renderPage = async (body) => {
    const pageFetch = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/available-slots') ? { primary: [], expander: [] } : body),
    }));
    vi.stubGlobal('fetch', pageFetch);
    const view = render(<EstimateViewPage />);
    await waitFor(() => expect(view.container.querySelector('#estimate-price-section')).not.toBeNull());
    return { ...view, pageFetch };
  };

  // The whole page is in the document: text and selector lookups, and role lookups only inside the
  // sheet, keep these tests quick (a role lookup walks every element of the page).
  const sheet = () => within(document.querySelector('[role="dialog"]'));
  const sheetTitle = () => document.querySelector('[role="dialog"]')?.getAttribute('aria-label');

  it('shows twice, beside the approve area and at the page bottom, and opens the sheet', async () => {
    const { container } = await renderPage(payload({ softExit: true, softExitChange: true, softExitCall: true }));
    const links = await screen.findAllByText(LINK);
    expect(links).toHaveLength(2);
    // The first one comes before the Ask Waves box; the second one after it.
    const ask = container.querySelector('#estimate-ask-section');
    expect(links[0].compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(links[1].compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.click(links[0]);
    expect(sheetTitle()).toBe('Not ready yet?');
  }, 20000);

  it('passes the server\'s phone answer to the sheet: a call is promised only with softExitCall', async () => {
    const { pageFetch } = await renderPage(payload({ softExit: true, softExitCall: true }));
    fireEvent.click((await screen.findAllByText(LINK))[0]);
    fireEvent.click(sheet().getByRole('button', { name: /still deciding/i }));
    await waitFor(() => expect(sheetTitle()).toBe('What would help you decide?'));
    fireEvent.click(sheet().getByRole('button', { name: 'Talking to a person first' }));
    fireEvent.click(sheet().getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sheetTitle()).toBe('We will call you'));
    const posts = pageFetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => [String(url), JSON.parse(init.body)]);
    expect(posts).toEqual([
      [expect.stringMatching(/\/estimates\/not-ready-token\/change-request$/), { kind: 'still_deciding' }],
      [expect.stringMatching(/\/estimates\/not-ready-token\/change-request$/), { kind: 'still_deciding', reason: 'person' }],
    ]);
  }, 20000);

  it('no link when the server did not offer the sheet', async () => {
    await renderPage(payload());
    await screen.findByText('Questions about this estimate? Ask Waves');
    expect(screen.queryByText(LINK)).toBeNull();
  }, 20000);
});
