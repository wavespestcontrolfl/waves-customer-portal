import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  COLORS as B,
  FONTS,
  GOLD_CTA,
  INFO_CTA,
  HALFTONE_PATTERN,
  HALFTONE_SIZE,
} from '../theme-brand';
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
  flea: 'Flea Service',
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
  host_activity: 'Host / activity notes',
  treatment_areas: 'Treatment areas',
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

function getProjectKind(projectType) {
  if (projectType === 'wdo_inspection') return 'wdo';
  if (projectType === 'termite_inspection') return 'termite';
  if (projectType === 'rodent_exclusion') return 'rodent';
  if (projectType === 'bed_bug') return 'bed_bug';
  if (projectType === 'flea') return 'flea';
  if (projectType === 'pest_inspection') return 'pest';
  return 'general';
}

function getRiskInsight(kind, allText) {
  if (kind === 'rodent') {
    if (includesAny(allText, ['roof rat'])) {
      return 'Roof rats are strong climbers, so soffits, roof returns, vents, utility gaps, and overhanging vegetation can become repeat access routes. Once inside, they may contaminate insulation, gnaw wiring or AC lines, and keep returning until openings are sealed.';
    }
    if (includesAny(allText, ['norway rat'])) {
      return 'Norway rats usually work from ground-level burrows, wall gaps, garage seals, and utility penetrations. Activity can expand quickly when food, water, and shelter stay available, so exclusion and sanitation matter as much as trap placement.';
    }
    if (includesAny(allText, ['mouse', 'mice'])) {
      return 'Mice can fit through very small openings and often use garage seals, pipe gaps, and stored materials as cover. A small opening can keep producing activity until the access route is corrected.';
    }
    return 'Rodents do more than create noise or droppings. They can contaminate stored items and insulation, chew wiring and soft building materials, and keep cycling through the same access points until exclusion work closes the routes.';
  }
  if (kind === 'termite') {
    return 'Termites can damage wood framing and trim from concealed areas before the surface looks severe. Early treatment and moisture correction help limit repair costs and reduce the chance of activity spreading.';
  }
  if (kind === 'wdo') {
    return 'Wood-destroying organisms and moisture conditions can affect structural materials over time. Correcting the source early helps protect the property and keeps inspection findings from becoming larger repair issues.';
  }
  if (kind === 'bed_bug') {
    return 'Bed bugs spread through resting areas, furniture, luggage, and personal items, and missed preparation can make follow-up activity harder to control. A complete treatment plan and the scheduled recheck are what keep the problem contained.';
  }
  if (kind === 'flea') {
    return 'Fleas can continue emerging from eggs and pupae after the first service, especially around pet resting areas, rugs, furniture edges, shaded yard areas, and wildlife travel zones. Vacuuming, pet flea prevention, and follow-up timing are what keep the cycle from restarting.';
  }
  if (kind === 'pest') {
    return 'General pest pressure is usually strongest where food, water, shelter, or entry gaps line up. Treating the current activity while correcting those conditions helps prevent the same issue from returning.';
  }
  return 'Targeted service works best when the finding, source condition, and follow-up plan all match the specific issue documented in the report.';
}

function buildClientSnapshot({ projectType, findings, recommendations }) {
  const allText = [
    projectType,
    recommendations,
    ...Object.values(findings || {}),
  ].filter(Boolean).join(' ').toLowerCase();

  const hasAction = shouldShowBookingCta(recommendations);
  const kind = getProjectKind(projectType);
  const hasMoisture = includesAny(allText, ['moisture', 'wood rot', 'rot ', 'leak', 'eave', 'attic']);
  const hasWdo = includesAny(allText, ['termite', 'wdo', 'wood-destroying', 'shelter tube', 'frass', 'boracare', 'bora care']);
  const hasRodent = includesAny(allText, ['rodent', 'rat', 'mouse', 'entry point', 'exclusion', 'trap']);
  const clean = includesAny(allText, ['no visible signs', 'no activity', 'none observed', 'not observed']) && !hasAction;

  if (clean) {
    return {
      priority: 'Monitor',
      meaning: kind === 'rodent'
        ? 'No active rodent pressure was documented at the time of inspection.'
        : 'No visible active issue was documented at the time of inspection.',
      insight: getRiskInsight(kind, allText),
      next: kind === 'rodent'
        ? 'Keep exterior access points monitored and contact Waves if scratching, droppings, odors, or new entry signs appear.'
        : 'Keep routine service and address new activity, moisture, or access issues if they appear.',
    };
  }
  if (kind === 'rodent' || (kind === 'general' && hasRodent)) {
    return {
      priority: hasAction ? 'Action recommended' : 'Review recommended',
      meaning: 'Rodent activity usually continues until entry points, travel routes, and nesting conditions are corrected together.',
      insight: getRiskInsight('rodent', allText),
      next: hasAction ? 'Schedule the recommended exclusion, trapping, or follow-up plan.' : 'Review the mapped areas and contact Waves with any activity changes.',
    };
  }
  if (kind === 'termite') {
    return {
      priority: hasAction ? 'Action recommended' : 'Review recommended',
      meaning: 'Termite activity or conditions that support termites can affect wood members and may worsen if the source is not corrected.',
      insight: getRiskInsight('termite', allText),
      next: hasAction ? 'Review the recommendation and schedule the listed termite treatment or follow-up.' : 'Review the findings and contact Waves if you want help prioritizing treatment options.',
    };
  }
  if (kind === 'wdo' || (kind === 'general' && (hasWdo || hasMoisture))) {
    return {
      priority: hasAction ? 'Action recommended' : 'Review recommended',
      meaning: 'Moisture, wood damage, or WDO evidence can affect structural materials and may worsen if the source is not corrected.',
      insight: getRiskInsight('wdo', allText),
      next: hasAction ? 'Review the recommendation and schedule the listed treatment or follow-up.' : 'Review the findings and contact Waves if you want help prioritizing repairs or treatment.',
    };
  }
  if (kind === 'bed_bug') {
    return {
      priority: hasAction ? 'Action recommended' : 'Review recommended',
      meaning: 'Bed bug work depends on treatment coverage, customer preparation, and a timely follow-up check.',
      insight: getRiskInsight('bed_bug', allText),
      next: hasAction ? 'Complete the listed preparation steps and keep the recommended follow-up on schedule.' : 'Review the treated rooms and contact Waves if activity is seen before the follow-up window.',
    };
  }
  if (kind === 'flea') {
    return {
      priority: hasAction ? 'Action recommended' : 'Review recommended',
      meaning: 'Flea work depends on treating the active areas while breaking the egg, larva, pupa, and adult cycle.',
      insight: getRiskInsight('flea', allText),
      next: hasAction ? 'Complete the prep steps, keep vacuuming on schedule, and follow the listed treatment or follow-up plan.' : 'Review the inspected areas and contact Waves if bites or pet activity continue.',
    };
  }
  if (kind === 'pest') {
    return {
      priority: hasAction ? 'Action recommended' : 'Review recommended',
      meaning: 'The report documents pest pressure or conducive conditions that can keep activity returning if they are not addressed.',
      insight: getRiskInsight('pest', allText),
      next: hasAction ? 'Use the recommendation below to book the correct pest service.' : 'Review the findings and contact Waves if the activity changes or spreads.',
    };
  }
  if (hasAction) {
    return {
      priority: 'Action recommended',
      meaning: 'The inspection found conditions that benefit from a targeted service or follow-up.',
      insight: getRiskInsight(kind, allText),
      next: 'Use the recommendation below to book the correct next visit.',
    };
  }
  return null;
}

function getReportText(data, findings) {
  return [
    data?.projectType,
    data?.title,
    data?.recommendations,
    ...Object.values(findings || {}),
  ].filter(Boolean).join(' ').toLowerCase();
}

function buildAtAGlance({ data, findings, reportTitle, clientSnapshot }) {
  const text = getReportText(data, findings);
  const kind = getProjectKind(data.projectType);
  const rows = [
    ['Service type', reportTitle],
  ];
  if (kind === 'rodent' || includesAny(text, ['rat', 'rodent', 'trap'])) {
    rows.push(['Activity level', includesAny(text, ['active', 'trap', 'pressure']) ? 'Active / suspected active roof rat activity' : 'Rodent activity documented']);
    rows.push(['Primary concern', includesAny(text, ['garage', 'jamb']) ? 'Garage entry point at right-side jamb' : 'Rodent travel routes and possible entry points']);
    rows.push(['Immediate action', includesAny(text, ['trap']) ? 'Leave traps undisturbed and keep children and pets away' : 'Monitor activity and avoid disturbing evidence']);
    rows.push(['Recommended next step', includesAny(text, ['seal', 'sweep', 'exclusion']) ? 'Garage door seal repair plus follow-up trapping/exclusion inspection' : clientSnapshot?.next || 'Review findings with Waves']);
  } else if (clientSnapshot) {
    rows.push(['Next step', clientSnapshot.priority]);
    rows.push(['Recommended action', clientSnapshot.next]);
  }
  if (data.upcomingAppointment) {
    rows.push(['Follow-up', formatAppointmentWindow(data.upcomingAppointment)]);
  } else if (data.followupDate) {
    rows.push(['Follow-up', formatAppointmentDate(data.followupDate)]);
  }
  return rows.filter(([, value]) => value);
}

function buildReportSummary({ text }) {
  if (!includesAny(text, ['roof rat']) || !includesAny(text, ['right-side jamb'])) return '';
  if (!includesAny(text, ['six snap traps']) || !includesAny(text, ['two inside the kitchen', 'four in the garage'])) return '';
  if (!includesAny(text, ['vinyl weather stripping']) || !includesAny(text, ['gap exceeding a quarter inch', 'gap over 1/4 inch'])) return '';
  if (!includesAny(text, ['garage door side seal']) || !includesAny(text, ['threshold sweep'])) return '';
  return 'Active roof rat pressure was documented around the attached garage. The main concern is gnaw damage and a gap at the right-side garage door jamb, which may allow rodents to access the garage. Six snap traps were placed in the kitchen and garage. The next priority is to monitor trap activity, repair the garage door seal, improve the threshold sweep, and reduce attractants near the garage.';
}

function buildScopeRows(text) {
  if (!includesAny(text, ['roof rat', 'rodent', 'trap'])) return [];
  const rows = [];
  if (includesAny(text, ['kitchen']) && includesAny(text, ['garage'])) {
    rows.push([
      'Areas inspected',
      'Kitchen, under sink, behind refrigerator, attached garage, garage door perimeter, and refuse storage area.',
    ]);
  }
  if (includesAny(text, ['garage door perimeter', 'building envelope', 'structural openings'])) {
    rows.push([
      'Limited or not fully inspected',
      'Attic, roofline, soffits, wall voids, crawlspaces, exterior utility penetrations, and other concealed areas unless specifically noted in the report photos or findings.',
    ]);
  }
  return rows;
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
          ...GOLD_CTA, marginTop: 16, fontSize: 14, minHeight: 44,
        }}>Call Us</a>
      </div>
    </div>
  );

  const typeLabel = TYPE_LABELS[data.projectType] || 'Inspection';
  const reportTitle = String(data.title || '').trim() || typeLabel;
  const findings = data.findings || {};
  const findingsEntries = Object.entries(findings).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const primaryPhotos = (data.photos || []).filter(p => p.visit === 'primary');
  const followupPhotos = (data.photos || []).filter(p => p.visit === 'followup');
  const projectDateLabel = formatReportDate(data.projectDate || data.sentAt);
  const sentDateLabel = data.sentAt ? formatReportDate(data.sentAt) : '';
  const showSentDate = sentDateLabel && reportDateKey(data.sentAt) !== reportDateKey(data.projectDate);
  const reportMetaStyle = { fontSize: 14, color: B.grayDark, lineHeight: 1.45 };
  const contactRows = [
    projectDateLabel ? `Inspection date: ${projectDateLabel}${data.technicianName ? ` · ${data.technicianName}` : ''}` : '',
    showSentDate ? `Report sent: ${sentDateLabel}` : '',
    data.customerAddress || '',
    data.customerEmail ? `Email: ${data.customerEmail}` : '',
    data.customerPhone ? `Phone: ${data.customerPhone}` : '',
  ].filter(Boolean);
  const clientSnapshot = buildClientSnapshot({
    projectType: data.projectType,
    findings,
    recommendations: data.recommendations,
  });
  const reportText = getReportText(data, findings);
  const atAGlanceRows = buildAtAGlance({ data, findings, reportTitle, clientSnapshot });
  const showRodentDetails = getProjectKind(data.projectType) === 'rodent' || includesAny(reportText, ['roof rat', 'rodent', 'trap']);
  const reportSummary = buildReportSummary({ text: reportText });
  const scopeRows = buildScopeRows(reportText);

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
            }}>{reportTitle}</h1>
            <div style={{ fontSize: 12, color: B.blueLight, marginTop: 4 }}>{data.customerName}</div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: '16px auto', padding: '0 16px' }}>
        {/* Summary card */}
        <div style={{ background: '#fff', borderRadius: 16, padding: 20, border: `1px solid ${B.bluePale}` }}>
          {contactRows.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {contactRows.map(row => (
                <div key={row} style={{ ...reportMetaStyle, whiteSpace: 'pre-wrap' }}>{row}</div>
              ))}
            </div>
          )}

          {atAGlanceRows.length > 0 && <AtAGlance rows={atAGlanceRows} />}

          {reportSummary && <ReportSummary text={reportSummary} />}

          {clientSnapshot && (
            <div style={{
              marginTop: 16,
              padding: '12px 14px',
              borderRadius: 10,
              background: '#FFF9DB',
              border: `1px solid ${B.yellow}`,
            }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: B.blueDeeper, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Next step: {clientSnapshot.priority}
              </div>
              <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55, marginTop: 6 }}>
                {clientSnapshot.meaning}
              </div>
              {clientSnapshot.insight && (
                <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.5, marginTop: 6 }}>
                  {clientSnapshot.insight}
                </div>
              )}
              <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.5, marginTop: 6 }}>
                {clientSnapshot.next}
              </div>
            </div>
          )}

          {showRodentDetails && <RodentDetails text={reportText} />}

          {scopeRows.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <ReportTable
                title="Inspection scope"
                columns={['Scope', 'Details']}
                rows={scopeRows}
              />
            </div>
          )}

          {/* Findings */}
          {findingsEntries.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Findings
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {findingsEntries.map(([key, value]) => {
                  const insight = getFindingInsight(key, value);
                  const showRoofRatPhoto = isRoofRatFinding(key, value);
                  const formattedValue = formatFindingValue(key, value);
                  return (
                    <div key={key} style={{ padding: '10px 12px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
                      {key === 'species' ? (
                        <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                          <strong style={{ color: B.navy }}>Species:</strong> {formattedValue}
                        </div>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 3 }}>{humanizeKey(key)}</div>
                          <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{formattedValue}</div>
                        </>
                      )}
                      {showRoofRatPhoto && <RoofRatPhoto />}
                      {insight && (
                        <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55, marginTop: 8 }}>
                          {insight}
                        </div>
                      )}
                      {showRoofRatPhoto && (
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ fontSize: 14, fontWeight: 800, color: B.blueDeeper, cursor: 'pointer' }}>
                            Learn more about roof rats
                          </summary>
                          <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55, marginTop: 6 }}>
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
          {data.recommendations && <RecommendationsBlock text={data.recommendations} upcomingAppointment={data.upcomingAppointment} />}
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
                ...INFO_CTA, marginTop: 12, padding: '14px 20px', minHeight: 44, fontSize: 14,
              }}
            >
              <Icon name="document" size={15} strokeWidth={2} /> View FDACS-13645
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
              ...GOLD_CTA, padding: '14px 20px', minHeight: 44, fontSize: 14,
            }}><Icon name="message" size={16} strokeWidth={2} /> Text Us</a>
            <a href="tel:+19412975749" style={{
              ...INFO_CTA, padding: '14px 20px', minHeight: 44, fontSize: 14,
            }}><Icon name="phone" size={16} strokeWidth={2} /> Call Us</a>
          </div>
        </div>

        <BrandFooter />
      </div>
    </div>
  );
}

function AtAGlance({ rows }) {
  return (
    <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: '#fff', border: `1px solid ${B.bluePale}` }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: B.blueDeeper, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        At a glance
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 0.45fr) 1fr', gap: '8px 12px' }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: B.navy }}>{label}</div>
            <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.45 }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportSummary({ text }) {
  return (
    <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: B.blueDeeper, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        Summary
      </div>
      <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.6 }}>
        {text}
      </div>
    </div>
  );
}

function RodentDetails({ text }) {
  const entryRows = [];
  if (includesAny(text, ['right-side jamb']) && includesAny(text, ['vinyl weather stripping']) && includesAny(text, ['quarter inch'])) {
    entryRows.push(['Garage door, right-side jamb', 'Gnawed vinyl weather stripping with gap over 1/4 inch', 'High', 'Replace side seal and install rodent-resistant sweep']);
  }
  if (includesAny(text, ['refuse containers staged close', 'refuse containers']) && includesAny(text, ['8-10 feet', 'sealed lidded bins'])) {
    entryRows.push(['Garage refuse area', 'Trash containers staged near damaged jamb', 'Medium', 'Move bins 8-10 feet away or use sealed lidded bins']);
  }
  if (includesAny(text, ['full door perimeter', 'full garage door perimeter']) && includesAny(text, ['follow-up', 'followup'])) {
    entryRows.push(['Full garage door perimeter', 'Needs reassessment during follow-up', 'Pending', 'Inspect during scheduled follow-up']);
  }
  const trapRows = [];
  if (includesAny(text, ['six snap traps']) && includesAny(text, ['behind the refrigerator']) && includesAny(text, ['under the sink'])) {
    trapRows.push(['Snap traps', '2', 'Kitchen: behind refrigerator and under sink']);
  }
  if (includesAny(text, ['six snap traps']) && includesAny(text, ['four in the garage']) && includesAny(text, ['wall-floor junctions'])) {
    trapRows.push(['Snap traps', '4', 'Garage: wall-floor junctions near entry corridor']);
  }
  if (trapRows.length > 0 && includesAny(text, ['pets and children', 'children and pets'])) {
    trapRows.push(['Safety note', '-', 'Do not move, reset, or dispose of traps. Keep children and pets away from trap locations.']);
  }
  if (entryRows.length === 0 && trapRows.length === 0) return null;
  return (
    <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
      {entryRows.length > 0 && (
        <ReportTable
          title="Entry points and vulnerabilities"
          columns={['Location', 'Finding', 'Priority', 'Recommendation']}
          rows={entryRows}
        />
      )}
      {trapRows.length > 0 && (
        <ReportTable
          title="Trap placement and safety"
          columns={['Trap type', 'Quantity', 'Location']}
          rows={trapRows}
        />
      )}
    </div>
  );
}

function ReportTable({ title, columns, rows }) {
  return (
    <div style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${B.bluePale}`, background: '#fff' }}>
      <div style={{ padding: '10px 12px', fontSize: 12, fontWeight: 800, color: B.blueDeeper, textTransform: 'uppercase', letterSpacing: 0.5, background: B.blueSurface }}>
        {title}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, color: B.grayDark }}>
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col} style={{ textAlign: 'left', padding: '9px 10px', color: B.navy, borderTop: `1px solid ${B.bluePale}`, borderBottom: `1px solid ${B.bluePale}` }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row[0]}-${i}`}>
                {row.map((cell, idx) => (
                  <td key={`${row[0]}-${idx}`} style={{ padding: '9px 10px', verticalAlign: 'top', borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${B.bluePale}` }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoofRatPhoto() {
  return (
    <figure style={{ margin: '10px 0 0', borderRadius: 8, overflow: 'hidden', border: `1px solid ${B.bluePale}`, background: '#fff' }}>
      <img
        src="/brand/roof-rat-report.png"
        alt="Roof rat"
        style={{ display: 'block', width: '100%', maxHeight: 240, objectFit: 'cover' }}
      />
      <figcaption style={{ padding: '6px 8px', fontSize: 14, color: B.grayDark, lineHeight: 1.35 }}>
        AI-generated roof rat reference image.
      </figcaption>
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
        <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {title}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
        {photos.map(ph => {
          const label = getPhotoLabel(ph);
          const tileStyle = {
            display: 'block', aspectRatio: '1/1', overflow: 'hidden',
            borderBottom: `1px solid ${B.bluePale}`, background: B.offWhite,
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
                padding: 12, textAlign: 'center', color: B.grayMid, fontSize: 14, fontWeight: 700,
              }}>
                Photo unavailable
              </div>
            )}
            </>
          );
          return (
            <div key={ph.id} style={{ borderRadius: 8, overflow: 'hidden', border: `1px solid ${B.bluePale}`, background: '#fff' }}>
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
                <div style={{ fontSize: 14, fontWeight: 800, color: B.navy, lineHeight: 1.35, textTransform: 'capitalize' }}>
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
    <div style={{ marginTop: 16, background: '#fff', borderRadius: 16, padding: 20, border: `1px solid ${B.bluePale}` }}>
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

function buildRecommendationPriorities(text) {
  const value = String(text || '').toLowerCase();
  if (!includesAny(value, ['rodent', 'rat', 'trap', 'garage door'])) return [];
  const rows = [];
  if (includesAny(value, ['traps undisturbed', 'follow-up', 'followup'])) {
    rows.push(['Priority 1', 'Trapping follow-up', 'Keep traps in place until the scheduled follow-up. Waves will check captures, reset or relocate traps as needed, and reassess activity.']);
  }
  if (includesAny(value, ['garage door side seal', 'side seal']) && includesAny(value, ['threshold sweep', 'rodent-resistant'])) {
    rows.push(['Priority 2', 'Seal likely entry point', 'Replace the damaged garage door side seal and install a rodent-resistant threshold sweep.']);
  }
  if (includesAny(value, ['refuse containers', 'sealed lidded bins', '8-10 feet'])) {
    rows.push(['Priority 3', 'Reduce attractants', 'Move refuse containers at least 8-10 feet from the garage or switch to sealed lidded bins.']);
  }
  if (includesAny(value, ['full door perimeter', 'additional vulnerabilities'])) {
    rows.push(['Priority 4', 'Confirm full exclusion needs', 'Inspect the garage door perimeter and other access points during the follow-up or exclusion estimate.']);
  }
  return rows;
}

function RecommendationPriorities({ rows }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 8, margin: '0 0 10px' }}>
      {rows.map(([priority, title, body]) => (
        <div key={priority} style={{ padding: '9px 10px', borderRadius: 8, background: '#fff', border: `1px solid ${B.bluePale}` }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: B.blueDeeper, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {priority} - {title}
          </div>
          <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.5, marginTop: 4 }}>
            {body}
          </div>
        </div>
      ))}
    </div>
  );
}

function RecommendationsBlock({ text, upcomingAppointment }) {
  const sections = parseSections(text);
  if (sections) {
    return (
      <div style={{ marginTop: 16, padding: '16px 18px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
        {sections.map((s, i) => (
          <div key={s.heading} style={{ marginTop: i === 0 ? 0 : 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {titleCase(s.heading)}
            </div>
            {s.heading === 'WHAT WE RECOMMEND' && <RecommendationPriorities rows={buildRecommendationPriorities(s.body)} />}
            <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{s.body}</div>
            {s.heading === 'WHAT WE RECOMMEND' && shouldShowBookingCta(s.body) && <BookingCta upcomingAppointment={upcomingAppointment} text={s.body} />}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 10, background: B.blueSurface, border: `1px solid ${B.bluePale}` }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: B.navy, marginBottom: 4 }}>Recommendations</div>
      <RecommendationPriorities rows={buildRecommendationPriorities(text)} />
      <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{text}</div>
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
        padding: '12px 14px',
        borderRadius: 8,
        background: '#fff',
        border: `1px solid ${B.bluePale}`,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: B.blueDeeper, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Upcoming appointment
        </div>
        <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.55, marginTop: 4 }}>
          {[appt.serviceType, formatAppointmentWindow(appt)].filter(Boolean).join(' - ')}
        </div>
        {appt.technicianName && (
          <div style={{ fontSize: 14, color: B.grayDark, lineHeight: 1.45 }}>
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
          ...GOLD_CTA,
          padding: '14px 20px',
          minHeight: 44,
          fontSize: 14,
        }}
      >
        <Icon name="calendar" size={15} strokeWidth={2} /> {includesAny(text, ['rodent', 'exclusion', 'trap']) ? 'Request Exclusion Estimate' : 'Book an appointment'}
      </a>
    </div>
  );
}
