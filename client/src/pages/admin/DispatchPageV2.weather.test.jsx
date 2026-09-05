// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DispatchPageV2 from './DispatchPageV2';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn(), isRateLimitError: () => false }));
vi.mock('../../components/schedule/TimeGridDay', () => ({ default: () => <div>Schedule visits</div> }));
vi.mock('../../components/schedule/MobileDispatchList', () => ({ default: () => null }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ alerts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([
  [{}, 'Weather unavailable', 'UNKNOWN'],
  [{ temp: 0, rainProbability: 0, windSpeed: 0 }, '0°F', 'GO'],
  [{ temp: 77, rainProbability: 0, windSpeed: 0 }, '77°F', 'GO'],
  [{ temp: 77, rainProbability: 10 }, '77°F', 'UNKNOWN'],
  [{ temp: 77, windSpeed: 5 }, '77°F', 'UNKNOWN'],
  [{ rainProbability: 51 }, 'Weather unavailable', 'HOLD'],
  [{ windSpeed: 16 }, 'Weather unavailable', 'HOLD'],
  [{ temp: 77, rainProbability: 50, windSpeed: 15 }, '77°F', 'GO'],
])('renders measured versus unavailable weather: %j', async (weather, temperature, assessment) => {
  vi.mocked(adminFetch).mockImplementation(async path => path.startsWith('/admin/schedule?')
    ? { services: [], technicians: [], weather }
    : { products: [], types: [] });
  render(<MemoryRouter initialEntries={['/admin/dispatch?tab=schedule&date=2026-09-05']}><DispatchPageV2 activeTab="board" /></MemoryRouter>);
  await screen.findByText(`SPRAY: ${assessment}`);
  expect(screen.getByText(temperature)).toBeInTheDocument();
  expect(screen.queryByText('82°F')).not.toBeInTheDocument();
  expect(screen.getByText('Schedule visits')).toBeInTheDocument();
});
