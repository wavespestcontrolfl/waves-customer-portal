import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', text: '#334155', muted: '#64748B', white: '#FFFFFF', input: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TYPE_COLORS = { blog: D.teal, social: D.purple, rss: D.green };
const TYPE_ICONS = { blog: '📝', social: '📲', rss: '📡' };

export default function ContentCalendar() {
  const [month, setMonth] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({ type: 'blog', title: '', date: '', time: '09:00', autoShare: true });
  const [toast, setToast] = useState('');

  const loadCalendar = useCallback(async () => {
    const start = new Date(month.year, month.month, 1).toISOString().split('T')[0];
    const end = new Date(month.year, month.month + 1, 0).toISOString().split('T')[0];
    try {
      const data = await adminFetch(`/admin/content/calendar?start=${start}&end=${end}`);
      setItems(data.items || []);
    } catch { setItems([]); }
    setLoading(false);
  }, [month]);

  useEffect(() => { loadCalendar(); }, [loadCalendar]);
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };

  const shiftMonth = (dir) => {
    setMonth(prev => {
      let m = prev.month + dir;
      let y = prev.year;
      if (m < 0) { m = 11; y--; }
      if (m > 11) { m = 0; y++; }
      return { year: y, month: m };
    });
  };

  // Build calendar grid
  const firstDay = new Date(month.year, month.month, 1).getDay();
  const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
  const weeks = [];
  let week = new Array(firstDay).fill(null);

  for (let d = 1; d <= daysInMonth; d++) {
    week.push(d);
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) { while (week.length < 7) week.push(null); weeks.push(week); }

  const getItemsForDay = (day) => {
    if (!day) return [];
    const dateStr = `${month.year}-${String(month.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return items.filter(i => (i.scheduledDate || i.date || '').startsWith(dateStr));
  };

  const today = new Date();
  const isToday = (day) => day && today.getFullYear() === month.year && today.getMonth() === month.month && today.getDate() === day;
  const monthName = new Date(month.year, month.month).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const handleSchedule = async () => {
    if (!scheduleForm.date) { showToast('Pick a date'); return; }
    const publishAt = `${scheduleForm.date}T${scheduleForm.time}:00`;
    try {
      if (scheduleForm.type === 'social') {
        await adminFetch('/admin/content/schedule-social', {
          method: 'POST', body: JSON.stringify({ title: scheduleForm.title, description: '', link: '', scheduledFor: publishAt }),
        });
      }
      showToast('Scheduled!');
      setShowSchedule(false);
      loadCalendar();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => shiftMonth(-1)} style={{ background: 'none', border: `1px solid ${D.border}`, borderRadius: 6, padding: '4px 10px', color: D.muted, cursor: 'pointer' }}>←</button>
          <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, minWidth: 200, textAlign: 'center' }}>{monthName}</div>
          <button onClick={() => shiftMonth(1)} style={{ background: 'none', border: `1px solid ${D.border}`, borderRadius: 6, padding: '4px 10px', color: D.muted, cursor: 'pointer' }}>→</button>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: D.muted }}>
          <span><span style={{ color: D.teal }}>●</span> Blog</span>
          <span><span style={{ color: D.purple }}>●</span> Social</span>
          <span><span style={{ color: D.green }}>●</span> RSS Auto</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{items.length} posts this month</span>
        </div>
      </div>

      {/* Calendar grid */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: 'hidden' }}>
        {/* Day headers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: `1px solid ${D.border}` }}>
          {DAYS.map(d => (
            <div key={d} style={{ padding: '8px 0', textAlign: 'center', fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1 }}>{d}</div>
          ))}
        </div>

        {/* Weeks */}
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: wi < weeks.length - 1 ? `1px solid ${D.border}22` : 'none' }}>
            {week.map((day, di) => {
              const dayItems = getItemsForDay(day);
              return (
                <div key={di} onClick={() => day && setSelectedDay(day === selectedDay ? null : day)} style={{
                  minHeight: 80, padding: 4, borderRight: di < 6 ? `1px solid ${D.border}11` : 'none',
                  background: isToday(day) ? `${D.teal}08` : day === selectedDay ? `${D.teal}05` : 'transparent',
                  cursor: day ? 'pointer' : 'default', transition: 'background .1s',
                }}>
                  {day && (
                    <>
                      <div style={{ fontSize: 12, fontWeight: isToday(day) ? 700 : 400, color: isToday(day) ? D.teal : D.muted, padding: '2px 4px' }}>{day}</div>
                      {dayItems.slice(0, 3).map((item, ii) => (
                        <div key={ii} style={{
                          fontSize: 9, padding: '2px 4px', marginBottom: 1, borderRadius: 3,
                          background: `${TYPE_COLORS[item.type] || D.muted}15`,
                          color: TYPE_COLORS[item.type] || D.muted,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {TYPE_ICONS[item.type] || '•'} {item.title?.substring(0, 25)}
                        </div>
                      ))}
                      {dayItems.length > 3 && <div style={{ fontSize: 9, color: D.muted, padding: '0 4px' }}>+{dayItems.length - 3} more</div>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Selected day detail */}
      {selectedDay && (
        <div style={{ marginTop: 12, background: D.card, border: `1px solid ${D.teal}`, borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>
            {new Date(month.year, month.month, selectedDay).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
          {getItemsForDay(selectedDay).length === 0 ? (
            <div style={{ fontSize: 13, color: D.muted }}>No content scheduled for this day</div>
          ) : getItemsForDay(selectedDay).map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${D.border}22`, fontSize: 13 }}>
              <span style={{ fontSize: 16 }}>{TYPE_ICONS[item.type]}</span>
              <div style={{ flex: 1 }}>
                <div style={{ color: D.heading, fontWeight: 500 }}>{item.title}</div>
                <div style={{ fontSize: 11, color: D.muted }}>{item.status} · {item.platforms?.join(', ') || item.type}</div>
              </div>
              <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: `${TYPE_COLORS[item.type]}22`, color: TYPE_COLORS[item.type] }}>{item.status}</span>
            </div>
          ))}
        </div>
      )}

      {/* Toast */}
      <div style={{ position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none' }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}
