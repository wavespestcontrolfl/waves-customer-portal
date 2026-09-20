// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RecruitingPage from './RecruitingPage';

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
  it('fetches the stage preview on click and PATCHes with notify for the checked channels', async () => {
    let patchedBody = null;
    const fetchMock = buildFetchMock({ onPatch: (body) => { patchedBody = body; } });
    vi.stubGlobal('fetch', fetchMock);

    await openInterviewStageDialog();

    expect(fetchMock.mock.calls.some(([url]) => url.includes('/stage-preview?status=interview'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(patchedBody).not.toBeNull());
    expect(patchedBody.status).toBe('interview');
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
