// @vitest-environment jsdom
// The Waves blog post on the completion form (GATE_REPORT_BLOG_POST, owner
// "ok go" 2026-10-01): the picker shows only while the server answers
// available, a pick is draft content that a reopened form restores, and the
// completion sends it as blogPostId. A search no post covers can be suggested
// as a new post (GATE_BLOG_SEARCH_SUGGEST; owner mockup approval 2026-10-03).
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
let tipsResponse;
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = { customer: {}, actions: [], available: false };
    if (String(url).includes('/tech-tips') && tipsResponse) data = tipsResponse;
    if (String(url).includes('/blog-posts')) data = blogResponse(String(url));
    if (String(url).includes('/blog-suggestions')) data = { status: 'queued' };
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
  tipsResponse = null;
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

  it.each([
    ['Mosquito Control'],
    ['Termite Bait Station Monitoring'],
    ['Rodent Trap Check'],
  ])('a %s visit asks the server and offers the search when it answers available (pre-push P1)', async (serviceType) => {
    const onSubmit = vi.fn().mockResolvedValue({});
    await act(async () => {
      render(<CompletionPanel service={{ ...service, serviceType }} products={[]} onClose={vi.fn()} onSubmit={onSubmit} />);
    });
    expect(await screen.findByLabelText('Search the Waves blog')).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url).includes(`/admin/dispatch/${service.id}/blog-posts`))).toBe(true);
  });

  it.each([['Lawn Care'], ['Tree & Shrub Care'], ['Palm Injection']])('the %s form never asks (another lane owns it)', async (serviceType) => {
    await act(async () => {
      render(<CompletionPanel service={{ ...service, serviceType }} products={[]} onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue({})} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/blog-posts'))).toBe(false);
    expect(screen.queryByLabelText('Search the Waves blog')).toBeNull();
  });

  it('no picker and no pick sent while the server answers unavailable (WDO, pre-treat, lawn, tree & shrub)', async () => {
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

  it('a search no post covers is suggested from the form: POST blog-suggestions with the phrase', async () => {
    blogResponse = (url) => ({ available: true, posts: url.includes('?q=') ? [{ ...POST, exact: false }] : [], suggest: true });
    await renderPanel();
    fireEvent.change(await screen.findByLabelText('Search the Waves blog'), { target: { value: 'standing water' } });
    expect(await screen.findByText('No post covers “standing water” yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a post about “standing water”' }));
    expect(await screen.findByRole('button', { name: 'Suggested: “standing water”' })).toBeTruthy();
    const [url, options] = fetch.mock.calls.find(([called]) => String(called).includes('/blog-suggestions'));
    expect(String(url)).toContain(`/admin/dispatch/${service.id}/blog-suggestions`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ phrase: 'standing water' });
  });
});

describe('tips with facts on the completion form (GATE_TECH_TIP_SOURCES, owner 2026-10-24)', () => {
  const TIP = { id: 'water_bromeliads', label: 'Flush bromeliads weekly', copy: 'Bromeliad cups hold water.', citations: [{ label: 'UF/IFAS', url: 'https://blogs.ifas.ufl.edu/sarasotaco/2024/06/21/mosquito-faqs/' }] };
  const PLAIN = { id: 'seal_door_sweeps', label: 'Replace worn door sweeps', copy: 'A mouse fits through a small gap.' };
  const sourced = (overrides = {}) => ({
    available: true,
    line: 'pest',
    groups: [{ id: 'water', label: 'Standing water', tips: [TIP, PLAIN] }],
    more: [],
    lastSent: {},
    conditions: {},
    tipSources: true,
    yard: { grass: 'St. Augustine', irrigationSystem: true, county: 'Sarasota' },
    blogPosts: { [TIP.id]: POST },
    ...overrides,
  });
  async function pickTip(label) {
    fireEvent.focus(await screen.findByPlaceholderText('Search tips…'));
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(label) }));
  }
  const NOTE = `Filled from the tip “${TIP.label}”`;

  it('picking a tip that names a live post fills the empty slot and says so; removing the tip keeps the post, and the completion sends it', async () => {
    tipsResponse = sourced();
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    await screen.findByLabelText('Search the Waves blog');
    await pickTip(TIP.label);
    expect(await screen.findByText(NOTE)).toBeTruthy();
    expect(screen.getByText(POST.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Remove tip: ${TIP.label}` }));
    expect(screen.getByText(POST.title)).toBeTruthy();
    const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(onSubmit.mock.calls[0][1].blogPostId).toBe(POST.id);
  });

  it('the chip prints the tip\'s sources, and the field says what the tips were matched to', async () => {
    tipsResponse = sourced();
    await renderPanel();
    expect(await screen.findByText('Matched to this yard: St. Augustine · irrigation system · Sarasota County')).toBeTruthy();
    await pickTip(TIP.label);
    expect(await screen.findByText('· UF/IFAS')).toBeTruthy();
  });

  it('a tip with no post fills nothing, and a post already picked is never replaced', async () => {
    tipsResponse = sourced();
    await renderPanel();
    await screen.findByLabelText('Search the Waves blog');
    await pickTip(PLAIN.label);
    expect(screen.getByLabelText('Search the Waves blog')).toBeTruthy();
    const OTHER = { id: '00000000-0000-4000-8000-0000000000b2', title: 'Mice in the attic: first steps', url: 'https://www.wavespestcontrol.com/pest-control/mice-in-the-attic/' };
    blogResponse = (url) => ({ available: true, posts: url.includes('?q=') ? [OTHER] : [] });
    fireEvent.change(screen.getByLabelText('Search the Waves blog'), { target: { value: 'mice' } });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(OTHER.title) }));
    await pickTip(TIP.label);
    expect(screen.getByText(OTHER.title)).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('a restored draft keeps its own post', async () => {
    tipsResponse = sourced();
    const OTHER = { id: '00000000-0000-4000-8000-0000000000b3', title: 'Rodent-proofing a garage door', url: 'https://www.wavespestcontrol.com/pest-control/rodent-proofing-garage-door/' };
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ serviceId: service.id, savedAt: Date.now(), notes: 'Checked the stations.', blogPost: OTHER }));
    await renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await pickTip(TIP.label);
    expect(await screen.findByText(OTHER.title)).toBeTruthy();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('gate off: a pick fills nothing, and the form shows no sources, no yard line and no Change', async () => {
    tipsResponse = { available: true, line: 'pest', groups: [{ id: 'water', label: 'Standing water', tips: [{ ...TIP, citations: undefined }] }], more: [], lastSent: {}, conditions: {} };
    await renderPanel();
    await screen.findByLabelText('Search the Waves blog');
    await pickTip(TIP.label);
    expect(screen.getByLabelText('Search the Waves blog')).toBeTruthy();
    expect(screen.queryByText(/Matched to this yard/)).toBeNull();
    expect(screen.queryByText('· UF/IFAS')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search the Waves blog'), { target: { value: 'ghost ants' } });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(POST.title) }));
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('a lawn visit asks for the blog post with tips with facts on (decision 6); tree & shrub and palm still never ask', async () => {
    tipsResponse = sourced({ line: 'lawn' });
    await act(async () => {
      render(<CompletionPanel service={{ ...service, serviceType: 'Lawn Care' }} products={[]} onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue({})} />);
    });
    expect(await screen.findByLabelText('Search the Waves blog')).toBeTruthy();
    cleanup();
    fetch.mockClear();
    for (const serviceType of ['Tree & Shrub Care', 'Palm Injection']) {
      await act(async () => {
        render(<CompletionPanel service={{ ...service, serviceType }} products={[]} onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue({})} />);
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/blog-posts'))).toBe(false);
      cleanup();
    }
  });
});

