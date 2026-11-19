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
    terms: { templateId: 't1', versionId: 'v1', title: 'Offer Letter: Technician Terms', issuedAt: '2026-11-11T02:30:00Z' },
    termsBlockers: [],
    viewer: { ownerActions: true },
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
    draftHash: 'hash-1',
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

  it('recomputes the step date when a cleared step rate is restored after a start-date change', async () => {
    setupFetch({});
    await openForm();
    fireEvent.change(screen.getByLabelText('Step rate ($)'), { target: { value: '' } });
    expect(screen.getByLabelText('Step date')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    fireEvent.change(screen.getByLabelText('Step rate ($)'), { target: { value: '25' } });
    expect(screen.getByLabelText('Step date')).toHaveValue('2027-04-12');
  });

  it('hides Send offer for an admin who is not the owner but still lets them save', async () => {
    setupFetch({}, { offer: offerPayload({ viewer: { ownerActions: false } }) });
    await openForm();
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    expect(screen.getByText(/Only the owner can send this offer/)).toBeInTheDocument();
  });

  it('saves the draft, then asks before sending one text and one email', async () => {
    const saved = offerRecord({ startDate: '2027-01-11', stepEffectiveOn: '2027-04-12', draftHash: 'hash-saved' });
    let current = null;
    const { calls } = setupFetch(
      {
        'POST /admin/careers/app-1/offer': () => {
          current = saved;
          return res(200, { offer: saved });
        },
        'POST /admin/careers/app-1/offer/offer-1/send': () =>
          res(200, { offer: { ...saved, status: 'sent' }, comms: { sms: { outcome: 'sent' }, email: { outcome: 'sent' } } }),
      },
      { offer: () => res(200, offerPayload({ current })) },
    );
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
    const sends = calls.filter((c) => c.path.endsWith('/send'));
    expect(sends).toHaveLength(1);
    // Send names the draft the owner read, by the hash of that draft.
    expect(sends[0].body).toEqual({ draftHash: 'hash-saved' });
  });

  it('shows the terms issue day in Eastern, not as the UTC day', async () => {
    setupFetch({});
    await openForm();
    expect(screen.getByText(/issued Nov 10, 2026/)).toBeInTheDocument();
  });

  it('on DRAFT_CHANGED it reloads the draft, shows the new preview and sends nothing more', async () => {
    let current = offerRecord({ draftHash: 'old' });
    const { calls } = setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-1/send': () => {
          current = offerRecord({ draftHash: 'new', hourlyRate: 24 });
          return res(409, { error: 'x', code: 'DRAFT_CHANGED' });
        },
      },
      { offer: () => res(200, offerPayload({ current, letterPreview: { markdown: `Rate ${current.hourlyRate}` } })) },
    );
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirmDialog = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('This draft changed after you opened it. Review the new preview, then send.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue(24));
    expect(screen.getByText('Rate 24')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/send'))).toHaveLength(1);
    // The next send carries the new hash.
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText(/Send this offer to Jordan/)).toBeInTheDocument();
  });

  it('after a save whose re-read fails the dialog is read-only with Try again that re-reads and never re-saves', async () => {
    let failRead = false;
    let readOk = false;
    const saved = offerRecord({ startDate: '2027-01-11', stepEffectiveOn: '2027-04-12', draftHash: 'hash-after' });
    const { calls } = setupFetch(
      { 'POST /admin/careers/app-1/offer': () => { failRead = true; return res(200, { offer: saved }); } },
      { offer: () => (failRead && !readOk ? res(500, { error: 'boom' }) : res(200, offerPayload({ current: readOk ? saved : null }))) },
    );
    await openForm();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/could not be loaded after your last change/)).toBeInTheDocument();
    expect(screen.getByLabelText('Hourly rate ($)')).toBeDisabled();
    expect(screen.getByLabelText('Start date')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    // Try again re-reads; the read now holds the saved draft.
    readOk = true;
    const dialog = screen.getByLabelText('Hourly rate ($)').closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByLabelText('Hourly rate ($)')).not.toBeDisabled());
    expect(screen.getByLabelText('Start date')).toHaveValue('2027-01-11');
    expect(screen.getByRole('button', { name: 'Send offer' })).not.toBeDisabled();
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/admin/careers/app-1/offer')).toHaveLength(1);
  });

  it('disables every field and button while a save runs, so no edit can be overwritten', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const saved = offerRecord({ startDate: '2027-01-11' });
    let current = null;
    setupFetch({}, { offer: () => res(200, offerPayload({ current })) });
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if ((options.method || 'GET') === 'POST' && String(url).endsWith('/admin/careers/app-1/offer')) {
        return gate.then(() => { current = saved; return res(200, { offer: saved }); });
      }
      return base(url, options);
    }));
    await openForm();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByLabelText('Hourly rate ($)')).toBeDisabled());
    for (const label of ['Job', 'Start date', 'Step rate ($)', 'Step date', 'Hours']) expect(screen.getByLabelText(label)).toBeDisabled();
    const saving = screen.getByLabelText('Hourly rate ($)').closest('[role="dialog"]');
    expect(within(saving).getByRole('button', { name: 'Close' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByLabelText('Hourly rate ($)')).not.toBeDisabled());
    expect(screen.getByLabelText('Start date')).toHaveValue('2027-01-11');
  });

  it.each([
    [{ name: 'Jordan Rivera', phone: '9415550123', email: 'j@example.com' }, 'It sends one text and one email.'],
    [{ name: 'Jordan Rivera', phone: '9415550123' }, 'It sends one text.'],
    [{ name: 'Jordan Rivera', email: 'j@example.com' }, 'It sends one email.'],
  ])('the send confirm names only the contact methods on file (%#)', async (contact, sentence) => {
    setupFetch({}, { offer: offerPayload({ current: offerRecord() }), detail: detailFixture({ contact_snapshot: contact }) });
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText(`Send this offer to Jordan? ${sentence}`)).toBeInTheDocument();
  });

  it('with no phone or email the confirm promises nothing and the server NO_CONTACT sentence shows', async () => {
    setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/send': () => res(409, { error: 'x', code: 'NO_CONTACT' }) },
      { offer: offerPayload({ current: offerRecord() }), detail: detailFixture({ contact_snapshot: { name: 'Jordan Rivera' } }) },
    );
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText('Send this offer to Jordan?')).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findAllByText('This applicant has no phone or email on file, so nothing can be sent.')).not.toHaveLength(0);
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
    expect(within(card).getByText('Fri, Dec 11, 10:20 AM')).toBeInTheDocument();
    expect(within(card).getByText('Fri, Dec 11, 12:02 PM')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Revise' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Withdraw offer' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'View signed copy' })).toBeNull();
  });

  it('Revise posts, then opens the new draft in the form', async () => {
    const draft = offerRecord({ id: 'offer-2', startDate: '2027-01-11', supersedesId: 'offer-1' });
    let revised = false;
    const { calls } = setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/revise': () => { revised = true; return res(200, { offer: draft }); } },
      { offer: () => res(200, offerPayload({ current: sent, draft: revised ? draft : null })), detail: detailFixture({ status: 'offer' }) },
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
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
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
    let revised = false;
    const { calls } = setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/revise': () => { revised = true; return res(200, { offer: draft }); } },
      { offer: () => res(200, offerPayload({ current: asked, draft: revised ? draft : null })), detail: detailFixture({ status: 'offer' }) },
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

describe('RecruitingPage offer flow: read failures, re-offers and drafts', () => {
  it('a failed offer read shows an error with Try again and no status-only move', async () => {
    let fail = true;
    setupFetch({}, { offer: () => (fail ? res(500, { error: 'Server error' }) : res(200, offerPayload())) });
    await openDetail();
    expect(await screen.findByText('Server error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Offer' })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Move to Offer' })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Offer' }));
    await screen.findByLabelText('Hourly rate ($)');
  });

  it('a 404 without enabled:false is a failure, not the gate-off answer', async () => {
    setupFetch({}, { offer: () => res(404, { error: 'Not found' }) });
    await openDetail();
    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Offer' })).toBeDisabled();
  });

  it.each(['withdrawn', 'expired'])('offers Make an offer next to a %s offer while the application is in Offer', async (status) => {
    const old = offerRecord({ status, timeline: [{ at: '2026-12-11T15:20:00Z', kind: status, label: 'Closed' }] });
    setupFetch({}, { offer: offerPayload({ current: old }), detail: detailFixture({ status: 'offer' }) });
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Make an offer' }));
    expect(await screen.findByLabelText('Hourly rate ($)')).toBeInTheDocument();
    expect(screen.getByLabelText('Start date')).toHaveValue('2027-01-04');
  });

  it.each([['accepted', 'hired'], ['declined', 'withdrawn']])('no new offer after a %s offer', async (status, appStatus) => {
    const old = offerRecord({ status, timeline: [] });
    setupFetch({}, { offer: offerPayload({ current: old }), detail: detailFixture({ status: appStatus }) });
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    expect(within(card).queryByRole('button', { name: 'Make an offer' })).toBeNull();
  });

  it('labels a revision draft as the draft and keeps Withdraw for the sent offer', async () => {
    const sent = offerRecord({ status: 'sent', timeline: [] });
    const draft = offerRecord({ id: 'offer-2', startDate: '2027-01-11', supersedesId: 'offer-1' });
    const { calls } = setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-2/withdraw': () => res(200, { offer: { ...draft, status: 'withdrawn' } }) },
      { offer: offerPayload({ current: sent, draft }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    expect(within(card).getByRole('button', { name: 'Open the updated draft' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Revise' })).toBeNull();
    // The sent offer's own action is Withdraw offer and its confirm says the link stops.
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const withdrawDialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    expect(withdrawDialog).toHaveTextContent('His link stops working');
    fireEvent.click(within(withdrawDialog).getByRole('button', { name: 'Cancel' }));
    // The draft's action never promises that the link stops.
    fireEvent.click(within(card).getByRole('button', { name: 'Discard this draft — the offer you sent stays open' }));
    const discardDialog = (await screen.findByText(/Discard this draft\? The offer you sent/)).closest('[role="dialog"]');
    expect(discardDialog).toHaveTextContent('stays open and his link keeps working');
    expect(discardDialog).not.toHaveTextContent('stops working');
    fireEvent.click(within(discardDialog).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/admin/careers/app-1/offer/offer-2/withdraw')).toHaveLength(1));
    expect(calls.some((c) => c.path === '/admin/careers/app-1/offer/offer-1/withdraw')).toBe(false);
  });
});

describe('RecruitingPage offer flow: owner actions, stale reads and applicant switches', () => {
  const sent = offerRecord({ status: 'sent', timeline: [] });
  const asked = offerRecord({ status: 'date_requested', requestedStartDate: '2027-01-11', timeline: [] });
  const draft = offerRecord({ id: 'offer-2', supersedesId: 'offer-1' });

  it('without viewer.ownerActions the card hides Revise, Withdraw, Discard and the updated-offer button but keeps the signed copy', async () => {
    const signed = offerRecord({ status: 'accepted', signedAt: '2026-12-12T13:15:00Z', signedName: 'Jordan Rivera', timeline: [] });
    setupFetch({}, { offer: offerPayload({ current: signed, viewer: { ownerActions: false } }), detail: detailFixture({ status: 'hired' }) });
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    expect(within(card).getByRole('button', { name: 'View signed copy' })).toBeInTheDocument();

    cleanup();
    setupFetch({}, { offer: offerPayload({ current: asked, draft, viewer: { ownerActions: false } }), detail: detailFixture({ status: 'offer' }) });
    await openDetail();
    const card2 = await screen.findByTestId('offer-card');
    expect(within(card2).getByRole('button', { name: 'Open the updated draft' })).toBeInTheDocument();
    for (const name of ['Revise', 'Withdraw offer', 'Discard this draft — the offer you sent stays open', /Make an updated offer/]) {
      expect(within(card2).queryByRole('button', { name })).toBeNull();
    }
  });

  it('after a successful withdraw whose re-read fails it shows Try again and disables the stale actions', async () => {
    let failRead = false;
    setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/withdraw': () => { failRead = true; return res(200, { offer: { ...sent, status: 'withdrawn' } }); } },
      { offer: () => (failRead ? res(500, { error: 'Read failed' }) : res(200, offerPayload({ current: sent }))), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('Read failed')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Revise' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Withdraw offer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Interview' })).toBeInTheDocument();
    failRead = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Read failed')).toBeNull());
    expect(within(await screen.findByTestId('offer-card')).getByRole('button', { name: 'Revise' })).toBeInTheDocument();
  });

  it('drops a Revise result that comes back after the owner opened another applicant', async () => {
    let releaseRevise;
    const pending = new Promise((resolve) => { releaseRevise = resolve; });
    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method || 'GET';
      const path = String(url).replace(/^.*\/api/, '');
      if (path.startsWith('/admin/careers?status=')) {
        return Promise.resolve(res(200, {
          applications: ['app-1', 'app-2'].map((id, i) => ({ id, role: 'technician', status: 'offer', contact_snapshot: { name: i ? 'Casey Morgan' : 'Jordan Rivera' }, created_at: '2026-09-10T12:00:00Z' })),
          counts: {},
        }));
      }
      if (method === 'POST' && path.endsWith('/offer/offer-1/revise')) return pending.then(() => res(200, { offer: draft }));
      if (path === '/admin/careers/app-1/offer') return Promise.resolve(res(200, offerPayload({ current: sent })));
      if (path === '/admin/careers/app-2/offer') return Promise.resolve(res(200, offerPayload({ current: null })));
      if (path === '/admin/careers/app-1') return Promise.resolve(res(200, { application: detailFixture({ status: 'offer' }) }));
      if (path === '/admin/careers/app-2') return Promise.resolve(res(200, { application: detailFixture({ id: 'app-2', status: 'offer', contact_snapshot: { name: 'Casey Morgan', phone: '9415550199', email: 'casey@example.com' } }) }));
      return Promise.resolve(res(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Jordan Rivera'));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Revise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('offer-card')).toBeNull());
    fireEvent.click(await screen.findByText('Casey Morgan'));
    await screen.findByRole('heading', { name: /Casey Morgan/ });
    releaseRevise();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText('Hourly rate ($)')).toBeNull();
  });
});

describe('RecruitingPage offer flow: one source of truth', () => {
  const sent = offerRecord({ status: 'sent', timeline: [] });
  const draft = offerRecord({ id: 'offer-2', startDate: '2027-01-11', supersedesId: 'offer-1' });

  it('Revise opens the new draft only after a read that holds it; a failed read leaves Try again and no form', async () => {
    let revised = false;
    let failRead = false;
    setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/revise': () => { revised = true; failRead = true; return res(200, { offer: draft }); } },
      { offer: () => (failRead ? res(500, { error: 'Read failed' }) : res(200, offerPayload({ current: sent, draft: revised ? draft : null }))), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Revise' }));
    expect(await screen.findByText('Read failed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Hourly rate ($)')).toBeNull();
    failRead = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open the updated draft' }));
    expect(await screen.findByLabelText('Start date')).toHaveValue('2027-01-11');
  });

  it('a failed re-read with no offer yet shows Try again in the section after the dialog is closed', async () => {
    let failRead = false;
    setupFetch(
      { 'POST /admin/careers/app-1/offer': () => { failRead = true; return res(200, { offer: offerRecord() }); } },
      { offer: () => (failRead ? res(500, { error: 'Read failed' }) : res(200, offerPayload())), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Make an offer' }));
    await screen.findByLabelText('Hourly rate ($)');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText(/could not be loaded after your last change/);
    const dlg = screen.getByLabelText('Hourly rate ($)').closest('[role="dialog"]');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText('Hourly rate ($)')).toBeNull());
    expect(await screen.findByText('Read failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
