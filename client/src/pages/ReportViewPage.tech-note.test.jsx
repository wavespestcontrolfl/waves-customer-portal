// @vitest-environment jsdom
// Tips from your tech — the quoted note on the live report.
// Owner decisions 2026-09-01: first name only, no sign-off, a greeting that
// never repeats the hero's "Hi", stable per report, live only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TechNoteCard, composeTechNote, techNoteSeed } from './ReportViewPage';

const TIPS = [
  { id: 'light_warm_bulbs', copy: 'Insects steer by short-wavelength light, so a warm bulb is far less visible to them.', source: 'library' },
  { id: 'lawn_irrigation_portal', copy: 'If you add your irrigation settings to your Waves portal, I can adjust the program to match.', source: 'library', link: { label: 'My Property', path: '/portal?tab=property' } },
  { id: 'custom', copy: 'Keep the lanai door sweep tight — that is where the ants come in.', source: 'technician' },
];

function payload(overrides = {}) {
  return {
    serviceRecordId: 'rec-123',
    token: 'tok',
    customerName: 'CHRIS SMITH',
    technician: { name: 'Adam B.', photoUrl: null, initials: 'AB' },
    techNote: { tips: TIPS, technicianFirstName: 'Adam' },
    ...overrides,
  };
}

afterEach(cleanup);

describe('composeTechNote', () => {
  it('never opens with the hero\'s "Hi", title-cases ALL-CAPS records, and matches the opener to the count', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const { greeting, opener } = composeTechNote({ tips: TIPS, customerName: 'CHRIS SMITH', seed });
      expect(greeting).not.toMatch(/^Hi\b/);
      expect(greeting).toContain('Chris');
      expect(greeting).not.toContain('CHRIS');
      expect(opener).toMatch(/^(Three things|A few things)/);
      // never promises a return visit — one-time services get the same note
      expect(opener).not.toMatch(/visit|before I|back/i);
    }
    expect(composeTechNote({ tips: TIPS.slice(0, 1), customerName: 'Pat', seed: 0 }).opener).toMatch(/^(One thing|If you do one thing)/);
    expect(composeTechNote({ tips: TIPS.slice(0, 2), customerName: 'Pat', seed: 0 }).opener).toMatch(/^(Two things|A couple of things)/);
  });

  it('varies across seeds and falls back without a name', () => {
    const greetings = new Set([0, 1, 2].map((seed) => composeTechNote({ tips: TIPS, customerName: 'Chris', seed }).greeting));
    expect(greetings.size).toBe(3);
    expect(composeTechNote({ tips: TIPS, customerName: '', seed: 5 }).greeting).toBe('Hey there,');
  });

  it('seeds deterministically from the record id', () => {
    expect(techNoteSeed('rec-123')).toBe(techNoteSeed('rec-123'));
    expect(techNoteSeed('rec-123')).not.toBe(techNoteSeed('rec-124'));
  });
});

describe('TechNoteCard', () => {
  it('renders the note from the frozen tips: first name only, greeting, every tip, the portal link, no sign-off', () => {
    render(<TechNoteCard data={payload()} mode="live" />);
    expect(screen.getByText('A note from Adam')).toBeInTheDocument();
    expect(screen.getByText('Adam')).toBeInTheDocument();
    expect(screen.getByText('Your Waves technician')).toBeInTheDocument();
    expect(screen.getByText(/^(Hey Chris,|Chris,|Hello Chris,)$/)).toBeInTheDocument();
    for (const tip of TIPS) expect(screen.getByText(tip.copy, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My Property' })).toHaveAttribute('href', '/portal?tab=property');
    expect(document.body.textContent).not.toMatch(/Adam B\.|Waves Pest Control|—\s*Adam/);
    expect(document.querySelector('#tech-note')).toHaveAttribute('data-glass', 'card');
  });

  it('is stable across renders of the same report', () => {
    const first = render(<TechNoteCard data={payload()} mode="live" />).container.textContent;
    cleanup();
    const second = render(<TechNoteCard data={payload()} mode="live" />).container.textContent;
    expect(second).toBe(first);
  });

  it('renders nothing without tips, with a null note, or outside live mode', () => {
    expect(render(<TechNoteCard data={payload({ techNote: null })} mode="live" />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<TechNoteCard data={payload({ techNote: { tips: [], technicianFirstName: 'Adam' } })} mode="live" />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<TechNoteCard data={payload()} mode="pdf" />).container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<TechNoteCard data={payload()} mode="static" />).container).toBeEmptyDOMElement();
  });

  it('a failed photo does not leak into the next report rendered by the same mount', () => {
    const withPhoto = (url) => ({ technician: { name: 'Adam B.', photoUrl: url, initials: 'AB' }, techVisitCard: true });
    const { rerender } = render(<TechNoteCard data={payload({ ...withPhoto('https://cdn.example/broken.jpg'), serviceRecordId: 'rec-1' })} mode="live" />);
    const img = document.querySelector('#tech-note img');
    expect(img).not.toBeNull();
    img.dispatchEvent(new Event('error'));
    expect(document.querySelector('#tech-note img')).toBeNull();
    rerender(<TechNoteCard data={payload({ ...withPhoto('https://cdn.example/adam.jpg'), serviceRecordId: 'rec-2' })} mode="live" />);
    expect(document.querySelector('#tech-note img')).toHaveAttribute('src', 'https://cdn.example/adam.jpg');
  });

  it('shows the technician photo only behind its own gate (techVisitCard), the initial otherwise', () => {
    const withPhoto = { technician: { name: 'Adam B.', photoUrl: 'https://cdn.example/adam.jpg', initials: 'AB' } };
    render(<TechNoteCard data={payload({ ...withPhoto, techVisitCard: false })} mode="live" />);
    expect(document.querySelector('#tech-note img')).toBeNull();
    expect(screen.getByText('A')).toBeInTheDocument();
    cleanup();
    render(<TechNoteCard data={payload({ ...withPhoto, techVisitCard: true })} mode="live" />);
    expect(document.querySelector('#tech-note img')).toHaveAttribute('src', 'https://cdn.example/adam.jpg');
  });

  it('falls back to a generic attribution when the record carries no technician', () => {
    render(<TechNoteCard data={payload({ techNote: { tips: TIPS.slice(0, 1), technicianFirstName: null } })} mode="live" />);
    expect(screen.getByText('A note from your technician')).toBeInTheDocument();
    expect(screen.getByText('Your technician')).toBeInTheDocument();
  });
});
