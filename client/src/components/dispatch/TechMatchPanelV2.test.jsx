// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TechMatchPanelV2 from './TechMatchPanelV2';
const ok = matches => ({ok:true,json:async () => ({allMatches:matches})});
beforeEach(() => {vi.stubGlobal('fetch',vi.fn());});
afterEach(() => {cleanup();vi.unstubAllGlobals();});
it.each(['http','network'])('shows %s failure and retries the existing simulation payload',async kind => {
 if(kind==='http') fetch.mockResolvedValueOnce({ok:false});else fetch.mockRejectedValueOnce(new Error('offline'));
 render(<TechMatchPanelV2 />);fireEvent.click(screen.getByRole('button',{name:'Run match'}));
 await screen.findByRole('alert');expect(screen.queryByText('Match result')).not.toBeInTheDocument();
 fetch.mockResolvedValueOnce(ok([{tech:{name:'Synthetic Technician'},matchScore:95,reasoning:'Synthetic eligible match'}]));
 fireEvent.click(screen.getByRole('button',{name:'Retry match'}));
 await screen.findByText('Synthetic Technician');expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 expect(JSON.parse(fetch.mock.lastCall[1].body)).toEqual({serviceType:'general_pest',zip:'34219',jobCategory:'recurring'});
});
it('keeps successful empty matches distinct and clears an old result on failed rerun',async () => {
 fetch.mockResolvedValueOnce(ok([]));render(<TechMatchPanelV2 />);
 fireEvent.click(screen.getByRole('button',{name:'Run match'}));await screen.findByText('Match result');
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 fetch.mockResolvedValueOnce({ok:false});fireEvent.click(screen.getByRole('button',{name:'Run match'}));
 await screen.findByRole('alert');expect(screen.queryByText('Match result')).not.toBeInTheDocument();
});
