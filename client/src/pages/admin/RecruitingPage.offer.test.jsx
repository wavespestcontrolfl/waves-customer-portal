// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RecruitingPage from './RecruitingPage';

// The offer endpoints are built in the server PR; these tests mock the contract shapes.

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body), clone() { return this; } };
}

const CONTACT = { name: 'Jordan Rivera', phone: '9415550123', email: 'jordan.rivera@example.com' };

function detailFixture(overrides = {}) {
  return {
    id: 'app-1',
    role: 'technician',
    status: 'interview',
    language: 'en',
    contact_snapshot: CONTACT,
    answers: {},
    ai_score: 80,
    ai_recommendation: 'strong',
    ai_screen: null,
    comms_history: [],
    status_history: [],
    created_at: '2026-09-10T12:00:00Z',
    ...overrides,
  };
}

const DEFAULTS = {
  jobTitle: 'Pest Control Technician',
  startDate: '2027-01-04',
  hourlyRate: 23,
  stepRate: 25,
  stepEffectiveOn: '2027-04-05',
  hoursLine: '40 paid hours each full week, four 10-hour days, Monday to Thursday',
};

function offerPayload(overrides = {}) {
  return {
    enabled: true,
    termsIssued: true,
    terms: { templateId: 't1', versionId: 'v1', title: 'Offer Letter: Technician Terms', issuedAt: '2026-11-10T15:00:00Z' },
    termsBlockers: [],
    defaults: DEFAULTS,
    letterPreview: { markdown: '# Your job offer\n\nStart: **Monday, January 4, 2027**.\n\n<script>alert(1)</script>' },
    current: null,
    history: [],
    ...overrides,
  };
}

function offerRecord(overrides = {}) {
  return {
    id: 'offer-1',
    applicationId: 'app-1',
    status: 'draft',
    ...DEFAULTS,
    reportTo: 'Owner, owner',
    timeline: [{ at: '2026-12-11T14:00:00Z', kind: 'drafted', label: 'Draft saved' }],
    ...overrides,
  };
}

// routes: { 'METHOD path-suffix': () => response }
function setupFetch(routes, { offer = offerPayload(), detail = detailFixture() } = {}) {
  const calls = [];
  const fetchMock = vi.fn((url, options = {}) => {
    const method = options.method || 'GET';
    const path = String(url).replace(/^.*\/api/, '');
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    const key = `${method} ${path}`;
    if (routes[key]) return Promise.resolve(routes[key]());
    if (path.startsWith('/admin/careers?status=')) {
      return Promise.resolve(res(200, {
        applications: [{ id: 'app-1', role: 'technician', status: detail.status, contact_snapshot: { name: CONTACT.name }, ai_score: 80, created_at: '2026-09-10T12:00:00Z' }],
        counts: {},
      }));
    }
    if (key === 'GET /admin/careers/app-1/offer') {
      return Promise.resolve(typeof offer === 'function' ? offer() : res(200, offer));
    }
    if (key === 'GET /admin/careers/app-1') return Promise.resolve(res(200, { application: detail }));
    if (path.includes('/stage-preview')) {
      return Promise.resolve(res(200, { status: 'offer', templated: false, channels: {}, sending_enabled: false }));
    }
    return Promise.resolve(res(200, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

async function openDetail() {
  render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
  fireEvent.click(await screen.findByText(CONTACT.name));
  await screen.findByRole('heading', { name: /Jordan Rivera — / });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'admin-token');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RecruitingPage offer flow: gate off', () => {
  it('keeps today status-only Offer move when the offer call answers 404 enabled:false', async () => {
    setupFetch({}, { offer: () => res(404, { enabled: false }) });
    await openDetail();
    const offerButton = screen.getByRole('button', { name: 'Offer' });
    await waitFor(() => expect(offerButton).not.toBeDisabled());
    fireEvent.click(offerButton);
    expect(await screen.findByRole('heading', { name: 'Move to Offer' })).toBeInTheDocument();
    expect(screen.queryByText('Letter preview')).toBeNull();
  });

  it('keeps the status-only move for a non-technician application even when the flow is on', async () => {
    setupFetch({}, { detail: detailFixture({ role: 'sales' }) });
    await openDetail();
    const offerButton = screen.getByRole('button', { name: 'Offer' });
    await waitFor(() => expect(offerButton).not.toBeDisabled());
    fireEvent.click(offerButton);
    expect(await screen.findByRole('heading', { name: 'Move to Offer' })).toBeInTheDocument();
  });
});

describe('RecruitingPage offer flow: form', () => {
  async function openForm() {
    await openDetail();
    const offerButton = screen.getByRole('button', { name: 'Offer' });
    await waitFor(() => expect(offerButton).not.toBeDisabled());
    fireEvent.click(offerButton);
    await screen.findByLabelText('Hourly rate ($)');
  }

  it('opens prefilled from the defaults with a safe letter preview and the masked contact', async () => {
    setupFetch({});
    await openForm();
    expect(screen.getByLabelText('Job')).toHaveValue('Pest Control Technician');
    expect(screen.getByLabelText('Start date')).toHaveValue('2027-01-04');
    expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue(23);
    expect(screen.getByLabelText('Step rate ($)')).toHaveValue(25);
    expect(screen.getByLabelText('Step date')).toHaveValue('2027-04-05');
    expect(screen.getByLabelText('Hours')).toHaveValue(DEFAULTS.hoursLine);
    expect(screen.getByText(/Offer Letter: Technician Terms/)).toBeInTheDocument();
    expect(screen.getByText('Text (941) ***-0123 · Email j***@example.com')).toBeInTheDocument();
    const preview = screen.getByText('Letter preview').parentElement;
    expect(within(preview).getByRole('heading', { name: 'Your job offer' })).toBeInTheDocument();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview).toHaveTextContent('<script>alert(1)</script>');
    expect(screen.getByRole('button', { name: 'Send offer' })).toBeDisabled();
  });

  it('recomputes the step date when the start date changes and refuses Friday to Sunday', async () => {
    setupFetch({});
    await openForm();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-05' } });
    expect(screen.getByLabelText('Step date')).toHaveValue('2027-04-05');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    expect(screen.getByLabelText('Step date')).toHaveValue('2027-04-12');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-09' } });
    expect(screen.getByText('Pick a Monday to Thursday.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('saves the draft, then asks before sending one text and one email', async () => {
    const saved = offerRecord({ startDate: '2027-01-11', stepEffectiveOn: '2027-04-12' });
    const { calls } = setupFetch({
      'POST /admin/careers/app-1/offer': () => res(200, { offer: saved }),
      'POST /admin/careers/app-1/offer/offer-1/send': () =>
        res(200, { offer: { ...saved, status: 'sent' }, comms: { sms: { outcome: 'sent' }, email: { outcome: 'sent' } } }),
    });
    await openForm();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    expect(screen.getByRole('button', { name: 'Send offer' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send offer' })).not.toBeDisabled());
    const save = calls.find((c) => c.method === 'POST' && c.path === '/admin/careers/app-1/offer');
    expect(save.body).toEqual({
      jobTitle: 'Pest Control Technician',
      startDate: '2027-01-11',
      hourlyRate: 23,
      stepRate: 25,
      stepEffectiveOn: '2027-04-12',
      hoursLine: DEFAULTS.hoursLine,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('Send this offer to Jordan? It sends one text and one email.')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/send'))).toBe(false);
    const confirmDialog = screen.getByText('Send this offer to Jordan? It sends one text and one email.').closest('[role="dialog"]');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('Offer sent to Jordan.')).toBeInTheDocument();
    expect(screen.getByText('Text sent. Email sent.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/send'))).toHaveLength(1);
  });

  it('shows the terms blockers and keeps Send off when the terms are not issued', async () => {
    setupFetch({}, { offer: offerPayload({ termsIssued: false, terms: null, termsBlockers: ['Decision needed: pay day wording'] }) });
    await openForm();
    expect(screen.getByText('Decision needed: pay day wording')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send offer' })).toBeDisabled();
  });

  it('shows a 409 code from the send as a plain sentence', async () => {
    const saved = offerRecord();
    setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-1/send': () => res(409, { error: 'conflict', code: 'NO_CONTACT' }),
      },
      { offer: offerPayload({ current: saved }) },
    );
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirmDialog = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('This applicant has no phone or email on file, so nothing can be sent.')).toBeInTheDocument();
  });

  it('shows the closed-application sentence when the save is refused', async () => {
    setupFetch({ 'POST /admin/careers/app-1/offer': () => res(409, { error: 'x', code: 'APPLICATION_CLOSED' }) });
    await openForm();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/This application is closed/)).toBeInTheDocument();
  });
});

describe('RecruitingPage offer flow: timeline card', () => {
  const sent = offerRecord({
    status: 'sent',
    sentAt: '2026-12-11T15:20:00Z',
    timeline: [
      { at: '2026-12-11T15:20:00Z', kind: 'sent', label: 'Offer sent, text and email' },
      { at: '2026-12-11T17:02:00Z', kind: 'opened', label: 'Opened' },
    ],
  });

  async function openCard() {
    await openDetail();
    return screen.findByTestId('offer-card');
  }

  it('lists the timeline in Eastern and offers Revise and Withdraw for a sent offer', async () => {
    setupFetch({}, { offer: offerPayload({ current: sent }), detail: detailFixture({ status: 'offer' }) });
    const card = await openCard();
    expect(within(card).getByText('Offer sent, text and email')).toBeInTheDocument();
    expect(within(card).getByText('Fri Dec 11, 10:20 AM')).toBeInTheDocument();
    expect(within(card).getByText('Fri Dec 11, 12:02 PM')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Revise' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'View signed copy' })).toBeNull();
  });

  it('Revise posts, then opens the new draft in the form', async () => {
    const draft = offerRecord({ id: 'offer-2', startDate: '2027-01-11', supersedesId: 'offer-1' });
    const { calls } = setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/revise': () => res(200, { offer: draft }) },
      { offer: offerPayload({ current: sent }), detail: detailFixture({ status: 'offer' }) },
    );
    const card = await openCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Revise' }));
    await screen.findByLabelText('Hourly rate ($)');
    expect(screen.getByLabelText('Start date')).toHaveValue('2027-01-11');
    expect(calls.find((c) => c.path.endsWith('/revise')).body).toEqual({});
  });

  it('Withdraw asks first, then posts', async () => {
    const { calls } = setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/withdraw': () => res(200, { offer: { ...sent, status: 'withdrawn' } }) },
      { offer: offerPayload({ current: sent }), detail: detailFixture({ status: 'offer' }) },
    );
    const card = await openCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw' }));
    expect(calls.some((c) => c.path.endsWith('/withdraw'))).toBe(false);
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/withdraw'))).toHaveLength(1));
  });

  it('a date request offers an updated offer for the asked date', async () => {
    const asked = offerRecord({
      status: 'date_requested',
      requestedStartDate: '2027-01-11',
      dateRequestNote: 'Need two more weeks',
      timeline: [{ at: '2026-12-12T13:15:00Z', kind: 'date_requested', label: 'Asked for another start date' }],
    });
    const draft = offerRecord({ id: 'offer-2', startDate: '2027-01-11' });
    const { calls } = setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/revise': () => res(200, { offer: draft }) },
      { offer: offerPayload({ current: asked }), detail: detailFixture({ status: 'offer' }) },
    );
    const card = await openCard();
    expect(within(card).getByText(/Need two more weeks/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Make an updated offer for Mon, Jan 11, 2027' }));
    await screen.findByLabelText('Hourly rate ($)');
    expect(calls.find((c) => c.path.endsWith('/revise')).body).toEqual({ startDate: '2027-01-11' });
  });

  it('shows the signed copy in a modal and keeps earlier offers collapsed', async () => {
    const signed = offerRecord({
      status: 'accepted',
      signedAt: '2026-12-12T13:15:00Z',
      signedName: 'Jordan Rivera',
      timeline: [{ at: '2026-12-12T13:15:00Z', kind: 'signed', label: 'Signed by Jordan Rivera' }],
    });
    const older = offerRecord({ id: 'offer-0', status: 'superseded', timeline: [] });
    setupFetch(
      {
        'GET /admin/careers/app-1/offer/offer-1/signed-copy': () =>
          res(200, { markdown: '# Signed offer\n\nTerms.', signedName: 'Jordan Rivera', signedAt: '2026-12-12T13:15:00Z', signedIp: '203.0.113.9', signatureHash: 'abc123' }),
      },
      { offer: offerPayload({ current: signed, history: [older] }), detail: detailFixture({ status: 'hired' }) },
    );
    const card = await openCard();
    const details = card.querySelector('details');
    expect(details).not.toHaveAttribute('open');
    expect(within(card).getByText('Earlier offers (1)')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Revise' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'View signed copy' }));
    expect(await screen.findByRole('heading', { name: 'Signed offer' })).toBeInTheDocument();
    expect(screen.getByText(/Signed by Jordan Rivera/, { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
  });
});
