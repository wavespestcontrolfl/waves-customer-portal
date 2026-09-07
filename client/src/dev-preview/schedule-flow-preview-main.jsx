/**
 * DEV HARNESS — the real ScheduleFlowPage with fictional availability.
 * /preview-schedule-flow.html supports picking, searching, and confirming
 * entirely in memory. ?flow=reservice renders the same picker for a callback;
 * ?scenario=collective shows the recurring-series disclosure.
 * No backend, booking, AI provider, or customer message is involved. This
 * entry point is not imported by the production app or Vite build.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '../index.css';
import '../styles/brand-tokens.css';
import ScheduleFlowPage from '../pages/ScheduleFlowPage';
import { addETDays, etDateString, formatETDateOnly } from '../lib/timezone';

const TOKEN = 'a'.repeat(64);
const params = new URLSearchParams(window.location.search);
const flow = params.get('flow') === 'reservice' ? 'reservice' : 'reschedule';
const collective = params.get('scenario') === 'collective';
const now = new Date();
const today = etDateString(now);
const days = [2, 3, 5, 6, 8, 9, 10].map((offset, index) => {
  const date = etDateString(addETDays(now, offset));
  const nearby = index === 0 || index === 2;
  return {
    date,
    fullDate: formatETDateOnly(date, { weekday: 'long', month: 'long', day: 'numeric' }),
    nearby,
    rainChance: index === 1 ? 55 : 20,
    slots: [
      { date, start_time: '09:00', end_time: '10:30', start_label: '9:00 AM', end_label: '10:30 AM', technician_id: 'tech-preview', nearby, rank: index * 2 + 1 },
      { date, start_time: '13:00', end_time: '14:30', start_label: '1:00 PM', end_label: '2:30 PM', technician_id: 'tech-preview', nearby: false, rank: index * 2 + 2 },
    ],
  };
});
const availability = {
  days,
  slots: [days[0].slots[0], days[2].slots[0], days[0].slots[1]],
  rangeFrom: today,
  rangeTo: etDateString(addETDays(now, 13)),
};
const payload = {
  state: flow === 'reservice' ? 'eligible' : 'reschedulable',
  customerFirstName: 'Jordan',
  service: { type: 'Quarterly Pest Control' },
  isRecurring: true,
  collectiveAnchor: collective,
  futurePlacementDays: collective ? 3 : null,
  current: { date: etDateString(addETDays(now, 5)), windowStart: '09:00', windowEnd: '10:30' },
  lanes: [{ key: 'pest', label: 'Pest control', alreadyBooked: null }],
  availability,
};
const endpoint = `/api/public/${flow}/${TOKEN}`;
const realFetch = window.fetch.bind(window);
const respond = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
  const method = options.method || input.method || 'GET';
  if (url.pathname === `${endpoint}/find-slots` && method === 'POST') {
    // One deterministic afternoon result; this exercises the real search UI,
    // without pretending the fixture interprets arbitrary natural language.
    return respond({
      summary: 'Afternoon openings from the preview calendar.',
      availability: { ...availability, slots: [], days: days.slice(0, 3).map((day) => ({ ...day, slots: [day.slots[1]] })) },
    });
  }
  if (url.pathname === endpoint && method === 'POST') {
    const selected = JSON.parse(options.body || '{}');
    const slot = days.find((day) => day.date === selected.date)?.slots.find((item) => item.start_time === selected.start_time);
    if (!slot) return respond({ error: 'Choose an available preview time.', code: 'SLOT_TAKEN', availability }, 409);
    return respond({
      success: true,
      newDate: selected.date,
      date: selected.date,
      window: { start: slot.start_time, end: slot.end_time },
      startLabel: slot.start_label,
      seriesShifted: collective && selected.date !== payload.current.date,
      futurePlacementDays: payload.futurePlacementDays,
      serviceType: 'Pest control re-service',
      rescheduleUrl: '/preview-schedule-flow.html',
    });
  }
  if (url.pathname === endpoint && method === 'GET') return respond(payload);
  if (url.pathname.startsWith('/api/') || url.origin !== window.location.origin) {
    return respond({ error: 'Preview endpoint not mocked' }, 404);
  }
  return realFetch(input, options);
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[`/${flow}/${TOKEN}`]}>
    <Routes>
      <Route path={`/${flow}/:token`} element={<ScheduleFlowPage flow={flow} />} />
    </Routes>
  </MemoryRouter>,
);
