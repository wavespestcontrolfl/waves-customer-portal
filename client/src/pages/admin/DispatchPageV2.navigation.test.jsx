// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DispatchPageV2 from './DispatchPageV2';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));
const enabledVisit = { id: 'service-one', visitId: 'visit-one', visitCloseoutEnabled: true, visitCloseoutPacket: null };
vi.mock('../../components/schedule/TimeGridDay', () => ({ default: ({ onEdit }) => <div>Schedule visits<button onClick={() => onEdit(enabledVisit)}>Open day visit</button></div> }));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: () => null }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));
vi.mock('../../components/admin/VisitCloseoutSheet', () => ({ default: ({ visitId }) => <div>Visit closeout {visitId}</div> }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });


vi.mock('../../components/schedule/TimeGridDays', () => ({ default: ({ date, dayCount, onEdit }) => <div>Grid date: {date}<button onClick={() => onEdit(enabledVisit)}>Open {dayCount}-day visit</button></div> }));
vi.mock('../../components/schedule/CalendarViewsV2', async importOriginal => ({
  ...await importOriginal(), MonthViewV2: ({date}) => <div>Month date: {date}</div>,
}));

it.each([
  ['2026-09-09', 'Sep 7 – Sep 11, 2026', '2026-09-16', 'Sep 14 – Sep 18, 2026'],
  ['2026-09-30', 'Sep 28 – Oct 2, 2026', '2026-10-07', 'Oct 5 – Oct 9, 2026'],
  ['2026-12-30', 'Dec 28 – Jan 1, 2027', '2027-01-06', 'Jan 4 – Jan 8, 2027'],
])('navigates adjacent workweeks from %s with matching date headings', async (date, heading, nextDate, nextHeading) => {
  vi.mocked(adminFetch).mockResolvedValue({ services: [], technicians: [], products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date='+date]}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', {name:'5-Day'}));
  expect(screen.getByText(heading)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Next', exact:true}));
  await screen.findByText('Grid date: '+nextDate);
  expect(screen.getByText(nextHeading)).toBeInTheDocument();
  expect(adminFetch).toHaveBeenCalledWith('/admin/schedule?date='+nextDate);
  fireEvent.click(screen.getByRole('button', {name:'Prev', exact:true}));
  await screen.findByText('Grid date: '+date);
  expect(screen.getByText(heading)).toBeInTheDocument();
});

it.each([
  ['Day', '2026-10-01'], ['Week', '2026-10-07'], ['Month', '2026-10-30'],
])('preserves %s navigation across a month boundary', async (mode, nextDate) => {
  vi.mocked(adminFetch).mockResolvedValue({ services: [], technicians: [], products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-09-30']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', {name:mode, exact:true}))[0]);
  fireEvent.click(screen.getByRole('button', {name:'Next', exact:true}));
  (await screen.findAllByRole('button', {name:mode, exact:true}))[0];
  expect(adminFetch).toHaveBeenCalledWith('/admin/schedule?date='+nextDate);
});

it.each([
  ['Day', 'Open day visit'],
  ['5-Day', 'Open 5-day visit'],
  ['Week', 'Open 7-day visit'],
])('opens an enabled unsubmitted combined visit from the desktop %s calendar', async (mode, entryName) => {
  vi.mocked(adminFetch).mockResolvedValue({ services: [enabledVisit], technicians: [], products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-09-12']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', { name: mode, exact: true }))[0]);
  fireEvent.click(await screen.findByRole('button', { name: entryName }));
  expect(await screen.findByText('Visit closeout visit-one')).toBeInTheDocument();
});
