// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import NewsletterPage from './NewsletterPage';

vi.mock('./EmailAutomationsPanelV2', () => ({ default: () => <div>Automations</div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('clears summary loading when a queued poll supersedes dashboard re-entry', async () => {
  localStorage.setItem('waves_admin_token', 'fixture');
  let reads = 0;
  let finishForeground;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url).split('?')[0];
    let data = {};
    if (path.endsWith('/sends')) {
      reads += 1;
      if (reads === 2) {
        // Focus arrives after the foreground request starts, before its loading render.
        window.dispatchEvent(new Event("focus"));
        return new Promise((resolve) => { finishForeground = resolve; });
      }
      data = { sends: [], counts: { sent: reads } };
    }
    if (path.endsWith('/subscribers')) data = { subscribers: [], counts: { active: 3 } };
    return { ok: true, json: async () => data };
  }));
  render(<MemoryRouter><NewsletterPage /></MemoryRouter>);
  await screen.findByRole('button', { name: 'Schedule (1)' });
  fireEvent.click(screen.getByRole('button', { name: 'Automation', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Dashboard', exact: true }));
  await waitFor(() => expect(finishForeground).toBeTypeOf('function'));
  await screen.findByRole('button', { name: 'Schedule (3)' });
  await act(async () => { finishForeground({ ok: true, json: async () => ({ sends: [], counts: { sent: 2 } }) }); });
  fireEvent(window, new Event("focus"));
  await screen.findByRole('button', { name: 'Schedule (4)' });
});
