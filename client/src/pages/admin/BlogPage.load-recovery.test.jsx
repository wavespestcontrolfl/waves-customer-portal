// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import BlogPage from './BlogPage';
import useRenderedTabBeacon from '../../hooks/useRenderedTabBeacon';

function LocationProbe() { const location = useLocation(); const navigate = useNavigate(); return <><output data-testid="location">{location.pathname}{location.search}{location.hash}</output><button onClick={() => navigate(-1)}>Browser back</button></>; }

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('distinguishes unavailable posts from an empty list and retries', async () => {
  let unavailable = true;
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (String(url).includes('/blog/analytics')) return new Response(JSON.stringify({ byStatus: {} }));
    return new Response(JSON.stringify(unavailable ? { error: 'Temporarily unavailable' } : { posts: [], counts: {} }), { status: unavailable ? 503 : 200 });
  }));
  render(<MemoryRouter initialEntries={['/admin/blog?tab=posts']}><BlogPage /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load posts");
  expect(screen.queryByText('No posts found')).not.toBeInTheDocument();
  unavailable = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('No posts found')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('opens a bookmarked post and returns to its list without dropping URL context', async () => {
  const post = { id: 'abcdef01-2345-4678-9012-abcdef012345', title: 'Fixture article', content: '', status: 'draft', tag: 'pest', city: 'Fixture town' };
  const fetchMock = vi.fn(async (url) => {
    const path = String(url);
    if (path.endsWith('/blog/ABCDEF01-2345-4678-9012-ABCDEF012345')) return new Response(JSON.stringify({ post }));
    if (path.endsWith('/authors')) return new Response(JSON.stringify({ authors: [] }));
    if (path.endsWith('/service-areas')) return new Response(JSON.stringify({ serviceAreas: [] }));
    return new Response(JSON.stringify({ posts: [], counts: {}, byStatus: {} }));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter initialEntries={['/admin/dashboard', '/admin/blog?tab=posts&status=draft&source=bookmark&post=ABCDEF01-2345-4678-9012-ABCDEF012345#details']}><BlogPage /><LocationProbe /></MemoryRouter>);
  expect(await screen.findByDisplayValue('Fixture article')).toBeInTheDocument();
  expect(useRenderedTabBeacon).toHaveBeenLastCalledWith('/admin/blog', 'editor', expect.any(Array));
  fireEvent.click(screen.getByRole('button', { name: /Back to list/i }));
  expect(await screen.findByText('No posts found')).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/blog?status=draft'))).toBe(true);
  expect(screen.getByTestId('location')).toHaveTextContent('?tab=posts&status=draft&source=bookmark#details');
  expect(useRenderedTabBeacon).toHaveBeenLastCalledWith('/admin/blog', 'draft', expect.any(Array));
  fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/dashboard');
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});

it('returns from a list-opened editor without leaving a duplicate list history entry', async () => {
  const post = { id: 'abcdef01-2345-4678-9012-abcdef012345', title: 'Fixture list article', content: '', status: 'draft', tag: 'pest', city: 'Fixture town' };
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = String(url);
    if (path.endsWith(`/blog/${post.id}`)) return new Response(JSON.stringify({ post }));
    if (path.includes('/blog?status=draft')) return new Response(JSON.stringify({ posts: [post], counts: {} }));
    if (path.endsWith('/authors')) return new Response(JSON.stringify({ authors: [] }));
    if (path.endsWith('/service-areas')) return new Response(JSON.stringify({ serviceAreas: [] }));
    return new Response(JSON.stringify({ byStatus: {} }));
  }));
  render(<MemoryRouter initialEntries={['/admin/dashboard', '/admin/blog?tab=posts&status=draft&source=list#details']}><BlogPage /><LocationProbe /></MemoryRouter>);

  fireEvent.click(await screen.findByText('Fixture list article'));
  expect(await screen.findByDisplayValue('Fixture list article')).toBeInTheDocument();
  expect(screen.getByTestId('location')).toHaveTextContent(`?tab=posts&status=draft&source=list&post=${post.id}#details`);

  fireEvent.click(screen.getByRole('button', { name: /Back to list/i }));
  expect(await screen.findByText('Fixture list article')).toBeInTheDocument();
  expect(screen.getByTestId('location')).toHaveTextContent('?tab=posts&status=draft&source=list#details');

  fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/admin/dashboard');
});

it('shows a failed bookmarked-post read with retry and a way back to the list', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url) => new Response(JSON.stringify(String(url).endsWith('/blog/missing') ? { error: 'Post not found' } : { byStatus: {} }), { status: String(url).endsWith('/blog/missing') ? 404 : 200 })));
  render(<MemoryRouter initialEntries={['/admin/blog?post=missing']}><BlogPage /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this post — Post not found");
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Back to list' })).toBeInTheDocument();
});
