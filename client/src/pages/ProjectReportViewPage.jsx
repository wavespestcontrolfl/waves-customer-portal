import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS as B, FONTS, BUTTON_BASE, HALFTONE_PATTERN, HALFTONE_SIZE } from '../theme-brand';
import BrandFooter from '../components/BrandFooter';
import Icon from '../components/Icon';

/**
 * Public project-report viewer (WDO, termite, pest, rodent, bed bug).
 * Mirrors ReportViewPage.jsx visually but renders type-specific findings
 * and a photo gallery instead of lawn-service products + measurements.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const BOOK_URL = 'https://www.wavespestcontrol.com/book/';

const TYPE_LABELS = {
  wdo_inspection: 'WDO Inspection',
  termite_inspection: 'Termite Inspection',
  pest_inspection: 'Pest Inspection',
  rodent_exclusion: 'Rodent Exclusion',
  bed_bug: 'Bed Bug Treatment',
};

function formatReportDate(value) {
  if (!value) return '';
  const raw = String(value);
  const dateOnlyValue = dateOnly(raw);
  const date = dateOnlyValue ? new Date(`${dateOnlyValue}T12:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function dateOnly(value) {
  if (!value) return '';
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(raw)) return raw.slice(0, 10);
  return '';
}

function reportDateKey(value) {
  const dateOnlyValue = dateOnly(value);
  if (dateOnlyValue) return dateOnlyValue;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Human-readable labels for finding keys. Keep in sync with
// server/services/project-types.js — if a key isn't listed we fall back to
// the snake_case key title-cased on the fly so the report never hides data.
const FIELD_LABELS = {
  areas_inspected: 'Areas inspected',
  evidence_type: 'Evidence found',
  evidence_location: 'Evidence location',
  moisture_issues: 'Moisture / conducive conditions',
  treatment_recommendation: 'Treatment recommendation',
  property_address: 'Property inspected',
  structures_inspected: 'Structure(s) inspected',
  requested_by: 'Inspection requested by',
  report_sent_to: 'Report sent to',
  inspection_scope: 'Visible / accessible areas inspected',
  wdo_finding: 'FDACS Section 2 finding',
  live_wdo: 'Live WDO(s)',
  wdo_evidence: 'Evidence of WDO(s)',
  wdo_damage: 'Damage caused by WDO(s)',
  inaccessible_areas: 'Obstructions / inaccessible areas',
  previous_treatment_evidence: 'Evidence of previous treatment',
  previous_treatment_notes: 'Previous treatment observations',
  notice_location: 'Notice of Inspection location',
  treated_at_inspection: 'Treated at time of inspection',
  organism_treated: 'Organism treated',
  pesticide_used: 'Pesticide used',
  treatment_terms: 'Treatment terms and conditions',
  treatment_notice_location: 'Treatment notice location',
  comments: 'Comments / financial disclosure notes',
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
        <div style={{ color: B.grayMid }}><Icon name="document" size={32} strokeWidth={1.75} /></div>
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
  const projectDateLabel = formatReportDate(data.projectDate || data.sentAt);
  const sentDateLabel = data.sentAt ? formatReportDate(data.sentAt) : '';
  const showSentDate = sentDateLabel && reportDateKey(data.sentAt) !== reportDateKey(data.projectDate);

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
            <div style={{ fontSize: 12, color: B.blueLight, marginTop: 4 }}>{data.customerName}</div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: '16px auto', padding: '0 16px' }}>
        {/* Summary card */}
        <div style={{ background: '#fff', borderRadius: 16, padding: 20, border: `1px solid ${B.bluePale}` }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading }}>
            {data.title || typeLabel}
          </div>
          <div style={{ fontSize: 14, color: B.grayDark, marginTop: 4 }}>
            {projectDateLabel && `Inspection date: ${projectDateLabel}`}
            {data.technicianName ? ` · ${data.technicianName}` : ''}
          </div>
          {showSentDate && (
            <div style={{ fontSize: 12, color: B.grayMid, marginTop: 2 }}>Report sent: {sentDateLabel}</div>
          )}
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
                    <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 3 }}>{humanizeKey(key)}</div>
                    <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{String(value)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recommendations — if the text is the three-section AI-drafted
               format, render each section with its own heading. Otherwise
               fall back to the single "Recommendations" block. */}
          {data.recommendations && <RecommendationsBlock text={data.recommendations} />}
        </div>

        {data.projectType === 'wdo_inspection' && (
          <div style={{ marginTop: 16, background: '#fff', borderRadius: 16, padding: 18, border: `1px solid ${B.bluePale}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Official WDO Form
            </div>
            <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55 }}>
              This inspection follows Florida FDACS-13645, Wood-Destroying Organisms Inspection Report.
            </div>
            <a
              href="/forms/fdacs-13645-wdo-inspection-report.pdf"
              target="_blank"
              rel="noreferrer"
              style={{
                ...BUTTON_BASE, marginTop: 12, padding: '0 18px', height: 40, fontSize: 14,
                borderRadius: 999, background: B.navy, color: '#fff',
                textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
                fontWeight: 800,
              }}
            >
              <Icon name="document" size={15} strokeWidth={2} style={{ marginRight: 6 }} /> View FDACS-13645
            </a>
          </div>
        )}

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
                    <div style={{ fontSize: 12, fontWeight: 700, color: B.navy }}>{humanizeKey(key)}</div>
                    <div style={{ fontSize: 14, color: B.grayDark, whiteSpace: 'pre-wrap' }}>{String(value)}</div>
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
          <div style={{ fontSize: 14, color: B.grayDark }}>Questions about this report?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginTop: 8 }}>
            <a href="sms:+19412975749" style={{
              ...BUTTON_BASE, padding: '0 22px', height: 44, fontSize: 14,
              borderRadius: 999, background: B.yellow, color: B.blueDeeper,
              textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
              fontWeight: 800,
            }}><Icon name="message" size={16} strokeWidth={2} style={{ marginRight: 6 }} /> Text Us — (941) 297-5749</a>
            <a href="tel:+19412975749" style={{
              ...BUTTON_BASE, padding: '0 22px', height: 44, fontSize: 14,
              borderRadius: 999, background: B.navy, color: '#fff',
              textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
              fontWeight: 800,
            }}><Icon name="phone" size={16} strokeWidth={2} style={{ marginRight: 6 }} /> Call Us — (941) 297-5749</a>
          </div>
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

// Heuristic: if the text contains all three section markers, split it into
// named sections and render each with its own heading. Otherwise render the
// whole block under a single "Recommendations" heading like before.
const SECTION_HEADINGS = ['WHAT WE INSPECTED', 'WHAT WE FOUND', 'WHAT WE RECOMMEND'];

function parseSections(text) {
  const hasAll = SECTION_HEADINGS.every(h => text.includes(h));
  if (!hasAll) return null;
  const sections = [];
  const headingPattern = new RegExp(`^(${SECTION_HEADINGS.join('|')})\\s*$`, 'gm');
  const indices = [];
  let m;
  while ((m = headingPattern.exec(text)) !== null) {
    indices.push({ heading: m[1], start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < indices.length; i++) {
    const end = i + 1 < indices.length ? indices[i + 1].start : text.length;
    const body = text.slice(indices[i].contentStart, end).trim();
    if (body) sections.push({ heading: indices[i].heading, body });
  }
  return sections.length === SECTION_HEADINGS.length ? sections : null;
}

function titleCase(s) {
  return s.split(' ').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
}

function RecommendationsBlock({ text }) {
  const sections = parseSections(text);
  if (sections) {
    return (
      <div style={{ marginTop: 16, padding: '16px 18px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
        {sections.map((s, i) => (
          <div key={s.heading} style={{ marginTop: i === 0 ? 0 : 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {titleCase(s.heading)}
            </div>
            <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{s.body}</div>
            {s.heading === 'WHAT WE RECOMMEND' && shouldShowBookingCta(s.body) && <BookingCta />}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 4 }}>Recommendations</div>
      <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{text}</div>
      {shouldShowBookingCta(text) && <BookingCta />}
    </div>
  );
}

function shouldShowBookingCta(text) {
  const value = String(text || '');
  const negativeBeforeAction = /\b(no|not|none|without|unnecessary|isn'?t|not currently)\b.{0,55}\b(service|appointment|schedule|booking|treatment|treat|application|follow[-\s]?up|inspection|exclusion)\b/i.test(value);
  const actionBeforeNegative = /\b(service|appointment|booking|treatment|application|follow[-\s]?up|inspection|exclusion)\b.{0,55}\b(no|not|unnecessary|isn'?t)\b/i.test(value);
  const negativeAction = negativeBeforeAction || actionBeforeNegative;
  if (negativeAction) return false;
  return /\b(schedule|book|appointment|recommend(?:ed)? (?:service|treatment|follow[-\s]?up|inspection)|apply|application|treatment|treat|follow[-\s]?up|exclusion|bait|boracare|bora care|termite|rodent|bed bug)\b/i.test(value);
}

function BookingCta() {
  return (
    <div style={{ marginTop: 14 }}>
      <a
        href={BOOK_URL}
        target="_blank"
        rel="noreferrer"
        style={{
          ...BUTTON_BASE,
          padding: '0 18px',
          height: 40,
          fontSize: 14,
          borderRadius: 999,
          background: B.yellow,
          color: B.blueDeeper,
          textDecoration: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          fontWeight: 800,
        }}
      >
        <Icon name="calendar" size={15} strokeWidth={2} style={{ marginRight: 6 }} /> Book an appointment
      </a>
    </div>
  );
}
