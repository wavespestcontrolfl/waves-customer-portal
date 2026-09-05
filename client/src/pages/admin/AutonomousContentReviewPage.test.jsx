// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
