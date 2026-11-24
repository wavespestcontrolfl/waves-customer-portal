// @vitest-environment jsdom
// Today's job card is the Schedule's ProtocolPanel, which draws its own
// dialog. When a deploy removed its code and the staff tab did not reload
// (lib/staleChunkReload.js), its Reload prompt shows in a "Job card" dialog
// whose Close clears the visit. In the panel's place, the prompt would sit at
// the end of the page, out of view and with no way to close it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { JobCardOverlay } from './TechHomePage';

// Stands for Schedule code the live build no longer serves. Vitest wraps an
// error that a mock factory throws, so the module loads once first and then
// becomes a thenable that rejects: a later import() adopts that rejection.
const schedule = vi.hoisted(() => ({ module: {} }));
vi.mock('../admin/SchedulePage', () => schedule.module);
beforeAll(async () => {
  await import('../admin/SchedulePage');
  schedule.module.then = (_resolve, reject) => reject(new TypeError('Failed to fetch dynamically imported module: /assets/SchedulePage-old.js'));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a job card whose code is missing shows its Reload prompt in a Job card dialog, and its Close clears the visit with no reload', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, pathname: '/admin/today', reload });
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/admin/today']}>
      <JobCardOverlay service={{ id: 'one' }} onClose={onClose} />
    </MemoryRouter>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Job card' });
  expect(within(dialog).getByText(/^This part of the page did not load/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});
