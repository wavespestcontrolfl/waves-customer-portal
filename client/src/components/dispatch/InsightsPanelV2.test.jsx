// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InsightsPanelV2 from './InsightsPanelV2';
const ok = (value=30) => ({ok:true,json:async () => ({summary:{avgRevPerHr:value,avgDrivePct:value,completionRate:value,callbackRate:value,actualRevenue:value,expectedRevenue:value},techMetrics:[],forecast:[]})});
beforeEach(() => {vi.stubGlobal('fetch',vi.fn(async () => ok()));});
afterEach(() => {cleanup();vi.unstubAllGlobals();});
it.each([true,false])('ignores obsolete period responses (success=%s)',async success => {
 render(<InsightsPanelV2 />);await screen.findAllByText('$30');
 let release;
 fetch.mockImplementationOnce(() => new Promise(resolve => {release=resolve;}));
 fireEvent.click(screen.getByRole('button',{name:'7d'}));
 expect(screen.queryAllByText('$30')).toHaveLength(0);
 expect(screen.getByRole('status')).toHaveTextContent('Loading insights');
 fetch.mockResolvedValueOnce(ok(90));
 fireEvent.click(screen.getByRole('button',{name:'90d'}));
 await screen.findAllByText('$90');
 await act(async () => {release(success ? ok(7) : {ok:false});});
 expect(screen.getAllByText('$90')).toHaveLength(2);
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 expect(screen.queryByText('$7')).not.toBeInTheDocument();
});
it('renders zero measurements and a zero forecast distinctly from missing data',async () => {
 fetch.mockResolvedValue(ok(0));render(<InsightsPanelV2 />);
 expect(await screen.findAllByText('$0')).toHaveLength(2);
 expect(screen.getAllByText('0%')).toHaveLength(3);
 expect(screen.getByText('vs $0 forecast')).toBeInTheDocument();
 fetch.mockResolvedValue({ok:true,json:async () => ({summary:{},techMetrics:[],forecast:[]})});
 fireEvent.click(screen.getByRole('button',{name:'7d'}));
 expect(await screen.findAllByText('$—')).toHaveLength(2);
 expect(screen.getByText('vs no forecast')).toBeInTheDocument();
});
it.each(['http','network'])('shows %s failure then retries the same period',async kind => {
 render(<InsightsPanelV2 />);await screen.findAllByText('$30');
 if(kind==='http') fetch.mockResolvedValueOnce({ok:false});else fetch.mockRejectedValueOnce(new Error('offline'));
 fireEvent.click(screen.getByRole('button',{name:'7d'}));
 await screen.findByRole('alert');expect(screen.queryByText('No tech data yet')).not.toBeInTheDocument();
 fetch.mockResolvedValueOnce(ok(7));fireEvent.click(screen.getByRole('button',{name:'Retry'}));
 await screen.findAllByText('$7');expect(fetch.mock.lastCall[0]).toContain('days=7');
});
it('ignores a response from a prior unmounted instance',async () => {
 let release;fetch.mockImplementationOnce(() => new Promise(resolve => {release=resolve;}));
 const view=render(<InsightsPanelV2 />);view.unmount();
 render(<InsightsPanelV2 />);await screen.findAllByText('$30');
 await act(async () => {release(ok(7));});
 expect(screen.queryByText('$7')).not.toBeInTheDocument();
});

it.each([
 { drive: 25, callback: 6, alert: false },
 { drive: 26, callback: 7, alert: true },
])('preserves summary alert thresholds for drive=$drive and callback=$callback', async ({ drive, callback, alert }) => {
 fetch.mockResolvedValue({ok:true,json:async () => ({summary:{avgDrivePct:drive,callbackRate:callback},techMetrics:[],forecast:[]})});
 render(<InsightsPanelV2 />);
 const driveValue=await screen.findByText(`${drive}%`);
 const callbackValue=screen.getByText(`${callback}%`);
 for (const value of [driveValue, callbackValue]) {
  expect(value).toHaveClass(alert ? 'text-alert-fg' : 'text-ink-primary');
  expect(value).not.toHaveClass(alert ? 'text-ink-primary' : 'text-alert-fg');
 }
 expect(screen.getByText('target <25%')).toBeInTheDocument();
 expect(screen.getByText('target <5%')).toBeInTheDocument();
});
