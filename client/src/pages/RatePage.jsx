import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const HIGHLIGHTS = [
  'On Time', 'Thorough', 'Professional', 'Friendly', 'Knowledgeable',
  'Great Communication', 'Clean Work', 'Fast Service', 'Fair Price', 'Above & Beyond',
];

const SERVICE_OPTIONS = [
  'Pest Control',
  'Lawn Care',
  'Mosquito',
  'Tree & Shrub',
];

const STANDOUT_OPTIONS = [
  'On time', 'Professional', 'Thorough', 'Friendly', 'Great results', 'Fair price',
];

export default function RatePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [score, setScore] = useState(null);
  const [screen, setScreen] = useState('rating'); // rating, highlights, ai-review, feedback, success, redirect
  const [highlights, setHighlights] = useState([]);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // AI Review Writer state
  const [selectedServices, setSelectedServices] = useState([]);
  const [selectedStandouts, setSelectedStandouts] = useState([]);
  const [personalNote, setPersonalNote] = useState('');
  const [generatedReview, setGeneratedReview] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const toggleService = (s) => {
    setSelectedServices(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  };

  const toggleStandout = (s) => {
    setSelectedStandouts(prev => {
      if (prev.includes(s)) return prev.filter(x => x !== s);
      if (prev.length >= 3) return prev; // max 3
      return [...prev, s];
    });
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

  // Submit score, then go to AI review step
  const handleHighlightsNext = async () => {
    setSubmitting(true);
    try {
      await fetch(`${API_BASE}/rate/${token}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, feedback: '', highlights }),
      });
    } catch { /* proceed anyway */ }
    setSubmitting(false);
    // Pre-select service type from data if available
    if (data?.serviceType) {
      const match = SERVICE_OPTIONS.find(s => data.serviceType.toLowerCase().includes(s.toLowerCase()));
      if (match && !selectedServices.includes(match)) {
        setSelectedServices([match]);
      }
    }
    setScreen('ai-review');
  };

  const handleGenerateReview = async () => {
    setGenerating(true);
    setGeneratedReview('');
    try {
      const r = await fetch(`${API_BASE}/rate/${token}/generate-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          services: selectedServices,
          highlights: selectedStandouts,
          personalNote,
        }),
      });
      const result = await r.json();
      setGeneratedReview(result.review || '');
    } catch {
      setGeneratedReview('Great experience with Waves Pest Control. Professional service and thorough treatment. Would recommend to anyone in Southwest Florida.');
    }
    setGenerating(false);
  };

  const handleCopyReview = () => {
    navigator.clipboard.writeText(generatedReview).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const handleGoToGoogle = () => {
    if (data?.googleReviewUrl) {
      window.location.href = data.googleReviewUrl;
    }
  };

  const handleSkipToGoogle = () => {
    if (data?.googleReviewUrl) {
      window.location.href = data.googleReviewUrl;
    } else {
      setScreen('success');
    }
  };

  const firstName = data?.firstName || 'there';
  const techName = data?.techName || 'your technician';

  if (loading) return (
    <Page>
      <div style={{ textAlign: 'center', padding: 48 }}>
        <div style={{ width: 32, height: 32, border: '3px solid #CBD5E1', borderTopColor: '#009CDE', borderRadius: '50%', animation: 'spin .7s linear infinite', margin: '0 auto 14px' }} />
        <span style={{ fontSize: 14, color: '#64748B' }}>Loading...</span>
      </div>
    </Page>
  );

  if (error) return (
    <Page>
      <div style={{ textAlign: 'center', padding: 36, color: '#334155', fontSize: 15, lineHeight: 1.5 }}>
        <p>This link may have expired or already been used.</p>
        <p style={{ marginTop: 12 }}><a href="https://wavespestcontrol.com" style={{ color: '#C8102E', fontWeight: 800, textDecoration: 'none' }}>Visit wavespestcontrol.com</a></p>
      </div>
    </Page>
  );

  return (
    <Page>
      {/* Rating Screen */}
      {screen === 'rating' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 22 }}>
            <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'linear-gradient(135deg, #4DC9F6, #009CDE)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 800, color: '#fff', fontFamily: "'Anton', 'Luckiest Guy', cursive", boxShadow: '0 4px 20px rgba(0,156,222,0.35)' }}>
              {(techName || 'W')[0].toUpperCase()}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#1B2C5B' }}>{techName}</div>
          </div>

          <div style={{ fontFamily: "'Anton', 'Luckiest Guy', cursive", fontSize: 22, fontWeight: 700, textAlign: 'center', color: '#1B2C5B', marginBottom: 22, lineHeight: 1.3 }}>
            Hey {firstName}, how'd we do?
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, padding: '0 2px' }}>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748B' }}>Not Great</span>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748B' }}>Amazing!</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {[1,2,3,4,5,6,7,8,9,10].map(n => {
              const selected = score === n;
              const bg = selected ? (n <= 3 ? '#C8102E' : n <= 7 ? '#F59E0B' : '#16A34A') : '#fff';
              return (
                <button key={n} onClick={() => handleScore(n)} style={{
                  minHeight: 44, minWidth: 44, border: `2px solid ${selected ? bg : '#CBD5E1'}`, borderRadius: 12,
                  background: bg, fontFamily: "'Anton', 'Luckiest Guy', cursive", fontSize: 18, fontWeight: 700,
                  color: selected ? '#fff' : '#334155', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', padding: 0,
                }}>{n}</button>
              );
            })}
          </div>
          <div style={{ textAlign: 'center', marginTop: 10, fontSize: 13, color: '#64748B', fontWeight: 600 }}>Tap a number to rate</div>
        </div>
      )}

      {/* Highlights Screen (8-10) */}
      {screen === 'highlights' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#DCFCE7', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
            <span role="img" aria-label="party">&#127881;</span>
          </div>
          <div style={{ fontFamily: "'Anton', 'Luckiest Guy', cursive", fontSize: 24, fontWeight: 800, color: '#1B2C5B', marginBottom: 8 }}>Awesome, thank you!</div>
          <div style={{ fontSize: 15, color: '#334155', lineHeight: 1.55, marginBottom: 16 }}>What stood out about your experience?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 16 }}>
            {HIGHLIGHTS.map(h => (
              <button key={h} onClick={() => toggleHighlight(h)} style={{
                padding: '10px 16px', minHeight: 44, border: `2px solid ${highlights.includes(h) ? '#009CDE' : '#CBD5E1'}`,
                borderRadius: 24, background: highlights.includes(h) ? '#009CDE' : '#fff',
                color: highlights.includes(h) ? '#fff' : '#334155', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>{h}</button>
            ))}
          </div>
          <button onClick={handleHighlightsNext} disabled={submitting} style={{
            display: 'inline-flex', alignItems: 'center', gap: 10, padding: '14px 28px',
            background: '#FFD700', color: '#1B2C5B', border: 'none', borderRadius: 9999,
            fontSize: 16, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
            fontFamily: "'Inter', system-ui, sans-serif",
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="#1B2C5B"/></svg>
            {submitting ? 'Sending...' : 'Leave a Google Review'}
          </button>
          <button onClick={() => { setScreen('success'); handleSubmit(); }} style={{ display: 'block', margin: '14px auto 0', fontSize: 13, color: '#64748B', background: 'none', border: 'none', cursor: 'pointer' }}>Skip for now</button>
        </div>
      )}

      {/* AI Review Writer Screen */}
      {screen === 'ai-review' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontFamily: "'Anton', 'Luckiest Guy', cursive", fontSize: 22, fontWeight: 800, color: '#1B2C5B', marginBottom: 6 }}>
              We'll write it for you!
            </div>
            <div style={{ fontSize: 14, color: '#334155', lineHeight: 1.5 }}>
              Answer a couple quick questions and we'll draft a Google review you can paste.
            </div>
          </div>

          {/* Service selection */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1B2C5B', marginBottom: 8 }}>What service did you receive?</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {SERVICE_OPTIONS.map(s => (
                <button key={s} onClick={() => toggleService(s)} style={{
                  padding: '9px 16px', border: `2px solid ${selectedServices.includes(s) ? '#009CDE' : '#CBD5E1'}`,
                  borderRadius: 20, background: selectedServices.includes(s) ? '#009CDE' : '#fff',
                  color: selectedServices.includes(s) ? '#fff' : '#334155', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                }}>{s}</button>
              ))}
            </div>
          </div>

          {/* Standout selection */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1B2C5B', marginBottom: 4 }}>What stood out?</div>
            <div style={{ fontSize: 11, color: '#64748B', marginBottom: 8 }}>Pick up to 3</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {STANDOUT_OPTIONS.map(s => (
                <button key={s} onClick={() => toggleStandout(s)} style={{
                  padding: '9px 16px', border: `2px solid ${selectedStandouts.includes(s) ? '#16A34A' : '#CBD5E1'}`,
                  borderRadius: 20, background: selectedStandouts.includes(s) ? '#16A34A' : '#fff',
                  color: selectedStandouts.includes(s) ? '#fff' : '#334155', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  opacity: (!selectedStandouts.includes(s) && selectedStandouts.length >= 3) ? 0.4 : 1,
                }}>{s}</button>
              ))}
            </div>
          </div>

          {/* Personal note */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1B2C5B', marginBottom: 8 }}>Anything specific you loved? <span style={{ fontWeight: 400, color: '#64748B' }}>(optional)</span></div>
            <input
              value={personalNote}
              onChange={e => setPersonalNote(e.target.value)}
              placeholder="e.g. No more ants in the kitchen!"
              maxLength={150}
              style={{
                width: '100%', padding: '12px 14px', border: '2px solid #CBD5E1', borderRadius: 12,
                fontSize: 14, color: '#1B2C5B', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Generate button */}
          {!generatedReview && (
            <button onClick={handleGenerateReview} disabled={generating || selectedServices.length === 0} style={{
              width: '100%', padding: 14, border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 800,
              color: '#fff', cursor: (generating || selectedServices.length === 0) ? 'default' : 'pointer',
              background: (generating || selectedServices.length === 0) ? '#94A3B8' : '#009CDE',
              opacity: selectedServices.length === 0 ? 0.5 : 1,
              transition: 'all 0.2s',
            }}>
              {generating ? 'Writing your review...' : 'AI Write My Review'}
            </button>
          )}

          {/* Generated review display */}
          {generatedReview && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1B2C5B', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Your Review</div>
              <div style={{
                background: '#E3F5FD', border: '2px solid #E3F5FD', borderRadius: 14, padding: 16,
                fontSize: 15, color: '#1B2C5B', lineHeight: 1.65, marginBottom: 14,
                position: 'relative',
              }}>
                <div style={{ position: 'absolute', top: -6, left: 16, background: '#E3F5FD', padding: '0 6px', fontSize: 10, color: '#065A8C', fontWeight: 700, letterSpacing: 0.5 }}>READY TO PASTE</div>
                {generatedReview}
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button onClick={handleCopyReview} style={{
                  flex: 1, padding: 14, border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 800,
                  color: '#fff', cursor: 'pointer',
                  background: copied ? '#16A34A' : '#009CDE',
                  transition: 'background 0.2s',
                }}>
                  {copied ? 'Copied!' : 'Copy to Clipboard'}
                </button>
              </div>

              <button onClick={handleGoToGoogle} style={{
                width: '100%', padding: 14, border: 'none', borderRadius: 9999, fontSize: 16, fontWeight: 800,
                color: '#1B2C5B', cursor: 'pointer', background: '#FFD700',
                boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
                fontFamily: "'Inter', system-ui, sans-serif",
              }}>
                Go to Google Reviews
              </button>

              <button onClick={handleGenerateReview} disabled={generating} style={{
                display: 'block', margin: '12px auto 0', fontSize: 13, color: '#009CDE', background: 'none',
                border: 'none', cursor: 'pointer', fontWeight: 600,
              }}>
                {generating ? 'Rewriting...' : 'Regenerate review'}
              </button>
            </div>
          )}

          {/* Skip link */}
          <button onClick={handleSkipToGoogle} style={{
            display: 'block', margin: '16px auto 0', fontSize: 13, color: '#64748B', background: 'none',
            border: 'none', cursor: 'pointer', textDecoration: 'underline',
          }}>
            Skip -- Write my own on Google
          </button>
        </div>
      )}

      {/* Feedback Screen (1-7) */}
      {screen === 'feedback' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: score <= 3 ? '#FEE2E2' : '#FEF7E0', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
            {score <= 3 ? '\uD83D\uDE14' : '\uD83E\uDD14'}
          </div>
          {score <= 3 && <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#FEE2E2', color: '#C8102E', fontSize: 13, fontWeight: 800, padding: '6px 14px', borderRadius: 20, marginBottom: 12 }}>We want to make this right</div>}
          <div style={{ fontFamily: "'Anton', 'Luckiest Guy', cursive", fontSize: 24, fontWeight: 800, color: '#1B2C5B', marginBottom: 8 }}>
            {score <= 3 ? "We're sorry to hear that." : "Thanks for the feedback."}
          </div>
          <div style={{ fontSize: 15, color: '#334155', lineHeight: 1.55, marginBottom: 16 }}>
            {score <= 3 ? "What went wrong? We'll personally follow up." : "What could we have done better?"}
          </div>
          <textarea value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Tell us what happened..." rows={4} style={{
            width: '100%', minHeight: 100, padding: 14, border: '2px solid #CBD5E1', borderRadius: 12,
            fontSize: 15, color: '#1B2C5B', resize: 'vertical', outline: 'none', boxSizing: 'border-box',
          }} />
          <button onClick={handleSubmit} disabled={submitting} style={{
            width: '100%', padding: 14, border: 'none', borderRadius: 9999, fontSize: 16, fontWeight: 800,
            color: '#1B2C5B', cursor: 'pointer', marginTop: 12,
            background: '#FFD700',
            fontFamily: "'Inter', system-ui, sans-serif",
          }}>{submitting ? 'Sending...' : 'Send Feedback'}</button>
        </div>
      )}

      {/* Redirect Screen (going to Google) */}
      {screen === 'redirect' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#DCFCE7', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
            <span role="img" aria-label="party">&#127881;</span>
          </div>
          <div style={{ fontFamily: "'Anton', 'Luckiest Guy', cursive", fontSize: 24, fontWeight: 800, color: '#1B2C5B', marginBottom: 8 }}>Taking you to Google...</div>
          <div style={{ fontSize: 15, color: '#334155' }}>Your review means the world to our small team!</div>
        </div>
      )}

      {/* Success Screen */}
      {screen === 'success' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#DCFCE7', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
            <span role="img" aria-label="check">&#9989;</span>
          </div>
          <div style={{ fontFamily: "'Anton', 'Luckiest Guy', cursive", fontSize: 24, fontWeight: 800, color: '#1B2C5B', marginBottom: 8 }}>Thank you!</div>
          <div style={{ fontSize: 15, color: '#334155', lineHeight: 1.55 }}>Your feedback helps us serve you better.</div>
        </div>
      )}
    </Page>
  );
}

function Page({ children }) {
  return (
    <div style={{ minHeight: '100dvh', background: '#009CDE', display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: "'Inter', system-ui, -apple-system, sans-serif", position: 'relative', overflow: 'hidden' }}>
      {/* Hero video — waves-hero-service.mp4 */}
      <video autoPlay muted loop playsInline preload="none" poster="/brand/waves-hero-service.webp"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.25, zIndex: 0, pointerEvents: 'none' }}
        aria-hidden="true">
        <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
      </video>
      <div style={{ position: 'relative', zIndex: 1, width: '100%', padding: '22px 20px 12px', textAlign: 'center' }}>
        <h1 style={{
          fontFamily: "'Anton', 'Luckiest Guy', cursive", fontWeight: 400,
          fontSize: 36, color: '#F1F5F9', letterSpacing: '0.03em', lineHeight: 1,
          margin: 0, textShadow: '2px 2px 0 #1B2C5B',
        }}>
          Waves <span style={{ color: '#FFD700' }}>Lawn & Pest</span>
        </h1>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,.85)', letterSpacing: 1, fontStyle: 'italic', marginTop: 6 }}>Wave Goodbye to Pests!</div>
      </div>
      <div style={{ position: 'relative', zIndex: 1, width: 'calc(100% - 24px)', maxWidth: 420, background: '#fff', borderRadius: 20, boxShadow: '0 12px 40px rgba(10,61,122,.25)', overflow: 'hidden', marginTop: 8 }}>
        <div style={{ height: 5, background: 'linear-gradient(90deg, #C8102E, #C8102E, #F59E0B, #FFD700)' }} />
        <div style={{ padding: '28px 22px 24px' }}>{children}</div>
      </div>
      <div style={{ position: 'relative', zIndex: 1, width: 'calc(100% - 24px)', maxWidth: 420, padding: '0 0 32px' }}>
        <BrandFooter variant="dark" />
      </div>
      {/* Anton / Montserrat / Inter load globally via client/index.html */}
    </div>
  );
}
