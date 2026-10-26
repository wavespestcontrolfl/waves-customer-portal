// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServiceOutlinePage from './ServiceOutlinePage';

// The v13 outline sections carry a `visual` (GATE_LAWN_OUTLINE_V13, server/services/lawn-service-outline.js);
// their bullets are the text for readers that draw none. Shapes below mirror what the builder writes.
const LABELS = {
  inspection: 'Inspection', feeding: 'Fertilizer', barrier: 'Pre-emergent', micros: 'Micronutrients',
  weeds: 'Weed control', insects: 'Insect control', disease: 'Disease control', dry_spots: 'Wetting agent',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function v13Content() {
  return {
    title: 'Your Waves Lawn Care Program Overview',
    intro: 'Based on your estimate for Test Customer. One program covers every lawn we treat.',
    property: { addressSummary: '100 Test Way, Sarasota', turfType: null, programLabel: 'One program for every lawn' },
    season: { monthName: 'Oct' },
    sections: [
      {
        key: 'lawn_program',
        title: 'One Program For Every Lawn',
        body: 'Most of the lawns we treat are St. Augustine, so the program is built around it.',
        bullets: ['Threshold counts first: Chinch bugs are counted before any curative treatment'],
        visual: { type: 'tiles', items: [{ icon: 'count', title: 'Threshold counts first', text: 'Chinch bugs are counted before any curative treatment' }] },
      },
      {
        key: 'season_focus',
        title: 'Oct Service Focus',
        body: 'As the soil cools in October, winter weeds start to sprout.',
        bullets: ['Disease control may be relevant when turf condition, weather, label directions, and local rules allow.'],
        visual: {
          type: 'chips',
          items: [
            { key: 'feeding', label: 'Fertilizer', tier: 'main' },
            { key: 'barrier', label: 'Pre-emergent', tier: 'main' },
            { key: 'disease', label: 'Disease control', tier: 'as_needed' },
          ],
          note: 'Each step depends on turf condition, weather, label directions, and local rules.',
        },
      },
      {
        key: 'program_year',
        title: 'Your Year At A Glance',
        body: 'Each visit follows the step for the month it falls in.',
        bullets: ['January: Pre-emergent, Micronutrients; as needed: Disease control, Weed control'],
        visual: {
          type: 'year',
          labels: LABELS,
          limitLabel: 'Local summer limits on nitrogen and phosphorus',
          months: MONTHS.map((label, index) => ({
            month: index + 1,
            label,
            main: index === 6 ? ['inspection'] : ['feeding'],
            asNeeded: index === 6 ? ['insects', 'disease'] : [],
            limited: index >= 5 && index <= 8,
          })),
        },
      },
      {
        key: 'typical_visit',
        title: 'What A Typical Visit Includes',
        body: '',
        bullets: ['Check: The whole lawn'],
        visual: { type: 'steps', items: [{ icon: 'inspection', title: 'Check', text: 'The whole lawn' }, { icon: 'report', title: 'Report', text: 'What was done' }] },
      },
      {
        key: 'treatment_categories',
        title: 'Treatments That May Be Used',
        body: 'Which ones a visit uses depends on the season.',
        bullets: ['Wetting agent: A soil surfactant that helps water soak into dry, water-repellent spots.'],
        visual: { type: 'categories', items: [{ key: 'dry_spots', label: 'Wetting agent', text: 'A soil surfactant that helps water soak into dry, water-repellent spots.' }] },
      },
      {
        key: 'local_rules',
        title: 'Local Fertilizer Rules',
        body: '',
        bullets: ['Your rule area: Sarasota County, FL'],
        visual: { type: 'tiles', items: [{ icon: 'area', title: 'Your rule area', text: 'Sarasota County, FL' }] },
      },
      {
        key: 'not_included',
        title: 'Not Included Unless Quoted',
        body: '',
        bullets: ['Irrigation repairs', 'Mowing'],
        visual: { type: 'tags', items: ['Irrigation repairs', 'Mowing'], note: 'Some lawn problems need separate work.' },
      },
    ],
    cta: { estimatePath: '/estimate/test-token' },
  };
}

// The gate-off outline: a grass in the side panel and sections with no drawing.
function legacyContent() {
  return {
    title: 'Your Waves Lawn Care Program Overview for St. Augustine',
    intro: 'Based on your estimate, this outline explains how Waves approaches your lawn care program.',
    property: { addressSummary: '100 Test Way, Sarasota', turfType: 'St. Augustine' },
    season: { monthName: 'Oct' },
    sections: [
      {
        key: 'local_rules',
        title: 'Local Fertilizer-Rule Note',
        body: 'Local fertilizer rules may affect what can be applied.',
        bullets: ['Rule area: Sarasota County, FL'],
      },
    ],
    cta: { estimatePath: '/estimate/test-token' },
  };
}

function renderWith(content) {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ packet: { content } }) }));
  return render(
    <MemoryRouter initialEntries={['/service-outlines/outline-token']}>
      <Routes>
        <Route path="/service-outlines/:token" element={<ServiceOutlinePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const sectionOf = (title) => screen.getByRole('heading', { level: 2, name: title }).closest('section');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ServiceOutlinePage drawn sections', () => {
  it('draws the year as twelve month cells, marks the limited months, and keys the icons', async () => {
    renderWith(v13Content());
    await screen.findByRole('heading', { level: 2, name: 'Your Year At A Glance' });
    const year = sectionOf('Your Year At A Glance');
    const cells = within(year).getAllByRole('listitem').filter((item) => MONTHS.includes(item.querySelector('p')?.textContent));
    expect(cells.map((cell) => cell.querySelector('p').textContent)).toEqual(MONTHS);
    expect(cells.filter((cell) => cell.dataset.limited === 'true').map((cell) => cell.querySelector('p').textContent)).toEqual(['Jun', 'Jul', 'Aug', 'Sep']);
    expect(within(cells[6]).getByText('Inspection')).toBeInTheDocument();
    expect(within(cells[6]).getByText('Insect control')).toHaveClass('sr-only');
    expect(within(year).getByText('Local summer limits on nitrogen and phosphorus')).toBeInTheDocument();
    // The text lines are for readers that draw nothing: the page shows the chart instead.
    expect(within(year).queryByText(/^January: /)).not.toBeInTheDocument();
  });

  it('draws the month as step chips, the program as tiles, the visit as numbered steps and the treatments as cards', async () => {
    renderWith(v13Content());
    await screen.findByRole('heading', { level: 2, name: 'Oct Service Focus' });
    const focus = sectionOf('Oct Service Focus');
    expect(within(focus).getByText("This month's step")).toBeInTheDocument();
    expect(within(focus).getByText('As needed')).toBeInTheDocument();
    expect(within(focus).getByText('Pre-emergent')).toBeInTheDocument();
    expect(within(focus).queryByText(/may be relevant/)).not.toBeInTheDocument();
    expect(within(sectionOf('One Program For Every Lawn')).getByText('Threshold counts first')).toBeInTheDocument();
    expect(within(sectionOf('Local Fertilizer Rules')).getByText('Sarasota County, FL')).toBeInTheDocument();
    const visit = sectionOf('What A Typical Visit Includes');
    expect(within(visit).getByText('1')).toBeInTheDocument();
    expect(within(visit).getByText('Report')).toBeInTheDocument();
    // An empty body under a drawing leaves no empty paragraph.
    expect([...visit.querySelectorAll('p')].some((p) => p.textContent === '')).toBe(false);
    expect(within(sectionOf('Treatments That May Be Used')).getByText('A soil surfactant that helps water soak into dry, water-repellent spots.')).toBeInTheDocument();
  });

  it('draws the exclusions as tags with their note, and the side panel names the program, not a grass', async () => {
    renderWith(v13Content());
    await screen.findByRole('heading', { level: 2, name: 'Not Included Unless Quoted' });
    const excluded = sectionOf('Not Included Unless Quoted');
    expect(within(excluded).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Irrigation repairs', 'Mowing']);
    expect(within(excluded).getByText('Some lawn problems need separate work.')).toBeInTheDocument();
    expect(screen.getByText('Program')).toBeInTheDocument();
    expect(screen.getByText('One program for every lawn')).toBeInTheDocument();
    expect(screen.queryByText('Turf type')).not.toBeInTheDocument();
  });

  it('a section with no drawing keeps its body and bullet cards, and the side panel keeps the grass (the gate-off outline)', async () => {
    renderWith(legacyContent());
    await screen.findByRole('heading', { level: 2, name: 'Local Fertilizer-Rule Note' });
    const rules = sectionOf('Local Fertilizer-Rule Note');
    expect(within(rules).getByText('Local fertilizer rules may affect what can be applied.')).toBeInTheDocument();
    expect(within(rules).getByText('Rule area: Sarasota County, FL')).toBeInTheDocument();
    expect(screen.getByText('Turf type')).toBeInTheDocument();
    expect(screen.getByText('St. Augustine')).toBeInTheDocument();
    expect(screen.queryByText('Program')).not.toBeInTheDocument();
  });
});
