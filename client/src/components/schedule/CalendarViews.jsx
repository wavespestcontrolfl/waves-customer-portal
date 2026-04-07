/**
 * CalendarViews.jsx
 * client/src/components/schedule/CalendarViews.jsx
 *
 * Three calendar views for the Schedule & Dispatch board:
 * - Day view (existing board — enhanced with timeline)
 * - Week view (7-day grid with service cards)
 * - Month view (full calendar with service counts + category dots)
 *
 * Props:
 *   viewMode: 'day' | 'week' | 'month'
 *   date: 'YYYY-MM-DD' (current selected date)
 *   onDateChange: (newDate: string) => void
 *   onViewModeChange: (mode: string) => void
 *   onServiceClick: (service) => void — opens the service detail / day view
 */

import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155', input: '#0f172a',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444',
  blue: '#3b82f6', purple: '#a855f7', gray: '#64748b',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
};

const CATEGORY_COLORS = {
  pest: '#0ea5e9', lawn: '#10b981', mosquito: '#a855f7',
  termite: '#f59e0b', tree_shrub: '#22c55e', rodent: '#ef4444',
  callback: '#64748b', general: '#94a3b8',
};

const CATEGORY_ICONS = {
  pest: '🐜', lawn: '🌿', mosquito: '🦟', termite: '🪵',
  tree_shrub: '🌳', rodent: '🐀', callback: '🔄', general: '🔧',
};

const MONO = "'JetBrains Mono', monospace";

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function formatDateISO(d) { return d.toISOString().split('T')[0]; }

// ─── VIEW MODE SELECTOR ──────────────────────────────────────────

export function ViewModeSelector({ viewMode, onViewModeChange }) {
  const modes = [
    { id: 'day', label: 'Day', icon: '📋' },
    { id: 'week', label: 'Week', icon: '📅' },
    { id: 'month', label: 'Month', icon: '🗓️' },
  ];

  return (
    <div style={{
      display: 'inline-flex', background: D.card, borderRadius: 10,
      border: `1px solid ${D.border}`, overflow: 'hidden',
    }}>
      {modes.map(m => (
        <button
          key={m.id}
          onClick={() => onViewModeChange(m.id)}
          style={{
            padding: '8px 16px', border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 600, transition: 'all 0.15s',
            background: viewMode === m.id ? D.teal : 'transparent',
            color: viewMode === m.id ? D.white : D.muted,
            display: 'flex', alignItems: 'center', gap: 5,
          }}
        >
          <span style={{ fontSize: 13 }}>{m.icon}</span> {m.label}
        </button>
      ))}
    </div>
  );
}


// ─── DATE NAVIGATION ─────────────────────────────────────────────

export function DateNavigator({ viewMode, date, onDateChange }) {
  const d = new Date(date + 'T12:00:00');
  const today = formatDateISO(new Date());

  function shift(direction) {
    const next = new Date(d);
    if (viewMode === 'day') next.setDate(next.getDate() + direction);
    else if (viewMode === 'week') next.setDate(next.getDate() + (direction * 7));
    else if (viewMode === 'month') next.setMonth(next.getMonth() + direction);
    onDateChange(formatDateISO(next));
  }

  // Format display based on view mode
  let displayText;
  if (viewMode === 'day') {
    displayText = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  } else if (viewMode === 'week') {
    const weekEnd = new Date(d);
    weekEnd.setDate(weekEnd.getDate() + 6);
    displayText = `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  } else {
    displayText = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button onClick={() => shift(-1)} style={navBtn} title="Previous">◀</button>
      <span style={{
        fontSize: 15, fontWeight: 700, color: D.text, minWidth: 220, textAlign: 'center',
        fontFamily: MONO,
      }}>
        {displayText}
      </span>
      <button onClick={() => shift(1)} style={navBtn} title="Next">▶</button>
      {date !== today && (
        <button onClick={() => onDateChange(today)} style={{
          ...navBtn, fontSize: 11, padding: '5px 12px', width: 'auto', fontWeight: 600,
        }}>Today</button>
      )}
    </div>
  );
}


// ─── WEEK VIEW ───────────────────────────────────────────────────

export function WeekView({ startDate, onDateClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    // Get Monday of the week containing startDate
    const d = new Date(startDate + 'T12:00:00');
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const mondayStr = formatDateISO(monday);

    adminFetch(`/admin/schedule/week?start=${mondayStr}`)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [startDate]);

  if (loading) return <div style={{ color: D.muted, textAlign: 'center', padding: 40 }}>Loading week...</div>;
  if (!data?.days) return null;

  const today = formatDateISO(new Date());
  const maxCount = Math.max(1, ...data.days.map(d => d.count));

  return (
    <div>
      {/* Week grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8,
        marginBottom: 16,
      }}>
        {data.days.map(day => {
          const isToday = day.date === today;
          const isSelected = day.date === startDate;
          const isWeekend = new Date(day.date + 'T12:00:00').getDay() % 6 === 0;

          return (
            <div
              key={day.date}
              onClick={() => onDateClick(day.date)}
              style={{
                background: isToday ? D.teal + '15' : D.card,
                border: `1.5px solid ${isToday ? D.teal : isSelected ? D.blue : D.border}`,
                borderRadius: 12, padding: 14, cursor: 'pointer',
                transition: 'all 0.15s', minHeight: 140,
                opacity: isWeekend && day.count === 0 ? 0.5 : 1,
              }}
            >
              {/* Day header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: D.muted, letterSpacing: 0.8 }}>
                    {day.dayOfWeek}
                  </div>
                  <div style={{
                    fontSize: 22, fontWeight: 800, fontFamily: MONO,
                    color: isToday ? D.teal : D.white,
                  }}>
                    {day.dayNum}
                  </div>
                </div>
                {day.count > 0 && (
                  <div style={{
                    fontSize: 13, fontWeight: 800, fontFamily: MONO,
                    color: D.teal, background: D.teal + '18', padding: '4px 10px',
                    borderRadius: 8,
                  }}>
                    {day.count}
                  </div>
                )}
              </div>

              {/* Service list (compact) */}
              {day.services.slice(0, 5).map(s => (
                <div key={s.id} style={{
                  fontSize: 11, padding: '4px 6px', marginBottom: 3, borderRadius: 6,
                  background: (CATEGORY_COLORS[s.serviceCategory] || D.blue) + '15',
                  borderLeft: `2px solid ${CATEGORY_COLORS[s.serviceCategory] || D.blue}`,
                  color: D.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  textDecoration: s.status === 'completed' ? 'line-through' : 'none',
                  opacity: s.status === 'completed' ? 0.6 : 1,
                }}>
                  {CATEGORY_ICONS[s.serviceCategory] || '🔧'} {s.customerName?.split(' ')[0]}
                </div>
              ))}
              {day.count > 5 && (
                <div style={{ fontSize: 10, color: D.muted, textAlign: 'center', marginTop: 4 }}>
                  +{day.count - 5} more
                </div>
              )}

              {/* Zone dots */}
              {Object.keys(day.zones || {}).length > 0 && (
                <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                  {Object.entries(day.zones).map(([zone, count]) => (
                    <span key={zone} style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: D.teal, display: 'inline-block',
                      opacity: 0.5 + (count / maxCount) * 0.5,
                    }} title={`${zone}: ${count}`} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Week summary bar */}
      <div style={{
        display: 'flex', gap: 16, justifyContent: 'center', padding: '12px 20px',
        background: D.card, borderRadius: 10, border: `1px solid ${D.border}`,
        fontSize: 12, color: D.muted,
      }}>
        <span><strong style={{ color: D.white, fontFamily: MONO }}>{data.days.reduce((sum, d) => sum + d.count, 0)}</strong> services this week</span>
        <span><strong style={{ color: D.green, fontFamily: MONO }}>{data.days.reduce((sum, d) => sum + d.services.filter(s => s.status === 'completed').length, 0)}</strong> completed</span>
      </div>
    </div>
  );
}


// ─── MONTH VIEW ──────────────────────────────────────────────────

export function MonthView({ date, onDateClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const yearMonth = date.slice(0, 7); // "2026-04"

  useEffect(() => {
    setLoading(true);
    adminFetch(`/admin/schedule/month?month=${yearMonth}`)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [yearMonth]);

  if (loading) return <div style={{ color: D.muted, textAlign: 'center', padding: 40 }}>Loading calendar...</div>;
  if (!data?.weeks) return null;

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div>
      {/* Month summary stats */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap',
      }}>
        {[
          { label: 'Total Services', value: data.summary.totalServices, color: D.teal },
          { label: 'Completed', value: data.summary.completed, color: D.green },
          { label: 'Pending', value: data.summary.pending, color: D.amber },
          { label: 'Unique Customers', value: data.summary.uniqueCustomers, color: D.blue },
        ].map(stat => (
          <div key={stat.label} style={{
            flex: '1 1 120px', background: D.card, borderRadius: 10,
            border: `1px solid ${D.border}`, padding: '12px 16px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: MONO, color: stat.color }}>
              {stat.value}
            </div>
            <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 2 }}>
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Category breakdown */}
      {Object.keys(data.summary.byCategory || {}).length > 0 && (
        <div style={{
          display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap',
        }}>
          {Object.entries(data.summary.byCategory).sort(([,a],[,b]) => b - a).map(([cat, count]) => (
            <span key={cat} style={{
              fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 8,
              background: (CATEGORY_COLORS[cat] || D.gray) + '18',
              color: CATEGORY_COLORS[cat] || D.gray,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              {CATEGORY_ICONS[cat] || '🔧'} {cat}: {count}
            </span>
          ))}
        </div>
      )}

      {/* Calendar grid */}
      <div style={{
        background: D.card, borderRadius: 14, border: `1px solid ${D.border}`,
        overflow: 'hidden',
      }}>
        {/* Day of week headers */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
          borderBottom: `1px solid ${D.border}`,
        }}>
          {DOW.map(d => (
            <div key={d} style={{
              padding: '10px 0', textAlign: 'center', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: 1, color: D.muted,
            }}>{d}</div>
          ))}
        </div>

        {/* Weeks */}
        {data.weeks.map((week, wi) => (
          <div key={wi} style={{
            display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
            borderBottom: wi < data.weeks.length - 1 ? `1px solid ${D.border}22` : 'none',
          }}>
            {week.map(day => (
              <div
                key={day.date}
                onClick={() => onDateClick(day.date)}
                style={{
                  minHeight: 90, padding: '6px 8px', cursor: 'pointer',
                  borderRight: `1px solid ${D.border}22`,
                  background: day.isToday
                    ? D.teal + '0a'
                    : day.isWeekend
                      ? D.bg + '40'
                      : 'transparent',
                  opacity: day.isCurrentMonth ? 1 : 0.35,
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!day.isToday) e.currentTarget.style.background = D.card + '80'; }}
                onMouseLeave={e => { if (!day.isToday) e.currentTarget.style.background = day.isWeekend ? D.bg + '40' : 'transparent'; }}
              >
                {/* Day number */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{
                    fontSize: 13, fontWeight: day.isToday ? 800 : 600, fontFamily: MONO,
                    color: day.isToday ? D.teal : D.text,
                    ...(day.isToday ? {
                      background: D.teal + '22', borderRadius: '50%',
                      width: 26, height: 26, display: 'inline-flex',
                      alignItems: 'center', justifyContent: 'center',
                    } : {}),
                  }}>
                    {day.dayNum}
                  </span>
                  {day.count > 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, fontFamily: MONO,
                      color: D.teal,
                    }}>
                      {day.count}
                    </span>
                  )}
                </div>

                {/* Category dots — show what types of services are on this day */}
                {day.count > 0 && (
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 3 }}>
                    {Object.entries(day.categoryCounts || {}).map(([cat, count]) => (
                      <span key={cat} title={`${cat}: ${count}`} style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: CATEGORY_COLORS[cat] || D.gray,
                        display: 'inline-block',
                      }} />
                    ))}
                  </div>
                )}

                {/* Compact service list (first 3) */}
                {day.services.slice(0, 3).map(s => (
                  <div key={s.id} style={{
                    fontSize: 9, lineHeight: '14px', padding: '1px 4px', marginBottom: 1,
                    borderRadius: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    background: (CATEGORY_COLORS[s.serviceCategory] || D.blue) + '15',
                    color: s.status === 'completed' ? D.green : D.text,
                    borderLeft: `2px solid ${CATEGORY_COLORS[s.serviceCategory] || D.blue}`,
                  }}>
                    {s.customerName?.split(' ')[0]}
                  </div>
                ))}
                {day.count > 3 && (
                  <div style={{ fontSize: 9, color: D.muted, marginTop: 1 }}>
                    +{day.count - 3}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Tech workload for the month */}
      {Object.keys(data.summary.byTech || {}).length > 0 && (
        <div style={{
          marginTop: 16, background: D.card, borderRadius: 10,
          border: `1px solid ${D.border}`, padding: 16,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>
            Tech Workload — {data.monthName}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {Object.entries(data.summary.byTech).sort(([,a],[,b]) => b - a).map(([tech, count]) => {
              const pct = Math.round(count / data.summary.totalServices * 100);
              return (
                <div key={tech} style={{
                  flex: '1 1 150px', padding: '10px 14px',
                  background: D.bg, borderRadius: 8, border: `1px solid ${D.border}`,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: D.white }}>{tech}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <div style={{
                      flex: 1, height: 6, background: D.border, borderRadius: 3, overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${pct}%`, height: '100%', background: D.teal, borderRadius: 3,
                        transition: 'width 0.3s',
                      }} />
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, fontFamily: MONO, color: D.teal }}>
                      {count}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── STYLES ──────────────────────────────────────────────────────

const navBtn = {
  width: 34, height: 34, borderRadius: 8, border: `1px solid ${D.border}`,
  background: D.card, color: D.text, fontSize: 12, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  transition: 'all 0.15s',
};

export default { ViewModeSelector, DateNavigator, WeekView, MonthView };
