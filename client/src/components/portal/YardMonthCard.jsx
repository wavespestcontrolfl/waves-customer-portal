import { useEffect, useId, useRef, useState } from 'react';
import api from '../../utils/api';
import { COLORS as B, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';
import Icon from '../Icon';
import { formatETDateOnly, formatETTime } from '../../lib/timezone';

// =========================================================================
// "Your yard this month" — the Learn tab's Local Conditions card, rebuilt on
// the SWFL yard pressure calendar (dark behind GATE_PORTAL_YARD_CALENDAR).
//
//   useYardMonth()   — one GET /api/feed/yard. {available:false} (gate off),
//                      any failure, or no answer within YARD_PROBE_TIMEOUT_MS
//                      means "not live": the caller keeps rendering the
//                      existing WeatherPestWidget untouched.
//   YardMonthCard    — the card: weather box (GET /api/feed/weather, the
//                      same-city data), tabs by the customer's plan lines,
//                      in-season items only, last lawn visit, the Photo ID
//                      launcher row and the "not a finding" footer.
//
// The server owns every fact (plan lines, grass, levels, the hidden count);
// this file only lays them out. See server/services/portal-yard-card.js.
// =========================================================================

const MAX_ROWS = 3;

// The API client has no request timeout; a hung /feed/yard must not hold the
// Learn tab on its loading panel, so the probe gives up and falls back.
export const YARD_PROBE_TIMEOUT_MS = 6000;

// Home pest levels (pest-forecast model). Text on a light fill, or white on
// the dark red, so every pill clears contrast.
const PEST_LEVEL = {
  high: { word: 'High', bg: '#C8102E', fg: '#FFFFFF', bar: '#C8102E' },
  elevated: { word: 'Elevated', bg: '#FFEDD5', fg: '#9A3412', bar: '#C2410C' },
  moderate: { word: 'Moderate', bg: '#E0F2FE', fg: '#1E5A85', bar: '#1E5A85' },
};

// Yard calendar levels: 3 Peak season, 2 In season (landscape-calendar.js).
const SEASON_LEVEL = {
  3: { bg: '#C8102E', fg: '#FFFFFF' },
  2: { bg: '#FFEDD5', fg: '#9A3412' },
};
const INFO_ONLY = { bg: '#F1F5F9', fg: '#334155' };

export function useYardMonth() {
  const [state, setState] = useState({ status: 'loading', data: null });
  useEffect(() => {
    let settled = false;
    const settle = (next) => { if (!settled) { settled = true; setState(next); } };
    const timer = setTimeout(() => settle({ status: 'off', data: null }), YARD_PROBE_TIMEOUT_MS);
    // Promise.resolve().then so a missing/throwing client method reads as
    // "not live" instead of breaking the Learn tab.
    Promise.resolve()
      .then(() => api.getYardMonth())
      .then((d) => settle(d?.available ? { status: 'on', data: d } : { status: 'off', data: null }))
      .catch(() => settle({ status: 'off', data: null }));
    return () => { settled = true; clearTimeout(timer); };
  }, []);
  return state;
}

// 'YYYY-MM-DD' (an ET calendar date) -> 'Sep 18'.
const shortDate = (ymd) => formatETDateOnly(ymd, { month: 'short', day: 'numeric' }) || null;

const pill = (bg, fg) => ({
  alignSelf: 'start', whiteSpace: 'nowrap', borderRadius: 999, padding: '4px 10px',
  fontSize: 14, fontWeight: 700, lineHeight: 1.2, background: bg, color: fg,
});

function YardItem({ item }) {
  const tone = item.infoOnly ? INFO_ONLY : SEASON_LEVEL[item.level] || INFO_ONLY;
  return (
    <li style={{
      background: SHELL.surface, border: `1px solid ${SHELL.border}`, borderRadius: 10,
      padding: '10px 12px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '3px 10px',
    }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: SHELL.text }}>{item.name}</span>
      <span style={pill(tone.bg, tone.fg)}>{item.infoOnly ? 'Info only' : item.levelLabel}</span>
      <span style={{ gridColumn: '1 / -1', fontSize: 14, fontWeight: 600, color: SHELL.muted }}>{item.hosts}</span>
      <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: 16, color: SHELL.body, lineHeight: 1.42 }}>{item.sign}</p>
    </li>
  );
}

function PestItem({ pest }) {
  const tone = PEST_LEVEL[pest.level] || PEST_LEVEL.moderate;
  return (
    <li style={{
      background: SHELL.surface, border: `1px solid ${SHELL.border}`, borderRadius: 10,
      padding: '10px 12px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '3px 10px',
    }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: SHELL.text }}>{pest.label}</span>
      <span style={pill(tone.bg, tone.fg)}>{tone.word} {pest.score10}/10</span>
      <span aria-hidden="true" style={{ gridColumn: '1 / -1', height: 5, borderRadius: 999, background: '#E2E8F0', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', borderRadius: 999, background: tone.bar, width: `${Math.min(100, Math.max(0, pest.score10 * 10))}%` }} />
      </span>
      {pest.note && <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: 16, color: SHELL.body, lineHeight: 1.42 }}>{pest.note}</p>}
    </li>
  );
}

// Body copy is 16px (the customer-surface floor); 14px is for labels only.
// Home pest headings. With live weather down the server sends the seasonal
// baseline (homePestsLive false), which must not read as current conditions.
const HOME_COPY = {
  live: {
    mine: 'live forecast', nearWithMine: 'Also active nearby · not in your plan',
    nearAlone: 'Active nearby · not in your plan', empty: 'No household pest is above moderate right now.',
  },
  seasonal: {
    mine: 'seasonal estimate', nearWithMine: 'Also common this month · not in your plan',
    nearAlone: 'Common this month · not in your plan', empty: 'No household pest is above moderate this season.',
  },
};
// The forecast read failed: say so, never the all-clear above.
const HOME_UNAVAILABLE = 'The local pest forecast is unavailable right now.';

const LAWN_CALENDAR_URL = 'https://www.wavespestcontrol.com/tools/swfl-lawn-pest-calendar/?cat=lawn';

const listStyle = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 };
const subheadStyle = { margin: '2px 0 0', fontSize: 14, fontWeight: 600, color: SHELL.muted, lineHeight: 1.3 };
const noteStyle = { margin: 0, fontSize: 16, color: SHELL.muted, lineHeight: 1.42 };

function WeatherBox({ weather, city }) {
  if (!weather || weather.temp == null) return null;
  const updated = weather.updatedAt ? new Date(weather.updatedAt) : null;
  const updatedText = updated && !Number.isNaN(updated.getTime())
    ? formatETTime(updated)
    : null;
  const afterDark = weather.isDaytime === false;
  const forecast = weather.forecast ? String(weather.forecast) : null;
  return (
    <div data-testid="yard-weather" style={{
      background: SHELL.soft, border: `1px solid ${SHELL.softBorder}`, borderRadius: 10, padding: '10px 12px',
      display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', alignItems: 'center',
    }}>
      <span style={{ gridRow: 'span 2', fontSize: 34, lineHeight: 1, fontWeight: 700, color: SHELL.text, fontFamily: FONTS.ui, fontVariantNumeric: 'tabular-nums' }}>
        {weather.temp}°
      </span>
      <span style={{ fontSize: 14, color: SHELL.body, lineHeight: 1.35 }}>
        <b style={{ color: SHELL.text }}>{city} weather</b>
        {forecast ? ` · ${forecast}${afterDark ? ' tonight' : ''}` : ''}
      </span>
      <span style={{ fontSize: 14, color: SHELL.body, lineHeight: 1.35 }}>
        {weather.nightTemp != null ? `${afterDark ? 'Low' : 'Tonight low'} ${weather.nightTemp}°` : ''}
        {weather.humidity != null ? `${weather.nightTemp != null ? ' · ' : ''}${weather.humidity}% humidity` : ''}
        {updatedText ? ` · updated ${updatedText}` : ''}
      </span>
    </div>
  );
}

// The plan decides what the card shows; the server decided what the plan is.
export function yardTabsFor(plan) {
  const yardPlan = plan.lawn || plan.treeShrub;
  // Any household line (pest, mosquito, rodent, termite) shows the live
  // forecast; a customer with no yard line still gets it too.
  const showHome = plan.pest || plan.mosquito || plan.rodent || plan.termite || !yardPlan;
  const tabs = [];
  if (plan.lawn) tabs.push({ key: 'lawn', label: 'Lawn' });
  if (showHome) tabs.push({ key: 'home', label: 'Home pests' });
  if (plan.lawn) tabs.push({ key: 'weeds', label: 'Weeds' });
  if (plan.treeShrub) tabs.push({ key: 'shrubs', label: 'Shrubs & trees' });
  return tabs;
}

// Tablist + panels for 2+ tabs (roving tabindex, arrow/Home/End keys); a single
// tab is just its panel, with no tab roles.
function YardTabs({ tabs, panels }) {
  const baseId = useId();
  const [active, setActive] = useState(tabs[0]?.key);
  const tabRefs = useRef({});
  if (tabs.length < 2) return <div style={{ display: 'grid', gap: 8 }}>{tabs[0] && panels[tabs[0].key]()}</div>;

  const tabId = (key) => `${baseId}-tab-${key}`;
  const panelId = (key) => `${baseId}-panel-${key}`;
  const onKeyDown = (event, index) => {
    const last = tabs.length - 1;
    const target = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    setActive(tabs[target].key);
    tabRefs.current[tabs[target].key]?.focus();
  };

  return (
    <>
      <div role="tablist" aria-label="Show" style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
        {tabs.map((tab, index) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              ref={(el) => { tabRefs.current[tab.key] = el; }}
              type="button"
              role="tab"
              id={tabId(tab.key)}
              aria-selected={selected}
              aria-controls={panelId(tab.key)}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
              style={{
                appearance: 'none', cursor: 'pointer', minHeight: 40, whiteSpace: 'nowrap',
                padding: '10px 12px', borderRadius: 10, fontSize: 14, fontWeight: 600, lineHeight: 1,
                fontFamily: FONTS.ui,
                border: `1px solid ${selected ? SHELL.text : SHELL.borderStrong}`,
                background: selected ? SHELL.text : SHELL.surface,
                color: selected ? '#FFFFFF' : SHELL.text,
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          role="tabpanel"
          id={panelId(tab.key)}
          aria-labelledby={tabId(tab.key)}
          tabIndex={0}
          hidden={tab.key !== active}
          style={{ display: tab.key === active ? 'grid' : 'none', gap: 8 }}
        >
          {panels[tab.key]()}
        </div>
      ))}
    </>
  );
}

function LastVisitRow({ date, reportUrl, onOpenReport }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center',
      borderTop: `1px solid ${SHELL.border}`, paddingTop: 10, fontSize: 14, color: SHELL.body,
    }}>
      <span>Last lawn visit: {date}</span>
      {reportUrl && (
        <a
          href={reportUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onOpenReport ? (e) => { e.preventDefault(); onOpenReport(reportUrl); } : undefined}
          style={{ color: '#065A8C', fontWeight: 700, textDecoration: 'none', fontSize: 14, whiteSpace: 'nowrap' }}
        >
          View service report →
        </a>
      )}
    </div>
  );
}

function lawnTeaser(items, monthName) {
  const lawn = items.filter((i) => i.category === 'lawn');
  if (!lawn.length) return null;
  const top = lawn.filter((i) => i.level === lawn[0].level).slice(0, 2);
  const verb = top.length === 1 ? 'is' : 'are';
  return `Your lawn in ${monthName}: ${top.map((i) => i.name).join(' and ')} ${verb} ${lawn[0].level === 3 ? 'at peak' : 'in season'}.`;
}

export default function YardMonthCard({ yard, onOpenPhotoId, onOpenReport = null, externalLinks = true }) {
  const [weather, setWeather] = useState(null);
  const tabs = yardTabsFor(yard.plan);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.getWeather())
      .then((d) => { if (!cancelled) setWeather(d || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const { plan, items, homePests, grass, hiddenCount, monthName } = yard;
  const city = yard.location?.city || 'Local';
  const yardPlan = plan.lawn || plan.treeShrub;
  const byCategory = (category) => items.filter((i) => i.category === category);

  // Known grass: only the hidden-count note. Otherwise say why every grass
  // shows; a failed lookup claims nothing about the customer's profile.
  let grassNote = null;
  if (grass.known) grassNote = hiddenCount > 0 ? `${hiddenCount} more in season on other grasses, hidden for your ${grass.label} lawn.` : null;
  else if (grass.unavailable) grassNote = 'Showing every grass.';
  else grassNote = grass.mixed ? 'Mixed lawn. Showing every grass.' : 'Grass type not set. Showing every grass.';

  const itemsPanel = (category, note) => {
    const shown = byCategory(category).slice(0, MAX_ROWS);
    return (
      <>
        {shown.length > 0 ? (
          <ul style={listStyle}>{shown.map((item) => <YardItem key={item.id} item={item} />)}</ul>
        ) : (
          <p style={noteStyle}>Nothing in this category is in season in {monthName}.</p>
        )}
        {note && <p style={noteStyle}>{note}</p>}
      </>
    );
  };

  const homePanel = () => {
    if (yard.homePestsUnavailable) return <p style={noteStyle}>{HOME_UNAVAILABLE}</p>;
    const copy = HOME_COPY[yard.homePestsLive === false ? 'seasonal' : 'live'];
    const mine = homePests.filter((p) => p.inPlan).slice(0, MAX_ROWS);
    const near = homePests.filter((p) => !p.inPlan).slice(0, MAX_ROWS);
    const mineHeading = `${mine.every((p) => p.line === 'pest') ? 'In your pest plan' : 'In your plan'} · ${copy.mine}`;
    return (
      <>
        {!mine.length && !near.length && <p style={noteStyle}>{copy.empty}</p>}
        {mine.length > 0 && (
          <>
            <p style={subheadStyle}>{mineHeading}</p>
            <ul style={listStyle}>{mine.map((p) => <PestItem key={p.key} pest={p} />)}</ul>
          </>
        )}
        {near.length > 0 && (
          <>
            <p style={subheadStyle}>{mine.length ? copy.nearWithMine : copy.nearAlone}</p>
            <ul style={listStyle}>{near.map((p) => <PestItem key={p.key} pest={p} />)}</ul>
          </>
        )}
      </>
    );
  };

  const panels = {
    lawn: () => itemsPanel('lawn', grassNote),
    weeds: () => itemsPanel('weed', null),
    shrubs: () => itemsPanel('shrub', null),
    home: homePanel,
  };

  const teaser = !plan.lawn ? lawnTeaser(items, monthName) : null;
  const visitDate = plan.lawn ? shortDate(yard.lastLawnVisit?.date) : null;
  const reviewed = shortDate(yard.reviewedAt);

  return (
    <section
      data-glass="card"
      aria-label={yardPlan ? 'Your yard this month' : 'Your home this month'}
      style={{
        background: SHELL.surface, border: `1px solid ${SHELL.border}`, borderRadius: 12, padding: 16,
        boxShadow: '0 1px 2px rgba(15,23,42,0.04)', color: SHELL.text, display: 'grid', gap: 12,
        fontFamily: FONTS.body,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600, color: SHELL.muted, lineHeight: 1.3 }}>
        {yardPlan ? 'Your yard this month' : 'Your home this month'}
      </span>
      <h3 style={{ margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.25, color: SHELL.text }}>
        {monthName} in {city}
      </h3>

      <WeatherBox weather={weather} city={city} />

      <YardTabs tabs={tabs} panels={panels} />

      {teaser && (
        <div style={{ border: `1px dashed ${SHELL.borderStrong}`, borderRadius: 10, padding: '10px 12px', fontSize: 16, color: SHELL.body, lineHeight: 1.42 }}>
          {teaser}
          {/* The app's webview cannot frame wavespestcontrol.com
              (X-Frame-Options SAMEORIGIN) and a new-window link strands the
              SPA (F-017), so the app shows the teaser without the link. */}
          {externalLinks && <>{' '}<a
            href={LAWN_CALENDAR_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#065A8C', fontWeight: 700, textDecoration: 'none' }}
          >
            See what to look for →
          </a></>}
        </div>
      )}

      {visitDate && <LastVisitRow date={visitDate} reportUrl={yard.lastLawnVisit?.reportUrl} onOpenReport={onOpenReport} />}

      {onOpenPhotoId && (
        <button
          type="button"
          onClick={() => onOpenPhotoId()}
          style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: 10, width: '100%', boxSizing: 'border-box',
            border: `1px solid ${SHELL.border}`, borderRadius: 10, background: SHELL.surface, cursor: 'pointer',
            textAlign: 'left', color: B.grayDark, fontFamily: FONTS.body,
          }}
        >
          <span style={{
            width: 36, height: 36, borderRadius: 8, flex: 'none', display: 'grid', placeItems: 'center',
            background: SHELL.soft, border: `1px solid ${SHELL.softBorder}`, color: SHELL.text,
          }}>
            <Icon name="camera" size={18} strokeWidth={2} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: SHELL.text }}>Photo ID</span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 14, color: SHELL.muted, lineHeight: 1.35 }}>Bugs, lawn, trees & shrubs</span>
          </span>
          <Icon name="chevronRight" size={17} strokeWidth={2} style={{ color: SHELL.muted }} />
        </button>
      )}

      <p style={{ margin: 0, fontSize: 14, color: SHELL.muted }}>
        Seasonal guide{reviewed ? ` reviewed ${reviewed}` : ''} · not a finding on your property
      </p>
    </section>
  );
}
