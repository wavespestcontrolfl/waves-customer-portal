// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';

// GATE_REPORT_WEB_PEOPLE (owner 2026-10-20): the server adds `webPeople` beside simpleWebReport. The page then shows the
// technician strip and the traced map at the top, and the next-visit card and review link at the foot. No key = no card.

function renderReport(payload) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
  vi.stubGlobal('fetch', fetchMock);
  const view = render(
    <MemoryRouter initialEntries={['/report/test-web-people']}>
      <Routes>
        <Route path="/report/:token" element={<ReportViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, fetchMock };
}

beforeEach(() => {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((key) => delete store[key]); },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const TRACED = { snapshotUrl: 'https://img.example/trace.jpg', maskUrl: null, captureMode: 'lawn', closedLoop: true, pathPoints: [] };
const payload = (people, extra = {}) => ({
  ...structuredClone(legacyLawnReport),
  pdfUrl: '/api/reports/test-web-people',
  simpleWebReport: true,
  customerFirstName: 'Casey',
  technicianName: 'Alex Rivera',
  ...(people ? { webPeople: people } : {}),
  ...extra,
});

describe('web report people cards', () => {
  it('no webPeople key: none of the cards render', async () => {
    const { container } = renderReport(payload(null));
    await screen.findByText(/This report is provided for your records/);
    expect(container.querySelector('.web-people-tech, .web-people-map, .web-people-next-visit, .web-people-review')).toBeNull();
  });

  it('technician strip: fixed sentences, photo, FDACS id; the count only when sent', async () => {
    const { container } = renderReport(payload({ tech: { firstName: 'Alex', photoUrl: 'https://img.example/alex.jpg', fdacsId: 'JF123456', visitsAtHome: 4 } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByText('Alex was your technician today.')).toBeInTheDocument();
    expect(screen.getByText('Alex has treated your home 4 times.')).toBeInTheDocument();
    expect(screen.getByText('FDACS ID card #JF123456')).toBeInTheDocument();
    expect(screen.getByAltText('Alex, your technician')).toHaveAttribute('src', 'https://img.example/alex.jpg');
    expect(container.querySelector('.web-people-tech')).not.toBeNull();
  });

  it('a technician photo that fails to load falls back to the initial', async () => {
    const { container } = renderReport(payload({ tech: { firstName: 'Alex', photoUrl: 'https://img.example/expired.jpg', fdacsId: null, visitsAtHome: null } }));
    await screen.findByText(/This report is provided for your records/);
    fireEvent.error(screen.getByAltText('Alex, your technician'));
    expect(screen.queryByAltText('Alex, your technician')).toBeNull();
    expect(container.querySelector('.web-people-tech').textContent).toContain('A');
  });

  it('technician strip without a photo shows the initial, and without a count says nothing about visits', async () => {
    renderReport(payload({ tech: { firstName: 'Alex', photoUrl: null, fdacsId: null, visitsAtHome: null } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByAltText('Alex, your technician')).toBeNull();
    expect(screen.queryByText(/has treated your home/)).toBeNull();
    expect(screen.queryByText(/FDACS ID card/)).toBeNull();
  });

  it('traced map: a lawn card with the traced snapshot, and the document leaves out its own flat map', async () => {
    const { container } = renderReport(payload({ treatedMap: true }, { treatmentMap: { traced: TRACED } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByText('Where we treated your lawn')).toBeInTheDocument();
    expect(container.querySelectorAll('img[src="https://img.example/trace.jpg"]')).toHaveLength(1);
    expect(screen.getByText('Treated lawn area outlined on-site by your technician.')).toBeInTheDocument();
    expect(screen.queryByAltText('Technician-traced treatment map')).toBeNull();
  });

  it('the top map snapshot fails to load: the card goes away and the document shows its own map', async () => {
    const { container } = renderReport(payload({ treatedMap: true }, { treatmentMap: { traced: TRACED } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByAltText('Technician-traced treatment map')).toBeNull();
    fireEvent.error(container.querySelector('.web-people-map img.traced-zone-image'));
    expect(container.querySelector('.web-people-map')).toBeNull();
    expect(screen.getByAltText('Technician-traced treatment map')).toBeInTheDocument();
  });

  it('no webPeople map flag: the document keeps its own traced map', async () => {
    const { container } = renderReport(payload({ tech: { firstName: 'Alex', photoUrl: null, fdacsId: null, visitsAtHome: null } }, { treatmentMap: { traced: TRACED } }));
    await screen.findByText(/This report is provided for your records/);
    expect(container.querySelector('.web-people-map')).toBeNull();
    expect(screen.getByAltText('Technician-traced treatment map')).toBeInTheDocument();
  });

  it('next visit: Works confirms on the page and writes nothing; Move it opens the signed-in portal schedule, never a token link', async () => {
    const { container, fetchMock } = renderReport(payload({ nextVisit: { serviceType: 'Lawn Care', scheduledDate: '2026-11-18', windowStart: '09:00:00' } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByText('Your next visit')).toBeInTheDocument();
    expect(screen.getByText(/Lawn Care · Wed, Nov 18 · 9:00 AM/)).toBeInTheDocument();
    expect(screen.getByText('Does this time work for you?')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Move it' })).toHaveAttribute('href', '/?tab=schedule');
    expect(container.innerHTML).not.toMatch(/\/reschedule/);
    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Works' }));
    expect(screen.getByText('Great. We will see you then.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Works' })).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('review card with no validated technician asks about "we", never the placeholder label', async () => {
    renderReport(payload({ tech: null, review: { url: 'https://g.page/r/example/review', locationId: 'venice' } }, { technician: { name: 'Your Waves technician' }, technicianName: 'Your Waves technician' }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByRole('heading', { name: /^How did we do today/ })).toBeInTheDocument();
    expect(screen.queryByText(/How did Your/)).toBeNull();
  });

  it('review card: names the technician and the customer, links to Google, and records the click', async () => {
    const { fetchMock } = renderReport(payload({ tech: { firstName: 'Alex', photoUrl: null, fdacsId: null, visitsAtHome: null }, review: { url: 'https://g.page/r/example/review', locationId: 'venice' } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.getByRole('heading', { name: 'How did Alex do today, Casey?' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Rate today.s visit/ });
    expect(link).toHaveAttribute('href', 'https://g.page/r/example/review');
    fireEvent.click(link);
    const eventCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/reports/test-web-people/events')
      && JSON.parse(init.body).eventName === 'review_request_clicked');
    expect(JSON.parse(eventCall[1].body).metadata).toEqual({ location: 'venice', placement: 'web_people' });
  });

  it('no review in webPeople: no review card', async () => {
    renderReport(payload({ nextVisit: { serviceType: 'Lawn Care', scheduledDate: '2026-11-18', windowStart: null } }));
    await screen.findByText(/This report is provided for your records/);
    expect(screen.queryByText(/How did .* do today/)).toBeNull();
  });
});
