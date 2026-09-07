// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EquipmentPage from './EquipmentPage';
vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));
vi.mock('./EquipmentMaintenancePage', () => ({ default: () => null }));
vi.mock('./EquipmentCalibrationPanel', () => ({ default: () => null }));
const mix = { id: 'qa-mix', name: 'Synthetic mix', products: [] };
const ok = (rows = [mix], key = 'tank_mixes') => ({ ok: true, json: async () => ({ [key]: rows }) });
let handler;
beforeEach(() => { handler = async () => ok(); vi.stubGlobal('fetch', vi.fn((...args) => handler(...args))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = (strict = false) => render(<MemoryRouter initialEntries={['/?tab=tank-mixes']}>{strict ? <StrictMode><EquipmentPage /></StrictMode> : <EquipmentPage />}</MemoryRouter>);
it.each(['http', 'network'])('reports %s failure and retries to true empty', async kind => {
 handler = async () => { if (kind === 'network') throw Error('offline'); return { ok: false, status: 503 }; };
 mount(); await screen.findByRole('alert'); expect(screen.queryByText(/No tank mixes configured/)).not.toBeInTheDocument();
 handler = async () => ok([]); fireEvent.click(screen.getByRole('button', { name: 'Retry tank mixes' }));
 await screen.findByText(/No tank mixes configured/); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it.each(['tank_mixes', 'mixes'])('renders %s response', async key => {
 handler = async () => ok([mix], key); mount(); await screen.findByText(mix.name);
});
it.each([true, false])('ignores obsolete StrictMode completion success=%s', async success => {
 let release; let calls = 0; handler = async () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : ok();
 mount(true); await screen.findByText(mix.name);
 await act(async () => release(success ? ok([{ ...mix, name: 'Obsolete' }]) : { ok: false, status: 503 }));
 expect(screen.getByText(mix.name)).toBeInTheDocument(); expect(screen.queryByText('Obsolete')).not.toBeInTheDocument(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('ignores load completion after unmount', async () => {
 let release; handler = () => new Promise(resolve => { release = resolve; }); const view = mount(); view.unmount();
 handler = async () => ok(); mount(); await screen.findByText(mix.name);
 await act(async () => release(ok([]))); expect(screen.getByText(mix.name)).toBeInTheDocument();
});
it('retains previous rows on post-recalculation refresh failure and retries', async () => {
 mount(); await screen.findByText(mix.name);
 handler = async (url, options) => options.method === 'POST' ? ok() : { ok: false, status: 503 };
 fireEvent.click(screen.getByRole('button', { name: 'Recalc', exact: true }));
 expect(await screen.findByRole('alert')).toHaveTextContent('costs may be out of date'); expect(screen.getByText(mix.name)).toBeInTheDocument();
 handler = async () => ok([{ ...mix, name: 'Refreshed mix' }]); fireEvent.click(screen.getByRole('button', { name: 'Retry tank mixes' }));
 await screen.findByText('Refreshed mix'); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
