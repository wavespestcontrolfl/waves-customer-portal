// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
    intro: 'Based on your estimate for Test Customer. The program follows the time of year.',
    property: { addressSummary: '100 Test Way, Sarasota', turfType: null, programLabel: 'Year-round, set to your lawn' },
    season: { monthName: 'Oct' },
    sections: [
      {
        key: 'lawn_program',
        title: 'How Your Program Works',
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

// GATE_LAWN_OUTLINE_VISUAL: the year bar, round cards, timeline, fact tiles and FAQ. Shapes mirror the server's packet: the bar's
// blocks carry MM-DD from/to dates and the words for "now", and the page marks the block that holds today.
const ROUND_DATES = [
  { key: 1, window: 'Dec 25 – Feb 2', from: '12-25', to: '02-02', main: ['barrier', 'micros'], short: 'Barrier + color' },
  { key: 2, window: 'Feb 3 – Mar 14', from: '02-03', to: '03-14', main: ['feeding', 'barrier'], short: 'Feed + barrier' },
  { key: 3, window: 'Mar 15 – Apr 23', from: '03-15', to: '04-23', main: ['feeding'], short: 'Spring feed' },
];
const BAR_LABELS = { feeding: 'Fertilizer', barrier: 'Pre-emergent', micros: 'Micronutrients', insects: 'Insect control' };

function roundBlocks() {
  return ROUND_DATES.map((r) => ({
    key: r.key, label: String(r.key), days: 40, window: r.window, main: r.main, short: r.short, from: r.from, to: r.to,
    now: `You are here: round ${r.key} (${r.window}).`, aside: `Round ${r.key} · ${r.window}`,
  }));
}

// Twelve month blocks, as a monthly or unknown plan draws them (February runs to 02-29, a leap-year day count).
function monthBlocks() {
  const last = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return MONTHS.map((label, index) => ({
    key: index + 1, label, days: last[index], window: label, main: ['feeding'], short: `Job ${label}`,
    from: `${String(index + 1).padStart(2, '0')}-01`, to: `${String(index + 1).padStart(2, '0')}-${last[index]}`,
    now: `You are here: ${full[index]}.`, aside: full[index],
  }));
}

function visualContent({ blocks = roundBlocks(), anchorPrefix = 'round' } = {}) {
  const round = (n, extra = {}) => ({
    n, window: ROUND_DATES[n - 1].window, title: `Round ${n} title`, main: ROUND_DATES[n - 1].main, asNeeded: n === 3 ? ['insects'] : [],
    why: `Why round ${n}.`, atHome: `Home step ${n}.`, links: [], ...extra,
  });
  return {
    ...v13Content(),
    property: { addressSummary: '100 Test Way, Sarasota', turfType: null, programLabel: 'Year-round, set to your lawn', planLabel: '9 visits a year, one per round' },
    season: { monthName: 'Feb' },
    sections: [
      {
        key: 'year_bar', title: 'Your Year In Nine Rounds', body: 'Tap a round to jump to it.', bullets: ['Round 1: Barrier'],
        visual: {
          type: 'yearBar', blocks, anchorPrefix, months: [{ label: 'J', offset: 0 }, { label: 'F', offset: 40 }], anchors: ['Dec 25', 'Jul', 'Dec 24'],
          limit: { offset: 40, days: 60, label: 'No nitrogen or phosphorus (local summer rule)' }, labels: BAR_LABELS, keySteps: ['feeding', 'barrier', 'micros'],
          caption: 'Your rule area: Manatee County, FL.',
        },
      },
      {
        key: 'rounds', title: 'Round By Round', body: '', bullets: ['Round 1'],
        visual: {
          type: 'rounds', labels: BAR_LABELS,
          rounds: [
            round(1),
            round(2, { extra: 'Extra line.', links: [{ label: 'Read the post', url: 'https://example.test/post', source: 'Waves' }] }),
            round(3),
          ],
        },
      },
      {
        key: 'after_visit_timeline', title: 'After A Visit', body: '', bullets: ['Day 0'],
        visual: { type: 'timeline', items: [{ when: 'Day 0', icon: 'reentry', title: 'Stay off', text: 'Until dry.' }, { when: 'Week 2', icon: 'report', title: 'Look', text: 'Green up.' }], note: 'Timeline note.' },
      },
      {
        key: 'after_visit', title: 'Your Part: Tools', body: '', bullets: ['Email'],
        visual: {
          type: 'facts',
          items: [
            {
              icon: 'reminders', title: 'Monday email', text: 'Weekly note.', wide: true,
              pictures: [
                { image: '/outline/watering-email-sample-thumb.jpg', imageAlt: 'A sample email', href: '/outline/watering-email-sample.jpg', linkLabel: 'See a sample email' },
                { image: '/outline/sample-irrigation-thumb.jpg', imageAlt: 'The Irrigation screen', href: '/outline/sample-irrigation.jpg', linkLabel: 'See the Irrigation screen' },
              ],
            },
            { icon: 'portal', title: 'Your customer portal', text: 'One place.', image: '/outline/sample-portal-home-thumb.jpg', imageAlt: 'The portal home screen', href: '/outline/sample-portal-home.jpg', linkLabel: 'See the customer portal' },
            { icon: 'label', title: 'Mowing', text: 'Keep it tall.', big: '3.5 to 4 in', href: 'https://example.test/mowing', linkLabel: 'A note for whoever mows' },
          ],
        },
      },
      {
        key: 'faq', title: 'Questions', body: '', bullets: ['Q1'],
        visual: {
          type: 'faq',
          items: [{ q: 'First question?', a: 'First answer.', links: [{ label: 'More reading', url: 'https://example.test/faq', source: 'UF/IFAS' }] }],
          more: [{ q: 'Hidden question?', a: 'Hidden answer.' }],
        },
      },
      {
        key: 'future_thing', title: 'A Future Section', body: 'Body text.', bullets: ['Falls back to bullets'], visual: { type: 'hologram', items: [] },
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

// Only Date is faked, so the page reads a chosen day and testing-library's timers keep running.
function setToday(iso) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
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
    expect(within(sectionOf('How Your Program Works')).getByText('Threshold counts first')).toBeInTheDocument();
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
    expect(screen.getByText('Year-round, set to your lawn')).toBeInTheDocument();
    expect(screen.queryByText('Turf type')).not.toBeInTheDocument();
  });

  // GATE_LAWN_OUTLINE_DETAIL: the month list replaces the year chart; a tile may carry the ET day it stops showing.
  it('draws the detailed month list: open months show the visit text and the at-home line, the rest open on a tap', async () => {
    const content = v13Content();
    const year = content.sections.find((s) => s.key === 'program_year');
    year.body = 'Each visit follows the step for the month it falls in. This month and the next two are open. Tap any month to see what a visit then does and one thing to do at home.';
    year.visual = {
      ...year.visual,
      type: 'months',
      months: year.visual.months.map((m) => ({
        ...m,
        name: m.label,
        visit: `Visit text for ${m.label}.`,
        atHome: `Home step for ${m.label}.`,
        open: [10, 11, 12].includes(m.month),
      })),
    };
    renderWith(content);
    await screen.findByRole('heading', { level: 2, name: 'Your Year At A Glance' });
    const list = sectionOf('Your Year At A Glance');
    const rows = [...list.querySelectorAll('details')];
    expect(rows).toHaveLength(12);
    expect(rows.filter((row) => row.open).map((row) => row.querySelector('summary span').textContent)).toEqual(['Oct', 'Nov', 'Dec']);
    expect(rows.filter((row) => row.dataset.limited === 'true').map((row) => row.querySelector('summary span').textContent)).toEqual(['Jun', 'Jul', 'Aug', 'Sep']);
    expect(within(rows[9]).getByText('Visit text for Oct.')).toBeInTheDocument();
    expect(within(rows[9]).getByText('At home:')).toBeInTheDocument();
    expect(within(rows[9]).getByText('Home step for Oct.')).toBeInTheDocument();
    // A closed row keeps its text in the page for the tap that opens it.
    expect(rows[0].open).toBe(false);
    expect(within(rows[0]).getByText('Home step for Jan.')).toBeInTheDocument();
    expect(within(rows[6]).getByText('Insect control')).toHaveClass('sr-only');
    expect(within(list).getByText('Local summer limits on nitrogen and phosphorus')).toBeInTheDocument();
  });

  // The new layout (GATE_LAWN_OUTLINE_VISUAL) draws the watering-order tile as a fact card; a stored packet keeps the tile.
  it.each(['tiles', 'facts'])('hides a %s item whose until day has passed and keeps one whose day has not', async (type) => {
    const content = v13Content();
    content.sections.push({
      key: 'your_watering',
      title: 'Your Part: Watering',
      body: 'Watering is the biggest part of lawn care you control.',
      bullets: ['When to water: Run one full cycle.', 'Old order: Ended.', 'Current order: Still running.'],
      visual: {
        type,
        items: [
          { icon: 'dry_spots', title: 'When to water', text: 'Run one full cycle.' },
          { icon: 'calendar', title: 'Old order', text: 'Ended.', until: '2000-01-01' },
          { icon: 'calendar', title: 'Current order', text: 'Still running.', until: '2999-12-31' },
        ],
      },
    });
    renderWith(content);
    await screen.findByRole('heading', { level: 2, name: 'Your Part: Watering' });
    const watering = sectionOf('Your Part: Watering');
    expect(within(watering).getByText('When to water')).toBeInTheDocument();
    expect(within(watering).queryByText('Old order')).not.toBeInTheDocument();
    expect(within(watering).getByText('Current order')).toBeInTheDocument();
  });

  // Packets stored before 2026-11-01 carry the tour videos; the public route serves them as stored, so they still play.
  it('a stored packet\'s tour video still plays and loads nothing until played', async () => {
    const content = v13Content();
    content.sections.push({
      key: 'after_visit',
      title: 'After Each Visit',
      body: '',
      bullets: ['A service report after every visit: What we found.'],
      visual: {
        type: 'facts',
        items: [{ icon: 'report', title: 'A service report after every visit', text: 'What we found.', image: '/app-email/videos/waves-lawn-tour-poster.jpg', video: '/app-email/videos/waves-lawn-tour.mp4', linkLabel: 'A 35-second tour of a lawn report (about 7 MB)' }],
      },
    });
    renderWith(content);
    await screen.findByRole('heading', { level: 2, name: 'After Each Visit' });
    const video = sectionOf('After Each Visit').querySelector('video');
    expect(video).toHaveAttribute('preload', 'none');
    expect(video).toHaveAttribute('poster', '/app-email/videos/waves-lawn-tour-poster.jpg');
    expect(video.querySelector('source')).toHaveAttribute('src', '/app-email/videos/waves-lawn-tour.mp4');
    expect(within(sectionOf('After Each Visit')).getByText('A 35-second tour of a lawn report (about 7 MB)')).toBeInTheDocument();
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

  // GATE_TS_OUTLINE: a Tree & Shrub packet names its program; two treatment cards share the fertilizer icon.
  it('names the Tree & Shrub program in the badge and the tab title, and draws cards that share an icon', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const content = {
      ...v13Content(),
      serviceLine: 'tree_shrub',
      title: 'Your Waves Tree & Shrub Program Overview',
      property: { addressSummary: '100 Test Way, Sarasota', turfType: null, programLabel: 'One program for every landscape' },
      sections: [{
        key: 'treatment_categories',
        title: 'Treatments That May Be Used',
        body: 'Which ones a visit uses depends on what the plants show.',
        bullets: ['Palm fertilizer: Slow-release.', 'Shrub fertilizer: Slow-release, twice a year.'],
        visual: { type: 'categories', items: [
          { key: 'feeding', label: 'Palm fertilizer', text: 'Slow-release.' },
          { key: 'feeding', label: 'Shrub fertilizer', text: 'Slow-release, twice a year.' },
        ] },
      }],
    };
    renderWith(content);
    await screen.findByRole('heading', { level: 2, name: 'Treatments That May Be Used' });
    expect(screen.getByText('Tree & Shrub Program')).toBeInTheDocument();
    expect(screen.queryByText('Lawn Care Program')).not.toBeInTheDocument();
    // The tab title is set in an effect after the packet renders: wait for it (CI ran the check before the effect).
    await waitFor(() => expect(document.title).toBe('Your Tree & Shrub Program Overview | Waves'));
    const cards = within(sectionOf('Treatments That May Be Used')).getAllByRole('listitem');
    expect(cards.map((card) => card.querySelector('span span').textContent)).toEqual(['Palm fertilizer', 'Shrub fertilizer']);
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  });

  it('a packet with no service line stays the lawn program', async () => {
    renderWith(v13Content());
    await screen.findByRole('heading', { level: 2, name: 'Your Year At A Glance' });
    expect(screen.getByText('Lawn Care Program')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Your Lawn Care Program Overview | Waves'));
  });

  // GATE_PEST_OUTLINE: a Pest Control packet names its program and draws the year as four season rows.
  it('names the Pest Control program and draws the year as season rows, the build season open', async () => {
    const seasons = [['Winter', 1], ['Spring', 4], ['Summer', 7], ['Fall', 10]];
    const content = {
      ...v13Content(),
      serviceLine: 'pest_control',
      title: 'Your Waves Pest Control Program Overview',
      property: { addressSummary: '100 Test Way, Sarasota', turfType: null, programLabel: 'One program for every home' },
      sections: [{
        key: 'program_year',
        title: 'Your Year At A Glance',
        body: 'Every visit follows the same routine, so each season shows what is active.',
        bullets: seasons.map(([label]) => `${label}: visit. At home: tip.`),
        visual: {
          type: 'months',
          labels: {},
          limitLabel: null,
          months: seasons.map(([label, month]) => ({ month, label, name: label, main: [], asNeeded: [], limited: false, visit: `${label} watch-for line.`, atHome: `${label} tip.`, open: label === 'Fall' })),
        },
      }],
    };
    renderWith(content);
    await screen.findByRole('heading', { level: 2, name: 'Your Year At A Glance' });
    expect(screen.getByText('Pest Control Program')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Your Pest Control Program Overview | Waves'));
    const rows = [...sectionOf('Your Year At A Glance').querySelectorAll('details')];
    expect(rows.map((row) => row.querySelector('summary span').textContent)).toEqual(['Winter', 'Spring', 'Summer', 'Fall']);
    expect(rows.filter((row) => row.open).map((row) => row.querySelector('summary span').textContent)).toEqual(['Fall']);
    expect(screen.getByText('Fall watch-for line.')).toBeInTheDocument();
  });

  // GATE_MOSQUITO_OUTLINE: a Mosquito packet names its program and draws the year as four season rows.
  it('names the Mosquito program and draws the year as season rows, the build season open', async () => {
    const seasons = [['Winter', 1], ['Spring', 4], ['Summer', 7], ['Fall', 10]];
    const content = {
      ...v13Content(),
      serviceLine: 'mosquito',
      title: 'Your Waves Mosquito Program Overview',
      property: { addressSummary: '100 Test Way, Sarasota', turfType: null, programLabel: 'One routine for every yard' },
      sections: [{
        key: 'program_year',
        title: 'Your Year At A Glance',
        body: 'Every visit follows the same routine, so each season shows what is active.',
        bullets: seasons.map(([label]) => `${label}: visit. At home: tip.`),
        visual: {
          type: 'months',
          labels: {},
          limitLabel: null,
          months: seasons.map(([label, month]) => ({ month, label, name: label, main: [], asNeeded: [], limited: false, visit: `${label} watch-for line.`, atHome: `${label} tip.`, open: label === 'Fall' })),
        },
      }],
    };
    renderWith(content);
    await screen.findByRole('heading', { level: 2, name: 'Your Year At A Glance' });
    expect(screen.getByText('Mosquito Program')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Your Mosquito Program Overview | Waves'));
    const rows = [...sectionOf('Your Year At A Glance').querySelectorAll('details')];
    expect(rows.map((row) => row.querySelector('summary span').textContent)).toEqual(['Winter', 'Spring', 'Summer', 'Fall']);
    expect(rows.filter((row) => row.open).map((row) => row.querySelector('summary span').textContent)).toEqual(['Fall']);
    expect(screen.getByText('Fall watch-for line.')).toBeInTheDocument();
  });
  // GATE_LAWN_OUTLINE_VISUAL: five new drawings; nothing emits them until the server gate is on.
  describe('visual layout sections', () => {
    it('draws the year bar, marks the block that holds today, and links each block to its round card', async () => {
      setToday('2027-02-10T15:00:00Z');
      renderWith(visualContent());
      await screen.findByRole('heading', { level: 2, name: 'Your Year In Nine Rounds' });
      const bar = sectionOf('Your Year In Nine Rounds');
      const links = within(bar).getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['#round-1', '#round-2', '#round-3']);
      expect(links.filter((a) => a.getAttribute('aria-current') === 'true').map((a) => a.getAttribute('href'))).toEqual(['#round-2']);
      expect(links.filter((a) => a.dataset.current === 'true')).toHaveLength(1);
      expect(links[1].getAttribute('aria-label')).toMatch(/\(now\)$/);
      expect(links[0].getAttribute('aria-label')).not.toMatch(/\(now\)/);
      expect(within(bar).getByText('Feed + barrier')).toBeInTheDocument();
      expect(within(bar).getByText('You are here: round 2 (Feb 3 – Mar 14).')).toBeInTheDocument();
      expect(within(bar).getByText('Your rule area: Manatee County, FL.')).toBeInTheDocument();
      expect(within(bar).getByText('No nitrogen or phosphorus (local summer rule)')).toBeInTheDocument();
      // The text lines are for readers that draw nothing.
      expect(within(bar).queryByText('Round 1: Barrier')).not.toBeInTheDocument();
      // The side panel reads the plan and today's round; the product-language row is gone.
      expect(screen.getByText('Your plan')).toBeInTheDocument();
      expect(screen.getByText('9 visits a year, one per round')).toBeInTheDocument();
      expect(screen.getByText('Now', { selector: 'dt' })).toBeInTheDocument();
      expect(screen.getByText('Round 2 · Feb 3 – Mar 14', { selector: 'dd' })).toBeInTheDocument();
      expect(screen.queryByText('Season focus')).not.toBeInTheDocument();
      expect(screen.queryByText('Product language')).not.toBeInTheDocument();
      expect(screen.queryByText('May be used, not guaranteed')).not.toBeInTheDocument();
    });

    // Round 1 runs over the year end: Dec 28 and Jan 5 both fall in it, and Feb 3 starts round 2.
    it.each([
      ['2027-12-28T15:00:00Z', '#round-1'],
      ['2027-01-05T15:00:00Z', '#round-1'],
      ['2027-02-03T15:00:00Z', '#round-2'],
    ])('on %s the bar marks %s', async (iso, expected) => {
      setToday(iso);
      renderWith(visualContent());
      await screen.findByRole('heading', { level: 2, name: 'Your Year In Nine Rounds' });
      const links = within(sectionOf('Your Year In Nine Rounds')).getAllByRole('link');
      expect(links.filter((a) => a.getAttribute('aria-current') === 'true').map((a) => a.getAttribute('href'))).toEqual([expected]);
    });

    it('a months bar marks the month of today and the side panel names it as the season focus', async () => {
      setToday('2027-10-10T15:00:00Z');
      renderWith(visualContent({ blocks: monthBlocks(), anchorPrefix: 'month' }));
      await screen.findByRole('heading', { level: 2, name: 'Your Year In Nine Rounds' });
      const bar = sectionOf('Your Year In Nine Rounds');
      const marked = within(bar).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'true');
      expect(marked.map((a) => a.getAttribute('href'))).toEqual(['#month-10']);
      expect(within(bar).getByText('You are here: October.')).toBeInTheDocument();
      expect(screen.getByText('Season focus', { selector: 'dt' })).toBeInTheDocument();
      expect(screen.getByText('October', { selector: 'dd' })).toBeInTheDocument();
      expect(screen.queryByText('Now', { selector: 'dt' })).not.toBeInTheDocument();
    });

    it('a leap day (Feb 29) falls in February', async () => {
      setToday('2028-02-29T15:00:00Z');
      renderWith(visualContent({ blocks: monthBlocks(), anchorPrefix: 'month' }));
      await screen.findByRole('heading', { level: 2, name: 'Your Year In Nine Rounds' });
      const marked = within(sectionOf('Your Year In Nine Rounds')).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'true');
      expect(marked.map((a) => a.getAttribute('href'))).toEqual(['#month-2']);
    });

    it('a bar without from/to dates marks nothing, opens no card, and the side panel keeps the season focus', async () => {
      setToday('2027-02-10T15:00:00Z');
      const undated = roundBlocks().map(({ from, to, now, aside, ...rest }) => rest);
      renderWith(visualContent({ blocks: undated }));
      await screen.findByRole('heading', { level: 2, name: 'Your Year In Nine Rounds' });
      const bar = sectionOf('Your Year In Nine Rounds');
      expect(within(bar).getAllByRole('link').some((a) => a.getAttribute('aria-current') === 'true')).toBe(false);
      expect(within(bar).queryByText(/You are here/)).not.toBeInTheDocument();
      expect([...sectionOf('Round By Round').querySelectorAll('details')].some((d) => d.open)).toBe(false);
      expect(screen.getByText('Season focus', { selector: 'dt' })).toBeInTheDocument();
      expect(screen.getByText('Feb', { selector: 'dd' })).toBeInTheDocument();
    });

    it('a dense (twelve-month) bar renders one diagonal job-name slot under each block, and a rounds bar keeps its plain labels', async () => {
      renderWith(visualContent({ blocks: monthBlocks(), anchorPrefix: 'month' }));
      await screen.findByRole('heading', { level: 2, name: 'Your Year In Nine Rounds' });
      const slots = [...sectionOf('Your Year In Nine Rounds').querySelectorAll('[data-job-slot]')];
      expect(slots).toHaveLength(12);
      expect(slots.map((slot) => slot.textContent)).toEqual(MONTHS.map((m) => `Job ${m}`));
      expect(slots.every((slot) => slot.querySelector('.rotate-45.whitespace-nowrap.text-sm'))).toBe(true);
      cleanup();

      renderWith(visualContent());
      await screen.findByRole('heading', { level: 2, name: 'Your Year In Nine Rounds' });
      expect(sectionOf('Your Year In Nine Rounds').querySelector('[data-job-slot]')).toBeNull();
    });

    it('draws round cards with ids, opens and marks the round that holds today, and links open in a new tab', async () => {
      setToday('2027-02-10T15:00:00Z');
      renderWith(visualContent());
      await screen.findByRole('heading', { level: 2, name: 'Round By Round' });
      const rounds = sectionOf('Round By Round');
      const cards = [...rounds.querySelectorAll('li[id^="round-"]')];
      expect(cards.map((li) => li.id)).toEqual(['round-1', 'round-2', 'round-3']);
      expect(cards.map((li) => li.querySelector('details').open)).toEqual([false, true, false]);
      expect(cards.filter((li) => li.getAttribute('aria-current') === 'step').map((li) => li.id)).toEqual(['round-2']);
      expect(within(cards[1]).getByText('Now')).toBeInTheDocument();
      // Glass forces its own border and shadow on what it marks, so it sits on the <li> and the <details> keeps the current ring.
      expect(cards.every((li) => li.getAttribute('data-glass') === 'soft')).toBe(true);
      expect(cards.every((li) => !li.querySelector('details').hasAttribute('data-glass'))).toBe(true);
      expect(cards[1].querySelector('details')).toHaveClass('ring-2', 'ring-inset', 'ring-waves-blue');
      expect(within(cards[1]).getByText('Round 2 · Feb 3 – Mar 14')).toBeInTheDocument();
      expect(within(cards[1]).getByText('Home step 2.')).toBeInTheDocument();
      expect(within(cards[1]).getByText('Extra line.')).toBeInTheDocument();
      expect(within(cards[2]).getByText('Insect control')).toHaveClass('sr-only');
      const link = within(cards[1]).getByRole('link', { name: /Read the post/ });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('draws the timeline, the fact pictures (two side by side, no video) and the FAQ with its More questions row', async () => {
      renderWith(visualContent());
      await screen.findByRole('heading', { level: 2, name: 'Questions' });
      const timeline = sectionOf('After A Visit');
      expect(within(timeline).getByText('Week 2')).toBeInTheDocument();
      expect(within(timeline).getByText('Timeline note.')).toBeInTheDocument();

      const facts = sectionOf('Your Part: Tools');
      expect(document.querySelector('video')).toBeNull();
      const sample = within(facts).getByRole('link', { name: /See a sample email/ });
      expect(sample).toHaveAttribute('href', '/outline/watering-email-sample.jpg');
      expect(sample).toHaveAttribute('target', '_blank');
      expect(sample).toHaveAttribute('rel', 'noopener noreferrer');
      const irrigation = within(facts).getByRole('link', { name: /See the Irrigation screen/ });
      expect(irrigation).toHaveAttribute('href', '/outline/sample-irrigation.jpg');
      expect(irrigation).toHaveAttribute('target', '_blank');
      expect(irrigation).toHaveAttribute('rel', 'noopener noreferrer');
      expect(irrigation.querySelector('img')).toHaveClass('h-44', 'object-cover', 'object-top');
      expect(sample.parentElement).toBe(irrigation.parentElement);
      expect(sample.parentElement).toHaveClass('grid', 'grid-cols-2', 'gap-3');
      const portal = within(facts).getByRole('link', { name: /See the customer portal/ });
      expect(portal).toHaveAttribute('href', '/outline/sample-portal-home.jpg');
      expect(within(facts).getByText('3.5 to 4 in')).toBeInTheDocument();
      const mowing = within(facts).getByRole('link', { name: 'A note for whoever mows' });
      expect(mowing).toHaveAttribute('target', '_blank');
      expect(mowing).toHaveAttribute('rel', 'noopener noreferrer');

      const faq = sectionOf('Questions');
      const rows = [...faq.querySelectorAll('details')];
      expect(rows.every((row) => !row.open)).toBe(true);
      // Question rows carry the glass surface (the "More questions" wrapper is a dashed box without it).
      expect(rows.filter((row) => row.getAttribute('data-glass') === 'soft')).toHaveLength(2);
      expect(within(faq).getByText('First question?')).toBeInTheDocument();
      expect(within(faq).getByText('More questions')).toBeInTheDocument();
      expect(within(faq).getByText('Hidden question?')).toBeInTheDocument();
      expect(within(faq).getByRole('link', { name: /More reading/ })).toHaveAttribute('target', '_blank');
    });

    it('an unknown visual type keeps its bullet cards', async () => {
      renderWith(visualContent());
      await screen.findByRole('heading', { level: 2, name: 'A Future Section' });
      const future = sectionOf('A Future Section');
      expect(within(future).getByText('Body text.')).toBeInTheDocument();
      expect(within(future).getByText('Falls back to bullets')).toBeInTheDocument();
    });

    it('gives each month row an id so a twelve-month bar can link to it', async () => {
      const content = v13Content();
      const year = content.sections.find((s) => s.key === 'program_year');
      year.visual = { ...year.visual, type: 'months', months: year.visual.months.map((m) => ({ ...m, visit: 'v', atHome: 'h', open: false })) };
      renderWith(content);
      await screen.findByRole('heading', { level: 2, name: 'Your Year At A Glance' });
      const ids = [...sectionOf('Your Year At A Glance').querySelectorAll('li[id^="month-"]')].map((li) => li.id);
      expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `month-${i + 1}`));
    });
  });
});
