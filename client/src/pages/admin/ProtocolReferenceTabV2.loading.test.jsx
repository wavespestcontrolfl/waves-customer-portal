// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProtocolReferenceTabV2 from './ProtocolReferenceTabV2';
import fieldGuideReference from '../../../../server/config/tree-shrub-field-guide.json';
import protocols from '../../../../server/config/protocols.json';

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

it('keeps program safety rules and detailed notes available with the month field guide', async () => {
  const program = protocols.tree_shrub;
  fetch.mockImplementation(async url => {
    if (url === '/api/admin/protocols/programs') return ok({ lawn: { tracks: [] }, programs: [{ key: 'tree_shrub', name: 'Tree & Shrub', visits: 12 }] });
    if (url.includes('/programs?')) return ok({ program: { ...program, fieldGuideEnabled: true,
      visits: program.visits.map(visit => ({ ...visit, fieldGuide: { ...visit.fieldGuide, ...fieldGuideReference, month: visit.month } })) } });
    return ok({ calibrations: [] });
  });
  render(<ProtocolReferenceTabV2 />);
  fireEvent.click(await screen.findByRole('option', { name: 'Tree & Shrub, 12 templates' }));
  await screen.findByTestId('tree-shrub-field-guide');
  expect(screen.getByRole('region', { name: 'Program safety rules' })).toBeInTheDocument();
  for (const rule of program.safety_rules) expect(screen.getByText(rule)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Program notes'));
  expect(screen.getByText(program.notes[0])).toBeInTheDocument();
});

it('reports initial catalog failure, repeats a failed retry, then loads the catalog and default track',async () => {
  render(<ProtocolReferenceTabV2 />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Select a program above')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await screen.findByRole('alert');
  catalogFails=false;
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await waitFor(() => expect(screen.getByRole('option', { name: 'Lawn, 0 visits' })).toHaveAttribute('aria-selected', 'true'));
  expect(screen.queryByText('Failed to load protocol catalog')).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith('/api/admin/protocols/programs?track=st_augustine',expect.anything());
});

it('keeps a default-track failure distinct from a catalog failure and allows manual recovery',async () => {
  catalogFails=false;trackFails=true;
  render(<ProtocolReferenceTabV2 />);
  await screen.findByText('Select a program above');
  expect(screen.queryByText('Failed to load protocol catalog')).not.toBeInTheDocument();
  trackFails=false;
  fireEvent.click(await screen.findByRole('option', { name: 'Lawn, 0 visits' }));
  await screen.findByText('Tier Legend');
});

it('preserves individual protocol rollback and retry after a successful catalog',async () => {
  catalogFails=false;
  render(<ProtocolReferenceTabV2 />);
  await screen.findByText('Tier Legend');
  trackFails=true;
  fireEvent.click(screen.getByRole('option', { name: 'Synthetic Pest, 0 templates' }));
  await screen.findByText(/Couldn't load that protocol/);
  expect(screen.getByRole('option', { name: 'Lawn, 0 visits' })).toHaveAttribute('aria-selected', 'true');
  trackFails=false;
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await waitFor(() => expect(screen.getByRole('option', { name: 'Synthetic Pest, 0 templates' })).toHaveAttribute('aria-selected', 'true'));
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

it('lists programs without the word Protocol and lets a Treatment tile pick the visit shown', async () => {
  catalogFails = false;
  const visit = (n, month, primary) => ({ visit: n, month, primary, secondary: '', notes: '', tiers: [] });
  fetch.mockImplementation(async url => {
    if (url === '/api/admin/protocols/programs') return ok({ lawn: { tracks: [] }, programs: [{ key: 'bed_bug', name: 'Bed Bug Control Protocol', visits: 2 }] });
    if (url.includes('program=bed_bug')) return ok({ program: { name: 'Bed Bug Control Protocol', visits: [visit(1, 'Jan', 'Aprehend alpha'), visit(2, 'Feb', 'Temprid beta')] } });
    return ok({ calibrations: [] });
  });
  render(<ProtocolReferenceTabV2 />);
  fireEvent.click(await screen.findByRole('option', { name: 'Bed Bug, 2 templates' }));
  await screen.findByText(/VISIT \d/);
  expect(screen.queryByText(/Protocol/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('option', { name: 'Visit 2, Feb' }));
  expect(screen.getByText(/VISIT 2 — FEB/)).toBeInTheDocument();
  expect(screen.getByText(/Temprid beta/)).toBeInTheDocument();
  expect(screen.queryByText(/Aprehend alpha/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('option', { name: 'Visit 1, Jan' }));
  expect(screen.getByText(/Aprehend alpha/)).toBeInTheDocument();
});
