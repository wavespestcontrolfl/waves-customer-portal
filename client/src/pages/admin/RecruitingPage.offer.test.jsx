// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RecruitingPage from './RecruitingPage';

// The offer endpoints are built in the server PR; these tests mock the contract shapes.

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body), clone() { return this; } };
}

// A success whose body is not JSON (a proxy's page, a cut-off answer).
function unreadable() {
  return { ok: true, status: 200, json: vi.fn(async () => { throw new SyntaxError('Unexpected token <'); }), clone() { return this; } };
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
  const payload = {
    enabled: true,
    termsIssued: true,
    terms: { templateId: 't1', versionId: 'v1', title: 'Offer Letter: Technician Terms', issuedAt: '2026-11-11T02:30:00Z' },
    termsBlockers: [],
    viewer: { ownerActions: true },
    defaults: DEFAULTS,
    // Who Send reaches, as the server names them (masked).
    sendTo: { sms: '(941) ***-0123', email: 'j***@example.com' },
    // The offer out now that sending the open draft replaces, or null.
    sendReplacesId: null,
    // The offers out as this read saw them; Send carries it back.
    outStamp: 'out-stamp-1',
    current: null,
    draft: null,
    history: [],
    ...overrides,
  };
  // The server builds the letter for the open draft and names it (offerId + draftHash).
  const open = [payload.draft, payload.current].find((o) => o && o.status === 'draft');
  payload.letterPreview = {
    offerId: open ? open.id : null,
    draftHash: open ? open.draftHash : null,
    markdown: '# Your job offer\n\nStart: **Monday, January 4, 2027**.\n\n<script>alert(1)</script>',
    ...(overrides.letterPreview || {}),
  };
  return payload;
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

// The API path of a request. The page's own re-reads of an application add ?peek=1 (they acknowledge no reply); the
// hand-written routers below answer them like an open.
const apiPath = (url) => String(url).replace(/^.*\/api/, '').replace(/\?peek=1$/, '');

// routes: { 'METHOD path-suffix': () => response }
function setupFetch(routes, { offer = offerPayload(), detail = detailFixture() } = {}) {
  const calls = [];
  const fetchMock = vi.fn((url, options = {}) => {
    const method = options.method || 'GET';
    const path = String(url).replace(/^.*\/api/, '');
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    // The page's own re-reads of the application add ?peek=1 (no reply is acknowledged); they answer like an open.
    const key = `${method} ${path}`.replace(/\?peek=1$/, '');
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
  // The fixtures use fixed dates (a Jan 4, 2027 start); freeze only Date so they stay in the future and the
  // Testing Library timers stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-19T15:00:00Z'));
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'admin-token');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('23');
    expect(screen.getByLabelText('Step rate ($)')).toHaveValue('25');
    expect(screen.getByLabelText('Step date')).toHaveValue('2027-04-05');
    expect(screen.getByLabelText('Hours')).toHaveValue(DEFAULTS.hoursLine);
    expect(screen.getByText(/Offer Letter: Technician Terms/)).toBeInTheDocument();
    expect(screen.getByText('Text (941) ***-0123 · Email j***@example.com')).toBeInTheDocument();
    // No saved draft yet: no letter (the server's defaults letter names no draft).
    expect(screen.getByText('Save the draft to see the letter.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send offer' })).toBeDisabled();
  });

  it('shows the saved draft letter as safe text, and never another offer letter', async () => {
    setupFetch({}, { offer: offerPayload({ current: offerRecord() }) });
    await openForm();
    const preview = screen.getByText('Letter preview').parentElement;
    expect(within(preview).getByRole('heading', { name: 'Your job offer' })).toBeInTheDocument();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview).toHaveTextContent('<script>alert(1)</script>');
    cleanup();
    // A letter built for a different offer (or another hash) is never shown.
    setupFetch({}, { offer: offerPayload({ current: offerRecord(), letterPreview: { offerId: 'old-offer', draftHash: 'old' } }) });
    await openForm();
    expect(screen.getByText('Save the draft to see the letter.')).toBeInTheDocument();
    expect(screen.queryByText('Your job offer')).toBeNull();
    // ...and Send stays off: the owner can only send a letter he has on screen.
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
    // A first offer replaces nothing, so the question says nothing about an old link.
    expect(screen.queryByText(/That link stops working/)).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/send'))).toBe(false);
    const confirmDialog = screen.getByText('Send this offer to Jordan? It sends one text and one email.').closest('[role="dialog"]');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('Offer sent to Jordan.')).toBeInTheDocument();
    const sends = calls.filter((c) => c.path.endsWith('/send'));
    expect(sends).toHaveLength(1);
    // Send names the draft the owner read, by the hash of that draft.
    expect(sends[0].body).toEqual({ draftHash: 'hash-saved', expectedOut: 'out-stamp-1' });
  });

  it('shows the terms issue day in Eastern, not as the UTC day', async () => {
    setupFetch({});
    await openForm();
    expect(screen.getByText(/issued Nov 10, 2026/)).toBeInTheDocument();
  });

  it('on DRAFT_CHANGED it keeps the form until the owner shows the new version, then needs a new send', async () => {
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
    expect(await screen.findByText('This draft changed after you opened it, so nothing was done. Review the new version first.')).toBeInTheDocument();
    // Nothing replaces the form by itself: it is read-only, with no Send, until the owner loads the new version.
    expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('23');
    expect(screen.getByLabelText('Hourly rate ($)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the new version' }));
    await waitFor(() => expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('24'));
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
    [{ phone: '9415550123', email: 'j@example.com' }, { sms: '(941) ***-0123', email: 'j***@example.com' }, 'It sends one text and one email.'],
    [{ phone: '9415550123' }, { sms: '(941) ***-0123', email: null }, 'It sends one text.'],
    [{ email: 'j@example.com' }, { sms: null, email: 'j***@example.com' }, 'It sends one email.'],
    // A number too short to mask is still tried by the send, so the question names the text too.
    [{ phone: '555-01', email: 'j@example.com' }, { sms: '***', email: 'j***@example.com' }, 'It sends one text and one email.'],
  ])('the send confirm names every channel the server tries (%#)', async (contact, sendTo, sentence) => {
    setupFetch({}, { offer: offerPayload({ current: offerRecord(), sendTo }), detail: detailFixture({ contact_snapshot: { name: 'Jordan Rivera', ...contact } }) });
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText(`Send this offer to Jordan? ${sentence}`)).toBeInTheDocument();
  });

  it('with no phone or email Send stays off, the form says nothing can be sent, and nothing is posted', async () => {
    const { calls } = setupFetch({}, { offer: offerPayload({ current: offerRecord(), sendTo: { sms: null, email: null } }), detail: detailFixture({ contact_snapshot: { name: 'Jordan Rivera' } }) });
    await openForm();
    expect(screen.getByText('This applicant has no phone or email on file, so nothing can be sent.')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send offer' });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(screen.queryByText('Send this offer to Jordan?')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/send'))).toBe(false);
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
    expect(calls.find((c) => c.path.endsWith('/revise')).body).toEqual({ expectedStatus: 'sent' });
  });

  // The applicant asks for another date between the Revise and the read after it. The card never showed that request,
  // so the form names it before anything else, and Send waits for Continue.
  it('a date request that lands while a Revise runs shows in the form, and Send waits for Continue', async () => {
    const draft = offerRecord({ id: 'offer-2', startDate: '2027-01-11', supersedesId: 'offer-1', draftHash: 'hash-2' });
    let revised = false;
    setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/revise': () => { revised = true; return res(200, { offer: draft }); } },
      {
        offer: () => res(200, revised
          ? offerPayload({
            current: { ...sent, status: 'date_requested', requestedStartDate: '2027-01-18', dateRequestNote: 'Need two more weeks' },
            draft, sendReplacesId: 'offer-1', outStamp: 'out-stamp-2',
          })
          : offerPayload({ current: sent })),
        detail: detailFixture({ status: 'offer' }),
      },
    );
    const card = await openCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Revise' }));
    expect(await screen.findByText(/changed after you opened this form\. Asked to start Mon, Jan 18, 2027\. Note: Need two more weeks/)).toBeInTheDocument();
    expect(screen.getByLabelText('Hourly rate ($)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this draft' }));
    expect(screen.getByLabelText('Hourly rate ($)')).toBeEnabled();
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
    expect(calls.find((c) => c.path.endsWith('/revise')).body).toEqual({ expectedStatus: 'date_requested', startDate: '2027-01-11' });
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

  // accepted and declined: the application was hired or withdrawn, then moved back to Offer.
  it.each(['withdrawn', 'expired', 'accepted', 'declined'])('offers Make an offer next to a %s offer while the application is in Offer', async (status) => {
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
    expect(withdrawDialog).toHaveTextContent('Their link stops working');
    fireEvent.click(within(withdrawDialog).getByRole('button', { name: 'Cancel' }));
    // The draft's action never promises that the link stops.
    fireEvent.click(within(card).getByRole('button', { name: 'Discard this draft — the offer you sent is unchanged' }));
    const discardDialog = (await screen.findByText(/Discard this draft\? The offer you sent/)).closest('[role="dialog"]');
    expect(discardDialog).toHaveTextContent('The offer you sent to Jordan is unchanged.');
    expect(discardDialog).not.toHaveTextContent('stays open');
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
    for (const name of ['Revise', 'Withdraw offer', 'Discard this draft — the offer you sent is unchanged', /Make an updated offer/]) {
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

  it('Try again after a failed offer re-read re-reads the application too, so a stage moved meanwhile shows', async () => {
    let failRead = false;
    let moved = false;
    setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-1/withdraw': () => { failRead = true; return res(200, { offer: { ...sent, status: 'withdrawn' } }); },
        'GET /admin/careers/app-1': () => res(200, { application: detailFixture({ status: moved ? 'reviewed' : 'offer' }) }),
      },
      { offer: () => (failRead ? res(500, { error: 'Read failed' }) : res(200, offerPayload({ current: { ...sent, status: moved ? 'withdrawn' : 'sent' } }))), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('Read failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reviewed' })).toBeInTheDocument(); // the detail still reads Offer
    // Another admin moves the application to Reviewed; then the owner presses the card's Try again.
    failRead = false;
    moved = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Read failed')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reviewed' })).toBeNull()); // the detail reads Reviewed
    expect(screen.getByRole('button', { name: 'Offer' })).toBeInTheDocument();
  });

  // The stage dialog words what the server's stage preview says the move does to the job offers: the same rule and owner
  // check as the move itself, with the offer gate on or off.
  const stagePreview = (offers) => () => res(200, { status: 'reviewed', templated: false, channels: {}, sending_enabled: false, offers });
  const openMove = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    return (await screen.findByRole('heading', { name: 'Move to Reviewed' })).closest('[role="dialog"]');
  };

  it('says before Confirm that moving out of Offer withdraws the offer that is out', async () => {
    setupFetch(
      { 'GET /admin/careers/app-1/stage-preview?status=reviewed': stagePreview({ held: true, draft: false, owner_only: false }) },
      { offer: offerPayload({ current: { ...sent, status: 'sent' } }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    await screen.findByTestId('offer-card');
    const stage = await openMove();
    expect(await within(stage).findByText('This move also withdraws the offer you sent to Jordan, so their link stops working.')).toBeInTheDocument();
    expect(within(stage).getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('keeps Confirm off for a move only the owner account may make, and sends nothing', async () => {
    const { calls } = setupFetch(
      { 'GET /admin/careers/app-1/stage-preview?status=reviewed': stagePreview({ held: true, draft: false, owner_only: true }) },
      { offer: offerPayload({ current: { ...sent, status: 'sent' }, viewer: { ownerActions: false } }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    await screen.findByTestId('offer-card');
    const stage = await openMove();
    expect(await within(stage).findByText('This application has a job offer out. Only the owner account can move it out of Offer.')).toBeInTheDocument();
    const confirm = within(stage).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('with offers turned off, still says what the move withdraws, from the preview', async () => {
    setupFetch(
      { 'GET /admin/careers/app-1/stage-preview?status=reviewed': stagePreview({ held: true, draft: true, owner_only: false }) },
      { offer: () => res(404, { enabled: false }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    const stage = await openMove();
    expect(await within(stage).findByText('This move also withdraws the offer you sent to Jordan, so their link stops working, and discards the unsent draft.')).toBeInTheDocument();
    expect(screen.queryByTestId('offer-card')).toBeNull();
  });

  it('reads the preview again when the job offers changed since it, and sends the offers it showed', async () => {
    let offers = { held: false, draft: true, owner_only: false, stamp: 'a'.repeat(32) };
    const { calls } = setupFetch(
      {
        'GET /admin/careers/app-1/stage-preview?status=reviewed': () => stagePreview(offers)(),
        // Another session sent the draft after the preview: the server refuses the move and changes nothing.
        'PATCH /admin/careers/app-1/status': () => {
          offers = { held: true, draft: false, owner_only: false, stamp: 'b'.repeat(32) };
          return res(409, { error: 'The job offer changed since this opened. Nothing was changed. Check the move again.', code: 'OFFERS_CHANGED', application: detailFixture({ status: 'offer' }) });
        },
      },
      { offer: offerPayload({ current: offerRecord() }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    await screen.findByTestId('offer-card');
    const offerReads = () => calls.filter((c) => c.method === 'GET' && c.path === '/admin/careers/app-1/offer').length;
    const stage = await openMove();
    expect(await within(stage).findByText('This move also discards the unsent offer draft.')).toBeInTheDocument();
    const readsBefore = offerReads();
    fireEvent.click(within(stage).getByRole('button', { name: 'Confirm' }));
    expect(await within(stage).findByText('This move also withdraws the offer you sent to Jordan, so their link stops working.')).toBeInTheDocument();
    expect(within(stage).getByText('The job offer changed since this opened. Nothing was changed. Check the move again.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH').body).toMatchObject({ status: 'reviewed', expected_status: 'offer', expected_offers: 'a'.repeat(32) });
    await waitFor(() => expect(offerReads()).toBeGreaterThan(readsBefore));
    expect(within(stage).getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('after the offers changed, the preview read again turns off a channel that closed since, and the move asks only for the other', async () => {
    const channels = (smsOpen) => ({
      sms: smsOpen ? { available: true, to: '(941) ***-1234', reason: null } : { available: false, to: null, reason: null },
      email: { available: true, to: 'j***@example.com', reason: null },
    });
    let preview = {
      status: 'interview', templated: true, sending_enabled: true, channels: channels(true),
      sms_body: 'Hi Jordan, pick a time: [interview link]', email_subject: 'Your interview', email_body: 'Pick a time: [interview link]',
      offers: { held: false, draft: true, owner_only: false, stamp: 'a'.repeat(32) },
    };
    let patches = 0;
    const { calls } = setupFetch(
      {
        'GET /admin/careers/app-1/stage-preview?status=interview': () => res(200, preview),
        'PATCH /admin/careers/app-1/status': () => {
          patches += 1;
          if (patches > 1) return res(200, { application: detailFixture({ status: 'interview' }), sent: null });
          // Another session sent the draft, and the applicant's number stopped taking texts.
          preview = { ...preview, channels: channels(false), offers: { held: true, draft: false, owner_only: false, stamp: 'b'.repeat(32) } };
          return res(409, { error: 'The job offer changed since this opened. Nothing was changed. Check the move again.', code: 'OFFERS_CHANGED', application: detailFixture({ status: 'offer' }) });
        },
      },
      { offer: offerPayload({ current: offerRecord() }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    await screen.findByTestId('offer-card');
    fireEvent.click(screen.getByRole('button', { name: 'Interview' }));
    const stage = (await screen.findByRole('heading', { name: 'Move to Interview' })).closest('[role="dialog"]');
    expect(await within(stage).findByRole('checkbox', { name: /^Text/ })).toBeChecked();
    fireEvent.click(within(stage).getByRole('button', { name: 'Confirm' }));
    expect(await within(stage).findByText(/withdraws the offer you sent to Jordan/)).toBeInTheDocument();
    const text = within(stage).getByRole('checkbox', { name: /^Text/ });
    expect(text).not.toBeChecked();
    expect(text).toBeDisabled();
    expect(within(stage).getByRole('checkbox', { name: /^Email/ })).toBeChecked();
    fireEvent.click(within(stage).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(patches).toBe(2));
    const second = calls.filter((c) => c.method === 'PATCH')[1].body;
    expect(second).toMatchObject({ expected_offers: 'b'.repeat(32), notify: { sms: false, email: true } });
  });

  const interviewPreview = (offers) => ({
    status: 'interview', templated: true, sending_enabled: true,
    channels: { sms: { available: true, to: '(941) ***-1234', reason: null }, email: { available: true, to: 'j***@example.com', reason: null } },
    sms_body: 'Hi Jordan, pick a time: [interview link]', email_subject: 'Your interview', email_body: 'Pick a time: [interview link]',
    offers,
  });

  it('after the offers changed, a failed preview read offers Try again, which reads the move again and keeps the note and the edited message', async () => {
    let preview = interviewPreview({ held: false, draft: true, owner_only: false, stamp: 'a'.repeat(32) });
    let failPreview = false;
    let patches = 0;
    const { calls } = setupFetch(
      {
        'GET /admin/careers/app-1/stage-preview?status=interview': () => (failPreview ? res(500, { error: 'The preview could not be loaded.' }) : res(200, preview)),
        'PATCH /admin/careers/app-1/status': () => {
          patches += 1;
          if (patches > 1) return res(200, { application: detailFixture({ status: 'interview' }), sent: null });
          // Another session sent the draft, and the preview read after the refusal fails.
          preview = { ...preview, offers: { held: true, draft: false, owner_only: false, stamp: 'b'.repeat(32) } };
          failPreview = true;
          return res(409, { error: 'The job offer changed since this opened. Nothing was changed. Check the move again.', code: 'OFFERS_CHANGED', application: detailFixture({ status: 'offer' }) });
        },
      },
      { offer: offerPayload({ current: offerRecord() }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    await screen.findByTestId('offer-card');
    fireEvent.click(screen.getByRole('button', { name: 'Interview' }));
    const stage = (await screen.findByRole('heading', { name: 'Move to Interview' })).closest('[role="dialog"]');
    fireEvent.change(await within(stage).findByLabelText('Note'), { target: { value: 'Call before noon.' } });
    fireEvent.change(within(stage).getByLabelText('Text message'), { target: { value: 'Hi Jordan, call me first: [interview link]' } });
    fireEvent.click(within(stage).getByRole('button', { name: 'Confirm' }));
    expect(await within(stage).findByText('The preview could not be loaded.')).toBeInTheDocument();
    expect(within(stage).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    failPreview = false;
    fireEvent.click(within(stage).getByRole('button', { name: 'Try again' }));
    expect(await within(stage).findByText(/withdraws the offer you sent to Jordan/)).toBeInTheDocument();
    expect(within(stage).getByLabelText('Note')).toHaveValue('Call before noon.');
    expect(within(stage).getByLabelText('Text message')).toHaveValue('Hi Jordan, call me first: [interview link]');
    fireEvent.click(within(stage).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(patches).toBe(2));
    const second = calls.filter((c) => c.method === 'PATCH')[1].body;
    expect(second).toMatchObject({ expected_offers: 'b'.repeat(32), note: 'Call before noon.', notify: { sms: true, sms_body: 'Hi Jordan, call me first: [interview link]' } });
  });

  it('a failed first preview read offers Try again, which loads the move and its message', async () => {
    let failPreview = true;
    setupFetch(
      {
        'GET /admin/careers/app-1/stage-preview?status=interview': () => (failPreview
          ? res(500, { error: 'The preview could not be loaded.' })
          : res(200, interviewPreview({ held: false, draft: false, owner_only: false, stamp: 'c'.repeat(32) }))),
      },
      { offer: offerPayload({ current: offerRecord() }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    await screen.findByTestId('offer-card');
    fireEvent.click(screen.getByRole('button', { name: 'Interview' }));
    const stage = (await screen.findByRole('heading', { name: 'Move to Interview' })).closest('[role="dialog"]');
    expect(await within(stage).findByText('The preview could not be loaded.')).toBeInTheDocument();
    failPreview = false;
    fireEvent.click(within(stage).getByRole('button', { name: 'Try again' }));
    expect(await within(stage).findByLabelText('Text message')).toHaveValue('Hi Jordan, pick a time: [interview link]');
    expect(within(stage).getByLabelText('Subject')).toHaveValue('Your interview');
    expect(within(stage).getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('re-reads the application after an offer action with ?peek=1, so no reply is marked read behind a dialog', async () => {
    const { calls } = setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/withdraw': () => res(200, { offer: { ...sent, status: 'withdrawn' } }) },
      { offer: offerPayload({ current: sent }), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.path === '/admin/careers/app-1?peek=1')).toBe(true));
    // Only the open itself read the application without it.
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/admin/careers/app-1')).toHaveLength(1);
  });

  it('drops a Revise result that comes back after the owner opened another applicant', async () => {
    let releaseRevise;
    const pending = new Promise((resolve) => { releaseRevise = resolve; });
    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method || 'GET';
      const path = apiPath(url);
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

  it('after a slow offer action the list reloads the tab on screen, not the tab open when the action began', async () => {
    let releaseRevise;
    const pending = new Promise((resolve) => { releaseRevise = resolve; });
    const sent = offerRecord({ status: 'sent', timeline: [] });
    const listCalls = [];
    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method || 'GET';
      const path = apiPath(url);
      if (path.startsWith('/admin/careers?status=')) {
        const status = new URLSearchParams(path.split('?')[1]).get('status');
        listCalls.push(status);
        const applications = status === 'rejected'
          ? [{ id: 'app-9', role: 'technician', status: 'rejected', contact_snapshot: { name: 'Riley Park' }, created_at: '2026-09-12T12:00:00Z' }]
          : [{ id: 'app-1', role: 'technician', status: 'offer', contact_snapshot: { name: CONTACT.name }, created_at: '2026-09-10T12:00:00Z' }];
        return Promise.resolve(res(200, { applications, counts: {} }));
      }
      if (method === 'POST' && path.endsWith('/offer/offer-1/revise')) return pending.then(() => res(200, { offer: offerRecord({ id: 'offer-2' }) }));
      if (path === '/admin/careers/app-1/offer') return Promise.resolve(res(200, offerPayload({ current: sent })));
      if (path === '/admin/careers/app-1') return Promise.resolve(res(200, { application: detailFixture({ status: 'offer' }) }));
      return Promise.resolve(res(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Revise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('offer-card')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /Rejected/ }));
    expect(await screen.findByText('Riley Park')).toBeInTheDocument();
    releaseRevise();
    await waitFor(() => expect(listCalls.filter((s) => s === 'rejected').length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(listCalls.at(-1)).toBe('rejected');
    expect(screen.getByText('Riley Park')).toBeInTheDocument();
  });

  // A stage move's answer is newer than a re-read still out after an offer action: that read must not put the old
  // stage back when it lands later.
  it('a stage move that lands while the re-read after an offer action is still out keeps its stage', async () => {
    let current = offerRecord({ status: 'sent', timeline: [] });
    let holdRead = false;
    let releaseRead;
    const detail = detailFixture({ status: 'offer' });
    setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-1/withdraw': () => {
          current = offerRecord({ status: 'withdrawn', timeline: [] });
          holdRead = true;
          return res(200, { offer: current });
        },
        'GET /admin/careers/app-1': () => {
          if (!holdRead) return res(200, { application: detail });
          holdRead = false;
          // The re-read after the withdraw: it read the stage before the move, and it lands after it.
          return new Promise((resolve) => { releaseRead = () => resolve(res(200, { application: detail })); });
        },
        'PATCH /admin/careers/app-1/status': () => res(200, { application: detailFixture({ status: 'reviewed' }), sent: {} }),
      },
      { offer: () => res(200, offerPayload({ current })), detail },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const confirm = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(releaseRead).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    const stage = (await screen.findByRole('heading', { name: 'Move to Reviewed' })).closest('[role="dialog"]');
    const confirmButton = within(stage).getByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    fireEvent.click(confirmButton);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reviewed' })).toBeNull());
    releaseRead();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'Reviewed' })).toBeNull(); // the detail still reads Reviewed
    expect(screen.queryByText(/could not be reloaded after the offer change/)).toBeNull();
  });

  it('a stage dialog opened while the re-read after an offer action is out holds Confirm when that re-read fails, until Try again reads', async () => {
    let current = offerRecord({ status: 'sent', timeline: [] });
    let holdRead = false;
    let failRead;
    const detail = detailFixture({ status: 'offer' });
    const patches = [];
    setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-1/withdraw': () => {
          current = offerRecord({ status: 'withdrawn', timeline: [] });
          holdRead = true;
          return res(200, { offer: current });
        },
        'GET /admin/careers/app-1': () => {
          if (!holdRead) return res(200, { application: detail });
          holdRead = false;
          // The re-read after the withdraw: held while the owner opens a stage move, then it fails.
          return new Promise((resolve) => { failRead = () => resolve(res(500, { error: 'Server error' })); });
        },
        'PATCH /admin/careers/app-1/status': () => {
          patches.push('PATCH');
          return res(200, { application: detailFixture({ status: 'reviewed' }), sent: {} });
        },
      },
      { offer: () => res(200, offerPayload({ current })), detail },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const confirm = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(failRead).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    const stage = (await screen.findByRole('heading', { name: 'Move to Reviewed' })).closest('[role="dialog"]');
    const confirmButton = within(stage).getByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    failRead();
    // The stage buttons behind the dialog turn off, and so does the dialog's own Confirm.
    expect(await within(stage).findByText(/could not be reloaded after the offer change, so its stage may be out of date\. Confirm stays off until it loads\./)).toBeInTheDocument();
    expect(confirmButton).toBeDisabled();
    fireEvent.click(confirmButton);
    expect(patches).toHaveLength(0);
    fireEvent.click(within(stage).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(stage).queryByText(/could not be reloaded/)).toBeNull());
    expect(confirmButton).not.toBeDisabled();
  });

  it('a failed application re-read turns off the card actions too, until Try again loads it', async () => {
    let failDetail = false;
    const detail = detailFixture({ status: 'offer' });
    setupFetch(
      {
        // The withdraw's answer is lost (502); the offer read after it still shows the offer out.
        'POST /admin/careers/app-1/offer/offer-1/withdraw': () => {
          failDetail = true;
          return res(502, { error: 'Bad gateway' });
        },
        'GET /admin/careers/app-1': () => (failDetail ? res(500, { error: 'Server error' }) : res(200, { application: detail })),
      },
      { offer: offerPayload({ current: sent }), detail },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const confirm = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Withdraw' }));
    const detailDialog = screen.getByRole('heading', { name: /Jordan Rivera — / }).closest('[role="dialog"]');
    expect(await within(detailDialog).findByText(/could not be reloaded after the offer change/)).toBeInTheDocument();
    // The offer read worked and the application read did not: the card's owner actions wait for it too.
    expect(within(screen.getByTestId('offer-card')).queryByRole('button', { name: 'Withdraw offer' })).toBeNull();
    failDetail = false;
    fireEvent.click(within(detailDialog).getByRole('button', { name: 'Try again' }));
    expect(await within(screen.getByTestId('offer-card')).findByRole('button', { name: 'Withdraw offer' })).toBeInTheDocument();
  });

  it('a failed application re-read after an offer change stays on the detail with Try again, and stage moves wait for it', async () => {
    let failDetail = false;
    let current = offerRecord({ status: 'sent', timeline: [] });
    const detail = detailFixture({ status: 'offer' });
    setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-1/withdraw': () => {
          current = offerRecord({ status: 'withdrawn', timeline: [] });
          failDetail = true;
          return res(200, { offer: current });
        },
        'GET /admin/careers/app-1': () => (failDetail ? res(500, { error: 'Server error' }) : res(200, { application: detail })),
      },
      { offer: () => res(200, offerPayload({ current })), detail },
    );
    await openDetail();
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const confirm = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Withdraw' }));
    const detailDialog = screen.getByRole('heading', { name: /Jordan Rivera — / }).closest('[role="dialog"]');
    const notice = 'This application could not be reloaded after the offer change, so its stage may be out of date. Stage moves stay off until it loads.';
    // The list reload that follows does not clear it.
    expect(await within(detailDialog).findByText(notice)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(within(detailDialog).getByText(notice)).toBeInTheDocument();
    expect(within(detailDialog).getByRole('button', { name: 'Hired' })).toBeDisabled();
    // A new offer depends on the stage too: it waits for the re-read.
    expect(within(screen.getByTestId('offer-card')).queryByRole('button', { name: 'Make an offer' })).toBeNull();
    failDetail = false;
    fireEvent.click(within(detailDialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(detailDialog).queryByText(notice)).toBeNull());
    expect(within(detailDialog).getByRole('button', { name: 'Hired' })).not.toBeDisabled();
    expect(within(screen.getByTestId('offer-card')).getByRole('button', { name: 'Make an offer' })).toBeInTheDocument();
  });

  it('after a send from Interview whose application re-read fails, the interview link button waits for the re-read too', async () => {
    let failDetail = false;
    let current = offerRecord();
    const detail = detailFixture({ status: 'interview', interview_url: 'https://portal.example.test/careers/interview/link' });
    setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-1/send': () => {
          // The send moves the application to Offer on the server; the re-read of it fails.
          current = offerRecord({ status: 'sent', timeline: [] });
          failDetail = true;
          return res(200, { offer: current, comms: { sms: { outcome: 'sent' }, email: { outcome: 'sent' } } });
        },
        'GET /admin/careers/app-1': () => (failDetail ? res(500, { error: 'Server error' }) : res(200, { application: detail })),
      },
      { offer: () => res(200, offerPayload({ current })), detail },
    );
    await openDetail();
    const offerButton = screen.getByRole('button', { name: 'Offer' });
    await waitFor(() => expect(offerButton).not.toBeDisabled());
    fireEvent.click(offerButton);
    await screen.findByLabelText('Hourly rate ($)');
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    const sentView = (await screen.findByText('Offer sent to Jordan.')).closest('[role="dialog"]');
    fireEvent.click(within(sentView).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Offer sent to Jordan.')).toBeNull());
    const detailDialog = screen.getByRole('heading', { name: /Jordan Rivera — / }).closest('[role="dialog"]');
    expect(await within(detailDialog).findByText(/could not be reloaded after the offer change/)).toBeInTheDocument();
    expect(within(detailDialog).getByRole('button', { name: 'Resend link' })).toBeDisabled();
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

  it('the Send question for a revision says the offer out now stops working at the send', async () => {
    const revision = offerRecord({ id: 'offer-2', draftHash: 'hash-draft', supersedesId: 'offer-1' });
    setupFetch({}, { offer: offerPayload({ current: sent, draft: revision, sendReplacesId: 'offer-1' }), detail: detailFixture({ status: 'offer' }) });
    await openDetail();
    fireEvent.click(await within(await screen.findByTestId('offer-card')).findByRole('button', { name: 'Open the updated draft' }));
    await screen.findByLabelText('Hourly rate ($)');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    expect(within(confirm).getByText('It replaces the offer you sent before. That link stops working when you press Send offer, even if this one does not reach Jordan.')).toBeInTheDocument();
  });

  it('a revision Send refused because the offer out changed re-reads, says nothing was sent, and the next Send carries the new read', async () => {
    const revision = offerRecord({ id: 'offer-2', draftHash: 'hash-draft', supersedesId: 'offer-1' });
    let answered = false;
    const { calls } = setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-2/send': () => {
          if (answered) return res(200, { offer: { ...revision, status: 'sent' }, comms: { sms: { outcome: 'sent' }, email: { outcome: 'sent' } } });
          answered = true;
          return res(409, { error: 'The offer you sent before changed after you opened this, so nothing was sent.', code: 'OFFERS_CHANGED' });
        },
      },
      {
        offer: () => res(200, offerPayload({
          current: answered ? { ...sent, status: 'date_requested', requestedStartDate: '2027-01-18', dateRequestNote: 'Need two more weeks' } : sent,
          draft: revision, sendReplacesId: 'offer-1', outStamp: answered ? 'out-stamp-2' : 'out-stamp-1',
        })),
        detail: detailFixture({ status: 'offer' }),
      },
    );
    await openDetail();
    fireEvent.click(await within(await screen.findByTestId('offer-card')).findByRole('button', { name: 'Open the updated draft' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    let confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    // The form says nothing was sent and what changed (the date request), before the owner goes on.
    expect(await screen.findByText(/so nothing was sent\. Asked to start Mon, Jan 18, 2027\. Note: Need two more weeks/)).toBeInTheDocument();
    expect(screen.queryByText(/Send this offer to Jordan/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this draft' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/offer-2/send'))).toHaveLength(2));
    expect(calls.filter((c) => c.path.endsWith('/offer-2/send')).map((c) => c.body.expectedOut)).toEqual(['out-stamp-1', 'out-stamp-2']);
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

describe('RecruitingPage offer flow: guarded save, busy close and send outcome', () => {
  async function openDraftForm(routes = {}, offer) {
    setupFetch(routes, { offer: offer || (() => res(200, offerPayload({ current: offerRecord() }))) });
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    await screen.findByRole('heading', { name: /Jordan Rivera — / });
    const offerButton = screen.getByRole('button', { name: 'Offer' });
    await waitFor(() => expect(offerButton).not.toBeDisabled());
    fireEvent.click(offerButton);
    await screen.findByLabelText('Hourly rate ($)');
  }

  it('saving an existing draft names it by id and hash', async () => {
    const calls = [];
    const saved = offerRecord({ startDate: '2027-01-11', draftHash: 'hash-2' });
    const fetchBase = vi.fn();
    setupFetch({ 'POST /admin/careers/app-1/offer': () => res(200, { offer: saved }) }, { offer: () => res(200, offerPayload({ current: offerRecord() })) });
    fetchBase.mockImplementation(globalThis.fetch);
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => { calls.push({ method: options.method || 'GET', url: String(url), body: options.body && JSON.parse(options.body) }); return fetchBase(url, options); }));
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    await screen.findByRole('heading', { name: /Jordan Rivera — / });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Offer' }));
    fireEvent.change(await screen.findByLabelText('Start date'), { target: { value: '2027-01-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/careers/app-1/offer'))).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/admin/careers/app-1/offer'));
    expect(post.body).toMatchObject({ startDate: '2027-01-11', draftId: 'offer-1', draftHash: 'hash-1' });
  });

  it('DRAFT_CHANGED on save keeps the typed edits on screen until the owner shows the other admin version', async () => {
    let current = offerRecord({ draftHash: 'old' });
    await openDraftForm(
      { 'POST /admin/careers/app-1/offer': () => { current = offerRecord({ draftHash: 'new', hourlyRate: 24 }); return res(409, { error: 'x', code: 'DRAFT_CHANGED' }); } },
      () => res(200, offerPayload({ current })),
    );
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('This draft changed after you opened it, so nothing was done. Review the new version first.')).toBeInTheDocument();
    // What the owner typed stays visible, read-only, until they choose to load the newer version.
    expect(screen.getByLabelText('Hours')).toHaveValue('Mon to Thu, 8 hours');
    expect(screen.getByLabelText('Hours')).toBeDisabled();
    expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('23');
    fireEvent.click(screen.getByRole('button', { name: 'Show the new version' }));
    await waitFor(() => expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('24'));
    expect(screen.getByLabelText('Hours')).toHaveValue(DEFAULTS.hoursLine);
    expect(screen.getByLabelText('Hours')).not.toBeDisabled();
    expect(screen.queryByText('This draft changed after you opened it, so nothing was done. Review the new version first.')).toBeNull();
  });

  it('Escape does not close the dialog while a save runs', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await openDraftForm({ 'POST /admin/careers/app-1/offer': () => gate.then(() => res(200, { offer: offerRecord() })) });
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByLabelText('Hours')).toBeDisabled());
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(screen.getByLabelText('Hours'), { key: 'Escape' });
    expect(screen.getByLabelText('Hours')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.getByLabelText('Hours')).not.toBeDisabled());
  });

  it.each([
    [{ sms: { outcome: 'failed' }, email: { outcome: 'blocked' } }, 'The offer is open.', ['The text did not go out.', 'The email did not go out.', 'Check the phone and email on file, then use Revise to send a new link.']],
    [{ sms: { outcome: 'deferred' }, email: { outcome: 'failed' } }, 'The offer is open.', ['The text is queued.', 'The email did not go out.']],
    [{ sms: { outcome: 'uncertain' }, email: { outcome: 'sent' } }, 'The offer is open.', ['The text may not have gone out.', 'The email went out.']],
    [{ sms: { outcome: 'sent' }, email: { outcome: 'sent' } }, 'Offer sent to Jordan.', []],
  ])('the send result tells which channels went out (%#)', async (comms, headline, lines) => {
    await openDraftForm({ 'POST /admin/careers/app-1/offer/offer-1/send': () => res(200, { offer: offerRecord({ status: 'sent' }), comms }) });
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText(headline)).toBeInTheDocument();
    for (const line of lines) expect(screen.getByText(line)).toBeInTheDocument();
    if (!lines.length) expect(screen.queryByText(/did not go out|is queued|may not/)).toBeNull();
  });

  it('DRAFT_CHANGED on a first save keeps the edits until the owner loads the other admin draft, then saves against it', async () => {
    let other = null;
    const calls = [];
    const theirs = offerRecord({ id: 'offer-9', draftHash: 'their-hash', hourlyRate: 24 });
    setupFetch(
      {
        'POST /admin/careers/app-1/offer': () => {
          if (!other) { other = theirs; return res(409, { error: 'x', code: 'DRAFT_CHANGED' }); }
          return res(200, { offer: { ...theirs, hoursLine: 'Mon to Thu, 8 hours', draftHash: 'mine' } });
        },
      },
      { offer: () => res(200, offerPayload({ current: other })) },
    );
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if ((options.method || 'GET') === 'POST' && String(url).endsWith('/admin/careers/app-1/offer')) calls.push(JSON.parse(options.body));
      return base(url, options);
    }));
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    await screen.findByRole('heading', { name: /Jordan Rivera — / });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Offer' }));
    fireEvent.change(await screen.findByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('This draft changed after you opened it, so nothing was done. Review the new version first.')).toBeInTheDocument();
    expect(screen.getByLabelText('Hours')).toHaveValue('Mon to Thu, 8 hours');
    expect(screen.getByLabelText('Hours')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Show the new version' }));
    await waitFor(() => expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('24'));
    expect(calls[0].draftId).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ draftId: 'offer-9', draftHash: 'their-hash' });
  });

  it('OFFER_NOT_DRAFT on send closes the confirm, keeps the form read-only with the reason, and Close shows the sent offer', async () => {
    let current = offerRecord();
    await openDraftForm(
      { 'POST /admin/careers/app-1/offer/offer-1/send': () => { current = offerRecord({ status: 'sent', timeline: [{ at: '2026-12-11T15:20:00Z', kind: 'sent', label: 'Offer sent by someone else' }] }); return res(409, { error: 'x', code: 'OFFER_NOT_DRAFT' }); } },
      () => res(200, offerPayload({ current })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('This offer is no longer a draft. Close this form and check its state.')).toBeInTheDocument();
    expect(screen.queryByText(/Send this offer to Jordan/)).toBeNull();
    expect(screen.getByLabelText('Hourly rate ($)')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Show the new version' })).toBeNull();
    expect(await screen.findByText('Offer sent by someone else')).toBeInTheDocument();
    const form = screen.getByLabelText('Hourly rate ($)').closest('[role="dialog"]');
    fireEvent.click(within(form).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText('Hourly rate ($)')).toBeNull());
  });

  it('OFFER_NOT_DRAFT on save keeps the typed hours read-only with the reason, and Close shows the card state', async () => {
    let current = offerRecord();
    await openDraftForm(
      { 'POST /admin/careers/app-1/offer': () => { current = offerRecord({ status: 'withdrawn', timeline: [{ at: '2026-12-11T15:20:00Z', kind: 'withdrawn', label: 'Withdrawn by someone else' }] }); return res(409, { error: 'x', code: 'OFFER_NOT_DRAFT' }); } },
      () => res(200, offerPayload({ current })),
    );
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('This offer is no longer a draft. Close this form and check its state.')).toBeInTheDocument();
    expect(screen.getByLabelText('Hours')).toHaveValue('Mon to Thu, 8 hours');
    expect(screen.getByLabelText('Hours')).toBeDisabled();
    expect(await screen.findByText('Withdrawn by someone else')).toBeInTheDocument();
    const form = screen.getByLabelText('Hours').closest('[role="dialog"]');
    fireEvent.click(within(form).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText('Hours')).toBeNull());
  });

  it('a sent offer past its expiry shows as closed, with Make an offer and no Revise or Withdraw', async () => {
    const lapsed = offerRecord({ status: 'sent', expiresAt: '2020-01-01T04:59:59Z', timeline: [] });
    setupFetch({}, { offer: offerPayload({ current: lapsed }), detail: detailFixture({ status: 'offer' }) });
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    expect(within(card).getByText('Closed unsigned')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Make an offer' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Revise' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Withdraw offer' })).toBeNull();
  });

  it('shows an invalid-date message and no step date for a start date that cannot be formed or is too far out', async () => {
    setupFetch({});
    await openDraftForm({}, () => res(200, offerPayload()));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '9999-12-27' } });
    expect(screen.getByText('That start date is too far out for a pay step date.')).toBeInTheDocument();
    expect(screen.getByLabelText('Step date')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('re-reads the offer card after a stage change on the open application', async () => {
    let moved = false;
    const { calls } = setupFetch(
      {
        'PATCH /admin/careers/app-1/status': () => { moved = true; return res(200, { application: detailFixture({ status: 'offer' }), sent: {} }); },
      },
      { offer: () => res(200, offerPayload({ current: moved ? offerRecord({ status: 'withdrawn', timeline: [{ at: '2026-12-11T15:20:00Z', kind: 'withdrawn', label: 'Closed earlier' }] }) : null })) },
    );
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    await screen.findByRole('heading', { name: /Jordan Rivera — / });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reviewed' })).not.toBeDisabled());
    expect(calls.filter((c) => c.path === '/admin/careers/app-1/offer')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    const confirmButton = await screen.findByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    fireEvent.click(confirmButton);
    expect(await screen.findByText('Closed earlier')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/admin/careers/app-1/offer')).toHaveLength(2);
  });

  it('a send that finishes while the owner is switching applicants does not cancel the switch', async () => {
    let releaseSend;
    let releaseB;
    let sentDone = false;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const bGate = new Promise((resolve) => { releaseB = resolve; });
    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method || 'GET';
      const path = apiPath(url);
      if (path.startsWith('/admin/careers?status=')) {
        return Promise.resolve(res(200, { applications: [{ id: 'app-1', role: 'technician', status: 'interview', contact_snapshot: { name: 'Jordan Rivera' }, created_at: '2026-09-10T12:00:00Z' }], counts: {} }));
      }
      if (method === 'POST' && path.endsWith('/offer/offer-1/send')) return sendGate.then(() => { sentDone = true; return res(200, { offer: offerRecord({ status: 'sent' }), comms: { sms: { outcome: 'sent' }, email: { outcome: 'sent' } } }); });
      if (path === '/admin/careers/app-1/offer') return Promise.resolve(res(200, offerPayload({ current: offerRecord() })));
      if (path === '/admin/careers/app-2/offer') return Promise.resolve(res(200, offerPayload()));
      if (path === '/admin/careers/app-1') return Promise.resolve(res(200, { application: detailFixture({ status: sentDone ? 'offer' : 'interview' }) }));
      if (path === '/admin/careers/app-2') return bGate.then(() => res(200, { application: detailFixture({ id: 'app-2', contact_snapshot: { name: 'Casey Morgan', phone: '9415550199' } }) }));
      return Promise.resolve(res(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    function Nav() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate('/?application=app-2')}>go-b</button>;
    }
    render(<MemoryRouter><Nav /><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Jordan Rivera'));
    await screen.findByRole('heading', { name: /Jordan Rivera — / });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Offer' }));
    await screen.findByLabelText('Hourly rate ($)');
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    // While the send is pending, the owner starts opening another applicant.
    fireEvent.click(screen.getByText('go-b'));
    releaseSend();
    await screen.findByText(/Offer sent to Jordan/);
    releaseB();
    expect(await screen.findByRole('heading', { name: /Casey Morgan — / })).toBeInTheDocument();
  });

  // A Try again on one applicant can finish after the owner opened another applicant's form. When its read finds the
  // first draft gone, it closes only its own form: the other form and its typed edits stay.
  it("a Try again that finds the draft gone after the owner opened another applicant's form leaves that form open", async () => {
    let phase = 'start';
    let releaseA;
    let aDetailAsked = false;
    const aGate = new Promise((resolve) => { releaseA = resolve; });
    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method || 'GET';
      const path = apiPath(url);
      if (path.startsWith('/admin/careers?status=')) {
        return Promise.resolve(res(200, { applications: [{ id: 'app-1', role: 'technician', status: 'interview', contact_snapshot: { name: 'Jordan Rivera' }, created_at: '2026-09-10T12:00:00Z' }], counts: {} }));
      }
      if (method === 'POST' && path === '/admin/careers/app-1/offer') {
        phase = 'saved';
        return Promise.resolve(res(200, { offer: offerRecord({ draftHash: 'hash-after' }) }));
      }
      if (path === '/admin/careers/app-1/offer') {
        if (phase === 'saved') return Promise.resolve(res(500, { error: 'boom' }));
        // 'gone': another admin sent or discarded the draft meanwhile.
        return Promise.resolve(res(200, offerPayload({ current: phase === 'gone' ? null : offerRecord() })));
      }
      if (path === '/admin/careers/app-1') {
        const answer = () => res(200, { application: detailFixture({ status: 'interview' }) });
        if (phase !== 'gone') return Promise.resolve(answer());
        aDetailAsked = true;
        return aGate.then(answer);
      }
      if (path === '/admin/careers/app-2/offer') return Promise.resolve(res(200, offerPayload()));
      if (path === '/admin/careers/app-2') {
        return Promise.resolve(res(200, { application: detailFixture({ id: 'app-2', status: 'interview', contact_snapshot: { name: 'Casey Morgan', phone: '9415550199' } }) }));
      }
      return Promise.resolve(res(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    function Nav() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate('/?application=app-2')}>go-b</button>;
    }
    render(<MemoryRouter><Nav /><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Jordan Rivera'));
    await screen.findByRole('heading', { name: /Jordan Rivera — / });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Offer' }));
    // A save whose re-read fails leaves the form read-only with Try again.
    fireEvent.change(await screen.findByLabelText('Hourly rate ($)'), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/could not be loaded after your last change/)).toBeInTheDocument();
    // Try again reads the offer (the draft is gone now); the application read after it is slow.
    phase = 'gone';
    fireEvent.click(within(screen.getByLabelText('Hourly rate ($)').closest('[role="dialog"]')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(aDetailAsked).toBe(true));
    // While that read is out, the owner opens another applicant and starts that applicant's offer.
    fireEvent.click(screen.getByText('go-b'));
    await screen.findByRole('heading', { name: /Casey Morgan — / });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Offer' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Offer' }));
    fireEvent.change(await screen.findByLabelText('Hourly rate ($)'), { target: { value: '26' } });
    // The first applicant's read finishes: its Try again finds that draft gone. The open form stays, edit included.
    await act(async () => {
      releaseA();
      await new Promise((resolve) => { setTimeout(resolve, 30); });
    });
    expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('26');
    expect(screen.getByRole('heading', { name: /Casey Morgan — / })).toBeInTheDocument();
  });

  // An action on one applicant can finish after the owner opened another. Its re-read is for an applicant no longer
  // on screen, so it must not cancel the open applicant's own re-read, which would leave that applicant's stage stale.
  it("a late offer action on one applicant does not cancel the open applicant's re-read", async () => {
    let releaseA;
    let releaseBRead;
    let bWithdrawn = false;
    let bReads = 0;
    const aGate = new Promise((resolve) => { releaseA = resolve; });
    const sentA = offerRecord({ status: 'sent', timeline: [] });
    const sentB = offerRecord({ id: 'offer-9', applicationId: 'app-2', status: 'sent', timeline: [] });
    const calls = [];
    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method || 'GET';
      const path = apiPath(url);
      calls.push(`${method} ${path}`);
      if (path.startsWith('/admin/careers?status=')) {
        return Promise.resolve(res(200, { applications: [{ id: 'app-1', role: 'technician', status: 'offer', contact_snapshot: { name: 'Jordan Rivera' }, created_at: '2026-09-10T12:00:00Z' }], counts: {} }));
      }
      if (method === 'POST' && path === '/admin/careers/app-1/offer/offer-1/withdraw') return aGate.then(() => res(200, { offer: { ...sentA, status: 'withdrawn' } }));
      if (method === 'POST' && path === '/admin/careers/app-2/offer/offer-9/withdraw') {
        bWithdrawn = true;
        return Promise.resolve(res(200, { offer: { ...sentB, status: 'withdrawn' } }));
      }
      if (path === '/admin/careers/app-1/offer') return Promise.resolve(res(200, offerPayload({ current: sentA })));
      if (path === '/admin/careers/app-2/offer') return Promise.resolve(res(200, offerPayload({ current: bWithdrawn ? { ...sentB, status: 'withdrawn' } : sentB })));
      if (path === '/admin/careers/app-1') return Promise.resolve(res(200, { application: detailFixture({ status: 'offer' }) }));
      if (path === '/admin/careers/app-2') {
        bReads += 1;
        const application = detailFixture({ id: 'app-2', status: bWithdrawn ? 'interview' : 'offer', contact_snapshot: { name: 'Casey Morgan', phone: '9415550199' } });
        if (bReads === 1) return Promise.resolve(res(200, { application }));
        // B's re-read after its own withdraw: held until A's late action has finished.
        return new Promise((resolve) => { releaseBRead = () => resolve(res(200, { application })); });
      }
      return Promise.resolve(res(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    function Nav() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate('/?application=app-2')}>go-b</button>;
    }
    render(<MemoryRouter><Nav /><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Jordan Rivera'));
    await screen.findByRole('heading', { name: /Jordan Rivera — / });
    // A's withdraw is sent, and its answer waits.
    fireEvent.click(within(await screen.findByTestId('offer-card')).getByRole('button', { name: 'Withdraw offer' }));
    fireEvent.click(within((await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]')).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(calls).toContain('POST /admin/careers/app-1/offer/offer-1/withdraw'));
    // The owner opens B and withdraws B's offer; B's re-read is out.
    fireEvent.click(screen.getByText('go-b'));
    const bHeading = await screen.findByRole('heading', { name: /Casey Morgan — / });
    fireEvent.click(within(await screen.findByTestId('offer-card')).getByRole('button', { name: 'Withdraw offer' }));
    fireEvent.click(within((await screen.findByText(/Withdraw this offer for Casey/)).closest('[role="dialog"]')).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(releaseBRead).toBeDefined());
    // A's answer lands now. Its follow-up (the re-read, then the list reload) runs to the end before B's re-read
    // answers: B's own list reload waits behind that re-read, so a new list read is A's.
    const lists = () => calls.filter((c) => c.startsWith('GET /admin/careers?status=')).length;
    const listsBefore = lists();
    releaseA();
    await waitFor(() => expect(lists()).toBeGreaterThan(listsBefore));
    releaseBRead();
    // B's detail follows its own re-read: the stage is Interview, so Interview is no longer a move.
    const bDialog = bHeading.closest('[role="dialog"]');
    await waitFor(() => expect(within(bDialog).queryByRole('button', { name: 'Interview' })).toBeNull());
    expect(within(bDialog).getByRole('button', { name: 'Offer' })).toBeInTheDocument();
  });

  it('Discard sends the draft status and hash, Withdraw the sent status', async () => {
    const sentOffer = offerRecord({ status: 'sent', timeline: [] });
    const theDraft = offerRecord({ id: 'offer-2', draftHash: 'hash-draft', supersedesId: 'offer-1' });
    const { calls } = setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-2/withdraw': () => res(200, { offer: { ...theDraft, status: 'withdrawn' } }),
        'POST /admin/careers/app-1/offer/offer-1/withdraw': () => res(200, { offer: { ...sentOffer, status: 'withdrawn' } }),
      },
      { offer: offerPayload({ current: sentOffer, draft: theDraft }), detail: detailFixture({ status: 'offer' }) },
    );
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Discard this draft — the offer you sent is unchanged' }));
    let dialog = (await screen.findByText(/Discard this draft\?/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/offer-2/withdraw'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/offer-2/withdraw')).body).toEqual({ expectedStatus: 'draft', draftHash: 'hash-draft' });
    fireEvent.click(await within(await screen.findByTestId('offer-card')).findByRole('button', { name: 'Withdraw offer' }));
    dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/offer-1/withdraw'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/offer-1/withdraw')).body).toEqual({ expectedStatus: 'sent' });
  });

  it('OFFER_CHANGED on withdraw closes the confirm, shows the message and re-reads the offer and the application', async () => {
    let current = offerRecord({ status: 'sent', timeline: [] });
    const detail = detailFixture({ status: 'offer' });
    const { calls } = setupFetch(
      {
        'POST /admin/careers/app-1/offer/offer-1/withdraw': () => {
          // The applicant signed meanwhile: the offer is accepted and the application moved to Hired.
          current = offerRecord({ status: 'accepted', signedAt: '2026-12-12T13:15:00Z', timeline: [{ at: '2026-12-12T13:15:00Z', kind: 'signed', label: 'Signed just now' }] });
          detail.status = 'hired';
          return res(409, { error: 'x', code: 'OFFER_CHANGED' });
        },
      },
      { offer: () => res(200, offerPayload({ current })), detail },
    );
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('Signed just now')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Withdraw this offer for Jordan/)).toBeNull());
    expect(screen.getByText('This offer changed after you opened it. Review it again.')).toBeInTheDocument();
    expect(screen.queryByText(/Withdraw this offer for Jordan/)).toBeNull();
    expect(calls.filter((c) => c.path === '/admin/careers/app-1/offer').length).toBeGreaterThanOrEqual(2);
    // The detail follows the stage the signature moved it to, with no manual reload: no Hired move on a hired application.
    const detailDialog = screen.getByRole('heading', { name: /Jordan Rivera — / }).closest('[role="dialog"]');
    await waitFor(() => expect(within(detailDialog).queryByRole('button', { name: 'Hired' })).toBeNull());
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/admin/careers/app-1?peek=1').length).toBeGreaterThanOrEqual(1); // the re-read
  });

  it('a withdraw whose answer is lost re-reads: the confirm closes and the card shows the offer as it reads now', async () => {
    let current = offerRecord({ status: 'sent', timeline: [] });
    setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/withdraw': () => { current = offerRecord({ status: 'withdrawn', timeline: [] }); return res(502, { error: 'Bad gateway' }); } },
      { offer: () => res(200, offerPayload({ current })), detail: detailFixture({ status: 'offer' }) },
    );
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(screen.queryByText(/Withdraw this offer for Jordan/)).toBeNull());
    const after = screen.getByTestId('offer-card');
    expect(within(after).getByText('No answer came back. The card shows the offer as it reads now, but the action may still finish. If it did, a repeat is refused.')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId('offer-card')).getByText('Withdrawn')).toBeInTheDocument());
    expect(within(screen.getByTestId('offer-card')).queryByRole('button', { name: 'Withdraw offer' })).toBeNull();
    expect(screen.queryByText('Bad gateway')).toBeNull();
  });

  // A success whose body cannot be read says nothing about what the server did (here it did nothing): the card takes
  // the lost-answer path, never a silent success.
  it('a withdraw answered 200 with a body that cannot be read is a lost answer: the card re-reads and says so', async () => {
    const current = offerRecord({ status: 'sent', timeline: [] });
    setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/withdraw': () => unreadable() },
      { offer: () => res(200, offerPayload({ current })), detail: detailFixture({ status: 'offer' }) },
    );
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(screen.queryByText(/Withdraw this offer for Jordan/)).toBeNull());
    const after = screen.getByTestId('offer-card');
    expect(within(after).getByText('No answer came back. The card shows the offer as it reads now, but the action may still finish. If it did, a repeat is refused.')).toBeInTheDocument();
    expect(within(after).getByText('Sent')).toBeInTheDocument();
  });

  it('a signed copy answered 200 with a body that cannot be read says so and shows no copy', async () => {
    const signed = offerRecord({ status: 'accepted', signedAt: '2026-12-12T13:15:00Z', signedName: 'Jordan Rivera', timeline: [] });
    setupFetch(
      { 'GET /admin/careers/app-1/offer/offer-1/signed-copy': () => unreadable() },
      { offer: offerPayload({ current: signed }), detail: detailFixture({ status: 'hired' }) },
    );
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'View signed copy' }));
    expect(await within(card).findByText('The answer could not be read. Try again.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Signed offer' })).toBeNull();
  });

  it('a withdraw answered gate-off turns the offer card off and brings back the plain stage moves', async () => {
    let off = false;
    setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/withdraw': () => { off = true; return res(404, { enabled: false }); } },
      { offer: () => (off ? res(404, { enabled: false }) : res(200, offerPayload({ current: offerRecord({ status: 'sent', timeline: [] }) }))), detail: detailFixture({ status: 'offer' }) },
    );
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(screen.queryByTestId('offer-card')).toBeNull());
    expect(screen.queryByText(/Withdraw this offer for Jordan/)).toBeNull();
    expect(screen.queryByText('HTTP 404')).toBeNull();
    expect(screen.getByRole('button', { name: 'Hired' })).not.toBeDisabled();
  });

  it('OFFER_NOT_WITHDRAWABLE (the offer expired meanwhile) closes the confirm, says so and shows the offer as closed', async () => {
    let current = offerRecord({ status: 'sent', timeline: [] });
    setupFetch(
      { 'POST /admin/careers/app-1/offer/offer-1/withdraw': () => { current = offerRecord({ status: 'expired', timeline: [] }); return res(409, { error: 'x', code: 'OFFER_NOT_WITHDRAWABLE', status: 'expired' }); } },
      { offer: () => res(200, offerPayload({ current })), detail: detailFixture({ status: 'offer' }) },
    );
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    const card = await screen.findByTestId('offer-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Withdraw offer' }));
    const dialog = (await screen.findByText(/Withdraw this offer for Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(screen.queryByText(/Withdraw this offer for Jordan/)).toBeNull());
    expect(screen.getByText('This offer expired before you withdrew it. Nothing was changed.')).toBeInTheDocument();
    const after = await screen.findByTestId('offer-card');
    expect(within(after).getByText('Closed unsigned')).toBeInTheDocument();
    expect(within(after).queryByRole('button', { name: 'Withdraw offer' })).toBeNull();
  });

  it('a send whose answer is lost re-reads: an offer that went out leaves the form read-only with no second Send', async () => {
    let current = offerRecord();
    await openDraftForm(
      { 'POST /admin/careers/app-1/offer/offer-1/send': () => { current = offerRecord({ status: 'sent', timeline: [] }); return res(502, { error: 'Bad gateway' }); } },
      () => res(200, offerPayload({ current })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('This draft is no longer open. Close this form to see the offer.')).toBeInTheDocument();
    expect(screen.queryByText(/Send this offer to Jordan/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
    expect(screen.queryByText('Bad gateway')).toBeNull();
  });

  it('a send with no answer whose offer is still the same draft says nothing went out and offers Send again', async () => {
    await openDraftForm({ 'POST /admin/careers/app-1/offer/offer-1/send': () => Promise.reject(new TypeError('Failed to fetch')) });
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    // The draft still reads as before, but the send may still finish on the server: no claim either way.
    expect(await screen.findByText('The send got no answer. The offer still reads as a draft, but it may still go out. If it did, sending again is refused, so it cannot go out twice.')).toBeInTheDocument();
    expect(screen.queryByText(/Send this offer to Jordan/)).toBeNull();
    expect(screen.getByLabelText('Hourly rate ($)')).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText(/Send this offer to Jordan/)).toBeInTheDocument();
  });

  it('a save whose answer is lost and whose re-read fails stays read-only; Try again only re-reads and keeps the typed edits', async () => {
    let failRead = false;
    const saves = [];
    await openDraftForm(
      { 'POST /admin/careers/app-1/offer': () => { saves.push(1); failRead = true; return res(503, { error: 'Unavailable' }); } },
      () => (failRead ? res(500, { error: 'Server error' }) : res(200, offerPayload({ current: offerRecord() }))),
    );
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const form = screen.getByLabelText('Hours').closest('[role="dialog"]');
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Try again' })).not.toBeDisabled());
    expect(screen.getByLabelText('Hours')).toHaveValue('Mon to Thu, 8 hours');
    expect(screen.getByLabelText('Hours')).toBeDisabled();
    failRead = false;
    fireEvent.click(within(form).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('The save got no answer. The draft still reads as before, but the save may still finish. If it did, saving again is refused and this form shows the newer version.')).toBeInTheDocument();
    expect(screen.getByLabelText('Hours')).toHaveValue('Mon to Thu, 8 hours');
    expect(screen.getByLabelText('Hours')).not.toBeDisabled();
    expect(saves).toHaveLength(1);
  });

  // An answer the form cannot use is a lost answer, whatever its status: the read decides, and no result is claimed.
  it('a send answered 200 without its offer is a lost answer: the form re-reads and claims no result', async () => {
    await openDraftForm({ 'POST /admin/careers/app-1/offer/offer-1/send': () => res(200, {}) });
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('The send got no answer. The offer still reads as a draft, but it may still go out. If it did, sending again is refused, so it cannot go out twice.')).toBeInTheDocument();
    expect(screen.queryByText('The offer is open.')).toBeNull();
    expect(screen.queryByText(/Offer sent to/)).toBeNull();
  });

  it('a save answered 200 with another draft than the one it named is a lost answer: the form re-reads before Save is offered again', async () => {
    const saves = [];
    await openDraftForm({ 'POST /admin/careers/app-1/offer': () => { saves.push(1); return res(200, { offer: offerRecord({ id: 'offer-9', draftHash: 'other' }) }); } });
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('The save got no answer. The draft still reads as before, but the save may still finish. If it did, saving again is refused and this form shows the newer version.')).toBeInTheDocument();
    expect(screen.getByLabelText('Hours')).toHaveValue('Mon to Thu, 8 hours');
    expect(saves).toHaveLength(1);
  });

  // A first save (no draft yet) whose answer is lost: the read decides by the offers it holds, not only by an open draft.
  async function lostFirstSave(offerAfter) {
    let saved = false;
    const saves = [];
    setupFetch(
      { 'POST /admin/careers/app-1/offer': () => { saves.push(1); saved = true; return res(502, { error: 'Bad gateway' }); } },
      { offer: () => res(200, saved ? offerAfter : offerPayload()), detail: detailFixture({ status: 'offer' }) },
    );
    await openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Make an offer' }));
    await screen.findByLabelText('Hourly rate ($)');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    return saves;
  }

  it('a first save whose answer is lost, and whose new draft was discarded before the read, asks for review and offers no second save', async () => {
    // The save landed, and another admin discarded the draft it made before this form read again.
    const saves = await lostFirstSave(offerPayload({ current: offerRecord({ status: 'withdrawn', timeline: [] }) }));
    expect(await screen.findByText('This draft is no longer open. Close this form to see the offer.')).toBeInTheDocument();
    expect(screen.queryByText(/The save got no answer/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(saves).toHaveLength(1);
  });

  it('a first save whose answer is lost, with no new offer in the read, says so and offers Save again', async () => {
    const saves = await lostFirstSave(offerPayload());
    expect(await screen.findByText('The save got no answer. The draft still reads as before, but the save may still finish. If it did, saving again is refused and this form shows the newer version.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    expect(saves).toHaveLength(1);
  });

  it('a save answered gate-off closes the form and brings back the status-only Offer move', async () => {
    let off = false;
    await openDraftForm(
      { 'POST /admin/careers/app-1/offer': () => { off = true; return res(404, { enabled: false }); } },
      () => (off ? res(404, { enabled: false }) : res(200, offerPayload({ current: offerRecord() }))),
    );
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.queryByLabelText('Hours')).toBeNull());
    expect(screen.queryByText('HTTP 404')).toBeNull();
    const offerButton = screen.getByRole('button', { name: 'Offer' });
    await waitFor(() => expect(offerButton).not.toBeDisabled());
    fireEvent.click(offerButton);
    expect(await screen.findByRole('heading', { name: 'Move to Offer' })).toBeInTheDocument();
  });

  it('a re-read that finds the gate off closes the form and brings back the status-only Offer move', async () => {
    let off = false;
    await openDraftForm(
      { 'POST /admin/careers/app-1/offer': () => { off = true; return res(200, { offer: offerRecord({ draftHash: 'hash-2' }) }); } },
      () => (off ? res(404, { enabled: false }) : res(200, offerPayload({ current: offerRecord() }))),
    );
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.queryByLabelText('Hours')).toBeNull());
    const offerButton = screen.getByRole('button', { name: 'Offer' });
    await waitFor(() => expect(offerButton).not.toBeDisabled());
    fireEvent.click(offerButton);
    expect(await screen.findByRole('heading', { name: 'Move to Offer' })).toBeInTheDocument();
  });

  it('a send answer whose offer was withdrawn during delivery says it is no longer open, with no Revise advice', async () => {
    await openDraftForm({
      'POST /admin/careers/app-1/offer/offer-1/send': () => res(200, { offer: offerRecord({ status: 'withdrawn' }), comms: { sms: { outcome: 'failed' }, email: { outcome: 'failed' } } }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));
    const confirm = (await screen.findByText(/Send this offer to Jordan/)).closest('[role="dialog"]');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send offer' }));
    expect(await screen.findByText('This offer is no longer open.')).toBeInTheDocument();
    expect(screen.getByText('It was withdrawn or replaced while it was being sent. The offer card shows where it stands.')).toBeInTheDocument();
    expect(screen.queryByText(/use Revise/)).toBeNull();
  });

  it('a background read with a different draft hash makes the form read-only until the owner loads it', async () => {
    let current = offerRecord({ draftHash: 'h1' });
    await openDraftForm(
      { 'PATCH /admin/careers/app-1/status': () => { current = offerRecord({ draftHash: 'h2', hourlyRate: 24 }); return res(200, { application: detailFixture({ status: 'reviewed' }), sent: {} }); } },
      () => res(200, offerPayload({ current })),
    );
    fireEvent.change(screen.getByLabelText('Hours'), { target: { value: 'Mon to Thu, 8 hours' } });
    // A stage change elsewhere triggers a background re-read of the offer.
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    const stage = (await screen.findByRole('heading', { name: 'Move to Reviewed' })).closest('[role="dialog"]');
    const confirmButton = within(stage).getByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    fireEvent.click(confirmButton);
    expect(await screen.findByText('This draft changed. Review the new version.')).toBeInTheDocument();
    expect(screen.getByLabelText('Hourly rate ($)')).toBeDisabled();
    expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('23');
    expect(screen.queryByRole('button', { name: 'Send offer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the new version' }));
    await waitFor(() => expect(screen.getByLabelText('Hourly rate ($)')).toHaveValue('24'));
    expect(screen.getByLabelText('Hourly rate ($)')).not.toBeDisabled();
    expect(screen.getByLabelText('Hours')).toHaveValue(DEFAULTS.hoursLine);
  });

  it('a past start date shows the date error and stays editable', async () => {
    await openDraftForm({}, () => res(200, offerPayload({ current: offerRecord({ startDate: '2020-01-06', stepEffectiveOn: '2020-04-13' }) })));
    expect(screen.getByText('Pick a date in the future.')).toBeInTheDocument();
    expect(screen.getByLabelText('Start date')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send offer' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-11' } });
    expect(screen.queryByText('Pick a date in the future.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save draft' })).not.toBeDisabled();
    // Today (Eastern) is not in the future: the server refuses it, so the form does too (the clock is frozen on Nov 19).
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-11-19' } });
    expect(screen.getByText('Pick a date in the future.')).toBeInTheDocument();
  });

  it.each(['hired', 'rejected', 'withdrawn'])('a %s application does not open the Offer form', async (status) => {
    setupFetch({}, { detail: detailFixture({ status }) });
    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText(CONTACT.name));
    await screen.findByRole('heading', { name: /Jordan Rivera — / });
    const offerButton = screen.getByRole('button', { name: 'Offer' });
    await waitFor(() => expect(offerButton).not.toBeDisabled());
    fireEvent.click(offerButton);
    expect(await screen.findByRole('heading', { name: 'Move to Offer' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Hourly rate ($)')).toBeNull();
  });
});
