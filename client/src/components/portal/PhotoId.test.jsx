// @vitest-environment jsdom
// Photo ID (GATE_CUSTOMER_PHOTO_ID) — the FAB/More-sheet entry points and the
// gate hook they share must never disagree about whether the feature is
// live; the sheet's picker -> photos -> analyzing -> result flow must send
// the contract's exact payload shape and render every result type + next
// step kind the server can hand back.
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This machine regularly runs many concurrent Claude Code lanes (see
// ~/.claude/CLAUDE.md), so a resolved-mock microtask chain (file read ->
// resize -> POST) can genuinely take longer than testing-library's 1000ms
// findBy* default under load. Widen it rather than chase a flaky timeout.
configure({ asyncUtilTimeout: 5000 });

vi.mock('../../utils/api', () => ({
  default: {
    getPhotoIds: vi.fn(),
    createPhotoId: vi.fn(),
    getPhotoId: vi.fn(),
  },
}));

import api from '../../utils/api';
import { PhotoIdFab, PhotoIdSheet, usePhotoIdGate } from './PhotoId';

// Mirrors how PortalPage wires the two entry points to one shared gate read
// (usePhotoIdGate) — the FAB and the sheet must always read the same status
// so a 404 hides both together.
function Harness({ onOpenRequest = () => {} }) {
  const gate = usePhotoIdGate();
  const [open, setOpen] = useState(false);
  const available = gate.status === 'available';
  return (
    <>
      {available && !open && <PhotoIdFab onOpen={() => setOpen(true)} hasBottomNav />}
      <PhotoIdSheet
        open={open && available}
        onClose={() => setOpen(false)}
        items={gate.items}
        onRefreshHistory={gate.refresh}
        onGateUnavailable={gate.refresh}
        onOpenRequest={onOpenRequest}
      />
    </>
  );
}

// jsdom has no canvas — keep the fixture image at or under the 1600px
// resize threshold so resizeImage's short-circuit branch resolves the
// original data URL without ever touching a canvas (see imageCompression's
// own test-file note on the same limitation).
class FixtureFileReader {
  readAsDataURL() {
    this.onload({ target: { result: 'data:image/jpeg;base64,cGhvdG8=' } });
  }
}
class FixtureImage {
  set src(_value) {
    this.width = 800;
    this.height = 600;
    this.onload();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('FileReader', FixtureFileReader);
  vi.stubGlobal('Image', FixtureImage);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const photoFile = () => new File(['photo'], 'bug.jpg', { type: 'image/jpeg' });

describe('gate: FAB + More-sheet entry point', () => {
  it('hides the floating button entirely when GET /api/photo-id 404s (feature dark)', async () => {
    const err = new Error('Not found');
    err.status = 404;
    api.getPhotoIds.mockRejectedValueOnce(err);
    render(<Harness />);
    await waitFor(() => expect(api.getPhotoIds).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /Photo ID/i })).not.toBeInTheDocument();
  });

  it('shows the button and opens the sheet listing all three types plus history', async () => {
    api.getPhotoIds.mockResolvedValueOnce({
      items: [{ id: 'h1', type: 'pest', created_at: '2026-09-01T12:00:00Z', headline: 'Ghost ant', next_step_kind: 'reservice' }],
    });
    render(<Harness />);
    const fab = await screen.findByRole('button', { name: /Photo ID/i });
    fireEvent.click(fab);

    expect(screen.getByRole('dialog', { name: 'Photo ID' })).toBeInTheDocument();
    expect(screen.getByText('Bug or pest')).toBeInTheDocument();
    expect(screen.getByText('Lawn spot')).toBeInTheDocument();
    expect(screen.getByText('Tree or shrub')).toBeInTheDocument();
    expect(screen.getByText('Ghost ant')).toBeInTheDocument();
  });

  it('a non-404 GET failure on the first read fails closed, same as a 404 (feature flags never fail open)', async () => {
    api.getPhotoIds.mockRejectedValueOnce(new Error('Unable to reach the server. Check your connection and try again.'));
    render(<Harness />);
    await waitFor(() => expect(api.getPhotoIds).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /Photo ID/i })).not.toBeInTheDocument();
  });

  it('a later background-refresh blip does not retract an already-proven-available feature', async () => {
    function GateHarness() {
      const gate = usePhotoIdGate();
      return (
        <div>
          <div>status: {gate.status}</div>
          <button onClick={() => gate.refresh()}>refresh</button>
        </div>
      );
    }
    api.getPhotoIds.mockResolvedValueOnce({ items: [] });
    render(<GateHarness />);
    await screen.findByText('status: available');

    api.getPhotoIds.mockRejectedValueOnce(new Error('network blip'));
    fireEvent.click(screen.getByText('refresh'));
    await waitFor(() => expect(api.getPhotoIds).toHaveBeenCalledTimes(2));
    expect(screen.getByText('status: available')).toBeInTheDocument();
  });
});

describe('identify flow', () => {
  it('sends the exact POST payload shape and hands the same photos to the request CTA', async () => {
    // Two reads: the mount-time gate check, then the background history
    // refresh a successful identify triggers.
    api.getPhotoIds.mockResolvedValue({ items: [] });
    const onOpenRequest = vi.fn();
    render(<Harness onOpenRequest={onOpenRequest} />);

    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(screen.getByText('Bug or pest'));

    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.change(fileInput, { target: { files: [photoFile()] } });
    await screen.findByRole('img');

    fireEvent.change(screen.getByPlaceholderText('Anything else worth mentioning?'), {
      target: { value: 'Found it by the AC unit' },
    });

    api.createPhotoId.mockResolvedValueOnce({
      id: 'r1',
      type: 'pest',
      created_at: '2026-09-24T00:00:00Z',
      result: {
        label: 'Ghost ant',
        confidence: 'high',
        safety: { stinging: false, venomous: false, disease_vector: false, structural_threat: false },
        about: 'Common in Florida kitchens.',
        urgency: 'low',
      },
      next_step: {
        kind: 'request',
        title: 'File a request',
        body: "We'll take a look at your next visit.",
        request_prefill: { category: 'pest_issue', location: 'inside_home', note: 'Found it by the AC unit' },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Identify' }));

    expect(screen.getByText('Comparing against our Florida library…')).toBeInTheDocument();

    await waitFor(() => expect(api.createPhotoId).toHaveBeenCalledTimes(1));
    const [type, payload] = api.createPhotoId.mock.calls[0];
    expect(type).toBe('pest');
    expect(payload.note).toBe('Found it by the AC unit');
    expect(payload.location).toBeUndefined();
    expect(Array.isArray(payload.photos)).toBe(true);
    expect(payload.photos).toHaveLength(1);
    expect(payload.photos[0]).toMatch(/^data:image\/jpeg;base64,/);

    expect(await screen.findByText('Ghost ant')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Common in Florida kitchens.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Request service' }));
    expect(onOpenRequest).toHaveBeenCalledTimes(1);
    const prefill = onOpenRequest.mock.calls[0][0];
    expect(prefill.category).toBe('pest_issue');
    expect(prefill.location).toBe('inside_home');
    expect(prefill.note).toBe('Found it by the AC unit');
    expect(prefill.photos).toHaveLength(1);
    expect(prefill.photos[0].data).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('shows the server 429 message and returns to the photos step so the customer can retry', async () => {
    api.getPhotoIds.mockResolvedValueOnce({ items: [] });
    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(screen.getByText('Lawn spot'));
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [photoFile()] } });
    await screen.findByRole('img');

    const err = new Error('Please wait a bit before trying another Photo ID.');
    err.status = 429;
    api.createPhotoId.mockRejectedValueOnce(err);
    fireEvent.click(screen.getByRole('button', { name: 'Identify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Please wait a bit before trying another Photo ID.');
    expect(screen.getByRole('button', { name: 'Identify' })).toBeInTheDocument();
  });

  it('a plain network failure (no status) shows the generic offline message', async () => {
    api.getPhotoIds.mockResolvedValueOnce({ items: [] });
    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(screen.getByText('Tree or shrub'));
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [photoFile()] } });
    await screen.findByRole('img');

    api.createPhotoId.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByRole('button', { name: 'Identify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach Waves. Try again.");
  });
});

describe('result rendering per type + next-step CTAs', () => {
  const historyItems = [
    { id: 'p1', type: 'pest', created_at: '2026-09-01T00:00:00Z', headline: 'Ghost ant', next_step_kind: 'reservice' },
    { id: 'l1', type: 'lawn', created_at: '2026-09-02T00:00:00Z', headline: 'Front lawn', next_step_kind: 'request' },
    { id: 't1', type: 'tree_shrub', created_at: '2026-09-03T00:00:00Z', headline: 'Hibiscus', next_step_kind: 'unclear' },
    { id: 'p2', type: 'pest', created_at: '2026-09-04T00:00:00Z', headline: 'Spider', next_step_kind: 'inspection' },
    { id: 'l2', type: 'lawn', created_at: '2026-09-05T00:00:00Z', headline: 'Back lawn', next_step_kind: 'none' },
  ];

  const detailFor = (type, id) => {
    if (type === 'pest') {
      return {
        id, type, created_at: '2026-09-01T00:00:00Z',
        result: {
          label: id === 'p1' ? 'Ghost ant' : 'Wolf spider',
          confidence: 'moderate',
          safety: { stinging: false, venomous: id === 'p2', disease_vector: false, structural_threat: false },
          about: 'About this pest.',
          urgency: 'moderate',
        },
        next_step: id === 'p1'
          ? { kind: 'reservice', title: 'Covered', body: 'This is on us.', url: '/reservice/tok-123' }
          : { kind: 'inspection', title: 'Worth a look', body: "We'd like to inspect this.", request_prefill: { category: 'pest_issue', location: '', note: '' } },
      };
    }
    if (type === 'lawn') {
      return {
        id, type, created_at: '2026-09-02T00:00:00Z',
        result: {
          grass_type: 'St. Augustine',
          scores: { turf_density: 72, weed_coverage: 14, color_health: 7 },
          signals: [{ key: 'watering', label: 'Watering', level: 'adequate' }],
          observations: 'Lawn observations here.',
        },
        next_step: id === 'l1'
          ? { kind: 'request', title: 'Send this in', body: 'Our team can take a look.', request_prefill: { category: 'lawn_concern', location: 'front_yard', note: 'From Photo ID' } }
          : { kind: 'none', title: 'Looking good', body: 'Nothing to flag right now.' },
      };
    }
    return {
      id, type, created_at: '2026-09-03T00:00:00Z',
      result: {
        plant_groups: [{ label: 'Hibiscus', status: 'stressed' }],
        scores: { foliage_fullness: 60, leaf_color_vigor: 55, overall: 6 },
        signals: [{ key: 'pests', label: 'Pest pressure', level: 'low' }],
        summary: 'Tree/shrub summary here.',
      },
      next_step: { kind: 'unclear', title: 'Not sure yet', body: "Let's have the team look." },
    };
  };

  beforeEach(() => {
    api.getPhotoIds.mockResolvedValueOnce({ items: historyItems });
    api.getPhotoId.mockImplementation(async (type, id) => detailFor(type, id));
  });

  it('renders the pest result (label, confidence, safety chip, about) and the reservice CTA', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(await screen.findByText('Ghost ant'));

    // "Ghost ant" is also the history row's own headline — wait for text
    // that only exists once the result view has actually mounted, so this
    // doesn't pass on the stale picker row still being in the document.
    expect(await screen.findByText('About this pest.')).toBeInTheDocument();
    expect(screen.getByText('Ghost ant')).toBeInTheDocument();
    expect(screen.getByText('Likely')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: 'Book free re-service' });
    expect(cta).toHaveAttribute('href', '/reservice/tok-123');
  });

  it('renders the lawn result (grass type, metrics, signal) and the request CTA', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(await screen.findByText('Front lawn'));

    expect(await screen.findByText('St. Augustine')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText('7/10')).toBeInTheDocument();
    expect(screen.getByText('Adequate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request service' })).toBeInTheDocument();
  });

  it('renders the tree/shrub result (plant group, scores, summary) and the "unclear" CTA label', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(await screen.findByText('Hibiscus'));

    expect(await screen.findByText('Tree/shrub summary here.')).toBeInTheDocument();
    expect(screen.getByText('6/10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to the team' })).toBeInTheDocument();
  });

  it('an inspection next step also opens the request path with its own copy', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(await screen.findByText('Spider'));

    expect(await screen.findByText("We'd like to inspect this.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request service' })).toBeInTheDocument();
    expect(screen.getByText('Venomous')).toBeInTheDocument();
  });

  it('a "none" next step shows the reassurance with no service CTA', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(await screen.findByText('Back lawn'));

    expect(await screen.findByText('Nothing to flag right now.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request service' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Book free re-service' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });
});

describe('stale-flow safety (Codex r1 P1s)', () => {
  it('closing the sheet mid-identify discards a late response instead of resurrecting it on reopen', async () => {
    api.getPhotoIds.mockResolvedValue({ items: [] });
    let resolvePost;
    api.createPhotoId.mockImplementationOnce(() => new Promise((resolve) => { resolvePost = resolve; }));
    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(screen.getByText('Bug or pest'));
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [photoFile()] } });
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Identify' }));
    await screen.findByText('Comparing against our Florida library…');

    // Close while the request is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Close Photo ID' }));
    expect(screen.queryByRole('dialog', { name: 'Photo ID' })).not.toBeInTheDocument();

    // The abandoned request finally resolves — it must not resurrect anything.
    resolvePost({
      id: 'late1', type: 'pest', created_at: '2026-09-24T00:00:00Z',
      result: { label: 'Stale roach', confidence: 'high', safety: {}, about: 'x', urgency: 'low' },
      next_step: { kind: 'none', title: 'Fine', body: 'All good.' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Stale roach')).not.toBeInTheDocument();

    // Reopening starts clean at the picker, not on the late result.
    fireEvent.click(screen.getByRole('button', { name: /Photo ID/i }));
    expect(await screen.findByText('What are you looking at?')).toBeInTheDocument();
    expect(screen.queryByText('Stale roach')).not.toBeInTheDocument();
  });

  it('going back from a live result to a different history item never attaches the earlier live photo', async () => {
    const items = [{ id: 'l1', type: 'lawn', created_at: '2026-09-02T00:00:00Z', headline: 'Front lawn', next_step_kind: 'request' }];
    api.getPhotoIds.mockResolvedValue({ items });
    api.getPhotoId.mockResolvedValue({
      id: 'l1', type: 'lawn', created_at: '2026-09-02T00:00:00Z',
      result: { grass_type: 'St. Augustine', scores: { turf_density: 70, weed_coverage: 10, color_health: 7 }, signals: [], observations: 'x' },
      next_step: { kind: 'request', title: 'Send this in', body: 'y', request_prefill: { category: 'lawn_concern', location: 'front_yard', note: 'z' } },
    });
    const onOpenRequest = vi.fn();
    render(<Harness onOpenRequest={onOpenRequest} />);

    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(screen.getByText('Bug or pest'));
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [photoFile()] } });
    await screen.findByRole('img');

    api.createPhotoId.mockResolvedValueOnce({
      id: 'live1', type: 'pest', created_at: '2026-09-24T00:00:00Z',
      result: { label: 'Roach', confidence: 'high', safety: {}, about: 'x', urgency: 'low' },
      next_step: { kind: 'none', title: 'Fine', body: 'All good.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Identify' }));
    await screen.findByText('Roach');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByText('Front lawn'));
    await screen.findByText('Send this in');
    fireEvent.click(screen.getByRole('button', { name: 'Request service' }));

    expect(onOpenRequest).toHaveBeenCalledTimes(1);
    expect(onOpenRequest.mock.calls[0][0].photos).toHaveLength(0);
  });

  it('switching type mid photo-read resets the busy flag instead of leaving Add stuck disabled', async () => {
    api.getPhotoIds.mockResolvedValue({ items: [] });
    // A FileReader whose read never completes on its own — held open so the
    // test controls exactly when (if ever) it resolves.
    class DeferredFileReader {
      readAsDataURL() { DeferredFileReader.pending.push(this); }
    }
    DeferredFileReader.pending = [];
    vi.stubGlobal('FileReader', DeferredFileReader);

    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Photo ID/i }));
    fireEvent.click(screen.getByText('Bug or pest'));
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [photoFile()] } });
    expect(await screen.findByText('Adding…')).toBeInTheDocument();

    // Abandon this read: go back and pick a different type while it's still
    // pending — Add must not stay stuck on "Adding…" (Codex r2 P1).
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByText('Lawn spot'));
    expect(screen.getByText('Add')).toBeInTheDocument();
    expect(screen.queryByText('Adding…')).not.toBeInTheDocument();

    // The abandoned read finally resolves — must not resurrect a photo here.
    DeferredFileReader.pending[0].onload({ target: { result: 'data:image/jpeg;base64,cGhvdG8=' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('session/account switching (Codex r5 P1)', () => {
  // PortalPage passes its `sessionEpoch` (bumped on login and on a
  // saved-property switch, since a property can belong to a different
  // customerId) as the gate's sessionKey — PortalPage itself never remounts
  // on those changes.
  function KeyedHarness({ sessionKey }) {
    const gate = usePhotoIdGate(sessionKey);
    return <div>status:{gate.status} items:{gate.items.map((i) => i.headline).join(',') || 'none'}</div>;
  }

  it('re-fetches on a sessionKey change and discards a stale response from the previous account', async () => {
    let resolveFirst;
    api.getPhotoIds.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const { rerender } = render(<KeyedHarness sessionKey={1} />);
    await screen.findByText('status:loading items:none');

    // Switch account/session BEFORE the first (account A) request resolves.
    api.getPhotoIds.mockResolvedValueOnce({ items: [{ id: 'b1', type: 'pest', created_at: '2026-09-01T00:00:00Z', headline: 'Account B item' }] });
    rerender(<KeyedHarness sessionKey={2} />);
    await screen.findByText('status:available items:Account B item');

    // The abandoned account-A response finally arrives — must not overwrite B's data.
    resolveFirst({ items: [{ id: 'a1', type: 'pest', created_at: '2026-09-01T00:00:00Z', headline: 'Account A item' }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText('status:available items:Account B item')).toBeInTheDocument();
  });
});
