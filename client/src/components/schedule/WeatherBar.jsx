import { useState, useEffect } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#fff' };

export default function WeatherBar({ date }) {
  const [weather, setWeather] = useState(null);

  useEffect(() => {
    if (!date) return;
    const token = localStorage.getItem('adminToken');
    fetch(`${API}/admin/dashboard-ops/weather?date=${date}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => data && setWeather(data))
      .catch(() => {});
  }, [date]);

  if (!weather) return null;

  const items = [
    { icon: '\u2600\ufe0f', label: `${Math.round(weather.temp)}\u00b0F` },
    { icon: '\ud83d\udca7', label: `${weather.humidity ?? '--'}%` },
    { icon: '\ud83c\udf2c\ufe0f', label: `${weather.windSpeed ?? '--'} mph` },
    { icon: '\ud83c\udf27\ufe0f', label: `${weather.rainfall ?? 0}"` },
  ];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '8px 16px',
      background: D.bg, borderRadius: 8, border: `1px solid ${D.border}`, flexWrap: 'wrap',
    }}>
      {items.map((item, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: D.text }}>
          <span>{item.icon}</span>
          <span>{item.label}</span>
        </span>
      ))}

      {weather.alerts && weather.alerts.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {weather.alerts.map((alert, i) => (
            <span key={i} style={{
              padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
              background: alert.level === 'red' ? D.red : D.amber,
              color: D.white,
            }}>
              {alert.text}
            </span>
          ))}
        </div>
      )}

      {weather.source === 'seasonal-average' && (
        <span style={{ fontSize: 11, color: D.muted, marginLeft: 'auto' }}>
          Seasonal avg
        </span>
      )}
    </div>
  );
}
