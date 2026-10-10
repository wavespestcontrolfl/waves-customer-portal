// @vitest-environment jsdom
// The visit note's box grows with its words (owner 2026-10-08: a dictated note
// ran past three lines on a phone and the fourth line showed cut in half).
// jsdom lays nothing out, so the element's measured sizes are stubbed.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VisitNote } from './FastCompleteParts';

vi.mock('./DictationButton', () => ({ default: () => null }));

const LINE = 24;
const PADDING = 16; // 8 top + 8 bottom
let contentHeight = 0;

beforeEach(() => {
  contentHeight = 3 * LINE + PADDING;
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
    lineHeight: `${LINE}px`, fontSize: '16px', paddingTop: '8px', paddingBottom: '8px', borderTopWidth: '0px', borderBottomWidth: '0px',
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const note = (text) => <VisitNote note={text} onChange={() => {}} onDictated={() => {}} serviceId="svc-1" locked={false} />;
const box = () => screen.getByLabelText('Tell me about the visit');

describe('VisitNote auto-grow', () => {
  it('is as tall as its words, with nothing to scroll, while the note is short', () => {
    contentHeight = 5 * LINE + PADDING;
    render(note('five lines of words'));
    expect(box().style.height).toBe(`${5 * LINE + PADDING}px`);
    expect(box().style.overflowY).toBe('hidden');
  });

  it('grows when a dictated note lands in the box', () => {
    const view = render(note(''));
    expect(box().style.height).toBe(`${3 * LINE + PADDING}px`);
    contentHeight = 7 * LINE + PADDING;
    view.rerender(note('a longer dictated note'));
    expect(box().style.height).toBe(`${7 * LINE + PADDING}px`);
  });

  it('stops at ten whole lines and scrolls past that, so no line shows cut in half', () => {
    contentHeight = 14 * LINE + PADDING;
    render(note('a very long note'));
    expect(box().style.height).toBe(`${10 * LINE + PADDING}px`);
    expect(box().style.overflowY).toBe('auto');
  });
});

// jsdom lays nothing out, so this reads the stylesheet: inside the photo box
// (a column) the words must not flex, or the browser ignores the height the
// note grows to. Measured on the live pest sheet 2026-10-08: with `flex: 1`
// the box stayed 88px for any note; with `flex: none` it grew to 160px, then
// to its 256px cap.
describe('VisitNote in the photo box', () => {
  it('keeps the height it grows to: the words do not flex inside the column box', () => {
    // vitest runs from client/ (the CI job and the repo's own scripts).
    const css = readFileSync(path.resolve(process.cwd(), 'src/styles/tech-workflow.css'), 'utf8');
    const rule = css.match(/\.tech-visit-note-box \.ui-control\.tech-visit-control \{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/flex:\s*none/);
  });
});
