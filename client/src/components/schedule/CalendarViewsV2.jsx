/**
 * CalendarViewsV2.jsx
 * client/src/components/schedule/CalendarViewsV2.jsx
 *
 * Monochrome Week/Month calendar views for the redesigned Dispatch (V2) page.
 * Strict 1:1 with V1 CalendarViews on:
 *   - endpoints (/admin/schedule/week, /admin/schedule/month)
 *   - slice counts (5 services/day in Week, 3/day in Month)
 *   - summary stats (total, completed, pending, unique + byCategory + byTech)
 *   - click behavior (onDateClick switches back to day view)
 *
 * Visual differences vs V1:
 *   - Zinc palette, no teal/amber/purple accents
 *   - Hairline borders, no colored tinted backgrounds
 *   - Category dots collapse to zinc-900 / zinc-300 (status-based), not color-coded
 *   - Uppercase labels via .u-label, tabular numerals via .u-nums
 *   - No emoji icons
 */

import { useState, useEffect } from 'react';
import { Card, CardBody, cn } from '../ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
  }).then((r) => {
    if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function formatDateISO(d) { return d.toISOString().split('T')[0]; }

// ─── VIEW MODE SELECTOR ──────────────────────────────────────────

export function ViewModeSelectorV2({ viewMode, onViewModeChange }) {
  const modes = [
    { id: 'day', label: 'Day' },
    { id: '5day', label: '5-Day' },
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
  ];

  return (
    <div className="inline-flex items-center border-hairline border-zinc-200 rounded-sm overflow-hidden bg-white">
      {modes.map((m) => (
        <button
          key={m.id}
          onClick={() => onViewModeChange(m.id)}
          className={cn(
            'h-8 px-4 text-11 uppercase tracking-label font-medium u-focus-ring transition-colors',
            viewMode === m.id
              ? 'bg-zinc-900 text-white'
              : 'bg-white text-ink-secondary hover:bg-zinc-50'
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}


// ─── WEEK VIEW ───────────────────────────────────────────────────

export function WeekViewV2({ startDate, onDateClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const d = new Date(startDate + 'T12:00:00');
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const mondayStr = formatDateISO(monday);

    adminFetch(`/admin/schedule/week?start=${mondayStr}`)
      .then((res) => { setData(res); setLoading(false); })
      .catch(() => setLoading(false));
  }, [startDate]);

  if (loading) return <div className="py-10 text-center text-13 text-ink-secondary">Loading week…</div>;
  if (!data?.days) return null;

  const today = formatDateISO(new Date());
  const totalServices = data.days.reduce((sum, d) => sum + d.count, 0);
  const completedServices = data.days.reduce(
    (sum, d) => sum + d.services.filter((s) => s.status === 'completed').length,
    0
  );

  return (
    <div>
      {/* Week grid — horizontal scroll on mobile (≤768px); 7 equal cols on desktop */}
      <div className="-mx-4 md:mx-0 overflow-x-auto mb-4">
        <div className="grid grid-cols-7 gap-2 px-4 md:px-0 min-w-[700px]">
        {data.days.map((day) => {
          const isToday = day.date === today;
          const isSelected = day.date === startDate;
          const isWeekend = new Date(day.date + 'T12:00:00').getDay() % 6 === 0;
          const dim = isWeekend && day.count === 0;

          return (
            <button
              key={day.date}
              onClick={() => onDateClick(day.date)}
              className={cn(
                'text-left bg-white rounded-md p-3 transition-colors u-focus-ring min-h-[140px]',
                'border-hairline',
                isToday
                  ? 'border-zinc-900 ring-1 ring-zinc-900'
                  : isSelected
                    ? 'border-zinc-900'
                    : 'border-zinc-200 hover:bg-zinc-50',
                dim && 'opacity-60'
              )}
            >
              {/* Day header */}
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="u-label text-ink-secondary">{day.dayOfWeek}</div>
                  <div className="u-nums text-22 font-medium tracking-tight mt-0.5 text-zinc-900 leading-none">
                    {day.dayNum}
                  </div>
                </div>
                {day.count > 0 && (
                  <span className="u-nums text-12 font-medium text-zinc-900">
                    {day.count}
                  </span>
                )}
              </div>

              {/* Service list (compact) */}
              <div className="space-y-0.5">
                {day.services.slice(0, 5).map((s) => (
                  <div
                    key={s.id}
                    className={cn(
                      'text-11 truncate',
                      s.status === 'completed' ? 'line-through text-ink-tertiary' : 'text-ink-primary'
                    )}
                  >
                    {s.customerName?.split(' ')[0] || '—'}
                  </div>
                ))}
              </div>
              {day.count > 5 && (
                <div className="text-11 text-ink-tertiary mt-1">
                  +{day.count - 5} more
                </div>
              )}

              {/* Zone dots — all zinc, count signals density not category */}
              {Object.keys(day.zones || {}).length > 0 && (
                <div className="flex gap-1 mt-2 flex-wrap">
                  {Object.entries(day.zones).map(([zone, count]) => (
                    <span
                      key={zone}
                      title={`${zone}: ${count}`}
                      className="u-dot u-dot--filled"
                    />
                  ))}
                </div>
              )}
            </button>
          );
        })}
        </div>
      </div>

      {/* Week summary bar */}
      <Card>
        <CardBody className="py-3 px-5 flex items-center justify-center gap-6 text-12 text-ink-secondary">
          <span>
            <strong className="u-nums text-zinc-900 font-medium">{totalServices}</strong>{' '}
            services this week
          </span>
          <span className="u-hairline w-px h-4 bg-zinc-200" aria-hidden />
          <span>
            <strong className="u-nums text-zinc-900 font-medium">{completedServices}</strong>{' '}
            completed
          </span>
        </CardBody>
      </Card>
    </div>
  );
}


// ─── MONTH VIEW ──────────────────────────────────────────────────

export function MonthViewV2({ date, onDateClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const yearMonth = date.slice(0, 7); // "2026-04"

  useEffect(() => {
    setLoading(true);
    adminFetch(`/admin/schedule/month?month=${yearMonth}`)
      .then((res) => { setData(res); setLoading(false); })
      .catch(() => setLoading(false));
  }, [yearMonth]);

  if (loading) return <div className="py-10 text-center text-13 text-ink-secondary">Loading calendar…</div>;
  if (!data?.weeks) return null;

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const { summary } = data;

  const SUMMARY_STATS = [
    { label: 'Total Services', value: summary.totalServices },
    { label: 'Completed', value: summary.completed },
    { label: 'Pending', value: summary.pending },
    { label: 'Unique Customers', value: summary.uniqueCustomers },
  ];

  return (
    <div>
      {/* Month summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {SUMMARY_STATS.map((stat) => (
          <Card key={stat.label}>
            <CardBody className="p-4 text-center">
              <div className="u-nums text-22 font-medium tracking-tight text-zinc-900 leading-none">
                {stat.value}
              </div>
              <div className="u-label text-ink-secondary mt-2">{stat.label}</div>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Category breakdown (monochrome chips) */}
      {Object.keys(summary.byCategory || {}).length > 0 && (
        <div className="flex gap-2 mb-4 flex-wrap">
          {Object.entries(summary.byCategory)
            .sort(([, a], [, b]) => b - a)
            .map(([cat, count]) => (
              <span
                key={cat}
                className="inline-flex items-center gap-2 text-11 px-2.5 h-6 rounded-sm border-hairline border-zinc-200 bg-white text-ink-secondary"
              >
                <span className="u-dot u-dot--filled" />
                <span className="lowercase">{cat}</span>
                <span className="u-nums text-zinc-900 font-medium">{count}</span>
              </span>
            ))}
        </div>
      )}

      {/* Calendar grid — horizontal scroll on mobile (≤768px) */}
      <div className="-mx-4 md:mx-0 overflow-x-auto">
      <Card className="overflow-hidden min-w-[700px] md:min-w-0 md:mx-0 mx-4">
        {/* Day of week headers */}
        <div className="grid grid-cols-7 border-b border-hairline border-zinc-200 bg-zinc-50">
          {DOW.map((d) => (
            <div key={d} className="u-label text-ink-secondary py-2 text-center">
              {d}
            </div>
          ))}
        </div>

        {/* Weeks */}
        {data.weeks.map((week, wi) => (
          <div
            key={wi}
            className={cn(
              'grid grid-cols-7',
              wi < data.weeks.length - 1 && 'border-b border-hairline border-zinc-200'
            )}
          >
            {week.map((day, di) => (
              <button
                key={day.date}
                onClick={() => onDateClick(day.date)}
                className={cn(
                  'text-left min-h-[90px] p-2 transition-colors u-focus-ring',
                  di < 6 && 'border-r border-hairline border-zinc-200',
                  day.isToday ? 'bg-zinc-50' : 'bg-white hover:bg-zinc-50',
                  !day.isCurrentMonth && 'opacity-40'
                )}
              >
                {/* Day number + count */}
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={cn(
                      'u-nums text-13',
                      day.isToday
                        ? 'font-medium text-white bg-zinc-900 rounded-full w-6 h-6 inline-flex items-center justify-center'
                        : 'text-ink-primary'
                    )}
                  >
                    {day.dayNum}
                  </span>
                  {day.count > 0 && (
                    <span className="u-nums text-11 font-medium text-zinc-900">
                      {day.count}
                    </span>
                  )}
                </div>

                {/* Category dots — all zinc-900 filled, hover title reveals category */}
                {day.count > 0 && Object.keys(day.categoryCounts || {}).length > 0 && (
                  <div className="flex gap-1 flex-wrap mb-1">
                    {Object.entries(day.categoryCounts).map(([cat, count]) => (
                      <span
                        key={cat}
                        title={`${cat}: ${count}`}
                        className="u-dot u-dot--filled"
                      />
                    ))}
                  </div>
                )}

                {/* Compact service list (first 3) */}
                <div className="space-y-0.5">
                  {day.services.slice(0, 3).map((s) => (
                    <div
                      key={s.id}
                      className={cn(
                        'text-11 truncate leading-tight',
                        s.status === 'completed'
                          ? 'line-through text-ink-tertiary'
                          : 'text-ink-primary'
                      )}
                    >
                      {s.customerName?.split(' ')[0] || '—'}
                    </div>
                  ))}
                </div>
                {day.count > 3 && (
                  <div className="text-11 text-ink-tertiary mt-0.5">
                    +{day.count - 3}
                  </div>
                )}
              </button>
            ))}
          </div>
        ))}
      </Card>
      </div>

      {/* Tech workload for the month */}
      {Object.keys(summary.byTech || {}).length > 0 && (
        <Card className="mt-4">
          <CardBody className="p-4">
            <div className="u-label text-ink-secondary mb-3">
              Tech Workload — {data.monthName}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(summary.byTech)
                .sort(([, a], [, b]) => b - a)
                .map(([tech, count]) => {
                  const pct = summary.totalServices
                    ? Math.round((count / summary.totalServices) * 100)
                    : 0;
                  return (
                    <div
                      key={tech}
                      className="border-hairline border-zinc-200 rounded-sm bg-white p-3"
                    >
                      <div className="flex items-baseline justify-between">
                        <div className="text-13 font-medium text-ink-primary">{tech}</div>
                        <span className="u-nums text-12 font-medium text-zinc-900">
                          {count}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 bg-zinc-100 rounded-sm overflow-hidden">
                        <div
                          className="h-full bg-zinc-900 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

export default { ViewModeSelectorV2, WeekViewV2, MonthViewV2 };
