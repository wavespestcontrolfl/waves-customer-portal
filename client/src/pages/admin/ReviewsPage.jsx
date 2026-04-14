import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReviewVelocityEngine from './ReviewVelocityEngine';
import GBPManagementPanel from './GBPManagement';
import SEOIntelligenceBar from '../../components/admin/SEOIntelligenceBar';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };
const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  return `${months} months ago`;
}

function Stars({ count, size = 16 }) {
  return (
    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: size, letterSpacing: 1 }}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ color: i < count ? D.amber : '#334155' }}>★</span>
      ))}
    </span>
  );
}

// --- Stat Card ---
function StatCard({ label, value, sub, color, highlight }) {
  return (
    <div style={{
      background: D.card, border: `1px solid ${highlight ? color : D.border}`, borderRadius: 12,
      padding: isMobile ? '14px 12px' : '20px 24px', flex: isMobile ? '1 1 calc(50% - 6px)' : '1 1 0', minWidth: isMobile ? 0 : 180,
    }}>
      <div style={{ color: D.muted, fontSize: 12, fontFamily: 'DM Sans, sans-serif', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 28, fontWeight: 700, color: color || D.white }}>{value}</div>
      {sub && <div style={{ color: D.muted, fontSize: 13, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// --- Star Breakdown Bar ---
function BreakdownBar({ star, count, max }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.muted, width: 16, textAlign: 'right' }}>{star}</span>
      <span style={{ color: D.amber, fontSize: 12 }}>★</span>
      <div style={{ flex: 1, height: 8, background: '#0f1923', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: D.amber, borderRadius: 4, transition: 'width 0.3s ease' }} />
      </div>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.muted, width: 24, textAlign: 'right' }}>{count}</span>
    </div>
  );
}

// --- Location Card ---
function LocationCard({ loc, breakdown, onRequestReview }) {
  const maxCount = breakdown ? Math.max(...Object.values(breakdown), 1) : 1;
  return (
    <div style={{
      background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: isMobile ? 14 : 20, flex: isMobile ? '1 1 100%' : '1 1 220px', minWidth: isMobile ? 0 : 220,
    }}>
      <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 4 }}>{loc.name}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 20, fontWeight: 700, color: D.white }}>{loc.avgRating}</span>
        <Stars count={Math.round(Number(loc.avgRating))} size={14} />
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: D.muted }}>({loc.count})</span>
      </div>
      <div style={{ marginBottom: 16 }}>
        {[5, 4, 3, 2, 1].map(s => (
          <BreakdownBar key={s} star={s} count={breakdown?.[String(s)] || 0} max={maxCount} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onRequestReview(loc)} style={{
          flex: 1, padding: '8px 12px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
          fontSize: 13, fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: 'pointer',
        }}>Request Review</button>
        {loc.reviewUrl && (
          <a href={loc.reviewUrl} target="_blank" rel="noopener noreferrer" style={{
            padding: '8px 12px', border: `1px solid ${D.border}`, color: D.muted, borderRadius: 8,
            fontSize: 13, fontFamily: 'DM Sans, sans-serif', textDecoration: 'none', display: 'flex', alignItems: 'center',
          }}>Google ↗</a>
        )}
      </div>
    </div>
  );
}

// --- Review Card ---
function ReviewCard({ review, onReplySubmit }) {
  const [editing, setEditing] = useState(false);
  const [replyText, setReplyText] = useState(review.reply || '');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const handleSubmit = async () => {
    if (!replyText.trim()) return;
    setSubmitting(true);
    try {
      await onReplySubmit(review.id, replyText.trim());
      setEditing(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      alert('Failed to post reply: ' + e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAiReply = async () => {
    setAiLoading(true);
    try {
      const data = await adminFetch(`/admin/reviews/${review.id}/ai-reply`, { method: 'POST' });
      if (data.reply) {
        setReplyText(data.reply);
        setEditing(true);
      }
    } catch (e) {
      alert('AI reply failed: ' + e.message);
    } finally {
      setAiLoading(false);
    }
  };

  const LOCATION_LABELS = {
    'lakewood-ranch': 'Lakewood Ranch',
    'parrish': 'Parrish',
    'sarasota': 'Sarasota',
    'venice': 'Venice',
  };

  return (
    <div style={{
      background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {review.reviewerPhoto ? (
            <img src={review.reviewerPhoto} alt="" style={{ width: 36, height: 36, borderRadius: '50%' }} />
          ) : (
            <div style={{
              width: 36, height: 36, borderRadius: '50%', background: '#334155',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, fontWeight: 600, color: D.muted,
            }}>{(review.reviewerName || '?')[0]}</div>
          )}
          <div>
            <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 15, fontWeight: 600, color: D.white }}>{review.reviewerName}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <Stars count={review.starRating} size={14} />
              <span style={{
                fontSize: 11, fontFamily: 'DM Sans, sans-serif', background: '#334155', color: D.muted,
                padding: '2px 8px', borderRadius: 99,
              }}>{LOCATION_LABELS[review.locationId] || review.locationId}</span>
            </div>
          </div>
        </div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.muted }}>{timeAgo(review.reviewCreatedAt)}</div>
      </div>

      {/* Review text */}
      {review.reviewText && (
        <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 14, color: D.text, lineHeight: 1.6, margin: '12px 0' }}>
          {review.reviewText}
        </div>
      )}

      {/* Matched customer */}
      {review.matchedCustomer && (
        <div style={{ fontSize: 13, fontFamily: 'DM Sans, sans-serif', color: D.teal, marginBottom: 12 }}>
          Matched: {review.matchedCustomer.name} — {review.matchedCustomer.tier}
        </div>
      )}

      {/* Reply section */}
      <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12, marginTop: 8 }}>
        {success && (
          <div style={{ color: D.green, fontSize: 13, fontFamily: 'DM Sans, sans-serif', marginBottom: 8 }}>
            Reply posted successfully
          </div>
        )}

        {review.reply && !editing ? (
          <div>
            <div style={{ fontSize: 12, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginBottom: 4 }}>
              Your reply {review.replyUpdatedAt && <span>· {timeAgo(review.replyUpdatedAt)}</span>}
            </div>
            <div style={{ fontSize: 14, color: D.text, fontFamily: 'DM Sans, sans-serif', lineHeight: 1.5, marginBottom: 8 }}>
              {review.reply}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setEditing(true); setReplyText(review.reply); }} style={{
                padding: '6px 14px', background: 'transparent', border: `1px solid ${D.border}`, color: D.muted,
                borderRadius: 6, fontSize: 13, fontFamily: 'DM Sans, sans-serif', cursor: 'pointer', minHeight: 44,
              }}>Edit</button>
              <button onClick={handleAiReply} disabled={aiLoading} style={{
                padding: '6px 14px', background: 'transparent', border: `1px solid ${D.teal}`, color: D.teal,
                borderRadius: 6, fontSize: 13, fontFamily: 'DM Sans, sans-serif', cursor: 'pointer', opacity: aiLoading ? 0.5 : 1,
              }}>{aiLoading ? 'Generating...' : 'AI Reply'}</button>
            </div>
          </div>
        ) : editing || !review.reply ? (
          <div>
            <textarea
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              placeholder="Write your reply..."
              rows={3}
              style={{
                width: '100%', padding: 12, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
                color: D.text, fontSize: 14, fontFamily: 'DM Sans, sans-serif', resize: 'vertical',
                outline: 'none', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button onClick={handleSubmit} disabled={submitting || !replyText.trim()} style={{
                padding: '8px 18px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
                fontSize: 13, fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: submitting ? 'not-allowed' : 'pointer',
                opacity: submitting || !replyText.trim() ? 0.5 : 1,
              }}>{submitting ? 'Posting...' : review.reply ? 'Update Reply' : 'Reply'}</button>
              <button onClick={handleAiReply} disabled={aiLoading} style={{
                padding: '8px 18px', background: 'transparent', border: `1px solid ${D.teal}`, color: D.teal, borderRadius: 8,
                fontSize: 13, fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: 'pointer', opacity: aiLoading ? 0.5 : 1,
              }}>{aiLoading ? 'Generating...' : 'AI Reply'}</button>
              {replyText.trim() && (
                <button onClick={() => { navigator.clipboard.writeText(replyText); }} style={{
                  padding: '8px 18px', background: 'transparent', border: `1px solid ${D.border}`, color: D.muted, borderRadius: 8,
                  fontSize: 13, fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: 'pointer',
                }}>Copy</button>
              )}
              {editing && (
                <button onClick={() => { setEditing(false); setReplyText(review.reply || ''); }} style={{
                  padding: '8px 14px', background: 'transparent', border: `1px solid ${D.border}`, color: D.muted,
                  borderRadius: 8, fontSize: 13, fontFamily: 'DM Sans, sans-serif', cursor: 'pointer',
                }}>Cancel</button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- Select input ---
function Select({ value, onChange, options, style: extraStyle }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{
      padding: '8px 12px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8,
      color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', cursor: 'pointer',
      ...extraStyle,
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// =============================================================================
// =============================================================================
// GBP MANAGEMENT
// =============================================================================
function GBPManagement() {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedLoc, setSelectedLoc] = useState(null);
  const [locTab, setLocTab] = useState('info');

  useEffect(() => {
    adminFetch('/admin/reviews/gbp-locations')
      .then(d => {
        setLocations(d.locations || []);
        if (d.locations?.length > 0) setSelectedLoc(d.locations[0]);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleExport = () => {
    const token = localStorage.getItem('waves_admin_token');
    const url = `${window.location.origin}/api/admin/reviews/export`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'waves-reviews-export.csv';
        a.click();
      });
  };

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center' }}>Loading GBP data from Google...</div>;

  const loc = selectedLoc;

  return (
    <div>
      {/* Location selector */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {locations.map(l => (
          <button key={l.id} onClick={() => { setSelectedLoc(l); setLocTab('info'); }} style={{
            padding: '12px 20px', borderRadius: 10, border: `1px solid ${selectedLoc?.id === l.id ? D.teal : D.border}`,
            background: selectedLoc?.id === l.id ? `${D.teal}15` : D.card, cursor: 'pointer',
            display: 'flex', flexDirection: 'column', gap: 4, minWidth: isMobile ? 0 : 180, flex: isMobile ? '1 1 100%' : undefined,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: selectedLoc?.id === l.id ? D.teal : D.white, fontFamily: 'DM Sans, sans-serif' }}>{l.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: D.amber, fontFamily: "'JetBrains Mono', monospace" }}>{l.rating}</span>
              <Stars count={Math.round(l.rating || 0)} size={12} />
              <span style={{ fontSize: 11, color: D.muted }}>({l.totalReviews})</span>
            </div>
            <div style={{ fontSize: 11, color: l.openNow ? D.green : D.red }}>{l.openNow ? 'Open now' : 'Closed'}</div>
          </button>
        ))}
      </div>

      {!loc ? (
        <div style={{ color: D.muted, padding: 40, textAlign: 'center', background: D.card, borderRadius: 12, border: `1px solid ${D.border}` }}>
          No location data available. Make sure Google Places API is enabled.
        </div>
      ) : (
        <>
          {/* Sub-tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
            {[
              { key: 'info', label: 'Location Info' },
              { key: 'hours', label: 'Hours' },
              { key: 'photos', label: 'Photos' },
              { key: 'export', label: 'Export Reviews' },
            ].map(t => (
              <button key={t.key} onClick={() => setLocTab(t.key)} style={{
                padding: isMobile ? '10px 14px' : '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
                background: locTab === t.key ? D.teal : 'transparent', color: locTab === t.key ? D.white : D.muted,
                transition: 'all 0.15s', fontFamily: 'DM Sans, sans-serif', whiteSpace: 'nowrap', minHeight: 44, flexShrink: 0,
              }}>{t.label}</button>
            ))}
          </div>

          {/* Location Info */}
          {locTab === 'info' && (
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
              <div style={{ background: D.card, borderRadius: 12, padding: isMobile ? 14 : 20, border: `1px solid ${D.border}` }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16, fontFamily: 'DM Sans, sans-serif' }}>Business Information</div>
                {[
                  { label: 'Business Name', value: loc.name },
                  { label: 'Address', value: loc.address },
                  { label: 'Phone', value: loc.phone },
                  { label: 'Website', value: loc.website, link: true },
                  { label: 'Status', value: loc.status === 'OPERATIONAL' ? 'Open' : loc.status },
                  { label: 'Categories', value: (loc.types || []).join(', ') },
                  { label: 'Place ID', value: loc.placeId },
                ].map((field, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 0', borderBottom: `1px solid ${D.border}33` }}>
                    <span style={{ fontSize: 12, color: D.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, minWidth: 120 }}>{field.label}</span>
                    {field.link ? (
                      <a href={field.value} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: D.teal, textDecoration: 'none', textAlign: 'right', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{field.value}</a>
                    ) : (
                      <span style={{ fontSize: 13, color: D.white, textAlign: 'right', maxWidth: 300 }}>{field.value || '--'}</span>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Rating Card */}
                <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}`, textAlign: 'center' }}>
                  <div style={{ fontSize: 48, fontWeight: 800, color: D.amber, fontFamily: "'JetBrains Mono', monospace" }}>{loc.rating}</div>
                  <Stars count={Math.round(loc.rating || 0)} size={20} />
                  <div style={{ fontSize: 14, color: D.muted, marginTop: 8 }}>{loc.totalReviews} reviews on Google</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'center' }}>
                    <a href={loc.mapsUrl} target="_blank" rel="noopener noreferrer" style={{
                      padding: '8px 16px', borderRadius: 8, background: D.teal, color: D.white, fontSize: 13, fontWeight: 600, textDecoration: 'none',
                    }}>View on Maps</a>
                    <a href={loc.reviewUrl} target="_blank" rel="noopener noreferrer" style={{
                      padding: '8px 16px', borderRadius: 8, border: `1px solid ${D.border}`, color: D.muted, fontSize: 13, textDecoration: 'none',
                    }}>Review Link</a>
                  </div>
                </div>

                {/* Quick Actions */}
                <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Quick Actions</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <a href={`https://business.google.com/dashboard/l/${loc.placeId}`} target="_blank" rel="noopener noreferrer" style={{
                      padding: '10px 14px', background: '#0f1923', borderRadius: 8, border: `1px solid ${D.border}`, color: D.text, fontSize: 13, textDecoration: 'none', display: 'block',
                    }}>Open Google Business Profile</a>
                    <a href={`https://business.google.com/posts/l/${loc.placeId}`} target="_blank" rel="noopener noreferrer" style={{
                      padding: '10px 14px', background: '#0f1923', borderRadius: 8, border: `1px solid ${D.border}`, color: D.text, fontSize: 13, textDecoration: 'none', display: 'block',
                    }}>Create Google Post</a>
                    <a href={`https://business.google.com/messaging/l/${loc.placeId}`} target="_blank" rel="noopener noreferrer" style={{
                      padding: '10px 14px', background: '#0f1923', borderRadius: 8, border: `1px solid ${D.border}`, color: D.text, fontSize: 13, textDecoration: 'none', display: 'block',
                    }}>View Messages</a>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Hours */}
          {locTab === 'hours' && (
            <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}`, maxWidth: 500 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Business Hours</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: loc.openNow ? D.green : D.red }} />
                <span style={{ fontSize: 14, color: loc.openNow ? D.green : D.red, fontWeight: 600 }}>{loc.openNow ? 'Currently Open' : 'Currently Closed'}</span>
              </div>
              {(loc.hours || []).length > 0 ? loc.hours.map((h, i) => {
                const isToday = i === (new Date().getDay() + 6) % 7;
                return (
                  <div key={i} style={{
                    padding: '10px 14px', borderRadius: 8, marginBottom: 4,
                    background: isToday ? `${D.teal}10` : 'transparent',
                    border: isToday ? `1px solid ${D.teal}33` : '1px solid transparent',
                    display: 'flex', justifyContent: 'space-between',
                  }}>
                    <span style={{ fontSize: 13, color: isToday ? D.teal : D.white, fontWeight: isToday ? 600 : 400 }}>{h}</span>
                  </div>
                );
              }) : (
                <div style={{ color: D.muted, fontSize: 13 }}>No hours data available</div>
              )}
              <div style={{ marginTop: 16, fontSize: 12, color: D.muted }}>
                To update hours, go to <a href={`https://business.google.com/dashboard/l/${loc.placeId}`} target="_blank" rel="noopener noreferrer" style={{ color: D.teal }}>Google Business Profile</a>
              </div>
            </div>
          )}

          {/* Photos */}
          {locTab === 'photos' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>{loc.name} Photos ({(loc.photos || []).length})</div>
                <a href={`https://business.google.com/photos/l/${loc.placeId}`} target="_blank" rel="noopener noreferrer" style={{
                  padding: '8px 16px', borderRadius: 8, border: `1px solid ${D.teal}`, color: D.teal, fontSize: 13, textDecoration: 'none',
                }}>Manage on Google</a>
              </div>
              {(loc.photos || []).length === 0 ? (
                <div style={{ color: D.muted, padding: 40, textAlign: 'center', background: D.card, borderRadius: 12, border: `1px solid ${D.border}` }}>No photos found</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                  {loc.photos.map((photo, i) => (
                    <div key={i} style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${D.border}`, background: D.card }}>
                      <img src={photo.url} alt={`${loc.name} photo ${i + 1}`} style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block' }} loading="lazy" />
                      <div style={{ padding: '8px 10px', fontSize: 11, color: D.muted }}>{photo.width}x{photo.height}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Export */}
          {locTab === 'export' && (
            <div style={{ background: D.card, borderRadius: 12, padding: 24, border: `1px solid ${D.border}`, maxWidth: 500 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 8 }}>Export Reviews</div>
              <div style={{ fontSize: 13, color: D.muted, marginBottom: 20 }}>Download all synced reviews across all locations as a CSV file.</div>
              <button onClick={handleExport} style={{
                padding: '12px 24px', borderRadius: 8, border: 'none', background: D.teal, color: D.white,
                fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
              }}>Download CSV</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// REVIEW OUTREACH HELPERS
// =============================================================================

// =============================================================================
// REVIEW OUTREACH — database-backed
// =============================================================================
function ReviewOutreach() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState({});

  useEffect(() => {
    // Fetch customers with recent completed services who haven't left a review
    adminFetch('/admin/reviews/outreach-candidates')
      .then(d => { setCustomers(d.customers || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = customers.filter(c => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (c.name || '').toLowerCase().includes(q) || (c.city || '').toLowerCase().includes(q) || (c.phone || '').toLowerCase().includes(q);
  });

  const sendReviewRequest = async (customer) => {
    setSending(prev => ({ ...prev, [customer.id]: true }));
    try {
      await adminFetch('/admin/reviews/send-request', {
        method: 'POST',
        body: JSON.stringify({ customerId: customer.id }),
      });
      setCustomers(prev => prev.map(c => c.id === customer.id ? { ...c, requestSent: true } : c));
    } catch (e) {
      alert('Failed: ' + e.message);
    } finally {
      setSending(prev => ({ ...prev, [customer.id]: false }));
    }
  };

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center' }}>Loading outreach candidates...</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatCard label="Outreach Candidates" value={customers.length} color={D.teal} />
        <StatCard label="Review Requests Sent" value={customers.filter(c => c.requestSent).length} color={D.green} />
      </div>

      <input
        type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search by name, city, or phone..."
        style={{ width: '100%', padding: '10px 14px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', boxSizing: 'border-box', marginBottom: 16 }}
      />

      {filtered.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: D.muted, background: D.card, borderRadius: 12, border: `1px solid ${D.border}` }}>
          <div style={{ fontSize: 15 }}>No outreach candidates found</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Customers with recent completed services who haven't been asked for a review will appear here.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {filtered.map(c => (
            <div key={c.id} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>{c.name}</div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                  {c.city && <span>{c.city} </span>}
                  {c.phone && <span>· {c.phone} </span>}
                  {c.lastService && <span>· Last service: {c.lastService} </span>}
                  {c.lastServiceDate && <span>· {new Date(c.lastServiceDate).toLocaleDateString()}</span>}
                </div>
                {c.tier && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: `${D.teal}22`, color: D.teal, marginTop: 4, display: 'inline-block' }}>{c.tier}</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {c.requestSent ? (
                  <span style={{ fontSize: 12, color: D.green, fontWeight: 600 }}>Sent</span>
                ) : (
                  <button onClick={() => sendReviewRequest(c)} disabled={sending[c.id]} style={{
                    padding: '8px 16px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
                    fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: sending[c.id] ? 0.5 : 1,
                  }}>{sending[c.id] ? 'Sending...' : 'Send Review Request'}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Legacy — removed Google Sheets dependency
function getReviewMessage(sentiment, firstName) {
  if (sentiment === 'happy') {
    return `Hey ${firstName}! This is Adam with Waves Pest Control \u{1F30A} Thanks for being a great customer \u2014 it means the world to our small family business.\n\nIf you have 30 seconds, a quick Google review would help us more than you know:\n\nhttps://g.page/r/CRkzS6M4EpncEBE/review\n\nThank you! \u{1F64F}`;
  }
  if (sentiment === 'issue') {
    return `Hi ${firstName}, this is Adam with Waves. I wanted to follow up and make sure everything's been taken care of. Your satisfaction is our top priority.\n\nPlease let me know if there's anything else we can do. \u2014 Waves \u{1F30A}`;
  }
  return `Hi ${firstName}! Adam here with Waves Pest Control \u{1F30A} Just checking in \u2014 hope everything's been great since our last visit.\n\nIf you've been happy with the service, a quick Google review would really help us out:\n\nhttps://g.page/r/CRkzS6M4EpncEBE/review\n\nThanks so much!`;
}

// (Old Google Sheets outreach was here — replaced by database version above)
function _PLACEHOLDER_REMOVED() {
  const [jobs, setJobs] = useState([]);
  const [smsRecords, setSmsRecords] = useState([]);
  const [callRecords, setCallRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [detailTab, setDetailTab] = useState('history');
  const [composeText, setComposeText] = useState('');
  const [localSms, setLocalSms] = useState([]);
  const [callModal, setCallModal] = useState(false);
  const smsEndRef = useRef(null);

  // Fetch all three sheets
  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(sheetURL('TECH KPIS')).then(r => r.text()),
      fetch(sheetURL('SMS RECORDINGS')).then(r => r.text()),
      fetch(sheetURL('CALL RECORDINGS')).then(r => r.text()),
    ]).then(([kpiText, smsText, callText]) => {
      const kpiRows = parseCSV(kpiText);
      const smsRows = parseCSV(smsText);
      const callRows = parseCSV(callText);

      // Parse jobs (skip header)
      const parsedJobs = kpiRows.slice(1).filter(r => r.length > 5 && r[KPI_COLS.CustName]?.trim()).map(r => ({
        date: r[KPI_COLS.Date]?.trim(),
        parsedDate: parseDate(r[KPI_COLS.Date]?.trim()),
        techName: r[KPI_COLS.TechName]?.trim(),
        svcType: r[KPI_COLS.SvcType]?.trim(),
        custName: r[KPI_COLS.CustName]?.trim(),
        custAddr: r[KPI_COLS.CustAddr]?.trim(),
        custEmail: r[KPI_COLS.CustEmail]?.trim(),
        apptStart: r[KPI_COLS.ApptStart]?.trim(),
        apptEnd: r[KPI_COLS.ApptEnd]?.trim(),
        laborHrs: r[KPI_COLS.LaborHrs]?.trim(),
        laborCost: r[KPI_COLS.LaborCost]?.trim(),
        matCost: r[KPI_COLS.MatCost]?.trim(),
        totalJobCost: r[KPI_COLS.TotalJobCost]?.trim(),
        revenue: r[KPI_COLS.Revenue]?.trim(),
        gp: r[KPI_COLS['GP$']]?.trim(),
        gpPct: r[KPI_COLS['GP%']]?.trim(),
        rpmh: r[KPI_COLS.RPMH]?.trim(),
        invoiceURL: r[KPI_COLS.InvoiceURL]?.trim(),
        svcPerformed: r[KPI_COLS.SvcPerformed]?.trim(),
        svcCallNotes: r[KPI_COLS.SvcCallNotes]?.trim(),
        custID: r[KPI_COLS.CustID]?.trim(),
        apptID: r[KPI_COLS.ApptID]?.trim(),
      }));

      // Parse SMS (header row then data)
      const smsHeader = smsRows[0] || [];
      const parsedSms = smsRows.slice(1).filter(r => r.length > 2).map(r => {
        const obj = {};
        smsHeader.forEach((h, i) => { obj[h.trim()] = (r[i] || '').trim(); });
        return obj;
      });

      // Parse calls (header row then data)
      const callHeader = callRows[0] || [];
      const parsedCalls = callRows.slice(1).filter(r => r.length > 2).map(r => {
        const obj = {};
        callHeader.forEach((h, i) => { obj[h.trim()] = (r[i] || '').trim(); });
        return obj;
      });

      setJobs(parsedJobs);
      setSmsRecords(parsedSms);
      setCallRecords(parsedCalls);
      setLoading(false);
    }).catch(e => {
      setError(e.message);
      setLoading(false);
    });
  }, []);

  // Group jobs by customer
  const customers = useMemo(() => {
    const map = {};
    jobs.forEach(j => {
      const key = j.custName;
      if (!key) return;
      if (!map[key]) {
        map[key] = { name: key, addr: j.custAddr, email: j.custEmail, jobs: [] };
      }
      map[key].jobs.push(j);
      if (j.custAddr && !map[key].addr) map[key].addr = j.custAddr;
      if (j.custEmail && !map[key].email) map[key].email = j.custEmail;
    });
    // Sort jobs within each customer by date desc
    Object.values(map).forEach(c => {
      c.jobs.sort((a, b) => (b.parsedDate || 0) - (a.parsedDate || 0));
      c.lastDate = c.jobs[0]?.parsedDate;
      c.lastSvcType = c.jobs[0]?.svcType;
      c.totalRevenue = c.jobs.reduce((s, j) => s + (parseFloat(j.revenue?.replace(/[$,]/g, '')) || 0), 0);
    });
    // Sort customers by most recent service
    return Object.values(map).sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));
  }, [jobs]);

  // Match SMS/calls to customer by name
  const getCustomerSms = useCallback((custName) => {
    const lower = custName.toLowerCase();
    return smsRecords.filter(s => {
      const name = (s.CustomerName || s.Name || s.Customer || '').toLowerCase();
      return name.includes(lower) || lower.includes(name);
    });
  }, [smsRecords]);

  const getCustomerCalls = useCallback((custName) => {
    const lower = custName.toLowerCase();
    return callRecords.filter(c => {
      const name = (c.CustomerName || c.Name || c.Customer || '').toLowerCase();
      return name.includes(lower) || lower.includes(name);
    });
  }, [callRecords]);

  // Customer SMS/call counts for sidebar cards
  const customerMeta = useMemo(() => {
    const meta = {};
    customers.forEach(c => {
      meta[c.name] = {
        smsCount: getCustomerSms(c.name).length,
        callCount: getCustomerCalls(c.name).length,
      };
    });
    return meta;
  }, [customers, getCustomerSms, getCustomerCalls]);

  // Search filtering
  const filteredCustomers = useMemo(() => {
    if (!searchQuery.trim()) return customers;
    const q = searchQuery.toLowerCase();
    return customers.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.addr || '').toLowerCase().includes(q) ||
      (c.lastSvcType || '').toLowerCase().includes(q)
    );
  }, [customers, searchQuery]);

  // Stats
  const totalJobs = jobs.length;
  const uniqueCustomers = customers.length;
  const totalRevenue = jobs.reduce((s, j) => s + (parseFloat(j.revenue?.replace(/[$,]/g, '')) || 0), 0);

  // Selected customer detail data
  const selSms = selectedCustomer ? [...getCustomerSms(selectedCustomer.name), ...localSms.filter(ls => ls.custName === selectedCustomer.name)] : [];
  const selCalls = selectedCustomer ? getCustomerCalls(selectedCustomer.name) : [];
  const selPhone = selSms[0]?.Phone || selSms[0]?.PhoneNumber || selCalls[0]?.Phone || selCalls[0]?.PhoneNumber || '';

  // Sentiment + brief
  const sentiment = selectedCustomer ? getSentiment(
    selSms.map(s => s.Message || s.Body || s.Text || ''),
    selCalls.map(c => c.Transcript || c.Notes || c.Text || ''),
    selectedCustomer.jobs.map(j => j.svcCallNotes || '')
  ) : 'neutral';

  const sentimentLabel = sentiment === 'happy' ? { text: 'Positive', color: D.green, icon: '😃' }
    : sentiment === 'issue' ? { text: 'Needs Attention', color: D.red, icon: '😕' }
    : { text: 'Neutral', color: D.amber, icon: '😐' };

  const handleSendSms = () => {
    if (!composeText.trim() || !selectedCustomer) return;
    console.log('[Review Outreach] Send SMS to', selectedCustomer.name, ':', composeText);
    setLocalSms(prev => [...prev, {
      custName: selectedCustomer.name,
      Date: new Date().toLocaleDateString(),
      Message: composeText,
      Direction: 'outbound',
      _local: true,
    }]);
    setComposeText('');
    setTimeout(() => smsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  };

  const handleSelectCustomer = (c) => {
    setSelectedCustomer(c);
    setDetailTab('history');
    const firstName = c.name.split(' ')[0] || c.name;
    const cSms = getCustomerSms(c.name);
    const cCalls = getCustomerCalls(c.name);
    const cSentiment = getSentiment(
      cSms.map(s => s.Message || s.Body || s.Text || ''),
      cCalls.map(cl => cl.Transcript || cl.Notes || cl.Text || ''),
      c.jobs.map(j => j.svcCallNotes || '')
    );
    setComposeText(getReviewMessage(cSentiment, firstName));
  };

  if (loading) {
    return (
      <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontFamily: 'DM Sans, sans-serif', fontSize: 15 }}>
        Loading review outreach data from Google Sheets...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ color: D.red, padding: 60, textAlign: 'center', fontFamily: 'DM Sans, sans-serif' }}>
        <div style={{ fontSize: 16, marginBottom: 12 }}>Failed to load sheet data</div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>{error}</div>
      </div>
    );
  }

  return (
    <div>
      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatCard label="Total Jobs" value={totalJobs} color={D.teal} />
        <StatCard label="Unique Customers" value={uniqueCustomers} color={D.white} />
        <StatCard label="Total Revenue" value={`$${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} color={D.green} />
      </div>

      {/* Main layout */}
      <div style={{ display: 'flex', gap: 16 }}>
        {/* Left sidebar */}
        <div style={{ width: 380, minWidth: 380, flexShrink: 0 }}>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search name, address, service..."
            style={{
              width: '100%', padding: '10px 14px', background: D.card, border: `1px solid ${D.border}`,
              borderRadius: 8, color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif',
              outline: 'none', boxSizing: 'border-box', marginBottom: 12,
            }}
          />
          <div style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto', paddingRight: 4 }}>
            {filteredCustomers.map(c => {
              const meta = customerMeta[c.name] || { smsCount: 0, callCount: 0 };
              const isSelected = selectedCustomer?.name === c.name;
              return (
                <div
                  key={c.name}
                  onClick={() => handleSelectCustomer(c)}
                  style={{
                    background: isSelected ? '#253347' : D.card,
                    border: `1px solid ${isSelected ? D.teal : D.border}`,
                    borderRadius: 10, padding: '14px 16px', marginBottom: 8, cursor: 'pointer',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 14, fontWeight: 600, color: D.white }}>{c.name}</div>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: D.green }}>
                      ${c.totalRevenue.toFixed(0)}
                    </div>
                  </div>
                  {c.addr && <div style={{ fontSize: 12, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginTop: 2 }}>{c.addr}</div>}
                  <div style={{ display: 'flex', gap: 10, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: D.teal, fontFamily: 'DM Sans, sans-serif' }}>{c.lastSvcType}</span>
                    <span style={{ fontSize: 11, color: D.muted, fontFamily: 'JetBrains Mono, monospace' }}>
                      {c.lastDate ? formatDate(c.lastDate) : ''}
                    </span>
                    {meta.smsCount > 0 && <span style={{ fontSize: 11, color: D.muted }}>{'💬'} {meta.smsCount}</span>}
                    {meta.callCount > 0 && <span style={{ fontSize: 11, color: D.muted }}>{'📞'} {meta.callCount}</span>}
                  </div>
                </div>
              );
            })}
            {filteredCustomers.length === 0 && (
              <div style={{ color: D.muted, textAlign: 'center', padding: 32, fontFamily: 'DM Sans, sans-serif', fontSize: 13 }}>
                No customers match your search
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!selectedCustomer ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              height: 400, color: D.muted, fontFamily: 'DM Sans, sans-serif',
              background: D.card, borderRadius: 12, border: `1px solid ${D.border}`,
            }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>{'📋'}</div>
              <div style={{ fontSize: 15 }}>Select a customer to view details</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Click a customer card on the left to get started</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Customer header */}
              <div style={{
                background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: '18px 20px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: D.white, fontFamily: 'DM Sans, sans-serif' }}>{selectedCustomer.name}</div>
                    <div style={{ fontSize: 13, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginTop: 2 }}>
                      {selectedCustomer.addr && <span>{selectedCustomer.addr}</span>}
                      {selectedCustomer.email && <span> &middot; {selectedCustomer.email}</span>}
                      {selPhone && <span> &middot; {selPhone}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => setCallModal(true)}
                      style={{
                        padding: '8px 16px', background: 'transparent', border: `1px solid ${D.border}`,
                        color: D.text, borderRadius: 8, fontSize: 13, fontFamily: 'DM Sans, sans-serif',
                        cursor: 'pointer',
                      }}
                    >{'📞'} Call via Twilio</button>
                    <button
                      onClick={() => {
                        setDetailTab('sms');
                        setTimeout(() => smsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 200);
                      }}
                      style={{
                        padding: '8px 16px', background: D.teal, color: D.white, border: 'none',
                        borderRadius: 8, fontSize: 13, fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: 'pointer',
                      }}
                    >{'💬'} Send Review SMS</button>
                  </div>
                </div>
              </div>

              {/* AI Call Prep Brief */}
              <div style={{
                background: D.card, borderRadius: 12, padding: '18px 20px',
                border: '1px solid transparent',
                backgroundImage: `linear-gradient(${D.card}, ${D.card}), linear-gradient(135deg, ${D.teal}44, ${D.teal}11)`,
                backgroundOrigin: 'border-box', backgroundClip: 'padding-box, border-box',
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.teal, fontFamily: 'DM Sans, sans-serif', marginBottom: 12 }}>
                  {'🤖'} AI Call Prep Brief
                </div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM Sans, sans-serif' }}>Customer</div>
                    <div style={{ fontSize: 13, color: D.text, fontFamily: 'DM Sans, sans-serif', marginTop: 2 }}>{selectedCustomer.name}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM Sans, sans-serif' }}>Jobs</div>
                    <div style={{ fontSize: 13, color: D.text, fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>{selectedCustomer.jobs.length}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM Sans, sans-serif' }}>Revenue</div>
                    <div style={{ fontSize: 13, color: D.green, fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>${selectedCustomer.totalRevenue.toFixed(0)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM Sans, sans-serif' }}>Last Service</div>
                    <div style={{ fontSize: 13, color: D.text, fontFamily: 'DM Sans, sans-serif', marginTop: 2 }}>
                      {selectedCustomer.lastSvcType} &middot; {selectedCustomer.lastDate ? formatDate(selectedCustomer.lastDate) : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'DM Sans, sans-serif' }}>Sentiment</div>
                    <div style={{ fontSize: 13, color: sentimentLabel.color, fontFamily: 'DM Sans, sans-serif', marginTop: 2 }}>
                      {sentimentLabel.icon} {sentimentLabel.text}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: D.muted, fontFamily: 'DM Sans, sans-serif', lineHeight: 1.5 }}>
                  {sentiment === 'happy' && `${selectedCustomer.name.split(' ')[0]} has shown positive sentiment in past communications. Great candidate for a review request.`}
                  {sentiment === 'issue' && `${selectedCustomer.name.split(' ')[0]} may have had service concerns. Consider addressing any issues before requesting a review.`}
                  {sentiment === 'neutral' && `No strong sentiment detected for ${selectedCustomer.name.split(' ')[0]}. A friendly check-in with a review request is appropriate.`}
                </div>
              </div>

              {/* Detail tabs */}
              <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${D.border}`, marginBottom: 0 }}>
                {['history', 'sms', 'calls'].map(tab => (
                  <button
                    key={tab}
                    onClick={() => setDetailTab(tab)}
                    style={{
                      padding: '10px 20px', background: 'transparent', border: 'none',
                      borderBottom: detailTab === tab ? `2px solid ${D.teal}` : '2px solid transparent',
                      color: detailTab === tab ? D.teal : D.muted, fontSize: 13,
                      fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    {tab === 'history' ? 'Service History' : tab === 'sms' ? `SMS Thread (${selSms.length})` : `Call Recordings (${selCalls.length})`}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div style={{
                background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
                padding: 0, maxHeight: 'calc(100vh - 580px)', overflowY: 'auto',
              }}>
                {detailTab === 'history' && (
                  <div style={{ padding: 16 }}>
                    {selectedCustomer.jobs.map((j, i) => (
                      <div key={i} style={{
                        padding: '12px 0', borderBottom: i < selectedCustomer.jobs.length - 1 ? `1px solid ${D.border}` : 'none',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                          <div>
                            <span style={{ fontSize: 13, fontWeight: 600, color: D.white, fontFamily: 'DM Sans, sans-serif' }}>{j.svcType}</span>
                            <span style={{ fontSize: 12, color: D.muted, fontFamily: 'JetBrains Mono, monospace', marginLeft: 10 }}>
                              {j.parsedDate ? formatDate(j.parsedDate) : j.date}
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <span style={{ fontSize: 12, color: D.muted, fontFamily: 'DM Sans, sans-serif' }}>Tech: {j.techName}</span>
                            <span style={{ fontSize: 12, color: D.green, fontFamily: 'JetBrains Mono, monospace' }}>${parseFloat(j.revenue?.replace(/[$,]/g, '') || 0).toFixed(0)}</span>
                            {j.gpPct && <span style={{ fontSize: 12, color: D.amber, fontFamily: 'JetBrains Mono, monospace' }}>{j.gpPct} margin</span>}
                          </div>
                        </div>
                        {j.svcPerformed && (
                          <div style={{ fontSize: 12, color: D.text, fontFamily: 'DM Sans, sans-serif', marginTop: 4, lineHeight: 1.4 }}>
                            {j.svcPerformed}
                          </div>
                        )}
                        {j.svcCallNotes && (
                          <div style={{ fontSize: 12, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginTop: 2, fontStyle: 'italic' }}>
                            {j.svcCallNotes}
                          </div>
                        )}
                      </div>
                    ))}
                    {selectedCustomer.jobs.length === 0 && (
                      <div style={{ color: D.muted, textAlign: 'center', padding: 24, fontSize: 13, fontFamily: 'DM Sans, sans-serif' }}>No service history found</div>
                    )}
                  </div>
                )}

                {detailTab === 'sms' && (
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {selSms.length === 0 && (
                      <div style={{ color: D.muted, textAlign: 'center', padding: 24, fontSize: 13, fontFamily: 'DM Sans, sans-serif' }}>No SMS records found</div>
                    )}
                    {selSms.map((s, i) => {
                      const isOutbound = (s.Direction || '').toLowerCase().includes('outbound') || (s.Direction || '').toLowerCase().includes('out') || s._local;
                      const msg = s.Message || s.Body || s.Text || '';
                      return (
                        <div key={i} style={{
                          display: 'flex', justifyContent: isOutbound ? 'flex-end' : 'flex-start',
                        }}>
                          <div style={{
                            maxWidth: '75%', padding: '10px 14px', borderRadius: 12,
                            background: isOutbound ? 'linear-gradient(135deg, #0ea5e9, #0284c7)' : D.bg,
                            border: isOutbound ? 'none' : `1px solid ${D.border}`,
                            color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', lineHeight: 1.5,
                          }}>
                            <div style={{ whiteSpace: 'pre-wrap' }}>{msg}</div>
                            <div style={{ fontSize: 10, color: isOutbound ? 'rgba(255,255,255,0.6)' : D.muted, marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                              {s.Date || s.Timestamp || ''}
                              {s._local && ' (pending)'}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={smsEndRef} />
                  </div>
                )}

                {detailTab === 'calls' && (
                  <div style={{ padding: 16 }}>
                    {selCalls.length === 0 && (
                      <div style={{ color: D.muted, textAlign: 'center', padding: 24, fontSize: 13, fontFamily: 'DM Sans, sans-serif' }}>No call recordings found</div>
                    )}
                    {selCalls.map((c, i) => (
                      <div key={i} style={{
                        padding: '12px 0', borderBottom: i < selCalls.length - 1 ? `1px solid ${D.border}` : 'none',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 12, color: D.muted, fontFamily: 'JetBrains Mono, monospace' }}>{c.Date || c.Timestamp || ''}</span>
                          <span style={{ fontSize: 12, color: D.muted, fontFamily: 'DM Sans, sans-serif' }}>{c.Duration || ''}</span>
                        </div>
                        {(c.Transcript || c.Text || c.Notes) && (
                          <div style={{ fontSize: 13, color: D.text, fontFamily: 'DM Sans, sans-serif', lineHeight: 1.5, marginTop: 4 }}>
                            {c.Transcript || c.Text || c.Notes}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Compose bar */}
              <div style={{
                background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16,
                display: 'flex', gap: 10, alignItems: 'flex-end',
              }}>
                <textarea
                  value={composeText}
                  onChange={e => setComposeText(e.target.value)}
                  placeholder="Type review request SMS..."
                  rows={3}
                  style={{
                    flex: 1, padding: 12, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
                    color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', resize: 'vertical',
                    outline: 'none', boxSizing: 'border-box',
                  }}
                />
                <button
                  onClick={handleSendSms}
                  disabled={!composeText.trim()}
                  style={{
                    padding: '12px 24px', background: D.teal, color: D.white, border: 'none',
                    borderRadius: 8, fontSize: 14, fontFamily: 'DM Sans, sans-serif', fontWeight: 600,
                    cursor: composeText.trim() ? 'pointer' : 'not-allowed',
                    opacity: composeText.trim() ? 1 : 0.5, whiteSpace: 'nowrap',
                  }}
                >Send {'\u2192'}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Call modal */}
      {callModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999,
        }} onClick={() => setCallModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: D.card, border: `1px solid ${D.border}`, borderRadius: 16,
            padding: '32px 40px', textAlign: 'center', maxWidth: 400,
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>{'📞'}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: D.white, fontFamily: 'DM Sans, sans-serif', marginBottom: 8 }}>
              Initiating Call via Twilio
            </div>
            <div style={{ fontSize: 14, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginBottom: 4 }}>
              Calling {selectedCustomer?.name}
            </div>
            {selPhone && (
              <div style={{ fontSize: 13, color: D.teal, fontFamily: 'JetBrains Mono, monospace', marginBottom: 20 }}>
                {selPhone}
              </div>
            )}
            <div style={{ fontSize: 12, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginBottom: 20 }}>
              Twilio integration coming soon. This is a placeholder.
            </div>
            <button onClick={() => setCallModal(false)} style={{
              padding: '10px 28px', background: D.teal, color: D.white, border: 'none',
              borderRadius: 8, fontSize: 14, fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: 'pointer',
            }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function ReviewsPage() {
  const [activeTab, setActiveTab] = useState('reviews');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);

  // Filters
  const [filterLocation, setFilterLocation] = useState('all');
  const [filterRating, setFilterRating] = useState('all');
  const [filterResponded, setFilterResponded] = useState('all');
  const [search, setSearch] = useState('');

  const loadData = () => {
    setLoading(true);
    setError(null);
    adminFetch('/admin/reviews')
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  useEffect(() => { loadData(); }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await adminFetch('/admin/reviews/sync', { method: 'POST', body: JSON.stringify({ fresh: true }) });
      await loadData();
    } catch (e) {
      alert('Sync failed: ' + e.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleReply = async (reviewId, replyText) => {
    await adminFetch(`/admin/reviews/${reviewId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ replyText }),
    });
    // Update local state
    setData(prev => ({
      ...prev,
      reviews: prev.reviews.map(r =>
        r.id === reviewId ? { ...r, reply: replyText, replyUpdatedAt: new Date().toISOString() } : r
      ),
    }));
  };

  const handleRequestReview = (loc) => {
    if (loc.reviewUrl) {
      navigator.clipboard.writeText(loc.reviewUrl).then(() => {
        alert(`Review link for ${loc.name} copied to clipboard!`);
      }).catch(() => {
        window.open(loc.reviewUrl, '_blank');
      });
    }
  };

  // --- Compute reviews data (without early returns, so tabs always render) ---
  const reviews = data?.reviews || [];
  const stats = data?.stats || {};
  const locations = data?.locations || [];
  const { totalReviews = 0, avgRating = 0, unresponded = 0, newThisMonth = 0, breakdown = {}, perLocation = [] } = stats;

  const respondedCount = reviews.filter(r => r.reply).length;
  const responseRate = totalReviews > 0 ? Math.round((respondedCount / totalReviews) * 100) : 0;

  // --- Filtering ---
  const filtered = reviews.filter(r => {
    if (filterLocation !== 'all' && r.locationId !== filterLocation) return false;
    if (filterRating !== 'all' && r.starRating !== Number(filterRating)) return false;
    if (filterResponded === 'responded' && !r.reply) return false;
    if (filterResponded === 'needs-reply' && r.reply) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matches = (r.reviewerName || '').toLowerCase().includes(q) ||
        (r.reviewText || '').toLowerCase().includes(q) ||
        (r.matchedCustomer?.name || '').toLowerCase().includes(q);
      if (!matches) return false;
    }
    return true;
  });

  // Build per-location lookup merging API locations with stats
  const locLookup = {};
  locations.forEach(l => { locLookup[l.id] = { ...l, count: 0, avgRating: '0.0' }; });
  perLocation.forEach(p => {
    if (locLookup[p.locationId]) {
      locLookup[p.locationId].count = p.count;
      locLookup[p.locationId].avgRating = p.avgRating;
    }
  });

  // Per-location breakdowns from reviews
  const locBreakdowns = {};
  reviews.forEach(r => {
    if (!locBreakdowns[r.locationId]) locBreakdowns[r.locationId] = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
    locBreakdowns[r.locationId][String(r.starRating)] = (locBreakdowns[r.locationId][String(r.starRating)] || 0) + 1;
  });

  const locationOptions = [
    { value: 'all', label: 'All Locations' },
    { value: 'lakewood-ranch', label: 'Lakewood Ranch' },
    { value: 'parrish', label: 'Parrish' },
    { value: 'sarasota', label: 'Sarasota' },
    { value: 'venice', label: 'Venice' },
  ];

  const ratingOptions = [
    { value: 'all', label: 'All Ratings' },
    { value: '5', label: '5 Stars' },
    { value: '4', label: '4 Stars' },
    { value: '3', label: '3 Stars' },
    { value: '2', label: '2 Stars' },
    { value: '1', label: '1 Star' },
  ];

  const respondedOptions = [
    { value: 'all', label: 'All Reviews' },
    { value: 'responded', label: 'Responded' },
    { value: 'needs-reply', label: 'Needs Reply' },
  ];

  return (
    <div>
      {/* ====================== INTELLIGENCE BAR ====================== */}
      <SEOIntelligenceBar context="reviews" />

      {/* ====================== TAB TOGGLE ====================== */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
        {[
          { key: 'reviews', label: 'Reviews' },
          { key: 'gbp', label: 'GBP Management' },
          { key: 'outreach', label: 'Review Outreach' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
              background: activeTab === tab.key ? D.teal : 'transparent',
              color: activeTab === tab.key ? D.white : D.muted,
              transition: 'all 0.15s', whiteSpace: 'nowrap', flexShrink: 0, minHeight: 44,
            }}
          >{tab.label}</button>
        ))}
      </div>

      {/* ====================== TAB: REVIEWS ====================== */}
      {activeTab === 'reviews' && (
        <div>
          {/* Loading state */}
          {loading && (
            <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontFamily: 'DM Sans, sans-serif', fontSize: 15 }}>
              Loading reviews...
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div style={{ color: D.red, padding: 60, textAlign: 'center', fontFamily: 'DM Sans, sans-serif' }}>
              <div style={{ fontSize: 16, marginBottom: 12 }}>Failed to load reviews</div>
              <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>{error}</div>
              <button onClick={loadData} style={{
                padding: '8px 20px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
                fontSize: 14, fontFamily: 'DM Sans, sans-serif', cursor: 'pointer',
              }}>Retry</button>
            </div>
          )}

          {/* Reviews content */}
          {!loading && !error && data && (
            <>
              {/* Page header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: D.white, fontFamily: 'DM Sans, sans-serif' }}>Google Reviews</div>
                  <div style={{ fontSize: 13, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginTop: 4 }}>
                    Manage reviews across all locations
                  </div>
                </div>
                <button onClick={handleSync} disabled={syncing} style={{
                  padding: '10px 20px', background: syncing ? D.border : D.teal, color: D.white, border: 'none',
                  borderRadius: 8, fontSize: 14, fontFamily: 'DM Sans, sans-serif', fontWeight: 600,
                  cursor: syncing ? 'not-allowed' : 'pointer', opacity: syncing ? 0.7 : 1,
                }}>{syncing ? 'Syncing...' : 'Sync Reviews'}</button>
              </div>

              {/* Stats bar */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
                <StatCard
                  label="Total Reviews"
                  value={totalReviews}
                  sub={<span><span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{Number(avgRating).toFixed(1)}</span> <Stars count={Math.round(avgRating)} size={13} /></span>}
                />
                <StatCard
                  label="No Portal Reply"
                  value={unresponded}
                  color={unresponded > 0 ? D.amber : D.green}
                  sub={unresponded > 0 ? 'reply via AI Reply below' : 'all replied'}
                />
                <StatCard
                  label="New This Month"
                  value={newThisMonth}
                  color={D.teal}
                />
                <StatCard
                  label="Response Rate"
                  value={`${responseRate}%`}
                  color={responseRate >= 90 ? D.green : responseRate >= 70 ? D.amber : D.red}
                  sub={`${respondedCount} of ${totalReviews} replied`}
                />
              </div>

              {/* Per-location cards */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
                {Object.values(locLookup).map(loc => (
                  <LocationCard
                    key={loc.id}
                    loc={loc}
                    breakdown={locBreakdowns[loc.id] || breakdown}
                    onRequestReview={handleRequestReview}
                  />
                ))}
              </div>

              {/* Filter bar */}
              <div style={{
                display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center',
                padding: '12px 16px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
              }}>
                <Select value={filterLocation} onChange={setFilterLocation} options={locationOptions} />
                <Select value={filterRating} onChange={setFilterRating} options={ratingOptions} />
                <Select value={filterResponded} onChange={setFilterResponded} options={respondedOptions} />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search reviews..."
                  style={{
                    padding: '8px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
                    color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', flex: '1 1 180px', minWidth: 160,
                  }}
                />
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.muted }}>
                  {filtered.length} review{filtered.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Reviews feed */}
              {filtered.length === 0 ? (
                <div style={{
                  padding: 48, textAlign: 'center', color: D.muted, fontFamily: 'DM Sans, sans-serif',
                  background: D.card, borderRadius: 12, border: `1px solid ${D.border}`,
                }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>★</div>
                  <div style={{ fontSize: 15 }}>No reviews match your filters</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>Try adjusting your search or filter criteria</div>
                </div>
              ) : (
                filtered.map(r => (
                  <ReviewCard key={r.id} review={r} onReplySubmit={handleReply} />
                ))
              )}
            </>
          )}
        </div>
      )}

      {/* ====================== TAB: REVIEW OUTREACH ====================== */}
      {activeTab === 'gbp' && <GBPManagementPanel />}
      {activeTab === 'outreach' && <ReviewVelocityEngine />}
    </div>
  );
}
