// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProtocolReferenceTabV2 from './ProtocolReferenceTabV2';

const catalog = {lawn:{tracks:[{key:'st_augustine',name:'Synthetic Lawn',visits:0}]},programs:[{key:'qa_pest',name:'Synthetic Pest',visits:0}]};
const ok = data => ({ok:true,json:async () => data});
const fail = () => ({ok:false,json:async () => ({error:'Synthetic unavailable'})});
let catalogFails, trackFails;
beforeEach(() => {
  catalogFails=true; trackFails=false;
  vi.stubGlobal('fetch',vi.fn(async url => {
    if(url === '/api/admin/protocols/programs') return catalogFails ? fail() : ok(catalog);
    if(url.includes('/programs?')) return trackFails ? fail() : ok({track:{name:'Synthetic protocol',visits:[]}});
    return ok({calibrations:[]});
  }));
});
afterEach(() => {cleanup();vi.unstubAllGlobals();});

it('reports initial catalog failure, repeats a failed retry, then loads the catalog and default track',async () => {
  render(<ProtocolReferenceTabV2 />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Select a program above')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await screen.findByRole('alert');
  catalogFails=false;
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await waitFor(() => expect(screen.getByLabelText('Protocol')).toHaveValue('st_augustine'));
  expect(screen.queryByText('Failed to load protocol catalog')).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith('/api/admin/protocols/programs?track=st_augustine',expect.anything());
});

it('keeps a default-track failure distinct from a catalog failure and allows manual recovery',async () => {
  catalogFails=false;trackFails=true;
  render(<ProtocolReferenceTabV2 />);
  await screen.findByText('Select a program above');
  expect(screen.queryByText('Failed to load protocol catalog')).not.toBeInTheDocument();
  trackFails=false;
  fireEvent.change(screen.getByLabelText('Protocol'),{target:{value:'st_augustine'}});
  await screen.findByText('Tier Legend');
});

it('preserves individual protocol rollback and retry after a successful catalog',async () => {
  catalogFails=false;
  render(<ProtocolReferenceTabV2 />);
  await screen.findByText('Tier Legend');
  trackFails=true;
  fireEvent.change(screen.getByLabelText('Protocol'),{target:{value:'qa_pest'}});
  await screen.findByText(/Couldn't load that protocol/);
  expect(screen.getByLabelText('Protocol')).toHaveValue('st_augustine');
  trackFails=false;
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await waitFor(() => expect(screen.getByLabelText('Protocol')).toHaveValue('qa_pest'));
  expect(screen.queryByText(/Couldn't load that protocol/)).not.toBeInTheDocument();
});

it('ignores an obsolete catalog result after unmount and remount',async () => {
  let resolveOld;
  fetch.mockImplementationOnce(() => new Promise(resolve => {resolveOld=resolve;}));
  const view=render(<ProtocolReferenceTabV2 />);
  view.unmount();
  render(<ProtocolReferenceTabV2 />);
  await screen.findByRole('alert');
  await act(async () => {resolveOld(ok(catalog));});
  expect(screen.getByText('Failed to load protocol catalog')).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([url])=>url.includes('/programs?'))).toHaveLength(0);
});
