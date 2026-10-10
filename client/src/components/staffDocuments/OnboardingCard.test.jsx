// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import OnboardingCard, { onboardingLink, outstandingLabel } from './OnboardingCard';
import OnboardingStatus from './OnboardingStatus';
import { request } from './common';

vi.mock('./common', async () => ({ ...await vi.importActual('./common'), request: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

const form = { document_id: 'doc-1', title: 'Vehicle agreement', kind: 'form', version_id: 'ver-1', due_at: '2026-10-15T12:00:00Z' };
const policy = { document_id: 'doc-2', title: 'Handbook', kind: 'policy', version_id: 'ver-2', due_at: null };
const card = (props = {}) => render(<MemoryRouter><OnboardingCard available base="/admin/today" {...props} /></MemoryRouter>);

test('wording is singular for one document and plural for more', () => {
  expect(outstandingLabel(1)).toBe('Sign 1 document to finish setup');
  expect(outstandingLabel(3)).toBe('Sign 3 documents to finish setup');
});

test('the link opens the first outstanding document', () => {
  expect(onboardingLink('/admin/today', '', form)).toBe('/admin/today/documents?document=doc-1&version=ver-1');
  expect(onboardingLink('/admin/today', '', policy)).toBe('/admin/today/documents?document=doc-2&version=ver-2');
  expect(onboardingLink('/tech', '?visit=v9', policy)).toBe('/tech/documents?visit=v9&document=doc-2&version=ver-2');
});

test('shows the count and opens the first outstanding document', async () => {
  request.mockResolvedValue({ enabled: true, documents: [form, policy], counts: { outstanding: 2, total: 2 } });
  card();
  expect(await screen.findByText('Sign 2 documents to finish setup')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith('/onboarding', undefined, expect.anything());
  expect(screen.getByRole('link', { name: 'Open Vehicle agreement' })).toHaveAttribute('href', '/admin/today/documents?document=doc-1&version=ver-1');
  expect(screen.getByTestId('onboarding-card')).toBeInTheDocument();
});

test('one outstanding document uses the singular wording', async () => {
  request.mockResolvedValue({ enabled: true, documents: [policy], counts: { outstanding: 1, total: 2 } });
  card();
  expect(await screen.findByText('Sign 1 document to finish setup')).toBeInTheDocument();
});

test.each([
  ['nothing is outstanding', { enabled: true, documents: [], counts: { outstanding: 0, total: 1 } }],
  ['the server says onboarding is off', { enabled: false, documents: [form], counts: { outstanding: 1, total: 1 } }],
])('hidden when %s', async (name, payload) => {
  request.mockResolvedValue(payload);
  card();
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(screen.queryByTestId('onboarding-card')).not.toBeInTheDocument();
});

test('hidden, and nothing is fetched, while staff documents are unavailable', () => {
  card({ available: false });
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByTestId('onboarding-card')).not.toBeInTheDocument();
});

test('hidden when the read fails', async () => {
  request.mockRejectedValue(new Error('offline'));
  card();
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(screen.queryByTestId('onboarding-card')).not.toBeInTheDocument();
});

test('the admin list is not fetched for staff who cannot manage', () => {
  render(<OnboardingStatus />);
  expect(request).not.toHaveBeenCalled();
});

test('the admin list shows signed and outstanding per person, and hides itself while dark', async () => {
  request.mockResolvedValue({ enabled: true, technicians: [
    { technician_id: 't1', name: 'QA Alpha', outstanding: [form], signed: [{ document_id: 'doc-2', title: 'Handbook', completed_at: '2026-10-09T12:00:00Z' }] },
    { technician_id: 't2', name: 'QA Beta', outstanding: [], signed: [] },
  ] });
  const { unmount } = render(<OnboardingStatus enabled />);
  expect(await screen.findByText(/QA Alpha/)).toBeInTheDocument();
  expect(screen.getByText(/1 of 2 signed · 1 outstanding/)).toBeInTheDocument();
  expect(screen.getByText(/Outstanding: Vehicle agreement/)).toBeInTheDocument();
  expect(screen.getByText(/Signed: Handbook/)).toBeInTheDocument();
  expect(screen.queryByText(/QA Beta/)).not.toBeInTheDocument();
  unmount();
  request.mockResolvedValue({ enabled: false, technicians: [] });
  render(<OnboardingStatus enabled />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId('onboarding-status')).not.toBeInTheDocument();
});
