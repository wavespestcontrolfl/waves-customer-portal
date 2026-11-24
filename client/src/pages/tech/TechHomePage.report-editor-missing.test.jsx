// @vitest-environment jsdom
// Today's report editor (ProjectDetail, for a visit whose report already
// exists) opens in a full-screen overlay, and its Close is the editor's own.
// When a deploy removed its code and the staff tab did not reload
// (lib/staleChunkReload.js), its Reload prompt shows in a "Report" dialog
// whose Close or Escape closes the editor. In the editor's place, the overlay
// would have no Close, and a keyboard user could leave it only by a reload.
import React, { Suspense } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ProjectDetail } from './TechHomePage';

// Stands for Jobs code the live build no longer serves. Vitest wraps an
// error that a mock factory throws, so the module loads once first and then
// becomes a thenable that rejects: a later import() adopts that rejection.
const projects = vi.hoisted(() => ({ module: {} }));
vi.mock('../admin/ProjectsPage', () => projects.module);
beforeAll(async () => {
  await import('../admin/ProjectsPage');
  projects.module.then = (_resolve, reject) => reject(new TypeError('Failed to fetch dynamically imported module: /assets/ProjectsPage-old.js'));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a report editor whose code is missing shows its Reload prompt in a Report dialog, whose Close or Escape closes the editor with no reload', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, pathname: '/admin/today', reload });
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/admin/today']}>
      <Suspense fallback={null}>
        <ProjectDetail projectId="one" onClose={onClose} />
      </Suspense>
    </MemoryRouter>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Report' });
  expect(within(dialog).getByText(/^This part of the page did not load/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  // The shared Dialog moves focus into itself and starts to listen for
  // Escape in one effect, which can run after the dialog shows.
  await waitFor(() => expect(dialog).toContainElement(document.activeElement));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
});
