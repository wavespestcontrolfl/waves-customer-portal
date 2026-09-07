// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AutonomousContentReviewPage from './AutonomousContentReviewPage';

let revision;
function item(id = 'blog-1') {
  return {
    id, action_type: id === 'other-1' ? 'refresh_existing_blog' : 'new_supporting_blog', status: 'pending_review',
    target_keyword: `Seasonal ants ${id}`, skip_reason: 'astro_pr_pending_merge',
    run: { id: `run-${revision}`, gate_summary: { quality_ok: true, uniqueness_ok: true, topic_ok: false,
      topic_findings: [{ code: 'TOPIC_ENTITY_OWNED', message: 'Another article owns this topic.' }] } },
    draft: { title: 'Seasonal ants', body_preview: `Draft revision ${revision}`, body: `Full draft revision ${revision}` },
    review_actions: { can_approve_named_competitor: true, can_requeue: true, can_dismiss: true },
  };
}
beforeEach(() => {
  revision = 1;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = { items: [], counts: {}, totals: {} };
    if (url.includes('/autonomous/review?')) {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
      data = { items: offset ? [item('blog-51')] : Array.from({ length: 50 }, (_, i) => item(`blog-${i + 1}`)),
        counts: { pending_review: 51 }, total: 51 };
      if (url.includes('actionType=other')) data = { items: [item('other-1')], counts: { pending_review: 1 }, total: 1 };
    } else if (url.includes('/autonomous/review/')) data = { item: item(url.split('/').at(-1)) };
    return { ok: true, json: async () => data };
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('autonomous blog monitor', () => {
  it('shows failed topic checks and offers no human publishing decisions', async () => {
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    expect(screen.getAllByText('Needs fix')).toHaveLength(50);
    expect(screen.getByText(/Another article owns this topic/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve & publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Requeue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish PR' })).toBeNull();
  });
  it('preserves non-blog recovery in Other content while keeping blog controls absent', async () => {
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    fireEvent.click(screen.getByRole('button', { name: 'Other content' }));
    await screen.findByRole('button', { name: 'Requeue' });
    fireEvent.click(screen.getByRole('button', { name: 'Requeue' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, opts]) => url.includes('/other-1/decision') && opts.method === 'POST' && JSON.parse(opts.body).decision === 'requeue')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Content' }));
    await screen.findByText('1–50 of 51');
    expect(screen.queryByRole('button', { name: 'Requeue' })).toBeNull();
  });
  it('refreshes the selected detail even when its opportunity id is unchanged', async () => {
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    revision = 2;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Full draft revision 2');
    expect(screen.queryByText('Full draft revision 1')).toBeNull();
  });
  it('reaches older activity and resets pagination when filtering', async () => {
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('1–50 of 51');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('51–51 of 51');
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity status' }), { target: { value: 'skipped' } });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes('status=skipped&limit=50&offset=0'))).toBe(true));
  });
});


describe('review regressions', () => {
  it('clears content notes on selection changes but preserves them on refresh', async () => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, opts) => url.includes('actionType=other')
      ? { ok: true, json: async () => ({ items: [item('other-1'), { ...item('other-2'), action_type: 'refresh_existing_blog' }], total: 2 }) }
      : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    fireEvent.click(screen.getByRole('button', { name: 'Other content' }));
    const note = await screen.findByPlaceholderText('Reviewer note (optional)');
    fireEvent.change(note, { target: { value: 'First record note' } });
    revision = 2;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Full draft revision 2');
    expect(screen.getByPlaceholderText('Reviewer note (optional)').value).toBe('First record note');
    fireEvent.click(screen.getByText('Seasonal ants other-2'));
    await waitFor(() => expect(screen.queryByDisplayValue('First record note')).toBeNull());
  });

  it('clears link notes when switching tasks', async () => {
    const original = fetch.getMockImplementation();
    const links = ['link-1', 'link-2'].map(id => ({ id, anchor_text: id, status: 'failed', review_actions: { can_requeue: true } }));
    fetch.mockImplementation(async (url, opts) => url.includes('/internal-links')
      ? { ok: true, json: async () => url.includes('?') ? { items: links } : { item: links.find(it => url.endsWith(it.id)) } }
      : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    const note = await screen.findByPlaceholderText('Reviewer note (optional)');
    fireEvent.change(note, { target: { value: 'Link one note' } });
    fireEvent.click(screen.getByText('link-2'));
    await waitFor(() => expect(screen.getByPlaceholderText('Reviewer note (optional)').value).toBe(''));
  });

  it.each([
    [{ quality_ok: false, quality_score: null, uniqueness_ok: true }, {}, 'In review'],
    [{ quality_ok: true, uniqueness_ok: true, soft_failures: ['Check wording'] }, { ok: true }, 'Soft flags'],
    [{ quality_ok: false, quality_score: 20 }, { ok: false }, 'Needs fix'],
  ])('distinguishes incomplete, soft, and failed gate results', async (summary, quality, label) => {
    const record = item();
    record.run.gate_summary = summary;
    record.run.quality_gate_result = quality;
    fetch.mockImplementation(async url => ({ ok: true, json: async () => url.includes('/review?')
      ? { items: [record], total: 1 } : url.includes('/review/') ? { item: record } : { items: [] } }));
    const { container } = render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    expect(screen.getByText(label)).toBeTruthy();
    expect(container.querySelectorAll('.lucide-triangle-alert, .lucide-alert-triangle').length).toBe(label === 'Needs fix' ? 1 : 0);
  });

  it('lets a slow list response finish before polling again', async () => {
    vi.useFakeTimers();
    const original = fetch.getMockImplementation();
    let finish;
    fetch.mockImplementation((url, opts) => url.includes('/review?')
      ? new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ items: [item()], total: 1 }) }); })
      : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    await act(async () => { await vi.advanceTimersByTimeAsync(61000); });
    expect(fetch.mock.calls.filter(([url]) => url.includes('/review?'))).toHaveLength(1);
    await act(async () => { finish(); });
    expect(screen.getByText('Full draft revision 1')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetch.mock.calls.filter(([url]) => url.includes('/review?'))).toHaveLength(2);
  });
});

describe('activity observability', () => {
  it.each([['Links', '/internal-links'], ['Impact', '/autonomous/impact']])('preserves %s errors during background blog polling', async (tab, endpoint) => {
    vi.useFakeTimers();
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => url.includes(endpoint)
      ? Promise.reject(new Error(`${tab} unavailable`)) : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: tab, exact: true }));
    expect(screen.getByText(`${tab} unavailable`)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(fetch.mock.calls.filter(([url]) => url.includes('/review?')).length).toBeGreaterThan(1);
    expect(screen.getByText(`${tab} unavailable`)).toBeTruthy();
  });

  it('shows lifecycle status on every activity card independently of gate state', async () => {
    const statuses = ['pending', 'claimed', 'pending_review', 'done', 'skipped'];
    const records = statuses.map(status => ({ ...item(status), status, run: null }));
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => url.includes('/review?')
      ? Promise.resolve({ ok: true, json: async () => ({ items: records, total: 5 }) }) : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByRole('button', { name: /Seasonal ants pending Queued/ });
    for (const [index, label] of ['Queued', 'Running', 'Processing / held', 'Completed', 'Skipped'].entries()) {
      expect(screen.getByRole('button', { name: new RegExp(`Seasonal ants ${statuses[index]} `) }).textContent).toContain(label);
    }
  });
});

describe('failed activity queries', () => {
  it.each(['page', 'status', 'lane'])('clears old cards and detail after a failed %s request', async (change) => {
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => url.includes('/review?')
      ? Promise.reject(new Error('Activity unavailable')) : original(url, opts));
    if (change === 'page') fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    if (change === 'status') fireEvent.change(screen.getByRole('combobox', { name: 'Activity status' }), { target: { value: 'skipped' } });
    if (change === 'lane') fireEvent.click(screen.getByRole('button', { name: 'Other content' }));
    await screen.findByText('Activity unavailable');
    expect(screen.queryByText('Seasonal ants blog-1')).toBeNull();
    expect(screen.queryByText('Full draft revision 1')).toBeNull();
    expect(screen.getByText('0–0 of 0')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Requeue' })).toBeNull();
  });
});

describe('background refresh boundaries', () => {
  it('keeps a failed decision visible after successful list polling', async () => {
    vi.useFakeTimers();
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => opts?.method === 'POST'
      ? Promise.reject(new Error('Decision failed')) : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Other content' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Requeue' })); });
    expect(screen.getByText('Decision failed')).toBeTruthy();
    revision = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText('Full draft revision 2')).toBeTruthy();
    expect(screen.getByText('Decision failed')).toBeTruthy();
  });

  it('can filter expired activity', async () => {
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('1–50 of 51');
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity status' }), { target: { value: 'expired' } });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes('status=expired&limit=50&offset=0'))).toBe(true));
  });

  it('closes vanished selection on polling without opening another run', async () => {
    vi.useFakeTimers();
    const original = fetch.getMockImplementation();
    let vanished = false;
    fetch.mockImplementation((url, opts) => vanished && url.includes('/review?')
      ? Promise.resolve({ ok: true, json: async () => ({ items: [item('blog-2')], total: 1 }) }) : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Seasonal ants blog-1 / }));
    vanished = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.queryByText('Full draft revision 1')).toBeNull();
    expect(screen.getByText('Select a run to see its status.')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText('Select a run to see its status.')).toBeTruthy();
  });
});

describe('slow and failed detail refresh', () => {
  it('lets a slow selected detail finish while list polling continues', async () => {
    vi.useFakeTimers();
    const original = fetch.getMockImplementation();
    let finish;
    fetch.mockImplementation((url, opts) => url.endsWith('/review/blog-1')
      ? new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ item: item() }) }); }) : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(61000); });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/review/blog-1'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.includes('/review?')).length).toBeGreaterThan(1);
    await act(async () => { finish(); });
    expect(screen.getByText('Full draft revision 1')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/review/blog-1'))).toHaveLength(2);
  });

  it('preserves selected content and unsaved notes after a background list failure', async () => {
    vi.useFakeTimers();
    render(<AutonomousContentReviewPage embedded />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Other content' })); });
    fireEvent.change(screen.getByPlaceholderText('Reviewer note (optional)'), { target: { value: 'Keep this note' } });
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => url.includes('/review?')
      ? Promise.reject(new Error('Poll failed')) : original(url, opts));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText('Poll failed')).toBeTruthy();
    expect(screen.getByText('Full draft revision 1')).toBeTruthy();
    expect(screen.getByPlaceholderText('Reviewer note (optional)').value).toBe('Keep this note');
  });

  it('shows a failed query alongside an earlier decision failure', async () => {
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    fireEvent.click(screen.getByRole('button', { name: 'Other content' }));
    await screen.findByRole('button', { name: 'Requeue' });
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => opts?.method === 'POST'
      ? Promise.reject(new Error('Decision failed')) : original(url, opts));
    fireEvent.click(screen.getByRole('button', { name: 'Requeue' }));
    await screen.findByText('Decision failed');
    fetch.mockImplementation((url, opts) => url.includes('/review?')
      ? Promise.reject(new Error('Query failed')) : original(url, opts));
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity status' }), { target: { value: 'expired' } });
    await screen.findByText('Decision failed · Query failed');
    expect(screen.queryByText('Full draft revision 1')).toBeNull();
  });
});

describe('navigation and background loading', () => {
  it('does not refresh an old lane when its decision finishes after navigation', async () => {
    const original = fetch.getMockImplementation();
    let finish;
    fetch.mockImplementation((url, opts) => opts?.method === 'POST'
      ? new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ item: item('other-1') }) }); }) : original(url, opts));
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    fireEvent.click(screen.getByRole('button', { name: 'Other content' }));
    await screen.findByRole('button', { name: 'Requeue' });
    fireEvent.click(screen.getByRole('button', { name: 'Requeue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Content' }));
    await screen.findByText('1–50 of 51');
    const count = fetch.mock.calls.filter(([url]) => url.includes('actionType=other')).length;
    await act(async () => { finish(); });
    expect(fetch.mock.calls.filter(([url]) => url.includes('actionType=other'))).toHaveLength(count);
    expect(screen.getByText('1–50 of 51')).toBeTruthy();
    expect(screen.queryByText('Seasonal ants other-1')).toBeNull();
  });

  it('keeps loaded cards visible and selectable while a background poll is pending', async () => {
    vi.useFakeTimers();
    render(<AutonomousContentReviewPage embedded />);
    await act(async () => {});
    const original = fetch.getMockImplementation();
    fetch.mockImplementation((url, opts) => url.includes('/review?') ? new Promise(() => {}) : original(url, opts));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    const row = screen.getByRole('button', { name: /Seasonal ants blog-2 / });
    expect(row.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Next' }).disabled).toBe(false);
    await act(async () => { fireEvent.click(row); });
    expect(screen.getByText('Full draft revision 1')).toBeTruthy();
  });
});

describe('3916 follow-ups', () => {
  it.each(['filter', 'page'])('disables decisions while a foreground %s query is pending', async (query) => {
    const original = fetch.getMockImplementation();
    let release;
    fetch.mockImplementation(async (url, opts) => {
      if (url.includes('actionType=other')) {
        const params = new URL(url, 'http://localhost').searchParams;
        if (params.get('offset') === '50' || params.get('status') === 'all') {
          return new Promise(resolve => { release = resolve; });
        }
        return { ok: true, json: async () => ({ items: [item('other-1')], total: 51 }) };
      }
      return original(url, opts);
    });
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    fireEvent.click(screen.getByRole('button', { name: 'Other content' }));
    await screen.findByPlaceholderText('Reviewer note (optional)');
    if (query === 'page') fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    else fireEvent.change(screen.getByRole('combobox', { name: 'Activity status' }), { target: { value: 'all' } });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    for (const name of ['Requeue', 'Approve & publish', 'Dismiss']) {
      const button = screen.getByRole('button', { name });
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(fetch.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
    await act(async () => release({ ok: true, json: async () => ({ items: [item('other-1')], total: 51 }) }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss' }).disabled).toBe(false));
  });

  it('keeps full detail and unsaved notes visible during a slow same-record poll', async () => {
    const original = fetch.getMockImplementation();
    let release;
    let hold = false;
    fetch.mockImplementation(async (url, opts) => {
      if (hold && url.endsWith('/review/other-1')) return new Promise(resolve => { release = resolve; });
      const response = await original(url, opts);
      if (url.includes('actionType=other')) return { ok: true, json: async () => ({
        items: [{ ...item('other-1'), draft: { body_preview: 'Abbreviated list preview' } }], total: 1,
      }) };
      return response;
    });
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Other content' })));
    expect(screen.getByText('Full draft revision 1')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Reviewer note (optional)'), { target: { value: 'Keep this note' } });
    hold = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(release).toBeTypeOf('function');
    expect(screen.getByText('Full draft revision 1')).toBeTruthy();
    expect(screen.queryByText('Abbreviated list preview')).toBeNull();
    expect(screen.getByDisplayValue('Keep this note')).toBeTruthy();
    revision = 2;
    await act(async () => release({ ok: true, json: async () => ({ item: item('other-1') }) }));
    expect(screen.getByText('Full draft revision 2')).toBeTruthy();
    expect(screen.getByDisplayValue('Keep this note')).toBeTruthy();
  });

  it('treats clicking the active tab as a no-op for review notes and queries', async () => {
    render(<AutonomousContentReviewPage embedded />);
    await screen.findByText('Full draft revision 1');
    fireEvent.click(screen.getByRole('button', { name: 'Other content' }));
    await screen.findByPlaceholderText('Reviewer note (optional)');
    fireEvent.change(screen.getByPlaceholderText('Reviewer note (optional)'), { target: { value: 'Unsaved review' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity status' }), { target: { value: 'all' } });
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    await screen.findByText('Full draft revision 1');
    const calls = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Other content' }));
    expect(screen.getByDisplayValue('Unsaved review')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Activity status' }).value).toBe('all');
    expect(screen.getByText('Full draft revision 1')).toBeTruthy();
    expect(fetch.mock.calls.length).toBe(calls);
  });
});
