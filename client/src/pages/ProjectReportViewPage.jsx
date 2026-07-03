import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  COLORS as B,
  FONTS,
} from '../theme-brand';
import BrandFooter from '../components/BrandFooter';
import Icon from '../components/Icon';
import { WAVES_FDACS_LICENSE_NUMBER } from '../constants/business';
import { INTERNAL_FINDING_KEYS } from '../lib/wdoReportFields';

/**
 * Public project-report viewer (WDO, termite, pest, rodent, bed bug).
 * Mirrors ReportViewPage.jsx visually but renders type-specific findings
 * and a photo gallery instead of lawn-service products + measurements.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const BOOK_URL = 'https://www.wavespestcontrol.com/book/';
const WAVES_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_PHONE_TEL = '+19412975749';
const FONT_BODY = "'Inter', system-ui, sans-serif";
const ESTIMATE_BG = '#FAF8F3';
const ESTIMATE_BORDER = '#E7E2D7';
const ESTIMATE_MUTED = '#6B7280';
const ESTIMATE_TEXT = '#1B2C5B';
const ESTIMATE_BODY = '#3F4A65';
const ESTIMATE_BUTTON_BG = B.blueDeeper;
const ESTIMATE_INPUT_BORDER = '#CFE7F5';
const ESTIMATE_INPUT_BG = '#F8FCFE';

const cardStyle = {
  background: B.white,
  borderRadius: 16,
  padding: 24,
  border: `1px solid ${ESTIMATE_BORDER}`,
};

const eyebrowStyle = {
  fontSize: 12,
  color: ESTIMATE_MUTED,
  letterSpacing: 0,
  textTransform: 'uppercase',
  fontWeight: 700,
};

const primaryButtonStyle = {
  minHeight: 48,
  border: 0,
  borderRadius: 10,
  padding: '0 18px',
  background: ESTIMATE_BUTTON_BG,
  color: B.white,
  fontSize: 14,
  fontWeight: 700,
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
};

const secondaryButtonStyle = {
  ...primaryButtonStyle,
  background: B.white,
  color: ESTIMATE_TEXT,
  border: `1px solid ${ESTIMATE_BORDER}`,
};

const TYPE_LABELS = {
  wdo_inspection: 'WDO Inspection',
  termite_inspection: 'Termite Inspection',
  termite_treatment: 'Termite Treatment',
  pest_inspection: 'Pest Inspection',
  cockroach: 'Cockroach Treatment',
  one_time_pest_treatment: 'One-Time Pest Treatment',
  one_time_lawn_treatment: 'One-Time Lawn Treatment',
  flea: 'Flea Service',
  rodent_exclusion: 'Rodent Exclusion',
  rodent_trapping: 'Rodent Trapping',
  wildlife_trapping: 'Wildlife Trapping',
  mosquito_event: 'Mosquito Event Spray',
  palm_injection: 'Palm Injection',
  bed_bug: 'Bed Bug Treatment',
  pre_treatment_termite_certificate: 'Certificate of Compliance — Pre-Construction Termite Treatment',
};

function formatReportDate(value) {
  if (!value) return '';
  const raw = String(value);
  const dateOnlyValue = dateOnly(raw);
  const date = dateOnlyValue ? new Date(`${dateOnlyValue}T12:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function formatAppointmentDate(value) {
  if (!value) return '';
  const raw = String(value);
  const dateOnlyValue = dateOnly(raw);
  const date = dateOnlyValue ? new Date(`${dateOnlyValue}T12:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

function formatAppointmentTime(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const match = /^(\d{1,2}):(\d{2})/.exec(raw);
  if (!match) return raw;
  const hour24 = Number(match[1]);
  const minute = match[2];
  const hour12 = hour24 % 12 || 12;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  return `${hour12}:${minute} ${suffix}`;
}

function formatAppointmentWindow(appt) {
  if (!appt) return '';
  const date = formatAppointmentDate(appt.scheduledDate);
  const start = formatAppointmentTime(appt.windowStart);
  const end = formatAppointmentTime(appt.windowEnd);
  const window = start && end ? `${start}-${end}` : start || end;
  return [date, window].filter(Boolean).join(' ');
}

function valueWithUnit(value, unitLabel, unitPattern) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return unitPattern.test(raw) ? raw : `${raw} ${unitLabel}`;
}

function gallonsApplied(value) {
  const raw = valueWithUnit(value, 'gal', /\b(gal|gallon|gallons)\b/i);
  if (!raw) return '';
  return /\bapplied\b/i.test(raw) ? raw : `${raw} applied`;
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
  structure_type: 'Structure type',
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
  structure_sqft: 'Structure footprint (approx. sq ft)',
  inspection_fee: 'Inspection fee',
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
  host_activity: 'Host / activity notes',
  treatment_areas: 'Treatment areas',
  // Pre-treatment Certificate of Compliance fields (FBC 1816.1.7)
  treatment_address: 'Treatment address',
  lot_block: 'Lot / Block',
  subdivision: 'Subdivision / Community',
  permit_number: 'Building permit #',
  builder_contractor: 'Builder / General contractor',
  treatment_date: 'Date of treatment',
  treatment_time: 'Time of treatment',
  treatment_method_other: 'Method description',
  wdo_target: 'Wood-destroying organism treated for',
  product_name: 'Product used',
  product_name_other: 'Product (other)',
  epa_registration: 'EPA registration #',
  active_ingredient: 'Active ingredient',
  concentration_pct: 'Concentration (%)',
  square_footage: 'Square footage treated',
  linear_feet: 'Linear feet treated',
  trench_depth_ft: 'Trench / rod depth (ft)',
  gallons_applied: 'Gallons applied',
  applicator_name: "Applicator's printed name",
  applicator_fdacs_id: 'Applicator FDACS ID #',
  applicator_attestation: 'Applicator attestation',
  warranty_type: 'Warranty / retreatment bond',
  renewal_due: 'Renewal due by',
};

function humanizeKey(k) {
  return FIELD_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatFindingValue(key, value) {
  const raw = String(value);
  if (key !== 'species') return raw;
  return raw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

const ROOF_RAT_SPECIES_NOTE = [
  'Roof rats are common climbers in Florida and often access homes through garage gaps, soffits, vents, roof returns, utility openings, and vegetation touching the structure.',
  'Because they can contaminate insulation, storage areas, and household surfaces, entry points should be sealed after trapping activity is addressed.',
].join(' ');

const ROOF_RAT_LEARN_MORE = [
  "UF/IFAS describes roof rats as one of Florida's most serious household rodent pests because they are well adapted to climbing trees, vines, utility lines, fences, and rooflines.",
  "Adults are usually about 12-14 inches long including the tail and 5-10 ounces, but Florida's warm climate can support multiple litters per year.",
  'The Florida Department of Health associates rats and mice with illnesses such as leptospirosis, salmonella, typhus, and rat-bite fever, so droppings, urine, saliva, nesting material, and contaminated dust are part of the concern.',
].join(' ');

function getFindingInsight(key, value) {
  if (key === 'species' && includesAny(value, ['roof rat'])) return ROOF_RAT_SPECIES_NOTE;
  return '';
}

function isRoofRatFinding(key, value) {
  return key === 'species' && includesAny(value, ['roof rat']);
}

function includesAny(text, words) {
  const value = String(text || '').toLowerCase();
  return words.some(word => value.includes(word));
}

function buildAtAGlance({ data, reportTitle }) {
  const rows = [
    ['Service type', reportTitle],
  ];
  if (data.upcomingAppointment) {
    rows.push(['Follow-up', formatAppointmentWindow(data.upcomingAppointment)]);
  } else if (data.followupCompletedAt) {
    rows.push(['Follow-up completed', formatAppointmentDate(data.followupCompletedAt)]);
  } else if (data.followupDate) {
    const followupLabel = formatAppointmentDate(data.followupDate);
    rows.push(['Follow-up', isPastReportDate(data.followupDate) ? `Past due: ${followupLabel}` : followupLabel]);
  }
  return rows.filter(([, value]) => value);
}

function isPastReportDate(value) {
  const key = reportDateKey(value);
  if (!key) return false;
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => todayParts.find(part => part.type === type)?.value || '';
  return key < `${get('year')}-${get('month')}-${get('day')}`;
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
    <div style={{ minHeight: '100vh', background: ESTIMATE_BG, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT_BODY }}>
      <div style={{ ...cardStyle, width: 'min(420px, calc(100% - 40px))' }}>
        <div style={{ height: 12, width: 120, background: B.offWhite, borderRadius: 4 }} />
        <div style={{ height: 32, width: '70%', background: B.offWhite, borderRadius: 4, marginTop: 14 }} />
        <div style={{ height: 14, width: '50%', background: B.offWhite, borderRadius: 4, marginTop: 10 }} />
      </div>
    </div>
  );

  if (!data || data.error) return (
    <div style={{ minHeight: '100vh', background: ESTIMATE_BG, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONT_BODY }}>
      <div style={{ ...cardStyle, maxWidth: 420, textAlign: 'center' }}>
        <div style={{ color: ESTIMATE_MUTED }}><Icon name="document" size={32} strokeWidth={1.75} /></div>
        <div style={{ fontFamily: FONTS.serif, fontSize: 28, fontWeight: 500, color: ESTIMATE_TEXT, marginTop: 8 }}>Report unavailable</div>
        <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.55, marginTop: 8 }}>
          This link may have expired or is not valid.
        </div>
        <a href={`tel:${WAVES_PHONE_TEL}`} style={{
          ...primaryButtonStyle, marginTop: 18,
        }}>Call Waves</a>
      </div>
    </div>
  );

  const typeLabel = TYPE_LABELS[data.projectType] || 'Project';
  const reportTitle = String(data.title || '').trim() || typeLabel;
  const findings = data.findings || {};
  const findingsEntries = Object.entries(findings)
    .filter(([k, v]) => !INTERNAL_FINDING_KEYS.has(k) && v !== null && v !== undefined && v !== '');
  const primaryPhotos = (data.photos || []).filter(p => p.visit === 'primary');
  const followupPhotos = (data.photos || []).filter(p => p.visit === 'followup');
  const projectDateLabel = formatReportDate(data.projectDate || data.sentAt);
  const sentDateLabel = data.sentAt ? formatReportDate(data.sentAt) : '';
  const showSentDate = sentDateLabel && reportDateKey(data.sentAt) !== reportDateKey(data.projectDate);
  const reportMetaStyle = { fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.45 };
  const isCertificate = data.projectType === 'pre_treatment_termite_certificate';
  const contactDateLabel = isCertificate
    ? (projectDateLabel ? `Treatment date: ${projectDateLabel}${data.technicianName ? ` · Applicator: ${data.technicianName}` : ''}` : '')
    : (projectDateLabel ? `Inspection date: ${projectDateLabel}${data.technicianName ? ` · ${data.technicianName}` : ''}` : '');
  const contactRows = [
    contactDateLabel,
    showSentDate ? `Report sent: ${sentDateLabel}` : '',
    data.customerAddress || '',
    data.customerEmail ? `Email: ${data.customerEmail}` : '',
    data.customerPhone ? `Phone: ${data.customerPhone}` : '',
  ].filter(Boolean);
  // The structured findings feed the AI writer, so when the report carries
  // the sectioned narrative (Customer Concern / What We Inspected / …) the
  // raw findings list would repeat the same content — the narrative is the
  // customer-facing rendering of it. Raw findings still show on reports
  // without a drafted narrative, otherwise they'd have no body at all.
  const aiNarrativeSections = data.recommendations ? parseSections(String(data.recommendations)) : null;
  const atAGlanceRows = buildAtAGlance({ data, reportTitle });
  const firstName = String(data.customerName || '').trim().split(/\s+/)[0] || 'there';
  const headline = isCertificate
    ? `Hey ${firstName}, here's your Certificate of Compliance.`
    : `Hey ${firstName}, here's your ${typeLabel.toLowerCase()} report.`;
  const subhead = data.customerAddress || data.cityState || '';

  return (
    <div style={{
      minHeight: '100vh',
      background: ESTIMATE_BG,
      fontFamily: FONT_BODY,
      color: ESTIMATE_TEXT,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Mirrors the pest/lawn service-report top bar (.sr-top): phone left,
          logo right, same 62px bar on the shared 960px grid. */}
      <header style={{ background: B.white, borderBottom: `1px solid ${ESTIMATE_BORDER}` }}>
        <div style={{
          maxWidth: 960,
          margin: '0 auto',
          minHeight: 62,
          padding: '16px 24px',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}>
          <a href={`tel:${WAVES_PHONE_TEL}`} style={{
            color: ESTIMATE_TEXT,
            fontSize: 15,
            fontWeight: 600,
            textDecoration: 'none',
          }}>
            {WAVES_PHONE_DISPLAY}
          </a>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 28, display: 'block' }} />
        </div>
      </header>

      <main style={{ flex: 1, padding: '32px 20px 64px', maxWidth: 720, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        <div style={{ padding: '8px 0 24px' }}>
          <div style={{ ...eyebrowStyle, marginBottom: 6 }}>
            Project report{typeLabel ? ` · ${typeLabel}` : ''}
          </div>
          <h1 style={{
            fontFamily: FONTS.serif,
            fontSize: 'clamp(34px, 5vw, 48px)',
            fontWeight: 500,
            letterSpacing: 0,
            lineHeight: 1.1,
            color: ESTIMATE_TEXT,
            margin: 0,
          }}>
            {headline}
          </h1>
          {subhead ? (
            <div style={{ fontSize: 20, color: ESTIMATE_BODY, marginTop: 16, lineHeight: 1.35 }}>{subhead}</div>
          ) : null}
        </div>

        {/* Summary card */}
        <div style={cardStyle}>
          {contactRows.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ ...eyebrowStyle, marginBottom: 4 }}>Report details</div>
              {contactRows.map(row => (
                <div key={row} style={{ ...reportMetaStyle, whiteSpace: 'pre-wrap' }}>{row}</div>
              ))}
            </div>
          )}

          {!isCertificate && atAGlanceRows.length > 0 && <AtAGlance rows={atAGlanceRows} />}

          {/* Findings — suppressed on the Certificate of Compliance (the
              Certificate block below renders the same data in its branded,
              FBC-compliant document layout) and whenever the AI-drafted
              sectioned narrative is present (the narrative IS the customer
              rendering of these fields — showing both reads twice). */}
          {!isCertificate && !aiNarrativeSections && findingsEntries.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ ...eyebrowStyle, marginBottom: 10 }}>
                Findings
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {findingsEntries.map(([key, value]) => {
                  const insight = getFindingInsight(key, value);
                  const showRoofRatPhoto = isRoofRatFinding(key, value);
                  const formattedValue = formatFindingValue(key, value);
                  return (
                    <div key={key} style={{ padding: '12px 14px', borderRadius: 10, background: ESTIMATE_INPUT_BG, border: `1px solid ${ESTIMATE_INPUT_BORDER}` }}>
                      {key === 'species' ? (
                        <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                          <strong style={{ color: ESTIMATE_TEXT }}>Species:</strong> {formattedValue}
                        </div>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, fontWeight: 700, color: ESTIMATE_TEXT, marginBottom: 3 }}>{humanizeKey(key)}</div>
                          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{formattedValue}</div>
                        </>
                      )}
                      {showRoofRatPhoto && <RoofRatPhoto />}
                      {insight && (
                        <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.55, marginTop: 8 }}>
                          {insight}
                        </div>
                      )}
                      {showRoofRatPhoto && (
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ fontSize: 14, fontWeight: 800, color: ESTIMATE_TEXT, cursor: 'pointer' }}>
                            Learn more about roof rats
                          </summary>
                          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.55, marginTop: 6 }}>
                            {ROOF_RAT_LEARN_MORE}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recommendations — if the text is the three-section AI-drafted
               format, render each section with its own heading. Otherwise
               fall back to the single "Recommendations" block. */}
          {!isCertificate && data.recommendations && <RecommendationsBlock text={data.recommendations} upcomingAppointment={data.upcomingAppointment} />}
        </div>

        {data.projectType === 'wdo_inspection' && (
          <div style={{ ...cardStyle, marginTop: 16 }}>
            <div style={{ ...eyebrowStyle, marginBottom: 6 }}>
              Official WDO Form
            </div>
            <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.55 }}>
              {data.fdacsPdfAvailable
                ? 'Your completed, signed FDACS-13645 Wood-Destroying Organisms Inspection Report — exactly as it was filed.'
                : 'This inspection follows Florida FDACS-13645, Wood-Destroying Organisms Inspection Report.'}
            </div>
            <a
              href={data.fdacsPdfAvailable
                ? `${API_BASE}/reports/project/${token}/fdacs-pdf`
                : '/forms/fdacs-13645-wdo-inspection-report.pdf'}
              target="_blank"
              rel="noreferrer"
              style={{
                ...secondaryButtonStyle, marginTop: 14,
              }}
            >
              <Icon name="document" size={15} strokeWidth={2} /> View FDACS-13645
            </a>
          </div>
        )}

        {isCertificate && (
          <CertificateOfCompliance
            findings={findings}
            customerName={data.customerName}
            customerAddress={data.customerAddress}
            technicianName={data.technicianName}
            projectDateLabel={projectDateLabel}
          />
        )}

        {/* Primary visit photos */}
        {primaryPhotos.length > 0 && (
          <PhotoGrid title="Photos" photos={primaryPhotos} />
        )}

        {/* Follow-up visit (bed bug) */}
        {(data.followupCompletedAt || data.followupFindings || followupPhotos.length > 0) && (
          <div style={{ ...cardStyle, marginTop: 16 }}>
            <div style={{ fontFamily: FONTS.serif, fontSize: 24, fontWeight: 500, color: ESTIMATE_TEXT }}>
              Follow-up visit
            </div>
            {data.followupCompletedAt && (
              <div style={{ fontSize: 14, color: ESTIMATE_BODY, marginTop: 4 }}>
                {new Date(data.followupCompletedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            )}
            {data.followupFindings && Object.keys(data.followupFindings).length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(data.followupFindings).filter(([, v]) => v).map(([key, value]) => (
                  <div key={key} style={{ padding: '10px 12px', borderRadius: 8, background: ESTIMATE_INPUT_BG, border: `1px solid ${ESTIMATE_INPUT_BORDER}` }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: ESTIMATE_TEXT }}>{humanizeKey(key)}</div>
                    <div style={{ fontSize: 14, color: ESTIMATE_BODY, whiteSpace: 'pre-wrap' }}>{String(value)}</div>
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
          <div style={{ fontSize: 14, color: ESTIMATE_BODY }}>Questions about this report?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginTop: 10 }}>
            <a href={`sms:${WAVES_PHONE_TEL}`} style={{
              ...primaryButtonStyle,
            }}><Icon name="message" size={16} strokeWidth={2} /> Text Us</a>
            <a href={`tel:${WAVES_PHONE_TEL}`} style={{
              ...secondaryButtonStyle,
            }}><Icon name="phone" size={16} strokeWidth={2} /> Call Us</a>
          </div>
        </div>

        <ReportTrustStrip />

        {/* Same closing treatment as the pest/lawn service reports: a
            for-your-records note plus the document brand footer (company
            block + service-area links) — not the newsletter/social footer. */}
        <footer style={{ color: ESTIMATE_MUTED, fontSize: 12, lineHeight: 1.6, padding: '22px 0 0' }}>
          Questions about this report? Ask Waves in your portal or call {WAVES_PHONE_DISPLAY}.
          {' '}This report is provided for your records.
        </footer>
        <BrandFooter variant="document" />
      </main>
    </div>
  );
}

function ReportTrustStrip() {
  const items = [
    { label: 'Licensed & insured', detail: `FDACS LIC. ${WAVES_FDACS_LICENSE_NUMBER}` },
    { label: 'Questions welcome', detail: 'call or text the Waves team' },
    { label: 'Local service', detail: 'Southwest Florida pest specialists' },
  ];

  return (
    <div style={{
      marginTop: 32,
      padding: '24px 16px',
      background: B.offWhite,
      borderTop: `1px solid ${ESTIMATE_BORDER}`,
      borderRadius: 12,
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 16,
      }}>
        {items.map((item) => (
          <div key={item.label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: ESTIMATE_TEXT }}>{item.label}</div>
            <div style={{ fontSize: 12, color: ESTIMATE_MUTED, marginTop: 2 }}>{item.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AtAGlance({ rows }) {
  return (
    <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 10, background: ESTIMATE_INPUT_BG, border: `1px solid ${ESTIMATE_INPUT_BORDER}` }}>
      <div style={{ ...eyebrowStyle, marginBottom: 10 }}>
        At a glance
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 0.45fr) 1fr', gap: '8px 12px' }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: ESTIMATE_TEXT }}>{label}</div>
            <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.45 }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * CertificateOfCompliance — Florida Building Code 1816.1.7 Certificate for
 * pre-construction subterranean termite soil treatment. The layout follows
 * the customer estimate visual language while preserving required certificate
 * fields and statutory language. Stamp ID: WV-002.
 *
 * Required content per FBC 1816.1.7: company name + phone, treatment address
 * or lot/block, method of treatment, the exact compliance statement, and an
 * authorized applicator signature. Additional fields (product/EPA/A.I./
 * concentration, sq ft, gallons, FDACS ID, warranty) satisfy FDACS Rule
 * 5E-14.106 treatment-record requirements simultaneously.
 */
function CertificateOfCompliance({ findings, customerName, customerAddress, technicianName, projectDateLabel }) {
  const f = findings || {};
  const method = f.treatment_method === 'Other' && f.treatment_method_other
    ? f.treatment_method_other
    : f.treatment_method;
  const product = f.product_name === 'Other' && f.product_name_other
    ? f.product_name_other
    : f.product_name;
  const productLine = [product, f.epa_registration ? `EPA Reg. ${f.epa_registration}` : '']
    .filter(Boolean)
    .join(' · ');
  const aiLine = [
    f.active_ingredient,
    f.concentration_pct ? `${String(f.concentration_pct).replace(/%$/, '')}%` : '',
  ].filter(Boolean).join(' — ');
  const trenchDepthRaw = String(f.trench_depth_ft || '').trim();
  const trenchDepthLine = !trenchDepthRaw
    ? ''
    : /depth/i.test(trenchDepthRaw)
      ? trenchDepthRaw
      // Inch notation ("6 in", 6", "6in.") counts as already-united — the
      // create form accepts it, so appending ft would print "6 in ft depth".
      : `${valueWithUnit(trenchDepthRaw, 'ft', /("|\b(ft|foot|feet|inch|inches)\b|\din\b|\bin\b)/i)} depth`;
  const coverageLine = [
    valueWithUnit(f.square_footage, 'sq ft', /\b(sq\.?\s*ft|square\s*feet|sf)\b/i),
    valueWithUnit(f.linear_feet, 'linear ft', /\b(linear\s*ft|lineal\s*ft|lf)\b/i),
    trenchDepthLine,
    gallonsApplied(f.gallons_applied),
  ].filter(Boolean).join(' · ');
  const treatmentDateValue = [
    f.treatment_date ? formatReportDate(f.treatment_date) : projectDateLabel || '',
    formatAppointmentTime(f.treatment_time),
  ].filter(Boolean).join(' · ');
  const addressValue = f.treatment_address || customerAddress || '';
  const lotLine = [f.lot_block, f.subdivision].filter(Boolean).join(' · ');
  const applicatorLine = [
    f.applicator_name || technicianName || '',
    f.applicator_fdacs_id ? `FDACS ID ${f.applicator_fdacs_id}` : '',
  ].filter(Boolean).join(' · ');
  const warrantyLine = [
    f.warranty_type,
    f.renewal_due ? `Renewal due ${f.renewal_due}` : '',
  ].filter(Boolean).join(' · ');

  const fields = [
    ['Treatment address', addressValue],
    ['Lot / Block / Subdivision', lotLine],
    ['Building permit #', f.permit_number],
    ['Builder / General contractor', f.builder_contractor],
    ['Date & time of treatment', treatmentDateValue],
    ['Method of treatment', method],
    ['Wood-destroying organism treated for', f.wdo_target],
    ['Product used', productLine],
    ['Active ingredient & concentration', aiLine],
    ['Coverage', coverageLine],
    ['Applicator', applicatorLine],
    ['Warranty / retreatment bond', warrantyLine],
  ];

  return (
    <div style={{
      marginTop: 16,
      background: B.white,
      borderRadius: 16,
      border: `1px solid ${ESTIMATE_BORDER}`,
      overflow: 'hidden',
      position: 'relative',
    }}>
      <div style={{
        background: B.white,
        borderBottom: `1px solid ${ESTIMATE_BORDER}`,
        padding: '22px 24px 20px',
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 18,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{
            ...eyebrowStyle,
            fontWeight: 700,
            marginBottom: 4,
          }}>
            Florida Certificate of Compliance
          </div>
          <div style={{
            fontFamily: FONTS.serif,
            fontSize: 30,
            fontWeight: 500,
            color: ESTIMATE_TEXT,
            lineHeight: 1.15,
            letterSpacing: 0,
          }}>
            Pre-Construction Termite Protection
          </div>
          <div style={{
            fontSize: 14,
            color: ESTIMATE_BODY,
            marginTop: 8,
            lineHeight: 1.4,
          }}>
            Required by FL Building Code 1816.1.7 • FL Statutes 482.226 • FDACS LIC. {WAVES_FDACS_LICENSE_NUMBER}
          </div>
        </div>
        <img src="/waves-logo.png" alt="Waves" style={{ height: 32, flexShrink: 0 }} />
      </div>

      {/* Property + customer header */}
      <div style={{ padding: '18px 24px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {customerName && (
          <div style={{ fontSize: 14, fontWeight: 800, color: ESTIMATE_TEXT }}>
            Issued to: {customerName}
          </div>
        )}
      </div>

      {/* Field grid */}
      <div style={{
        padding: '16px 24px 8px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        rowGap: 14,
        columnGap: 18,
      }}>
        {fields.map(([label, value]) => (
          <div key={label}>
            <div style={{
              fontFamily: FONT_BODY,
              fontSize: 12,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0,
              color: ESTIMATE_MUTED,
              marginBottom: 5,
            }}>
              {label}
            </div>
            <div style={{
              fontFamily: FONT_BODY,
              fontSize: 14,
              fontWeight: 700,
              color: ESTIMATE_TEXT,
              minHeight: 20,
              borderBottom: `1px solid ${ESTIMATE_BORDER}`,
              paddingBottom: 4,
              wordBreak: 'break-word',
            }}>
              {value || '—'}
            </div>
          </div>
        ))}
      </div>

      {/* FBC required compliance statement (exact wording per 1816.1.7) */}
      <div style={{ padding: '16px 24px 4px' }}>
        <div style={{
          fontSize: 15,
          color: ESTIMATE_BODY,
          lineHeight: 1.55,
          textAlign: 'center',
          padding: '14px 16px',
          borderRadius: 12,
          background: ESTIMATE_INPUT_BG,
          border: `1px solid ${ESTIMATE_INPUT_BORDER}`,
        }}>
          The building has received a complete treatment for the prevention of subterranean termites.
          Treatment is in accordance with rules and laws established by the Florida Department of
          Agriculture and Consumer Services.
        </div>
        <div style={{
          fontSize: 14,
          color: B.red,
          fontWeight: 700,
          lineHeight: 1.5,
          textAlign: 'center',
          marginTop: 10,
          padding: '0 8px',
        }}>
          This Certificate must be retained in the building permit file as required by FBC 1816.1.7.
        </div>
        {f.comments && (
          <div style={{
            marginTop: 12,
            padding: '12px 14px',
            borderRadius: 10,
            background: ESTIMATE_INPUT_BG,
            border: `1px solid ${ESTIMATE_INPUT_BORDER}`,
            fontSize: 14,
            color: ESTIMATE_BODY,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
          }}>
            <div style={{ ...eyebrowStyle, marginBottom: 4 }}>
              Applicator notes
            </div>
            {f.comments}
          </div>
        )}
      </div>

      {/* Electronic signature / attestation block — FBC 1816.1.7 requires
          an authorized applicator signature. The typed attestation + printed
          name + FDACS ID + treatment date together constitute an electronic
          signature accepted by Florida building departments. */}
      {f.applicator_attestation && (f.applicator_name || technicianName) && (
        <div style={{
          margin: '16px 24px 0',
          padding: '14px 16px',
          borderRadius: 12,
          background: '#F5F1E6',
          border: `1px solid ${ESTIMATE_BORDER}`,
        }}>
          <div style={{
            ...eyebrowStyle,
            marginBottom: 6,
          }}>
            Signed electronically
          </div>
          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.55 }}>
            {f.applicator_attestation}
          </div>
          <div style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${ESTIMATE_BORDER}`,
            fontSize: 14,
            color: ESTIMATE_TEXT,
            lineHeight: 1.5,
          }}>
            <span style={{ color: B.green, fontWeight: 800, marginRight: 6 }}>Signed by</span>
            <span style={{ fontWeight: 700 }}>{f.applicator_name || technicianName}</span>
            {f.applicator_fdacs_id ? ` · FDACS ID ${f.applicator_fdacs_id}` : ''}
            {(f.treatment_date || projectDateLabel) ? (
              <>
                <br />
                <span style={{ color: ESTIMATE_BODY, fontSize: 14 }}>
                  Attested on {f.treatment_date ? formatReportDate(f.treatment_date) : projectDateLabel}
                </span>
              </>
            ) : null}
          </div>
        </div>
      )}

      <div style={{
        margin: '18px 24px 24px',
        background: ESTIMATE_BUTTON_BG,
        borderRadius: 12,
        padding: '16px 18px',
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: FONT_BODY,
          fontSize: 15,
          fontWeight: 800,
          color: B.white,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}>
          Activate Your Termite Warranty
        </div>
        <div style={{
          fontSize: 14,
          color: B.white,
          opacity: 0.94,
          marginTop: 4,
          letterSpacing: 0.3,
        }}>
          {WAVES_PHONE_DISPLAY} • wavespestcontrol.com/register
        </div>
        <div style={{
          fontSize: 10,
          color: B.white,
          opacity: 0.85,
          marginTop: 6,
        }}>
          Waves Pest Control, LLC • 13649 Luxe Ave #110, Bradenton, FL 34211
        </div>
      </div>

      {/* Form-ID stamp — bottom right, matches v10 "WV-001" treatment */}
      <div style={{
        position: 'absolute',
        bottom: 7,
        right: 10,
        fontSize: 9,
        color: ESTIMATE_MUTED,
        opacity: 0.8,
        letterSpacing: 0.5,
        fontFamily: FONTS.mono,
      }}>
        WV-002
      </div>
    </div>
  );
}

function RoofRatPhoto() {
  return (
    <figure style={{ margin: '10px 0 0', borderRadius: 10, overflow: 'hidden', border: `1px solid ${ESTIMATE_BORDER}`, background: B.white }}>
      <img
        src="/brand/roof-rat-report.png"
        alt="Roof rat"
        style={{ display: 'block', width: '100%', maxHeight: 240, objectFit: 'cover' }}
      />
    </figure>
  );
}

function getPhotoLabel(photo) {
  return photo.caption || (photo.category ? `${photo.category.replace(/_/g, ' ')} photo` : 'Service photo');
}

function PhotoGrid({ title, photos, noCard }) {
  const content = (
    <div>
      {title && (
        <div style={{ ...eyebrowStyle, marginBottom: 10 }}>
          {title}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
        {photos.map(ph => {
          const label = getPhotoLabel(ph);
          const tileStyle = {
            display: 'block', aspectRatio: '1/1', overflow: 'hidden',
            borderBottom: `1px solid ${ESTIMATE_BORDER}`, background: ESTIMATE_BG,
          };
          const media = (
            <>
            {ph.url ? (
              <img
                src={ph.url}
                alt={label}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <div style={{
                width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 12, textAlign: 'center', color: ESTIMATE_MUTED, fontSize: 14, fontWeight: 700,
              }}>
                Photo unavailable
              </div>
            )}
            </>
          );
          return (
            <div key={ph.id} style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${ESTIMATE_BORDER}`, background: B.white }}>
              {ph.url ? (
                <a href={ph.url} target="_blank" rel="noreferrer" style={tileStyle}>
                  {media}
                </a>
              ) : (
                <div style={tileStyle}>
                  {media}
                </div>
              )}
              <div style={{ padding: '8px 9px' }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: ESTIMATE_TEXT, lineHeight: 1.35, textTransform: 'capitalize' }}>
                  {label}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  if (noCard) return content;
  return (
    <div style={{ ...cardStyle, marginTop: 16 }}>
      {content}
    </div>
  );
}

// Heuristic: if the text contains the core section markers, split it into
// named sections and render each with its own heading. Otherwise render the
// whole block under a single "Recommendations" heading like before.
const REQUIRED_SECTION_HEADINGS = ['WHAT WE INSPECTED', 'WHAT WE FOUND', 'WHAT WE RECOMMEND'];
const SECTION_HEADINGS = ['CUSTOMER CONCERN', 'WHAT WE INSPECTED', 'WHAT WE FOUND', 'WHAT WE DID', 'WHAT WE RECOMMEND'];

function parseSections(text) {
  const hasAll = REQUIRED_SECTION_HEADINGS.every(h => text.includes(h));
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
  const foundRequired = REQUIRED_SECTION_HEADINGS.every(h => sections.some(s => s.heading === h));
  return foundRequired ? sections : null;
}

function titleCase(s) {
  return s.split(' ').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
}

function RecommendationsBlock({ text, upcomingAppointment }) {
  const sections = parseSections(text);
  if (sections) {
    return (
      <div style={{ marginTop: 16, padding: '18px 20px', borderRadius: 12, background: ESTIMATE_INPUT_BG, border: `1px solid ${ESTIMATE_INPUT_BORDER}` }}>
        {sections.map((s, i) => (
          <div key={s.heading} style={{ marginTop: i === 0 ? 0 : 14 }}>
            <div style={{ ...eyebrowStyle, marginBottom: 6 }}>
              {titleCase(s.heading)}
            </div>
            <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{s.body}</div>
            {s.heading === 'WHAT WE RECOMMEND' && shouldShowBookingCta(s.body) && <BookingCta upcomingAppointment={upcomingAppointment} text={s.body} />}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16, padding: '18px 20px', borderRadius: 12, background: ESTIMATE_INPUT_BG, border: `1px solid ${ESTIMATE_INPUT_BORDER}` }}>
      <div style={{ ...eyebrowStyle, marginBottom: 6 }}>Recommendations</div>
      <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{text}</div>
      {shouldShowBookingCta(text) && <BookingCta upcomingAppointment={upcomingAppointment} text={text} />}
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

function BookingCta({ upcomingAppointment, text }) {
  const appt = upcomingAppointment;
  if (appt) {
    return (
      <div style={{
        marginTop: 14,
        padding: '14px 16px',
        borderRadius: 10,
        background: B.white,
        border: `1px solid ${ESTIMATE_BORDER}`,
        textAlign: 'center',
      }}>
        <div style={{ ...eyebrowStyle }}>
          Upcoming appointment
        </div>
        <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.55, marginTop: 4 }}>
          {[appt.serviceType, formatAppointmentWindow(appt)].filter(Boolean).join(' - ')}
        </div>
        {appt.technicianName && (
          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.45 }}>
            Technician: {appt.technicianName}
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 14, display: 'flex', justifyContent: 'center' }}>
      <a
        href={BOOK_URL}
        target="_blank"
        rel="noreferrer"
        style={{
          ...primaryButtonStyle,
        }}
      >
        <Icon name="calendar" size={15} strokeWidth={2} /> {includesAny(text, ['rodent', 'exclusion', 'trap']) ? 'Request Exclusion Estimate' : 'Book an appointment'}
      </a>
    </div>
  );
}
