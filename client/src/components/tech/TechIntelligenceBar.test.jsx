// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import TechIntelligenceBar from './TechIntelligenceBar';

function ok(body) {
  return { ok: true, json: async () => body };
}

let queryResolvers;
let fetchMock;

async function mount() {
  render(<TechIntelligenceBar />);
  return screen.findByPlaceholderText('Ask anything...');
}

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'tech-token');
  queryResolvers = [];
  fetchMock = vi.fn((url) => {
    if (url.includes('/query')) return new Promise((resolve) => queryResolvers.push(resolve));
    if (url.includes('/quick-actions')) return Promise.resolve(ok({ actions: [] }));
    return Promise.resolve(ok({}));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('auto-growing composer', () => {
  // Owner-reported bug: the tech bar's prompt boxes were single-line
  // <input>s, so long typed or dictated text was clipped past the visible
  // edge. Follow-up to #5218, which gave the admin bar the same fix.
  it('renders the composer as a growable textarea, not a single-line input', async () => {
    const box = await mount();
    expect(box.tagName).toBe('TEXTAREA');
  });

  // jsdom has no layout: stub scrollHeight as 20px per line so the hook's
  // measurement is observable through the style it writes.
  const stubLineHeight = () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return 20 * Math.max(1, String(this.value).split('\n').length); },
    });
    return () => {
      if (desc) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', desc);
      else delete HTMLTextAreaElement.prototype.scrollHeight;
    };
  };

  it('grows with its text, caps at the mobile-friendly height, and shrinks after clearing', async () => {
    const restore = stubLineHeight();
    try {
      const box = await mount();
      fireEvent.change(box, { target: { value: 'a\nb\nc' } });
      expect(box.style.height).toBe('60px');
      expect(box.style.overflowY).toBe('hidden');
      // 12 lines * 20px = 240px, past the min(148, 40vh) cap (jsdom innerHeight
      // is 768, so 148 wins) — must clamp and scroll internally.
      fireEvent.change(box, { target: { value: Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') } });
      expect(box.style.height).toBe('148px');
      expect(box.style.overflowY).toBe('auto');
      fireEvent.change(box, { target: { value: '' } });
      expect(box.style.height).toBe('20px');
    } finally { restore(); }
  });

  it('re-measures on a viewport resize or rotation that re-wraps the text without a render', async () => {
    let perLine = 20;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return perLine * Math.max(1, String(this.value).split('\n').length); },
    });
    try {
      const box = await mount();
      fireEvent.change(box, { target: { value: 'a\nb' } });
      expect(box.style.height).toBe('40px');
      perLine = 40; // narrower box: each line now wraps onto two
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(box.style.height).toBe('80px');
    } finally {
      if (desc) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', desc);
      else delete HTMLTextAreaElement.prototype.scrollHeight;
    }
  });

  it('Enter (no Shift) submits the prompt', async () => {
    const box = await mount();
    fireEvent.change(box, { target: { value: "What's my next stop?" } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(queryResolvers).toHaveLength(1));
  });

  it('Shift+Enter does not submit, leaving the multi-line draft in place', async () => {
    const box = await mount();
    fireEvent.change(box, { target: { value: 'Line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(queryResolvers).toHaveLength(0);
    expect(box).toHaveValue('Line one');
    // The textarea's own default behavior inserts the newline; simulate
    // that follow-on onChange the same way a real keystroke would.
    fireEvent.change(box, { target: { value: 'Line one\nLine two' } });
    expect(box).toHaveValue('Line one\nLine two');
    expect(queryResolvers).toHaveLength(0);
  });

  it('Enter during IME composition does not submit', async () => {
    const box = await mount();
    fireEvent.change(box, { target: { value: '日本語' } });
    // keyCode 229 is the IME-composition signal handleKeyDown checks
    // (nativeEvent.isComposing isn't reliably settable through jsdom's
    // fireEvent, but every browser also sends keyCode 229 for this key).
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(queryResolvers).toHaveLength(0);
    expect(box).toHaveValue('日本語');
  });

  it('the follow-up box is also a growable textarea once a response lands', async () => {
    const box = await mount();
    fireEvent.change(box, { target: { value: "What's my next stop?" } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(queryResolvers).toHaveLength(1));
    await act(async () => { queryResolvers[0](ok({ response: 'Head to River Home next.', conversationHistory: [] })); });
    const followUp = await screen.findByPlaceholderText('Follow up...');
    expect(followUp.tagName).toBe('TEXTAREA');
  });
});

describe('answers', () => {
  async function askAndAnswer(response) {
    render(<MemoryRouter initialEntries={['/admin/today']}><TechIntelligenceBar /></MemoryRouter>);
    const box = await screen.findByPlaceholderText('Ask anything...');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "What's my next stop?" } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(queryResolvers).toHaveLength(1));
    return () => act(async () => { queryResolvers[0](ok({ response, conversationHistory: [] })); });
  }

  it('links open records in the app and https pages in a new tab; other targets stay text', async () => {
    const answer = await askAndAnswer([
      'Next: [the fixture customer](/admin/customers?customerId=customer-a).',
      '- Read **[the label guide](https://example.invalid/label)**',
      '[run](javascript:alert(1))',
    ].join('\n'));
    await answer();
    expect(await screen.findByRole('link', { name: 'the fixture customer' })).toHaveAttribute('href', '/admin/customers?customerId=customer-a');
    const guide = screen.getByRole('link', { name: 'the label guide' });
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide.closest('strong')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'run' })).not.toBeInTheDocument();
    expect(screen.getByText(/\[run\]\(javascript:alert\(1\)\)/)).toBeInTheDocument();
  });

  it('text and controls are at least 14px', async () => {
    fetchMock.mockImplementation((url) => {
      if (url.includes('/query')) return new Promise((resolve) => queryResolvers.push(resolve));
      return Promise.resolve(ok({ actions: [{ id: 'route', label: "Today's Route", prompt: "What's my route today?" }] }));
    });
    // The list bullet is a decorative dot, not text.
    const small = () => [...document.querySelectorAll('[style]')]
      .filter(el => el.style.fontSize && parseFloat(el.style.fontSize) < 14 && el.textContent.trim() !== '●');
    const answer = await askAndAnswer('**Stop 2**\n- Gate code on file');
    expect(screen.getByText('...')).toBeInTheDocument();
    expect(small()).toEqual([]);
    await answer();
    fireEvent.change(await screen.findByPlaceholderText('Follow up...'), { target: { value: 'And after that?' } });
    expect(screen.getAllByRole('button', { name: 'Go' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: '✕' })).toBeInTheDocument();
    expect(small()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    fireEvent.focus(screen.getByPlaceholderText('Ask anything...'));
    expect(await screen.findByText("Today's Route")).toBeInTheDocument();
    expect(small()).toEqual([]);
  });
});
