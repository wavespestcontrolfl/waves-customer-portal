// @vitest-environment jsdom
// The Waves blog post on the completion form (GATE_REPORT_BLOG_POST, owner
// "ok go" 2026-10-01): the picker shows only while the server answers
// available, a pick is draft content that a reopened form restores, and the
// completion sends it as blogPostId.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const service = {
  id: 'blog-post-visit',
  customerId: 'blog-post-customer',
  customerName: 'Synthetic Customer',
  serviceType: 'Pest Control',
  status: 'confirmed',
  scheduledDate: '2099-01-01',
  estimatedPrice: 100,
};

const POST = {
  id: '00000000-0000-4000-8000-0000000000b1',
  title: 'Ghost ants in the kitchen: what works',
  url: 'https://www.wavespestcontrol.com/pest-control/ghost-ants-in-the-kitchen/',
};
const DRAFT_KEY = `waves_completion_draft_${service.id}`;

let blogResponse;
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = { customer: {}, actions: [], available: false };
    if (String(url).includes('/blog-posts')) data = blogResponse(String(url));
    return { ok: true, json: async () => data };
  }));
}

async function renderPanel(props = {}) {
  await act(async () => {
    render(
      <CompletionPanel
        service={service}
        products={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue({})}
        {...props}
      />,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  blogResponse = (url) => ({ available: true, posts: url.includes('?q=') ? [POST] : [] });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the blog post on the completion form', () => {
  it('a pick alone is draft content: it saves with the draft (codex local r1 on #5547)', async () => {
    await renderPanel();
    fireEvent.change(await screen.findByLabelText('Search the Waves blog'), { target: { value: 'ghost ants' } });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(POST.title) }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
      expect(saved.blogPost).toEqual(POST);
    }, { timeout: 3000 });
  });

  it('a reopened form restores the pick, and the completion sends it', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Ghost ants on the kitchen counter.',
      blogPost: POST,
    }));
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    expect(await screen.findByText(POST.title)).toBeTruthy();

    const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][1].blogPostId).toBe(POST.id);
  });

  it('a restored pick stays, shows and is sent while the search has not answered, for /complete to check (codex local r2 on #5547)', async () => {
    blogResponse = () => { throw new Error('offline'); };
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Ghost ants on the kitchen counter.',
      blogPost: POST,
    }));
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    expect(await screen.findByText(POST.title)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();

    const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][1].blogPostId).toBe(POST.id);
  });

  it('no picker and no pick sent while the server answers unavailable (a visit whose line is not pest)', async () => {
    blogResponse = () => ({ available: false, posts: [] });
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Rodent stations checked.',
      blogPost: POST,
    }));
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/blog-posts'))).toBe(true));
    expect(screen.queryByLabelText('Search the Waves blog')).toBeNull();

    const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][1]).not.toHaveProperty('blogPostId');
  });
});
