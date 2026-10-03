// @vitest-environment jsdom
// The Waves blog post picker on the completion forms (GATE_REPORT_BLOG_POST):
// it searches as the operator types (short queries never search), lists the
// live posts the server answers, picks one, and removes it. When no post holds
// every word, it says so, shows the closest posts and (the server's
// GATE_BLOG_SEARCH_SUGGEST on) suggests the search as a new post for the
// autonomous blog queue (owner mockup approval 2026-10-03).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BlogPostPicker, { blogPostPath } from './BlogPostPicker';

afterEach(cleanup);

const POST = {
  id: 'post-1',
  title: 'How to Get Rid of Ghost Ants in Sarasota Without Losing Your Mind',
  url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-ghost-ants-in-sarasota/',
};

function Harness({ search, suggest = null, initial = null }) {
  const [value, setValue] = React.useState(initial);
  return <BlogPostPicker search={search} suggest={suggest} value={value} onChange={setValue} />;
}

const NEAR = {
  id: 'post-9',
  title: 'What Dollarweed Tells You About Your Venice Lawn\'s Water',
  url: 'https://www.wavespestcontrol.com/lawn-care/dollarweed-control-venice-fl/',
  exact: false,
};
const searchFor = async (query) => {
  fireEvent.change(screen.getByLabelText('Search the Waves blog'), { target: { value: query } });
};

describe('BlogPostPicker', () => {
  test('searches as the operator types and picks a post', async () => {
    const search = vi.fn(async () => ({ posts: [POST] }));
    render(<Harness search={search} />);
    fireEvent.change(screen.getByLabelText('Search the Waves blog'), { target: { value: 'ghost ants' } });
    const result = await screen.findByRole('button', { name: /Ghost Ants in Sarasota/ });
    expect(search).toHaveBeenCalledWith('ghost ants');
    expect(screen.getByText('pest-control/get-rid-of-ghost-ants-in-sarasota/')).toBeTruthy();
    fireEvent.click(result);
    expect(screen.getByText(/Picked · pest-control\/get-rid-of-ghost-ants-in-sarasota\//)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByLabelText('Search the Waves blog')).toBeTruthy();
  });

  test('a query under two characters never searches', async () => {
    const search = vi.fn(async () => ({ posts: [POST] }));
    render(<Harness search={search} />);
    fireEvent.change(screen.getByLabelText('Search the Waves blog'), { target: { value: 'g' } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(search).not.toHaveBeenCalled();
  });

  test('no match and a failed search each say so', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce({ posts: [] })
      .mockRejectedValueOnce(new Error('down'));
    render(<Harness search={search} />);
    const input = screen.getByLabelText('Search the Waves blog');
    fireEvent.change(input, { target: { value: 'scorpions' } });
    expect(await screen.findByText('No live posts match.')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'scorpions in lanai' } });
    expect(await screen.findByText('The blog search didn’t answer. Try again.')).toBeTruthy();
  });

  test('only the latest search lands', async () => {
    let resolveFirst;
    const search = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ posts: [{ ...POST, id: 'post-2', title: 'The Most Dangerous Ants in Florida' }] });
    render(<Harness search={search} />);
    const input = screen.getByLabelText('Search the Waves blog');
    fireEvent.change(input, { target: { value: 'ants' } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'dangerous ants' } });
    expect(await screen.findByRole('button', { name: /Most Dangerous Ants/ })).toBeTruthy();
    resolveFirst({ posts: [POST] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: /Ghost Ants in Sarasota/ })).toBeNull();
  });

  test('blogPostPath is the URL path without the leading slash', () => {
    expect(blogPostPath(POST.url)).toBe('pest-control/get-rid-of-ghost-ants-in-sarasota/');
    expect(blogPostPath('not a url')).toBe('');
  });

  describe('a search no post covers', () => {
    test('says so, shows the closest posts, and suggests the search as a new post', async () => {
      const search = vi.fn(async () => ({ posts: [NEAR], suggest: true }));
      const suggest = vi.fn(async () => ({ status: 'queued' }));
      render(<Harness search={search} suggest={suggest} />);
      await searchFor('Standing water');
      expect(await screen.findByText('No post covers “Standing water” yet.')).toBeTruthy();
      expect(screen.getByText('Closest posts')).toBeTruthy();
      expect(screen.getByRole('button', { name: /Dollarweed/ })).toBeTruthy();
      expect(screen.getByText('It goes straight into the blog queue and is written and published automatically.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Suggest a post about “Standing water”' }));
      expect(await screen.findByRole('button', { name: 'Suggested: “Standing water”' })).toBeDisabled();
      expect(suggest).toHaveBeenCalledWith('Standing water');
      expect(screen.getByText('In the blog queue. It will be written and published automatically.')).toBeTruthy();
    });

    test('a topic someone already suggested says so', async () => {
      const search = vi.fn(async () => ({ posts: [], suggest: true }));
      render(<Harness search={search} suggest={vi.fn(async () => ({ status: 'already_queued' }))} />);
      await searchFor('standing water');
      fireEvent.click(await screen.findByRole('button', { name: 'Suggest a post about “standing water”' }));
      expect(await screen.findByRole('button', { name: 'Already in the blog queue' })).toBeDisabled();
      expect(screen.getByText('Someone suggested it already. It will be written and published automatically.')).toBeTruthy();
      expect(screen.queryByText('Closest posts')).toBeNull();
    });

    test('a suggestion that did not go through can be sent again', async () => {
      const search = vi.fn(async () => ({ posts: [], suggest: true }));
      const suggest = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ status: 'queued' });
      render(<Harness search={search} suggest={suggest} />);
      await searchFor('standing water');
      fireEvent.click(await screen.findByRole('button', { name: 'Suggest a post about “standing water”' }));
      expect(await screen.findByText('That didn’t go through. Try again.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Suggest a post about “standing water”' }));
      expect(await screen.findByRole('button', { name: 'Suggested: “standing water”' })).toBeTruthy();
    });

    test('a phrase the server refuses says what to leave out and is not offered again (pre-push P1 on 1aaeaa36ab)', async () => {
      const search = vi.fn(async () => ({ posts: [], suggest: true }));
      const suggest = vi.fn().mockRejectedValue(Object.assign(new Error('not_a_topic'), { status: 422 }));
      render(<Harness search={search} suggest={suggest} />);
      await searchFor('ants at John Smith home');
      fireEvent.click(await screen.findByRole('button', { name: 'Suggest a post about “ants at John Smith home”' }));
      expect(await screen.findByRole('button', { name: 'Can’t suggest this one' })).toBeDisabled();
      expect(screen.getByText('Name the topic only, with no names, addresses or phone numbers.')).toBeTruthy();
      expect(suggest).toHaveBeenCalledTimes(1);
      await searchFor('ghost ants');
      expect(await screen.findByRole('button', { name: 'Suggest a post about “ghost ants”' })).not.toBeDisabled();
    });

    test('a new search starts a new suggestion', async () => {
      const search = vi.fn(async () => ({ posts: [], suggest: true }));
      render(<Harness search={search} suggest={vi.fn(async () => ({ status: 'queued' }))} />);
      await searchFor('standing water');
      fireEvent.click(await screen.findByRole('button', { name: 'Suggest a post about “standing water”' }));
      await screen.findByRole('button', { name: 'Suggested: “standing water”' });
      await searchFor('love bugs');
      expect(await screen.findByRole('button', { name: 'Suggest a post about “love bugs”' })).not.toBeDisabled();
    });
  });

  test('when some posts hold every word, only those show and nothing is offered', async () => {
    const search = vi.fn(async () => ({ posts: [{ ...POST, exact: true }, NEAR], suggest: true }));
    render(<Harness search={search} suggest={vi.fn()} />);
    await searchFor('ghost ants');
    expect(await screen.findByRole('button', { name: /Ghost Ants in Sarasota/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Dollarweed/ })).toBeNull();
    expect(screen.queryByText(/No post covers/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Suggest a post/ })).toBeNull();
  });

  test('with suggestions off on the server, no suggestion is offered', async () => {
    const search = vi.fn(async () => ({ posts: [], suggest: false }));
    render(<Harness search={search} suggest={vi.fn()} />);
    await searchFor('standing water');
    expect(await screen.findByText('No live posts match.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Suggest a post/ })).toBeNull();
  });
});
