// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import VisitSummaryPage from './VisitSummaryPage';

const token = 'a'.repeat(64);
const summary = { serviceDate: '2020-01-01', services: [
  { id: 'service-a', serviceType: 'Pest Control', outcome: 'completed', reportUrl: `/report/${'b'.repeat(32)}` },
  { id: 'service-b', serviceType: 'Lawn Care', outcome: 'incomplete', reportUrl: `/report/${'c'.repeat(32)}` },
  { id: 'service-c', serviceType: 'Tree & Shrub', outcome: 'follow_up_needed', reportUrl: `/report/${'d'.repeat(32)}` },
  { id: 'service-d', serviceType: 'Mosquito', outcome: 'customer_concern', reportUrl: `/report/${'e'.repeat(32)}` },
  { id: 'service-e', serviceType: 'Termite', outcome: 'unexpected_value', reportUrl: `/report/${'f'.repeat(32)}` },
] };
const mount = (path = token) => render(<MemoryRouter initialEntries={[`/visit/${path}`]}><Routes><Route path="/visit/:token" element={<VisitSummaryPage />} /></Routes></MemoryRouter>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows each recorded outcome and opens its own report', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => summary })));
  mount();
  expect(await screen.findByText('Pest Control')).toBeInTheDocument();
  expect(screen.getByText('Not completed — we will return')).toBeInTheDocument();
  expect(screen.getByText('Follow-up needed')).toBeInTheDocument();
  expect(screen.getByText('Concern noted — we will follow up')).toBeInTheDocument();
  expect(screen.getByText('Service recorded')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /View service report/ }).map((link) => link.getAttribute('href'))).toEqual(summary.services.map((service) => service.reportUrl));
});

it('keeps temporary failures retryable and distinguishes a missing link', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: false, status: 404 }));
  mount();
  expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText(/This visit summary is unavailable/)).toBeInTheDocument();
});

it('rejects malformed tokens before fetching and refuses unsafe report destinations', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ...summary, services: [{ ...summary.services[0], reportUrl: 'https://example.invalid/private' }] }) }));
  vi.stubGlobal('fetch', fetchMock);
  const view = mount('invalid');
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
  view.unmount();
  mount();
  expect(await screen.findByText('Pest Control')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /View service report/ })).not.toBeInTheDocument();
});
