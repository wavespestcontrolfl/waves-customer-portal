/**
 * CalendarDatePicker — dependency-free month grid for customer-facing slot
 * browsing. Themeable so it can sit in both the public booking flow (brand
 * blues) and the estimate page. Constrains selection to [minDate, maxDate]
 * (the 90-day horizon), greys out Sundays, and — when `availableDates` is
 * provided — dims days with no open windows.
 *
 * All dates are plain 'YYYY-MM-DD' calendar strings; no timezone math, since a
 * calendar day is the same wall-clock date everywhere in the flow.
 */
import { useMemo, useState } from 'react';

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function ymd(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseYmd(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return { year: y, month: (m || 1) - 1, day: d || 1 };
}

export default function CalendarDatePicker({
  theme,
  minDate,
  maxDate,
  availableDates = null,
  selectedDate = null,
  onPick,
  disableSundays = true,
}) {
  const t = {
    accent: '#1B2C5B',
    accentText: '#FFFFFF',
    surface: '#FFFFFF',
    text: '#1B2C5B',
    muted: '#64748B',
    border: '#E2E8F0',
    ...theme,
  };

  const min = useMemo(() => parseYmd(minDate), [minDate]);
  const max = useMemo(() => parseYmd(maxDate), [maxDate]);
  const availSet = useMemo(
    () => (availableDates ? new Set(availableDates) : null),
    [availableDates],
  );

  // Start the view on the selected date's month, else the min date's month.
  const initial = selectedDate ? parseYmd(selectedDate) : min;
  const [view, setView] = useState({ year: initial.year, month: initial.month });

  const monthIndex = (p) => p.year * 12 + p.month;
  const canPrev = monthIndex(view) > monthIndex(min);
  const canNext = monthIndex(view) < monthIndex(max);

  const step = (delta) => {
    const next = view.month + delta;
    setView({ year: view.year + Math.floor(next / 12), month: ((next % 12) + 12) % 12 });
  };

  const firstWeekday = new Date(Date.UTC(view.year, view.month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);

  const navBtn = (enabled) => ({
    width: 36, height: 36, borderRadius: 8,
    border: `1px solid ${t.border}`, background: t.surface,
    color: enabled ? t.text : t.muted,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.4, fontSize: 18, lineHeight: 1,
  });

  return (
    <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <button type="button" aria-label="Previous month" disabled={!canPrev} onClick={() => canPrev && step(-1)} style={navBtn(canPrev)}>‹</button>
        <div style={{ fontSize: 16, fontWeight: 600, color: t.text }}>
          {MONTH_LABELS[view.month]} {view.year}
        </div>
        <button type="button" aria-label="Next month" disabled={!canNext} onClick={() => canNext && step(1)} style={navBtn(canNext)}>›</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} style={{ textAlign: 'center', fontSize: 12, fontWeight: 600, color: t.muted, padding: '4px 0' }}>{w}</div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {cells.map((day, idx) => {
          if (day == null) return <div key={`pad-${idx}`} />;
          const dateStr = ymd(view.year, view.month, day);
          const dow = new Date(Date.UTC(view.year, view.month, day)).getUTCDay();
          const outOfRange = dateStr < minDate || dateStr > maxDate;
          const sundayBlocked = disableSundays && dow === 0;
          const noAvailability = availSet ? !availSet.has(dateStr) : false;
          const disabled = outOfRange || sundayBlocked || noAvailability;
          const isSelected = dateStr === selectedDate;
          return (
            <button
              key={dateStr}
              type="button"
              disabled={disabled}
              onClick={() => !disabled && onPick && onPick(dateStr)}
              aria-pressed={isSelected}
              style={{
                aspectRatio: '1 / 1', minHeight: 38, borderRadius: 8,
                border: `1px solid ${isSelected ? t.accent : t.border}`,
                background: isSelected ? t.accent : t.surface,
                color: isSelected ? t.accentText : (disabled ? t.muted : t.text),
                fontSize: 14, fontWeight: isSelected ? 700 : 500,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.35 : 1,
                transition: 'background 120ms ease, border-color 120ms ease',
              }}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
