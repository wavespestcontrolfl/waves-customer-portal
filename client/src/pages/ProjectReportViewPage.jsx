import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS as B, FONTS, BUTTON_BASE, HALFTONE_PATTERN, HALFTONE_SIZE } from '../theme-brand';
import BrandFooter from '../components/BrandFooter';

/**
 * Public project-report viewer (WDO, termite, pest, rodent, bed bug).
 * Mirrors ReportViewPage.jsx visually but renders type-specific findings
 * and a photo gallery instead of lawn-service products + measurements.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const TYPE_LABELS = {
  wdo_inspection: 'WDO Inspection',
  termite_inspection: 'Termite Inspection',
  pest_inspection: 'Pest Inspection',
  rodent_exclusion: 'Rodent Exclusion',
  bed_bug: 'Bed Bug Treatment',
};

// Human-readable labels for finding keys. Keep in sync with
// server/services/project-types.js — if a key isn't listed we fall back to
// the snake_case key title-cased on the fly so the report never hides data.
const FIELD_LABELS = {
  areas_inspected: 'Areas inspected',
  evidence_type: 'Evidence found',
  evidence_location: 'Evidence location',
  moisture_issues: 'Moisture / conducive conditions',
  treatment_recommendation: 'Treatment recommendation',
  termite_type: 'Termite species',
  activity_status: 'Activity status',
  infestation_extent: 'Infestation extent',
  pests_identified: 'Pests identified',
  severity: 'Severity',
  conducive_conditions: 'Conducive conditions',
  recommendation: 'Recommendation',
  species: 'Species',
  entry_points_found: 'Entry points identified',
  traps_set: 'Traps set',
  exclusion_completed: 'Exclusion work completed',
  exclusion_pending: 'Exclusion work pending',
  followup_plan: 'Follow-up plan',
  rooms_treated: 'Rooms treated',
  evidence_level: 'Evidence level',
  treatment_method: 'Treatment method',
  products_used: 'Products used',
  prep_for_customer: 'Customer prep for follow-up',
};

function humanizeKey(k) {
  return FIELD_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function ProjectReportViewPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/reports/project/${token}/data`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  if (loading) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#fff', fontFamily: FONTS.body }}>Loading report…</div>
    </div>
  );

  if (!data || data.error) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>📄</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: B.navy, marginTop: 8 }}>Report not found</div>
        <a href="tel:+19412975749" style={{
          ...BUTTON_BASE, marginTop: 16, padding: '10px 22px', borderRadius: 9999,
          background: B.yellow, color: B.blueDeeper, textDecoration: 'none',
          display: 'inline-flex', fontWeight: 800,
        }}>Call (941) 297-5749</a>
      </div>
    </div>
  );

  const typeLabel = TYPE_LABELS[data.projectType] || 'Inspection';
  const findings = data.findings || {};
  const findingsEntries = Object.entries(findings).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const primaryPhotos = (data.photos || []).filter(p => p.visit === 'primary');
  const followupPhotos = (data.photos || []).filter(p => p.visit === 'followup');

  return (
    <div style={{ minHeight: '100vh', background: B.offWhite, fontFamily: FONTS.body }}>
      {/* Header */}
      <div style={{
        position: 'relative', overflow: 'hidden',
        background: B.blueDark, padding: '14px 20px',
        backgroundImage: HALFTONE_PATTERN, backgroundSize: HALFTONE_SIZE,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <video autoPlay muted loop playsInline preload="none" poster="/brand/waves-hero-service.webp"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3, zIndex: 0, pointerEvents: 'none' }}
          aria-hidden="true">
          <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
        </video>
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 28 }} />
          <div>
            <h1 style={{
              fontFamily: FONTS.display, fontWeight: 400,
              fontSize: 20, color: '#fff',
              letterSpacing: '0.02em', lineHeight: 1, margin: 0,
            }}>{typeLabel}</h1>
            <div style={{ fontSize: 11, color: B.blueLight, marginTop: 4 }}>{data.customerName}</div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: '16px auto', padding: '0 16px' }}>
        {/* Summary card */}
        <div style={{ background: '#fff', borderRadius: 16, padding: 20, border: `1px solid ${B.bluePale}` }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
            {data.title || typeLabel}
          </div>
          <div style={{ fontSize: 13, color: B.grayDark, marginTop: 4 }}>
            {data.sentAt && new Date(data.sentAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {data.technicianName ? ` · ${data.technicianName}` : ''}
          </div>
          {data.cityState && (
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>{data.cityState}</div>
          )}

          {/* Findings */}
          {findingsEntries.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Findings
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {findingsEntries.map(([key, value]) => (
                  <div key={key} style={{ padding: '10px 12px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: B.navy, marginBottom: 3 }}>{humanizeKey(key)}</div>
                    <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{String(value)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {data.recommendations && (
            <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 4 }}>Recommendations</div>
              <div style={{ fontSize: 13, color: B.grayDark, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{data.recommendations}</div>
            </div>
          )}
        </div>

        {/* Primary visit photos */}
        {primaryPhotos.length > 0 && (
          <PhotoGrid title="Photos" photos={primaryPhotos} />
        )}

        {/* Follow-up visit (bed bug) */}
        {(data.followupCompletedAt || data.followupFindings || followupPhotos.length > 0) && (
          <div style={{ marginTop: 16, background: '#fff', borderRadius: 16, padding: 20, border: `1px solid ${B.bluePale}` }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
              Follow-up visit
            </div>
            {data.followupCompletedAt && (
              <div style={{ fontSize: 12, color: B.grayDark, marginTop: 4 }}>
                {new Date(data.followupCompletedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            )}
            {data.followupFindings && Object.keys(data.followupFindings).length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(data.followupFindings).filter(([, v]) => v).map(([key, value]) => (
                  <div key={key} style={{ padding: '8px 10px', borderRadius: 8, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: B.navy }}>{humanizeKey(key)}</div>
                    <div style={{ fontSize: 13, color: B.grayDark, whiteSpace: 'pre-wrap' }}>{String(value)}</div>
                  </div>
                ))}
              </div>
            )}
            {followupPhotos.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <PhotoGrid photos={followupPhotos} noCard />
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        <div style={{ textAlign: 'center', marginTop: 20, padding: '16px 0' }}>
          <div style={{ fontSize: 13, color: B.grayDark }}>Questions about this report?</div>
          <a href="sms:+19412975749" style={{
            ...BUTTON_BASE, padding: '0 22px', height: 44, fontSize: 14, marginTop: 8,
            borderRadius: 999, background: B.yellow, color: B.blueDeeper,
            textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
            fontWeight: 800,
          }}>💬 Text Us — (941) 297-5749</a>
        </div>

        <BrandFooter />
      </div>
    </div>
  );
}

function PhotoGrid({ title, photos, noCard }) {
  const content = (
    <div>
      {title && (
        <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {title}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
        {photos.map(ph => (
          <a
            key={ph.id}
            href={ph.url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'block', aspectRatio: '1/1', borderRadius: 8, overflow: 'hidden',
              border: `1px solid ${B.bluePale}`, position: 'relative', background: B.offWhite,
            }}
          >
            {ph.url ? (
              <img
                src={ph.url}
                alt={ph.caption || ph.category || 'Photo'}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : null}
            {ph.category && (
              <div style={{
                position: 'absolute', left: 0, right: 0, bottom: 0,
                padding: '4px 6px', background: 'rgba(0,0,0,0.5)', color: '#fff',
                fontSize: 10, fontWeight: 600, textTransform: 'capitalize',
              }}>{ph.category.replace(/_/g, ' ')}</div>
            )}
          </a>
        ))}
      </div>
    </div>
  );

  if (noCard) return content;
  return (
    <div style={{ marginTop: 16, background: '#fff', borderRadius: 16, padding: 20, border: `1px solid ${B.bluePale}` }}>
      {content}
    </div>
  );
}
