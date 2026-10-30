// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RecruitingPage, { inviteDelivered } from './RecruitingPage';

function apiResponse(body) {
  return { ok: true, json: vi.fn(async () => body) };
}

function detailFixture(overrides = {}) {
  return {
    id: 'app-1',
    role: 'technician',
    status: 'new',
    language: 'en',
    contact_snapshot: { name: 'Jordan Lee', phone: '9415551234', email: 'jordan@example.com' },
    answers: {},
    ai_score: 80,
    ai_recommendation: 'strong',
    ai_screen: null,
    comms_history: [],
    interview_url: null,
    interview_mode: null,
    interview_at: null,
    interview_booked_at: null,
    sms_consent: false,
    created_at: '2026-09-10T12:00:00Z',
    ...overrides,
  };
}

function previewFixture(overrides = {}) {
  return {
    status: 'interview',
    sending_enabled: true,
    templated: true,
    channels: {
      sms: { available: true, to: '(941) ***-1234', reason: null },
      email: { available: true, to: 'j***@example.com', reason: null },
    },
    sms_body: "Hi Jordan, pick a time: [interview link]",
    email_subject: "Let's set up your interview with Waves",
    email_body: 'Pick a time: [interview link]',
    interview_url: null,
    ...overrides,
  };
}

function buildFetchMock({ onPatch } = {}) {
  return vi.fn((url, options = {}) => {
    const method = options.method || 'GET';
    if (url.includes('/admin/careers?status=')) {
      return Promise.resolve(
        apiResponse({
          applications: [
            {
              id: 'app-1',
              role: 'technician',
              status: 'new',
              contact_snapshot: { name: 'Jordan Lee' },
              ai_score: 80,
              ai_recommendation: 'strong',
              created_at: '2026-09-10T12:00:00Z',
            },
          ],
          counts: { new: 1 },
        }),
      );
    }
    if (url.includes('/admin/careers/app-1/stage-preview')) {
      return Promise.resolve(apiResponse(previewFixture()));
    }
    if (url.endsWith('/admin/careers/app-1/status') && method === 'PATCH') {
      onPatch?.(JSON.parse(options.body));
      return Promise.resolve(
        apiResponse({
          application: detailFixture({ status: 'interview' }),
          sent: { sms: 'sent', email: 'sent' },
        }),
      );
    }
    if (url.endsWith('/admin/careers/app-1')) {
      return Promise.resolve(apiResponse({ application: detailFixture() }));
    }
    return Promise.resolve(apiResponse({}));
  });
}

async function openInterviewStageDialog() {
  render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
  fireEvent.click(await screen.findByText('Jordan Lee'));
  fireEvent.click(await screen.findByRole('button', { name: 'Interview' }));
  await screen.findByRole('heading', { name: 'Move to Interview' });
  // Preview resolves async — wait for the templated controls to appear.
  await screen.findByLabelText(/Text \(941\)/);
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

describe('RecruitingPage — stage change dialog', () => {
  it('a stage PATCH still in flight when the detail switches applicants is discarded — it never replaces the new detail (Codex r19 P2)', async () => {
    let releasePatch;
    const slowPatch = new Promise((resolve) => { releasePatch = resolve; });
    const base = buildFetchMock();
    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method || 'GET';
      if (url.includes('/admin/careers?status=')) {
        return Promise.resolve(apiResponse({
          applications: [
            { id: 'app-1', role: 'technician', status: 'new', contact_snapshot: { name: 'Jordan Lee' }, ai_score: 80, ai_recommendation: 'strong', created_at: '2026-09-10T12:00:00Z' },
            { id: 'app-2', role: 'technician', status: 'new', contact_snapshot: { name: 'Casey Kim' }, ai_score: 70, ai_recommendation: 'maybe', created_at: '2026-09-11T12:00:00Z' },
          ],
          counts: { new: 2 },
        }));
      }
      if (url.endsWith('/admin/careers/app-1/status') && method === 'PATCH') return slowPatch;
      if (url.endsWith('/admin/careers/app-2')) {
        return Promise.resolve(apiResponse({ application: detailFixture({ id: 'app-2', contact_snapshot: { name: 'Casey Kim', phone: '9415559876', email: 'casey@example.com' } }) }));
      }
      return base(url, options);
    });
    vi.stubGlobal('fetch', fetchMock);
    await openInterviewStageDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith('/admin/careers/app-1/status') && o?.method === 'PATCH')).toBe(true));
    // the detail switches to applicant B while A's PATCH is still pending
    fireEvent.click(screen.getAllByText('Casey Kim')[0]);
    await screen.findByText(/Casey Kim — /); // B's detail title
    // A's request finally FAILS (Codex r22 P2): its error must not surface in B's context
    releasePatch({ ok: false, status: 500, json: vi.fn(async () => ({ error: 'Stage change failed for applicant A' })) });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // B is still the open detail; A's failure never rendered over it
    expect(screen.getByText(/Casey Kim — /)).toBeInTheDocument();
    expect(screen.queryByText(/Jordan Lee — /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stage change failed for applicant A/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Text sent/)).not.toBeInTheDocument();
    // B's own stage workflow is usable (busy was reset on the switch)
    fireEvent.click(await screen.findByRole('button', { name: 'Interview' }));
    expect(await screen.findByRole('heading', { name: 'Move to Interview' })).toBeInTheDocument();
  });

  it('closes and clears the stage dialog when the detail switches to another applicant while it is open', async () => {
    const base = buildFetchMock();
    const fetchMock = vi.fn((url, options = {}) => {
      if (url.includes('/admin/careers?status=')) {
        return Promise.resolve(apiResponse({
          applications: [
            { id: 'app-1', role: 'technician', status: 'new', contact_snapshot: { name: 'Jordan Lee' }, ai_score: 80, ai_recommendation: 'strong', created_at: '2026-09-10T12:00:00Z' },
            { id: 'app-2', role: 'technician', status: 'new', contact_snapshot: { name: 'Casey Kim' }, ai_score: 70, ai_recommendation: 'maybe', created_at: '2026-09-11T12:00:00Z' },
          ],
          counts: { new: 2 },
        }));
      }
      if (url.endsWith('/admin/careers/app-2')) {
        return Promise.resolve(apiResponse({ application: detailFixture({ id: 'app-2', contact_snapshot: { name: 'Casey Kim', phone: '9415559876', email: 'casey@example.com' } }) }));
      }
      return base(url, options);
    });
    vi.stubGlobal('fetch', fetchMock);
    await openInterviewStageDialog();
    // applicant A's edited body is in the form
    fireEvent.change(screen.getByLabelText(/Text \(941\)/), { target: { value: 'Hi Jordan, custom [interview link]' } });
    // the detail switches to applicant B (same path a bell deep-link takes) while the dialog is up
    fireEvent.click(screen.getAllByText('Casey Kim')[0]);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/admin/careers/app-2'))).toBe(true));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Move to Interview' })).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue('Hi Jordan, custom [interview link]')).not.toBeInTheDocument();
  });

  it('fetches the stage preview on click and PATCHes with notify for the checked channels', async () => {
    let patchedBody = null;
    const fetchMock = buildFetchMock({ onPatch: (body) => { patchedBody = body; } });
    vi.stubGlobal('fetch', fetchMock);

    await openInterviewStageDialog();

    expect(fetchMock.mock.calls.some(([url]) => url.includes('/stage-preview?status=interview'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(patchedBody).not.toBeNull());
    expect(patchedBody.status).toBe('interview');
    // bound to the stage the operator saw on the detail (audit R1)
    expect(patchedBody.expected_status).toBe('new');
    expect(patchedBody.notify).toEqual({
      sms: true,
      email: true,
      sms_body: "Hi Jordan, pick a time: [interview link]",
      email_subject: "Let's set up your interview with Waves",
      email_body: 'Pick a time: [interview link]',
    });

    expect(await screen.findByText('Text sent · Email sent')).toBeInTheDocument();
  });

  it('shows a secondary Resend link button next to a booked interview time, wired to the resend flow', async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      const method = options.method || 'GET';
      if (url.includes('/admin/careers?status=')) {
        return Promise.resolve(apiResponse({
          applications: [{
            id: 'app-1', role: 'technician', status: 'interview',
            contact_snapshot: { name: 'Jordan Lee' }, ai_score: 80, ai_recommendation: 'strong',
            created_at: '2026-09-10T12:00:00Z',
          }],
          counts: { interview: 1 },
        }));
      }
      if (url.includes('/admin/careers/app-1/stage-preview')) {
        return Promise.resolve(apiResponse(previewFixture()));
      }
      if (method === 'PATCH') {
        return Promise.resolve(apiResponse({
          application: detailFixture({ status: 'interview' }),
          sent: { sms: 'sent', email: 'sent' },
        }));
      }
      if (url.endsWith('/admin/careers/app-1')) {
        return Promise.resolve(apiResponse({
          application: detailFixture({
            status: 'interview',
            interview_mode: 'phone',
            interview_at: '2026-09-22T20:30:00Z',
            interview_booked_at: '2026-09-15T00:00:00Z',
            interview_url: 'https://portal.wavespestcontrol.com/careers/interview/abc',
          }),
        }));
      }
      return Promise.resolve(apiResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Jordan Lee'));

    // The booked time itself still renders...
    await screen.findByText(/Phone call/);
    // ...next to a secondary Resend link button (not the primary Send/Resend
    // link CTA, which only shows when there's no booking yet).
    const resendButton = await screen.findByRole('button', { name: 'Resend link' });
    fireEvent.click(resendButton);

    await screen.findByRole('heading', { name: 'Resend interview link' });
  });

  it('hides every Resend/Send link action once the candidate has left the Interview stage', async () => {
    const fetchMock = vi.fn((url) => {
      if (url.includes('/admin/careers?status=')) {
        return Promise.resolve(apiResponse({
          applications: [{
            id: 'app-1', role: 'technician', status: 'offer',
            contact_snapshot: { name: 'Jordan Lee' }, ai_score: 80, ai_recommendation: 'strong',
            created_at: '2026-09-10T12:00:00Z',
          }],
          counts: { offer: 1 },
        }));
      }
      if (url.endsWith('/admin/careers/app-1')) {
        return Promise.resolve(apiResponse({
          application: detailFixture({
            status: 'offer',
            interview_mode: 'phone',
            interview_at: '2026-09-22T20:30:00Z',
            interview_booked_at: '2026-09-15T00:00:00Z',
            interview_url: 'https://portal.wavespestcontrol.com/careers/interview/abc',
          }),
        }));
      }
      return Promise.resolve(apiResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Jordan Lee'));

    await screen.findByText(/Phone call/);
    expect(screen.queryByRole('button', { name: 'Resend link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send link' })).toBeNull();
  });

  it('omits notify entirely when "Move without notifying" is checked', async () => {
    let patchedBody = null;
    const fetchMock = buildFetchMock({ onPatch: (body) => { patchedBody = body; } });
    vi.stubGlobal('fetch', fetchMock);

    await openInterviewStageDialog();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Move without notifying' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(patchedBody).not.toBeNull());
    expect(patchedBody.status).toBe('interview');
    expect(patchedBody).not.toHaveProperty('notify');
  });
});

describe('RecruitingPage — stale stage decision (audit R1)', () => {
  it('a 409 shows the refusal and replaces the detail with the newer stage and its history', async () => {
    const conflict = {
      error: "Cannot move: the application is now 'rejected', not 'new'. Nothing was changed or sent.",
      application: detailFixture({
        status: 'rejected',
        status_history: [{ from: 'new', to: 'rejected', note: 'No license', by: 'tech-uuid-2', at: '2026-10-29T19:00:00Z' }],
      }),
    };
    const base = buildFetchMock();
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if (url.endsWith('/admin/careers/app-1/status') && options.method === 'PATCH') {
        return Promise.resolve({ ok: false, status: 409, json: vi.fn(async () => conflict), clone: () => ({ json: async () => conflict }) });
      }
      return base(url, options);
    }));

    await openInterviewStageDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText(/now 'rejected', not 'new'/)).toBeInTheDocument();
    expect(screen.queryByText(/Text sent/)).not.toBeInTheDocument();
    // the detail under the dialog now shows the newer stage and why
    expect(screen.getByText('rejected')).toBeInTheDocument();
    expect(screen.getByText('No license')).toBeInTheDocument();
    // this dialog was opened on the old stage: Confirm could only 409 again
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });
});

describe('RecruitingPage — stage history and notes (audit R2)', () => {
  it('shows a note saved with a stage change in the detail, and the applicant entries on reopen', async () => {
    const savedHistory = [
      { from: 'new', to: 'reviewed', note: 'Called back, strong fit', by: 'tech-uuid-1', at: '2026-10-29T19:15:00Z' },
    ];
    const base = buildFetchMock();
    const fetchMock = vi.fn((url, options = {}) => {
      if (url.includes('/admin/careers/app-1/stage-preview')) {
        return Promise.resolve(apiResponse(previewFixture({ status: 'reviewed', templated: false, sms_body: null, email_subject: null, email_body: null })));
      }
      if (url.endsWith('/admin/careers/app-1/status') && options.method === 'PATCH') {
        return Promise.resolve(apiResponse({
          application: detailFixture({ status: 'reviewed', status_history: savedHistory }),
          sent: { sms: 'not_requested', email: 'not_requested' },
        }));
      }
      return base(url, options);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Jordan Lee'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reviewed' }));
    await screen.findByRole('heading', { name: 'Move to Reviewed' });
    fireEvent.change(await screen.findByLabelText('Note'), { target: { value: 'Called back, strong fit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('No message sent.');

    // the detail under the stage dialog now lists the saved note
    expect(await screen.findByText('Called back, strong fit')).toBeInTheDocument();
    expect(screen.getByText(/New → Reviewed/)).toBeInTheDocument();
  });

  it('labels each entry with who made it: the applicant, the named staff member, or Staff', async () => {
    const base = buildFetchMock();
    vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
      if (url.endsWith('/admin/careers/app-1')) {
        return Promise.resolve(apiResponse({
          application: detailFixture({
            status: 'interview',
            status_history: [
              { from: 'new', to: 'reviewed', note: null, by: 'bbbbbbbb-0000-4000-8000-000000000002', at: '2026-10-27T14:00:00Z' },
              { from: 'reviewed', to: 'interview', note: null, by: 'tech-uuid-1', by_name: 'Sam Office', at: '2026-10-28T14:00:00Z' },
              { from: 'interview', to: 'interview', note: 'Interview booked Tue Nov 3, 4:30 PM (phone)', by: 'applicant', at: '2026-10-28T16:00:00Z' },
            ],
          }),
        }));
      }
      return base(url, options);
    }));

    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Jordan Lee'));

    expect(await screen.findByText('Interview booked Tue Nov 3, 4:30 PM (phone)')).toBeInTheDocument();
    expect(screen.getByText(/Interview · Applicant/)).toBeInTheDocument();
    expect(screen.getByText(/Reviewed → Interview · Sam Office/)).toBeInTheDocument();
    // A staff id with no name on file says Staff, never the raw id.
    expect(screen.getByText(/New → Reviewed · Staff/)).toBeInTheDocument();
    expect(screen.queryByText(/bbbbbbbb-/)).not.toBeInTheDocument();
  });
});

describe('RecruitingPage — queue reads (audit R3)', () => {
  function failedResponse(status, error) {
    const body = { error };
    return { ok: false, status, json: vi.fn(async () => body), clone: () => ({ json: async () => body }) };
  }

  it("a failed read for another tab shows the error with Try again, never the previous tab's cards", async () => {
    let rejectedFails = true;
    const base = buildFetchMock();
    const fetchMock = vi.fn((url, options = {}) => {
      if (url.includes('/admin/careers?status=rejected')) {
        return Promise.resolve(rejectedFails
          ? failedResponse(503, 'Failed to load applications')
          : apiResponse({ applications: [], counts: { new: 1 } }));
      }
      return base(url, options);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);
    expect(await screen.findByText('Jordan Lee')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Rejected/ }));

    expect(await screen.findByText('Failed to load applications')).toBeInTheDocument();
    expect(screen.queryByText('Jordan Lee')).not.toBeInTheDocument();
    expect(screen.queryByText(/No rejected applications/)).not.toBeInTheDocument();

    rejectedFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No rejected applications/)).toBeInTheDocument();
    expect(screen.queryByText('Failed to load applications')).not.toBeInTheDocument();
  });

  it('a failed first read shows the error, not an empty queue', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(failedResponse(503, 'Failed to load applications'))));

    render(<MemoryRouter><RecruitingPage /></MemoryRouter>);

    expect(await screen.findByText('Failed to load applications')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/No new applications/)).not.toBeInTheDocument();
  });
});

describe('RecruitingPage — stage dialog field labels (audit R4)', () => {
  it('names the text and email editors by channel', async () => {
    vi.stubGlobal('fetch', buildFetchMock());

    await openInterviewStageDialog();

    expect(screen.getByLabelText('Text message')).toHaveValue('Hi Jordan, pick a time: [interview link]');
    expect(screen.getByLabelText('Subject')).toHaveValue("Let's set up your interview with Waves");
    expect(screen.getByLabelText('Email message')).toHaveValue('Pick a time: [interview link]');
    expect(screen.getByLabelText('Note')).toHaveValue('');
  });
});

describe('inviteDelivered', () => {
  it('is true only for a sent/uncertain/handoff interview_invite entry, never for a minted token alone', () => {
    expect(inviteDelivered({ interview_url: 'https://x/y', comms_history: [] })).toBe(false);
    expect(inviteDelivered({ comms_history: [{ stage: 'interview_invite', outcome: 'blocked' }] })).toBe(false);
    expect(inviteDelivered({ comms_history: [{ stage: 'application_received', outcome: 'sent' }] })).toBe(false);
    for (const outcome of ['sent', 'uncertain', 'handoff']) {
      expect(inviteDelivered({ comms_history: [{ stage: 'interview_invite', outcome }] })).toBe(true);
    }
  });
});
