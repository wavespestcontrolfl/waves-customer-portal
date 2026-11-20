// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: () => {} }));

import CareersOfferPage from './CareersOfferPage';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const TERMS = {
  title: 'Technician Terms',
  markdown: '## Hours\nFour 10-hour days.\n\n## Pay\nPaid every Friday.\n\n<script>alert(1)</script>',
};

const VERSION = '2026-12-11T15:20:00.000Z'; // the offer's version as the first read shows it

function openPayload(overrides = {}) {
  return {
    state: 'open',
    firstName: 'Jordan',
    jobTitle: 'Pest Control Technician',
    startDate: '2027-01-04',
    hourlyRate: '23.00',
    stepRate: '25.00',
    stepEffectiveOn: '2027-04-05',
    hoursLine: '40 paid hours each full week, four 10-hour days, Monday to Thursday',
    reportTo: 'Sam Carter, owner',
    payDayLine: 'Every Friday, for the week before',
    owner: { name: 'Sam Carter', title: 'owner', sentOn: '2026-12-11' },
    expiresAt: '2026-12-18T15:20:00.000Z',
    textConsent: false,
    version: VERSION,
    signedName: null,
    signedAt: null,
    terms: TERMS,
    ...overrides,
  };
}

const TOKEN = 'ab'.repeat(32); // 64 lowercase hex, as Send makes it

function renderPage(path = `/careers/offer/${TOKEN}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/careers/offer/:token" element={<CareersOfferPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function bodyOf(fetchMock, index) {
  return JSON.parse(fetchMock.mock.calls[index][1].body);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-12-14T15:00:00Z')); // Mon Dec 14 ET
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CareersOfferPage — open state', () => {
  it('shows the offer rows, the notice and the expiry line', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload()));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Your job offer' })).toBeInTheDocument();
    expect(globalThis.fetch.mock.calls[0][0]).toMatch(new RegExp(`/public/careers/offer/${TOKEN}$`));
    expect(screen.getByText((_, el) => el.tagName === 'P' && el.textContent === 'Signed by Sam Carter, owner · Dec 11, 2026')).toBeInTheDocument();
    expect(screen.getByText('Pest Control Technician')).toBeInTheDocument();
    expect(screen.getByText('Mon, Jan 4, 2027')).toBeInTheDocument();
    expect(screen.getByText('$23.00 an hour, $25.00 from Apr 5')).toBeInTheDocument();
    expect(screen.getByText(/four 10-hour days, Monday to Thursday/)).toBeInTheDocument();
    expect(screen.getByText('Sam Carter, owner')).toBeInTheDocument();
    expect(screen.getByText('Every Friday, for the week before')).toBeInTheDocument();
    expect(screen.getByText(/Please don.t give notice at your current job until you have signed this offer\./)).toBeInTheDocument();
    expect(screen.getByText('Open until Fri, Dec 18')).toBeInTheDocument();
  });

  it('shows only the hourly rate when there is no step', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload({ stepRate: null, stepEffectiveOn: null })));
    renderPage();
    expect(await screen.findByText('$23.00 an hour')).toBeInTheDocument();
  });

  it('expands the terms inline and never injects raw HTML', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload()));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Read the Technician Terms/ }));
    const terms = screen.getByTestId('offer-terms');
    expect(terms).toHaveTextContent('Four 10-hour days.');
    expect(terms.querySelector('script')).toBeNull();
    expect(terms).toHaveTextContent('<script>alert(1)</script>');
  });

  // Another tab changed the text choice after this page read the offer. The
  // sign is refused with the offer still open, so the page reads it again,
  // shows the stored choice and asks to try again; the next sign carries the
  // version the applicant now sees.
  it('signs only the text choice on screen: a sign made on an older version re-reads and asks again', async () => {
    const changed = '2026-12-11T15:25:00.000Z';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ state: 'open' }, 409))
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true, version: changed })))
      .mockResolvedValueOnce(jsonResponse({ state: 'signed', signedAt: '2026-12-12T13:15:00.000Z' }));
    globalThis.fetch = fetchMock;
    renderPage();
    const box = await screen.findByLabelText('Text me about this offer');
    expect(box).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText('That did not go through. Please try again.')).toBeInTheDocument();
    expect(bodyOf(fetchMock, 1)).toEqual({ signedName: 'Jordan Rivera', version: VERSION });
    expect(fetchMock.mock.calls[2][0]).toMatch(new RegExp(`/public/careers/offer/${TOKEN}$`)); // the re-read
    await waitFor(() => expect(screen.getByLabelText('Text me about this offer')).toBeChecked());
    expect(screen.queryByText(/You signed this offer|This offer was (already )?signed/)).toBeNull(); // still open
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/You signed this offer on Sat, Dec 12, 2026/)).toBeInTheDocument();
    expect(bodyOf(fetchMock, 3)).toEqual({ signedName: 'Jordan Rivera', version: changed });
  });

  it('enables Accept and sign only with at least two words, then posts the name', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ state: 'signed', signedAt: '2026-12-12T13:15:00.000Z' }));
    globalThis.fetch = fetchMock;
    renderPage();
    const accept = await screen.findByRole('button', { name: 'Accept and sign' });
    const input = screen.getByLabelText('Type your full name to sign');
    expect(accept).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Jordan' } });
    expect(accept).toBeDisabled();
    fireEvent.change(input, { target: { value: '  Jordan Rivera ' } });
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    expect(await screen.findByText(/You signed this offer on Sat, Dec 12, 2026\. Welcome to Waves\. Sam will contact you about your first day\./)).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toMatch(new RegExp(`/public/careers/offer/${TOKEN}/v2/accept$`));
    expect(bodyOf(fetchMock, 1)).toEqual({ signedName: 'Jordan Rivera', version: VERSION });
  });

  it('posts the text consent choice and puts the box back when saving fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ textConsent: true, version: '2026-12-11T15:21:00.000Z' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Try later' }, 400));
    globalThis.fetch = fetchMock;
    renderPage();
    const box = await screen.findByLabelText('Text me about this offer');
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/v2\/text-consent$/);
    expect(bodyOf(fetchMock, 1)).toEqual({ consent: true, version: VERSION });
    fireEvent.click(box);
    expect(await screen.findByText('Try later')).toBeInTheDocument();
    expect(box).toBeChecked();
  });

  it('re-reads the offer when the consent save answers 409', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not open', code: 'NOT_OPEN' }, 409))
      .mockResolvedValueOnce(jsonResponse({ state: 'withdrawn', message: 'This offer is no longer open. Please call Sam.', contactPhone: '(941) 297-5749' }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByLabelText('Text me about this offer'));
    expect(await screen.findByText(/This offer is no longer open/)).toBeInTheDocument();
  });

  it('stays locked with a retry when the refresh after a consent 409 fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not open', code: 'NOT_OPEN' }, 409))
      .mockResolvedValueOnce(jsonResponse({}, 500));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByLabelText('Text me about this offer'));
    expect(await screen.findByText(/We could not confirm that choice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saving|Accept and sign/ })).toBeDisabled();
  });

  it('treats a 502 on the consent save as unknown and re-reads the stored value', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true })));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByLabelText('Text me about this offer'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByLabelText('Text me about this offer')).toBeChecked());
    expect(screen.getByLabelText('Text me about this offer')).toBeEnabled();
  });

  it('renders the terminal state the consent re-read returns without a second read', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse({ state: 'withdrawn', message: 'This offer is no longer open. Please call Sam.', contactPhone: '(941) 297-5749' }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByLabelText('Text me about this offer'));
    expect(await screen.findByText(/This offer is no longer open/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shows the not-valid page when the consent save and the read after it answer 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByLabelText('Text me about this offer'));
    expect(await screen.findByRole('heading', { name: 'This link is not valid.' })).toBeInTheDocument();
    expect(fetchMock.mock.calls[2][0]).toMatch(new RegExp(`/public/careers/offer/${TOKEN}$`)); // the read
  });

  // A server without the /v2 routes (a mixed deploy or a rollback) answers 404 for a live offer: the page reads the
  // offer before it calls the link dead, and an open read keeps the offer and says the answer did not go through.
  it('keeps the offer when a consent save answers 404 and the read says open', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404))
      .mockResolvedValueOnce(jsonResponse(openPayload()));
    globalThis.fetch = fetchMock;
    renderPage();
    const box = await screen.findByLabelText('Text me about this offer');
    fireEvent.click(box);
    expect(await screen.findByText('That did not go through. Please try again.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'This link is not valid.' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Text me about this offer')).not.toBeChecked();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the offer when a signature answers 404 and the read says open, and signs nothing on screen', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404))
      .mockResolvedValueOnce(jsonResponse(openPayload()));
    globalThis.fetch = fetchMock;
    renderPage();
    const accept = await screen.findByRole('button', { name: 'Accept and sign' });
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(accept);
    expect(await screen.findByText('That did not go through. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'This link is not valid.' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[2][0]).toMatch(new RegExp(`/public/careers/offer/${TOKEN}$`)); // the read
  });

  it('shows the not-valid page when a signature and the read after it answer 404', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404));
    renderPage();
    const accept = await screen.findByRole('button', { name: 'Accept and sign' });
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(accept);
    expect(await screen.findByRole('heading', { name: 'This link is not valid.' })).toBeInTheDocument();
  });

  it('keeps signing locked when a consent reply is lost and the read fails, and Try again sends the same choice', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline')) // POST consent true: reply lost
      .mockRejectedValueOnce(new Error('offline')) // the read fails
      .mockResolvedValueOnce(jsonResponse({ textConsent: true, version: '2026-12-11T15:21:00.000Z' })); // Try again: the same choice, saved
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByLabelText('Text me about this offer'));
    expect(await screen.findByText(/We could not confirm that choice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saving|Accept and sign/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeEnabled());
    expect(screen.getByLabelText('Text me about this offer')).toBeChecked();
    expect(fetchMock.mock.calls[3][0]).toMatch(/\/v2\/text-consent$/);
    expect(bodyOf(fetchMock, 3)).toEqual({ consent: true, version: VERSION });
  });

  // The same for a text choice: a resend that reaches a server without /v2 says nothing about the save whose reply
  // was lost, so the page reads the offer, and signing stays locked while the read holds the old choice.
  it('keeps the choice and the lock when a resend after a lost consent reply answers 404 and the read holds the old value', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline')) // POST consent true: reply lost
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read: the lost save has not landed yet
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404)) // Try again reaches a server without /v2
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read: still the old choice
      .mockResolvedValueOnce(jsonResponse({ textConsent: true, version: '2026-12-11T15:21:00.000Z' })); // Try again: saved
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByLabelText('Text me about this offer'));
    expect(await screen.findByText(/We could not confirm that choice/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled());
    expect(screen.getByText(/We could not confirm that choice/)).toBeInTheDocument();
    expect(screen.queryByText('That did not go through. Please try again.')).toBeNull();
    expect(screen.getByLabelText('Text me about this offer')).toBeChecked();
    expect(screen.getByRole('button', { name: /Saving|Accept and sign/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeEnabled());
    expect(screen.getByLabelText('Text me about this offer')).toBeChecked();
    expect(fetchMock.mock.calls[5][0]).toMatch(/\/v2\/text-consent$/);
    expect(bodyOf(fetchMock, 5)).toEqual({ consent: true, version: VERSION });
  });

  it('keeps the choice and the lock when the read after a lost reply still holds the old value, until the choice is sent again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true })))
      .mockRejectedValueOnce(new Error('offline')) // POST consent false: reply lost
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true }))) // the read: the lost save has not landed yet
      .mockResolvedValueOnce(jsonResponse({ textConsent: false, version: '2026-12-11T15:21:00.000Z' })); // Try again: the same choice, saved
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    const box = screen.getByLabelText('Text me about this offer');
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(await screen.findByText(/We could not confirm that choice/)).toBeInTheDocument();
    expect(screen.getByLabelText('Text me about this offer')).not.toBeChecked(); // still the applicant's choice
    expect(screen.getByRole('button', { name: /Saving|Accept and sign/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeEnabled());
    expect(screen.getByLabelText('Text me about this offer')).not.toBeChecked();
    expect(screen.queryByText(/We could not confirm that choice/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(bodyOf(fetchMock, 3)).toEqual({ consent: false, version: VERSION });
  });

  // The server refuses a change made from an older version, so a save that
  // lands late cannot undo a later choice. The page sends the version of the
  // read or save the choice was made on.
  it('sends each text choice with the version it was made on: the read first, then the version the last save returned', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ textConsent: true, version: '2026-12-11T15:21:00.000Z' }))
      .mockResolvedValueOnce(jsonResponse({ textConsent: false, version: '2026-12-11T15:22:00.000Z' }));
    globalThis.fetch = fetchMock;
    renderPage();
    const box = await screen.findByLabelText('Text me about this offer');
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(bodyOf(fetchMock, 1)).toEqual({ consent: true, version: VERSION });
    expect(bodyOf(fetchMock, 2)).toEqual({ consent: false, version: '2026-12-11T15:21:00.000Z' });
  });

  // A server from before the version answers a save with the choice only. The
  // page must not lose its version (a signature without one skips the check),
  // so it reads the offer and signs with the version that read carries.
  it.each([
    ['a version', { textConsent: true }],
    ['the choice', { version: '2026-12-11T15:24:00.000Z' }],
  ])('reads the offer when a text choice save answers without %s, and signs with the version of that read', async (label, saved) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse(saved)) // saved, but the answer cannot be applied
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true, version: '2026-12-11T15:25:00.000Z' })))
      .mockResolvedValueOnce(jsonResponse({ state: 'signed', signedAt: '2026-12-12T13:15:00.000Z' }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByLabelText('Text me about this offer'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][1]).toBeUndefined(); // a read, not a write
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeEnabled());
    expect(screen.getByLabelText('Text me about this offer')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/You signed this offer/)).toBeInTheDocument();
    expect(bodyOf(fetchMock, 3)).toEqual({ signedName: 'Jordan Rivera', version: '2026-12-11T15:25:00.000Z' });
  });

  it('keeps signing locked when the read after a save without a version has no version either', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ textConsent: true })) // saved, no version
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true, version: undefined })));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByLabelText('Text me about this offer'));
    expect(await screen.findByText(/We could not confirm that choice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saving|Accept and sign/ })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shows the load error, not the offer, when the open offer read has no version', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload({ version: undefined })));
    renderPage();
    expect(await screen.findByText(/load that offer link/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and sign' })).toBeNull();
  });

  // Only an explicit open state with its version shows the signing controls.
  it.each([
    ['an empty answer', {}],
    ['an unknown state', { ...openPayload(), state: 'pending' }],
    ['open without the text choice', openPayload({ textConsent: undefined })],
    ['open without the Terms', openPayload({ terms: null })],
    ['open with empty Terms', openPayload({ terms: { title: 'Technician Terms', markdown: '  ' } })],
    ['open without the start date', openPayload({ startDate: null })],
    ['open with a start date that is not a day', openPayload({ startDate: '2027-02-30' })],
    ['open without the hourly rate', openPayload({ hourlyRate: null })],
    ['open with a zero hourly rate', openPayload({ hourlyRate: '0.00' })],
    ['open with a step rate and no step date', openPayload({ stepEffectiveOn: null })],
    ['open with a step date and no step rate', openPayload({ stepRate: null })],
    ['open without the job', openPayload({ jobTitle: ' ' })],
    ['open without the week', openPayload({ hoursLine: null })],
    ['open without who they report to', openPayload({ reportTo: '' })],
    ['open without pay day', openPayload({ payDayLine: null })],
  ])('shows the load error, not the offer, when the offer read is %s', async (label, body) => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(body));
    renderPage();
    expect(await screen.findByText(/load that offer link/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and sign' })).toBeNull();
  });

  // A 200 that does not name the answer cannot be read: the page reads the
  // offer, as for a lost reply, and never claims the signature as its own.
  it('reads the offer when the signature answer names no state, and shows what the read says', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse(openPayload({ state: 'signed', signedName: 'Jordan Rivera', signedAt: '2026-12-12T13:15:00.000Z' })));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/^This offer was signed by Jordan Rivera on Sat, Dec 12, 2026\./)).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).toBeNull();
    expect(fetchMock.mock.calls[2][1]).toBeUndefined(); // a read, not a write
  });

  // An applicant who unticks the box must not sign believing texts are off
  // when the server refused that change: the page shows the stored choice and
  // says the change did not go through.
  it('shows the stored choice and says so when a change made from an older version is refused, and the next change sends the new version', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true })))
      .mockResolvedValueOnce(jsonResponse({ state: 'open' }, 409)) // another tab changed the choice since this read
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true, version: '2026-12-11T15:30:00.000Z' })))
      .mockResolvedValueOnce(jsonResponse({ textConsent: false, version: '2026-12-11T15:31:00.000Z' }));
    globalThis.fetch = fetchMock;
    renderPage();
    const box = await screen.findByLabelText('Text me about this offer');
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).toBeChecked(); // the stored choice, not the refused one
    expect(screen.getByText('That did not go through. Please try again.')).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(bodyOf(fetchMock, 3)).toEqual({ consent: false, version: '2026-12-11T15:30:00.000Z' });
    expect(screen.queryByText('That did not go through. Please try again.')).toBeNull();
  });

  // The same refusal, but the read after it fails: signing stays locked, and
  // the read Try again makes still says the change did not go through.
  it('still says a refused change did not go through when the read after it failed and Try again reads the offer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true })))
      .mockResolvedValueOnce(jsonResponse({ state: 'open' }, 409)) // another tab changed the choice since this read
      .mockRejectedValueOnce(new Error('offline')) // the read after the refusal fails
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true, version: '2026-12-11T15:30:00.000Z' })));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByLabelText('Text me about this offer'));
    expect(await screen.findByText(/We could not confirm that choice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saving|Accept and sign/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeEnabled());
    expect(screen.getByLabelText('Text me about this offer')).toBeChecked(); // the stored choice, not the refused one
    expect(screen.getByText('That did not go through. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/We could not confirm that choice/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // The 409 says where the offer stands. A closed offer comes back whole, with
  // no read. An answer given in another tab names only its state: the page
  // shows it at once, and a failed read for its details does not hide it.
  it.each([
    ['sign', { state: 'withdrawn', message: 'This offer is no longer open. Please call Sam.', contactPhone: '(941) 297-5749' }, 'This offer is no longer open. Please call Sam.', 2],
    ['consent', { state: 'withdrawn', message: 'This offer is no longer open. Please call Sam.', contactPhone: '(941) 297-5749' }, 'This offer is no longer open. Please call Sam.', 2],
    ['sign', { state: 'signed' }, /^This offer was signed\. Welcome to Waves\./, 3],
    ['consent', { state: 'declined' }, 'This offer was declined. Thank you for your time.', 3],
    ['date', { state: 'date_requested' }, /^Sam will look at the new date\. If it works, he will send an updated offer\./, 3],
  ])('after a %s refused with %o, shows where the offer stands even when the next read fails', async (act, refusal, text, calls) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse(refusal, 409))
      .mockRejectedValueOnce(new Error('offline')); // the read for details fails
    globalThis.fetch = fetchMock;
    renderPage();
    if (act === 'sign') {
      fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
      fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    } else if (act === 'consent') {
      fireEvent.click(await screen.findByLabelText('Text me about this offer'));
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Ask for another start date' }));
      fireEvent.change(screen.getByLabelText(/Another start date/), { target: { value: '2027-01-11' } }); // Monday
      fireEvent.click(screen.getByRole('button', { name: 'Send this date' }));
    }
    expect(await screen.findByText(text)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
    expect(screen.queryByRole('button', { name: 'Accept and sign' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('after a sign refused because the offer is signed, names the signer and the time on record', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ state: 'signed' }, 409)) // another name is on record
      .mockResolvedValueOnce(jsonResponse(openPayload({ state: 'signed', signedName: 'Jordan M. Rivera', signedAt: '2026-12-12T13:15:00.000Z' })));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/^This offer was signed by Jordan M\. Rivera on Sat, Dec 12, 2026\. Welcome to Waves\./)).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).toBeNull();
  });

  // Codex P1 (round 27): an answer another tab gave reaches this tab through a
  // 409 and a read. It is not this tab's doing, so it is told in neutral words.
  it.each([
    ['sign', { state: 'declined' }, openPayload({ state: 'declined' }), 'This offer was declined. Thank you for your time.', /You declined/],
    ['decline', { state: 'date_requested' }, openPayload({ state: 'date_requested', requestedStartDate: '2027-01-11' }), 'A new start date was asked for: Mon, Jan 11, 2027.', /You asked to start on|your new date/],
  ])('after a %s refused because another tab answered, tells that answer in neutral words', async (act, refusal, read, text, notMine) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse(refusal, 409))
      .mockResolvedValueOnce(jsonResponse(read));
    globalThis.fetch = fetchMock;
    renderPage();
    if (act === 'sign') {
      fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
      fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
      fireEvent.click(screen.getByRole('button', { name: 'Yes, decline' }));
    }
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(notMine)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('the text box follows a fresh read of the open offer, such as a choice made in another tab', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: false })))
      .mockResolvedValueOnce(jsonResponse({}, 502)) // sign: no answer
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true }))); // the re-read: still open, texts on
    globalThis.fetch = fetchMock;
    renderPage();
    const box = await screen.findByLabelText('Text me about this offer');
    expect(box).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByLabelText('Text me about this offer')).toBeChecked());
  });

  // Only a read shows the signature (the reply was lost): another tab may have
  // signed in the same name, so the page names the signer, never "You signed".
  it('re-reads the offer when a successful sign reply cannot be read, and names the signer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('cut off'); } })
      .mockResolvedValueOnce(jsonResponse(openPayload({ state: 'signed', signedName: 'Jordan Rivera', signedAt: '2026-12-12T13:15:00.000Z' })));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/^This offer was signed by Jordan Rivera on Sat, Dec 12, 2026\. Welcome to Waves\./)).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).toBeNull();
  });

  // Codex P1: the server answers a sign in the name already signed (another
  // tab signed first) with 200 and a replay mark. This tab signed nothing, so
  // the page names the stored signature, never "You signed".
  it('a sign answered as a replay names the stored signer, never "You signed"', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ state: 'signed', signedAt: '2026-12-12T13:15:00.000Z', signedName: 'Jordan Rivera', replay: true }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'jordan rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/^This offer was signed by Jordan Rivera on Sat, Dec 12, 2026\. Welcome to Waves\./)).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Codex P1: this tab's sign was refused, then a signature in the same name
  // came from elsewhere. Nothing this tab sent went through, so the page names
  // the signer, never "You signed".
  it('after this tab\'s sign is refused, a signature in the same name from elsewhere is never "You signed"', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'This offer changed. Please review it.' }, 409)) // the sign: refused
      .mockResolvedValueOnce(jsonResponse(openPayload({ version: '2026-12-11T09:00:00.000Z' }))) // the read: still open
      .mockResolvedValueOnce(jsonResponse({ state: 'signed' }, 409)) // the decline: signed meanwhile
      .mockResolvedValueOnce(jsonResponse(openPayload({ state: 'signed', signedName: 'Jordan Rivera', signedAt: '2026-12-12T13:15:00.000Z' })));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText('That did not go through. Please try again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, decline' }));
    expect(await screen.findByText(/^This offer was signed by Jordan Rivera on Sat, Dec 12, 2026\./)).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('sends a date request for a future Monday to Thursday only', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ state: 'date_requested' }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for another start date' }));
    const date = screen.getByLabelText(/Another start date/);
    expect(date).toHaveAttribute('min', '2026-12-15');
    const send = screen.getByRole('button', { name: 'Send this date' });
    expect(send).toBeDisabled();
    fireEvent.change(date, { target: { value: '2027-01-08' } }); // Friday
    expect(send).toBeDisabled();
    expect(screen.getByText('Start days are Monday to Thursday.')).toBeInTheDocument();
    fireEvent.change(date, { target: { value: '2027-01-11' } }); // Monday
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: ' Need a week ' } });
    expect(screen.getByLabelText('Note (optional)')).toHaveAttribute('maxlength', '500');
    fireEvent.click(send);
    expect(await screen.findByText(/Thanks\. Sam will look at your new date\. If it works, he will send you an updated offer\./)).toBeInTheDocument();
    expect(screen.getByText('You asked to start on Mon, Jan 11, 2027.')).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/v2\/date-request$/);
    expect(bodyOf(fetchMock, 1)).toEqual({ requestedStartDate: '2027-01-11', note: 'Need a week', version: VERSION });
  });

  it('asks to confirm before declining, then posts the reason', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ state: 'declined' }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Took another job' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, decline' }));
    expect(await screen.findByText('You declined this offer. Thank you for your time.')).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/v2\/decline$/);
    expect(bodyOf(fetchMock, 1)).toEqual({ reason: 'Took another job', version: VERSION });
  });

  it('re-reads the offer when an action answers 409', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not open' }, 409))
      .mockResolvedValueOnce(jsonResponse({ state: 'superseded', message: 'This offer was updated. Please use the newest link Sam sent you.', contactPhone: '(941) 297-5749' }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/This offer was updated/)).toBeInTheDocument();
  });

  it('shows a retry message when the refresh after a 409 fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not open', code: 'NOT_OPEN' }, 409))
      .mockResolvedValueOnce(jsonResponse({}, 500));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/We could not refresh this offer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Saving|Accept and sign/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    expect(screen.getByLabelText('Text me about this offer')).toBeDisabled();
  });

  // A send whose reply was lost may still go through, even when the read after
  // it says open. Every action stays locked, and only a resend of that send is
  // offered. The server answers a resend of the same signature with the stored
  // one (job-offers.js acceptOffer), so nothing is signed twice.
  it('after a lost sign reply and a read that still says open, locks every action and offers only a resend', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline')) // sign: reply lost
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read: the sign has not landed yet
      .mockResolvedValueOnce(jsonResponse({ state: 'signed', signedAt: '2026-12-12T13:15:00.000Z' })); // the resend signs
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText('We could not confirm that. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask for another start date' })).toBeDisabled();
    expect(screen.getByLabelText('Text me about this offer')).toBeDisabled();
    expect(screen.getByLabelText('Type your full name to sign')).toBeDisabled(); // a resend sends what is shown
    expect(screen.queryByText(/Could not save that/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/You signed this offer on Sat, Dec 12, 2026\. Welcome to Waves\./)).toBeInTheDocument();
    expect(fetchMock.mock.calls[3][0]).toMatch(new RegExp(`/public/careers/offer/${TOKEN}/v2/accept$`));
    expect(bodyOf(fetchMock, 3)).toEqual({ signedName: 'Jordan Rivera', version: VERSION });
  });

  // A resend can reach a server without the /v2 routes (a mixed deploy or a rollback) while the first send still waits
  // for the offer. Its 404 says nothing about that send, so the send stays the only action until a read or a resend
  // settles it.
  it('after a lost sign reply, a resend that answers 404 keeps the send the only action while the read says open', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline')) // sign: reply lost
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read: the sign has not landed yet
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404)) // the resend reaches a server without /v2
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read: still open
      .mockResolvedValueOnce(jsonResponse({ state: 'signed', signedAt: '2026-12-12T13:15:00.000Z' })); // the next resend signs
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled());
    expect(screen.getByText('We could not confirm that. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText('That did not go through. Please try again.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask for another start date' })).toBeDisabled();
    expect(screen.getByLabelText('Text me about this offer')).toBeDisabled();
    expect(screen.getByLabelText('Type your full name to sign')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/You signed this offer on Sat, Dec 12, 2026\. Welcome to Waves\./)).toBeInTheDocument();
    expect(fetchMock.mock.calls[5][0]).toMatch(new RegExp(`/public/careers/offer/${TOKEN}/v2/accept$`));
    expect(bodyOf(fetchMock, 5)).toEqual({ signedName: 'Jordan Rivera', version: VERSION });
  });

  it('after a lost decline reply and a failed read, the resend is the same decline and its answer is shown', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({}, 502)) // decline: no answer
      .mockRejectedValueOnce(new Error('offline')) // the read fails
      .mockResolvedValueOnce(jsonResponse({ state: 'declined' })); // the resend goes through
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Took another job' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, decline' }));
    expect(await screen.findByText('We could not confirm that. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeDisabled();
    expect(screen.getByLabelText('Reason (optional)')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('You declined this offer. Thank you for your time.')).toBeInTheDocument();
    expect(fetchMock.mock.calls[3][0]).toMatch(/\/v2\/decline$/);
    expect(bodyOf(fetchMock, 3)).toEqual(bodyOf(fetchMock, 1));
  });

  it('keeps a lost sign the only action when its resend is refused before the offer is checked (429)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline')) // sign: reply lost
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read: not landed yet
      .mockResolvedValueOnce(jsonResponse({ error: 'Too many requests, please try again shortly.' }, 429)) // the resend
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read after it: still open
      .mockResolvedValueOnce(jsonResponse({ state: 'signed', signedAt: '2026-12-12T13:15:00.000Z' })); // the next resend signs
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Too many requests, please try again shortly.')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(screen.getByText('We could not confirm that. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask for another start date' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/You signed this offer on Sat, Dec 12, 2026\. Welcome to Waves\./)).toBeInTheDocument();
    expect(bodyOf(fetchMock, 5)).toEqual({ signedName: 'Jordan Rivera', version: VERSION });
  });

  it('frees the date for a new value when the resend of a lost date request is refused as invalid and the offer reads open', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline')) // date request: reply lost
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read: still open
      .mockResolvedValueOnce(jsonResponse({ error: 'Pick a start date after today.' }, 400)) // the resend, after midnight
      .mockResolvedValueOnce(jsonResponse(openPayload())) // the read: still open
      .mockResolvedValueOnce(jsonResponse({ state: 'date_requested' })); // the new date
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for another start date' }));
    fireEvent.change(screen.getByLabelText(/Another start date/), { target: { value: '2027-01-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send this date' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Another start date/)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Pick a start date after today.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Another start date/)).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Another start date/), { target: { value: '2027-01-12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send this date' }));
    expect(await screen.findByText('You asked to start on Tue, Jan 12, 2027.')).toBeInTheDocument();
    expect(bodyOf(fetchMock, 5)).toEqual({ requestedStartDate: '2027-01-12', version: VERSION });
  });

  it('keeps a text choice locked when its resend after a lost reply is refused, until a save settles it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline')) // POST consent true: reply lost
      .mockRejectedValueOnce(new Error('offline')) // the read fails
      .mockResolvedValueOnce(jsonResponse({ error: 'Too many requests, please try again shortly.' }, 429)) // the resend is refused
      .mockResolvedValueOnce(jsonResponse({ textConsent: true, version: '2026-12-11T15:21:00.000Z' })); // the next resend is saved
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByLabelText('Text me about this offer'));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(await screen.findByText(/We could not confirm that choice/)).toBeInTheDocument();
    expect(screen.getByLabelText('Text me about this offer')).toBeChecked(); // never guessed back to off
    expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeEnabled());
    expect(screen.getByLabelText('Text me about this offer')).toBeChecked();
    expect(bodyOf(fetchMock, 4)).toEqual({ consent: true, version: VERSION });
  });

  it('locks the other panel while the accept request is pending', async () => {
    let finish;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Yes, decline' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish(jsonResponse({ state: 'signed', signedAt: '2026-12-12T13:15:00.000Z' }));
    expect(await screen.findByText(/You signed this offer/)).toBeInTheDocument();
  });

  it('blocks signing until the text consent choice is saved', async () => {
    let finish;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload({ textConsent: true })))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByLabelText('Text me about this offer'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Saving|Accept and sign/ })).toBeDisabled());
    finish(jsonResponse({ textConsent: false, version: '2026-12-11T15:21:00.000Z' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept and sign' })).toBeEnabled());
    expect(screen.getByLabelText('Text me about this offer')).not.toBeChecked();
  });

  it('shows the signing date in Eastern time', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload({ state: 'signed', signedAt: '2026-12-13T00:00:00.000Z' })));
    renderPage();
    expect(await screen.findByText(/^This offer was signed on Sat, Dec 12, 2026\./)).toBeInTheDocument();
  });

  it('re-reads the offer when signing answers 502, and names the signer on record', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse(openPayload({ state: 'signed', signedName: 'JORDAN RIVERA', signedAt: '2026-12-12T13:15:00.000Z' })));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: '  Jordan   Rivera ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/^This offer was signed by JORDAN RIVERA on Sat, Dec 12, 2026\./)).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).toBeNull();
  });

  // Another tab signed under another name while this tab's reply was lost:
  // the read shows that signature, and this tab must not claim it.
  it.each([
    ['sign', 'Jordan M. Rivera'],
    ['decline', 'Jordan Rivera'],
  ])('after a lost %s reply, a read that shows a signature names the signer, never "You signed"', async (act, onRecord) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline')) // this tab's send: reply lost
      .mockResolvedValueOnce(jsonResponse(openPayload({ state: 'signed', signedName: onRecord, signedAt: '2026-12-12T13:15:00.000Z' })));
    globalThis.fetch = fetchMock;
    renderPage();
    if (act === 'sign') {
      fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
      fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
      fireEvent.click(screen.getByRole('button', { name: 'Yes, decline' }));
    }
    expect(await screen.findByText(new RegExp(`^This offer was signed by ${onRecord.replace('.', '\\.')} on Sat, Dec 12, 2026\\.`))).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).toBeNull();
  });

  it('keeps the form and shows an error when the connection drops', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(openPayload()))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse(openPayload()));
    globalThis.fetch = fetchMock;
    renderPage();
    fireEvent.change(await screen.findByLabelText('Type your full name to sign'), { target: { value: 'Jordan Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign' }));
    expect(await screen.findByText(/Check your connection and try again/)).toBeInTheDocument();
    expect(screen.getByLabelText('Type your full name to sign')).toHaveValue('Jordan Rivera');
  });
});

describe('CareersOfferPage — other states', () => {
  // Anyone with the link may open a signed offer, so the page names the signer
  // and the date; "You signed" is only for the tab that sent that signature.
  it('names the signer and the date on a return visit, never "You signed"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload({ state: 'signed', signedName: 'Jordan Rivera', signedAt: '2026-12-12T13:15:00.000Z' })));
    renderPage();
    expect(await screen.findByText(/^This offer was signed by Jordan Rivera on Sat, Dec 12, 2026\. Welcome to Waves\. Sam will contact you about your first day\./)).toBeInTheDocument();
    expect(screen.queryByText(/You signed this offer/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept and sign' })).toBeNull();
  });

  // Anyone with the link may open it, so a return visit tells a decline or a
  // date request in neutral words, as it does a signature.
  it('tells a declined or date-asked offer in neutral words on a return visit', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload({ state: 'declined' })));
    const first = renderPage();
    expect(await screen.findByText('This offer was declined. Thank you for your time.')).toBeInTheDocument();
    first.unmount();
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload({ state: 'date_requested', requestedStartDate: '2027-01-11' })));
    renderPage();
    expect(await screen.findByText('Sam will look at the new date. If it works, he will send an updated offer.')).toBeInTheDocument();
    expect(screen.getByText('A new start date was asked for: Mon, Jan 11, 2027.')).toBeInTheDocument();
    expect(screen.queryByText(/You asked to start on|You declined/)).toBeNull();
  });

  it.each(['expired', 'withdrawn', 'superseded'])('shows only the message and the phone for %s', async (state) => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ state, message: `Server words for ${state}.`, contactPhone: '(941) 297-5749' }));
    renderPage();
    expect(await screen.findByText(`Server words for ${state}.`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '(941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
    expect(screen.queryByText('Accept and sign')).toBeNull();
    expect(screen.queryByText(/Technician Terms/)).toBeNull();
  });

  // A stored message hides only the literal link (any letter case), so only
  // that spelling may open the offer: an encoded or malformed one never asks.
  it.each([
    [`/careers/offer/%61${TOKEN.slice(1)}`],
    [`/careers/%6Fffer/${TOKEN}`],
    [`/careers/offer/${TOKEN.toUpperCase()}`],
    ['/careers/offer/tok-123'],
  ])('shows the not-valid page for %s without reading the offer', async (path) => {
    globalThis.fetch = vi.fn();
    renderPage(path);
    expect(await screen.findByRole('heading', { name: 'This link is not valid.' })).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('opens the literal link in any letter case of the path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload()));
    renderPage(`/Careers/Offer/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Your job offer' })).toBeInTheDocument();
    expect(globalThis.fetch.mock.calls[0][0]).toMatch(new RegExp(`/public/careers/offer/${TOKEN}$`));
  });

  it('shows a plain not-valid page on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, 404));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'This link is not valid.' })).toBeInTheDocument();
  });

  it('offers a retry when the load fails', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse(openPayload()));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Pest Control Technician')).toBeInTheDocument();
  });

  it('marks the page noindex and no-referrer while it is open', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(openPayload()));
    const view = renderPage();
    await screen.findByText('Pest Control Technician');
    expect(document.head.querySelector('meta[name="robots"]').content).toMatch(/noindex/);
    expect(document.head.querySelector('meta[name="referrer"]').content).toBe('no-referrer');
    view.unmount();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });
});
