import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const HIGHLIGHTS = [
  'On Time', 'Thorough', 'Professional', 'Friendly', 'Knowledgeable',
  'Great Communication', 'Clean Work', 'Fast Service', 'Fair Price', 'Above & Beyond',
];

export default function RatePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [score, setScore] = useState(null);
  const [screen, setScreen] = useState('rating'); // rating, highlights, feedback, success, redirect
  const [highlights, setHighlights] = useState([]);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/rate/${token}`)
      .then(r => { if (!r.ok) throw new Error('Invalid link'); return r.json(); })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  const handleScore = (s) => {
    setScore(s);
    if (s >= 8) setScreen('highlights');
    else if (s >= 4) setScreen('feedback');
    else setScreen('feedback');
  };

  const toggleHighlight = (h) => {
    setHighlights(prev => prev.includes(h) ? prev.filter(x => x !== h) : [...prev, h]);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/rate/${token}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, feedback, highlights }),
      });
      const result = await r.json();
      if (result.redirect) {
        setScreen('redirect');
        setTimeout(() => { window.location.href = result.redirect; }, 2000);
      } else {
        setScreen('success');
      }
    } catch { setScreen('success'); }
    setSubmitting(false);
  };

  const firstName = data?.firstName || 'there';
  const techName = data?.techName || 'your technician';

  if (loading) return (
    <Page>
      <div style={{ textAlign: 'center', padding: 48 }}>
        <div style={{ width: 32, height: 32, border: '3px solid #D8E4EE', borderTopColor: '#1E7FD9', borderRadius: '50%', animation: 'spin .7s linear infinite', margin: '0 auto 14px' }} />
        <span style={{ fontSize: 14, color: '#8FA4B8' }}>Loading...</span>
      </div>
    </Page>
  );

  if (error) return (
    <Page>
      <div style={{ textAlign: 'center', padding: 36, color: '#3A5068', fontSize: 15, lineHeight: 1.5 }}>
        <p>This link may have expired or already been used.</p>
        <p style={{ marginTop: 12 }}><a href="https://wavespestcontrol.com" style={{ color: '#E85D3A', fontWeight: 800, textDecoration: 'none' }}>Visit wavespestcontrol.com →</a></p>
      </div>
    </Page>
  );

  return (
    <Page>
      {/* Rating Screen */}
      {screen === 'rating' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 22 }}>
            <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'linear-gradient(135deg, #5BC0EB, #1E7FD9)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 800, color: '#fff', fontFamily: "'Baloo 2', cursive", boxShadow: '0 4px 20px rgba(30,127,217,.35)' }}>
              {(techName || 'W')[0].toUpperCase()}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0A3D7A' }}>{techName}</div>
          </div>

          <div style={{ fontFamily: "'Baloo 2', cursive", fontSize: 22, fontWeight: 700, textAlign: 'center', color: '#0A3D7A', marginBottom: 22, lineHeight: 1.3 }}>
            Hey {firstName}, how'd we do?
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, padding: '0 2px' }}>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: '#8FA4B8' }}>Not Great</span>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: '#8FA4B8' }}>Amazing!</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 5 }}>
            {[1,2,3,4,5,6,7,8,9,10].map(n => {
              const selected = score === n;
              const bg = selected ? (n <= 3 ? '#E53935' : n <= 7 ? '#F5A623' : '#00C853') : '#fff';
              return (
                <button key={n} onClick={() => handleScore(n)} style={{
                  aspectRatio: '1', border: `2px solid ${selected ? bg : '#D8E4EE'}`, borderRadius: 12,
                  background: bg, fontFamily: "'Baloo 2', cursive", fontSize: 18, fontWeight: 700,
                  color: selected ? '#fff' : '#3A5068', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}>{n}</button>
              );
            })}
          </div>
          <div style={{ textAlign: 'center', marginTop: 10, fontSize: 13, color: '#8FA4B8', fontWeight: 600 }}>Tap a number to rate</div>
        </div>
      )}

      {/* Highlights Screen (8-10) */}
      {screen === 'highlights' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#E8F5E9', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🎉</div>
          <div style={{ fontFamily: "'Baloo 2', cursive", fontSize: 24, fontWeight: 800, color: '#0A3D7A', marginBottom: 8 }}>Awesome, thank you!</div>
          <div style={{ fontSize: 15, color: '#3A5068', lineHeight: 1.55, marginBottom: 16 }}>What stood out about your experience?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 16 }}>
            {HIGHLIGHTS.map(h => (
              <button key={h} onClick={() => toggleHighlight(h)} style={{
                padding: '8px 16px', border: `2px solid ${highlights.includes(h) ? '#1E7FD9' : '#D8E4EE'}`,
                borderRadius: 24, background: highlights.includes(h) ? '#1E7FD9' : '#fff',
                color: highlights.includes(h) ? '#fff' : '#3A5068', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>{h}</button>
            ))}
          </div>
          <button onClick={handleSubmit} disabled={submitting} style={{
            display: 'inline-flex', alignItems: 'center', gap: 10, padding: '14px 28px',
            background: '#E85D3A', color: '#fff', border: 'none', borderRadius: 12,
            fontSize: 16, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 14px rgba(232,93,58,.35)',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="white"/></svg>
            {submitting ? 'Sending...' : 'Leave a Google Review'}
          </button>
          <button onClick={() => { setScreen('success'); handleSubmit(); }} style={{ display: 'block', margin: '14px auto 0', fontSize: 13, color: '#8FA4B8', background: 'none', border: 'none', cursor: 'pointer' }}>Skip for now</button>
        </div>
      )}

      {/* Feedback Screen (1-7) */}
      {screen === 'feedback' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: score <= 3 ? '#FFEBEE' : '#FFF8E1', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
            {score <= 3 ? '😔' : '🤔'}
          </div>
          {score <= 3 && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#FFEBEE', color: '#E53935', fontSize: 13, fontWeight: 800, padding: '6px 14px', borderRadius: 20, marginBottom: 12 }}>⚡ We want to make this right</div>}
          <div style={{ fontFamily: "'Baloo 2', cursive", fontSize: 24, fontWeight: 800, color: '#0A3D7A', marginBottom: 8 }}>
            {score <= 3 ? "We're sorry to hear that." : "Thanks for the feedback."}
          </div>
          <div style={{ fontSize: 15, color: '#3A5068', lineHeight: 1.55, marginBottom: 16 }}>
            {score <= 3 ? "What went wrong? We'll personally follow up." : "What could we have done better?"}
          </div>
          <textarea value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Tell us what happened..." rows={4} style={{
            width: '100%', minHeight: 100, padding: 14, border: '2px solid #D8E4EE', borderRadius: 12,
            fontSize: 15, color: '#0A3D7A', resize: 'vertical', outline: 'none', boxSizing: 'border-box',
          }} />
          <button onClick={handleSubmit} disabled={submitting} style={{
            width: '100%', padding: 14, border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 800,
            color: '#fff', cursor: 'pointer', marginTop: 12,
            background: score <= 3 ? '#E53935' : '#E85D3A',
          }}>{submitting ? 'Sending...' : 'Send Feedback'}</button>
        </div>
      )}

      {/* Redirect Screen (going to Google) */}
      {screen === 'redirect' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#E8F5E9', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>🎉</div>
          <div style={{ fontFamily: "'Baloo 2', cursive", fontSize: 24, fontWeight: 800, color: '#0A3D7A', marginBottom: 8 }}>Taking you to Google...</div>
          <div style={{ fontSize: 15, color: '#3A5068' }}>Your review means the world to our small team!</div>
        </div>
      )}

      {/* Success Screen */}
      {screen === 'success' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#E8F5E9', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>✅</div>
          <div style={{ fontFamily: "'Baloo 2', cursive", fontSize: 24, fontWeight: 800, color: '#0A3D7A', marginBottom: 8 }}>Thank you!</div>
          <div style={{ fontSize: 15, color: '#3A5068', lineHeight: 1.55 }}>Your feedback helps us serve you better.</div>
        </div>
      )}
    </Page>
  );
}

function Page({ children }) {
  return (
    <div style={{ minHeight: '100dvh', background: '#1E7FD9', display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: "'Nunito', -apple-system, sans-serif" }}>
      <div style={{ width: '100%', padding: '22px 20px 12px', textAlign: 'center' }}>
        <div style={{ fontFamily: "'Baloo 2', cursive", fontSize: 26, fontWeight: 800, color: '#F0F4F8', textTransform: 'uppercase', letterSpacing: 1.5, textShadow: '2px 2px 0 #0A3D7A' }}>
          Waves <span style={{ color: '#F06A42' }}>Lawn & Pest</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,.75)', letterSpacing: 1, fontStyle: 'italic', marginTop: 4 }}>Wave Goodbye to Pests!</div>
      </div>
      <div style={{ width: 'calc(100% - 24px)', maxWidth: 420, background: '#fff', borderRadius: 20, boxShadow: '0 12px 40px rgba(10,61,122,.25)', overflow: 'hidden', marginTop: 8 }}>
        <div style={{ height: 5, background: 'linear-gradient(90deg, #E53935, #E85D3A, #F5A623, #FDB935)' }} />
        <div style={{ padding: '28px 22px 24px' }}>{children}</div>
      </div>
      <div style={{ textAlign: 'center', padding: '20px 16px 32px' }}>
        <div style={{ fontFamily: "'Baloo 2', cursive", fontSize: 15, fontWeight: 800, color: 'rgba(255,255,255,.85)' }}>Waves <span style={{ color: '#F06A42' }}>Pest Control</span></div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', marginTop: 2, fontWeight: 600 }}>Serving Southwest Florida</div>
      </div>
      <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />
    </div>
  );
}
