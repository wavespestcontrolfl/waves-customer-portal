// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useIsMobile', () => ({ default: () => false }));
vi.mock('./useBestTimes', () => ({
  useBestTimes: () => ({ pickedByTech: [], availability: null, checking: false }),
}));

import RainOutSheet from './RainOutSheet';

// The dispatch sheet reads its commit result through the shared helper; these
// pin the visible behavior: attention results keep the sheet open and lock Move.
const json = (body) => ({ ok: true, json: async () => body });
let commitBody;
let fetchMock;

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  fetchMock = vi.fn(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/rain-out-options')) {
      return json({
        sameDay: [], days: [{ kind: 'day', date: '2099-01-02', window: { start: '09:00', end: '10:00' }, display: 'Fri, Jan 2, 9:00 AM-10:00 AM' }],
        service: { window: { start: '10:00', end: '11:00' } }, remainingRouteCount: 0,
      });
    }
    if (path.endsWith('/rain-out') && init?.method === 'POST') return json(commitBody);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

async function move(onDone) {
  render(<RainOutSheet service={{ id: 'visit-1', customerName: 'Fixture Customer' }} onClose={vi.fn()} onDone={onDone} />);
  const button = await screen.findByRole('button', { name: 'Move appointment' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('RainOutSheet commit result', () => {
  it('keeps a not-texted result on screen and locks a second Move', async () => {
    commitBody = { movedCount: 1, failedCount: 0, results: [{ id: 'visit-1', ok: true, smsSent: false }] };
    const onDone = vi.fn();
    await move(onDone);
    expect(await screen.findByText(/customer NOT texted\.\s+Some customers were NOT texted/)).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ movedCount: 1, notTexted: true, failedCount: 0, overlapCount: 0 }));
    expect(screen.getByRole('button', { name: 'Moved' })).toBeDisabled();
  });

  it('hands a clean move to the parent with no warning shown', async () => {
    commitBody = { movedCount: 1, failedCount: 0, results: [{ id: 'visit-1', ok: true, smsSent: true }] };
    const onDone = vi.fn();
    await move(onDone);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0]).toMatchObject({ summary: expect.stringMatching(/^Moved 1 stop to Fri, Jan 2.*customer texted$/), notTexted: false });
    expect(screen.queryByText(/NOT texted/)).not.toBeInTheDocument();
  });
});
