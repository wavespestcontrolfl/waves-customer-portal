// @vitest-environment jsdom
// The Waves blog post picker on the completion forms (GATE_REPORT_BLOG_POST):
// it searches as the operator types (short queries never search), lists the
// live posts the server answers, picks one, and removes it.
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BlogPostPicker, { blogPostPath } from './BlogPostPicker';

afterEach(cleanup);

const POST = {
  id: 'post-1',
  title: 'How to Get Rid of Ghost Ants in Sarasota Without Losing Your Mind',
  url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-ghost-ants-in-sarasota/',
};

function Harness({ search, initial = null }) {
  const [value, setValue] = React.useState(initial);
  return <BlogPostPicker search={search} value={value} onChange={setValue} />;
}

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
});
