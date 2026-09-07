/**
 * DEV HARNESS — the real TrackPage, with fictional first-visit data.
 * /preview-track.html?state=scheduled|en_route|on_property|complete
 * Fetch and Socket.IO stay in this browser. Coordinates are intentionally
 * absent: the ETA is a fixture and the real GPS-unavailable state renders;
 * no Google Maps key, tile request, or customer location is needed.
 * Not imported by the production entry point or build.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Manager } from 'socket.io-client';
import '../index.css';
import '../styles/brand-tokens.css';
import TrackPage from '../pages/TrackPage';
import { etDateString, etDatetimeLocalToISO } from '../lib/timezone';

const TOKEN = 'b'.repeat(64);
const requestedState = new URLSearchParams(window.location.search).get('state');
const state = ['scheduled', 'on_property', 'complete'].includes(requestedState) ? requestedState : 'en_route';
const now = new Date().toISOString();
const payload = {
  state,
  customerFirstName: 'Jordan',
  customer: { name: 'Jordan Rivera', serviceContactNames: [] },
  service: { type: 'Quarterly Pest Control' },
  tech: { firstName: 'Alex', photoUrl: null },
  property: { addressLine1: '1200 Sample Lane', city: 'Parrish', state: 'FL', zip: '34219', lat: null, lng: null },
  window: { start: etDatetimeLocalToISO(`${etDateString()}T09:00`) },
  vehicle: { etaMinutes: 12, etaSource: 'provider', lat: null, lng: null, lastReportedAt: now },
  stopsAhead: state === 'scheduled' ? 2 : null,
  routeProgress: { currentStop: 2, yourStop: 4, totalStops: 6, atStop: true },
  arrivedAt: now,
  summary: {
    completedAt: now,
    photos: [],
    serviceReportToken: 'c'.repeat(64),
    invoiceToken: 'd'.repeat(64),
  },
  meta: { pollIntervalSeconds: 0 },
};

// Socket.IO constructs its manager during the page effect. Disable transport
// startup before mounting; the page keeps its real subscribe/cleanup calls.
// This override lives only in this standalone preview document.
Manager.prototype.open = function previewSocketOpen() { return this; };

const realFetch = window.fetch.bind(window);
const respond = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
  const method = options.method || input.method || 'GET';
  if (url.pathname === `/api/public/track/${TOKEN}` && method === 'GET') return respond(payload);
  if (url.pathname.startsWith('/api/') || url.origin !== window.location.origin) {
    return respond({ error: 'Preview endpoint not mocked' }, 404);
  }
  return realFetch(input, options);
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[`/track/${TOKEN}`]}>
    <Routes>
      <Route path="/track/:token" element={<TrackPage />} />
    </Routes>
  </MemoryRouter>,
);
