import { useState } from 'react';
import { Printer } from 'lucide-react';
import { WAVES_FL_LICENSE_LINE, WAVES_PRODUCTS_SAFETY_URL, WAVES_SUPPORT_PHONE_DISPLAY } from '../constants/business';
import PoisonControlCopy, { applicatorIdLine } from '../components/report/PoisonControlCopy';
import { isNativeApp } from '../native/nativeFile';
import { FS, FW, LH } from '../theme-doc';
import {
  BOOK_URL,
  TYPE_LABELS,
  buildAtAGlance,
  displayContactLine,
  formatAppointmentWindow,
  formatCustomerPhone,
  formatFindingValue,
  formatReportDate,
  getFindingInsight,
  getPhotoLabel,
  humanizeKey,
  includesAny,
  parseSections,
  projectFindingsView,
  shouldShowBookingCta,
  titleCase,
} from './ProjectReportViewPage';

// GATE_REPORT_SIMPLE_WEB (owner 2026-10-17: "skip wdo, and pre treatment, but
// for everything else the simple layout"): a project report shown as the same
// work-order document the service report uses. The server sets
// data.simpleWebReport on every project type except the two paper documents.
//
// The look is ServiceReportDocument's (letterhead, title row, info grid,
// section headers). Its few small pieces are repeated here, not imported:
// that module pulls in the 10k-line service report, which would load on every
// project report link for three tiny components. This page is screen-only (no
// headless PDF capture), so its type comes from the theme-doc scale.

const NAVY = '#04395E';
const INK = '#04395E'; // sheet ink (theme-doc DOC.ink)
const MUTED = '#3F4A65'; // DOC.muted
const LINE = '#D8D0C0'; // DOC.borderStrong
const HAIR = '#E7E2D7'; // DOC.border
const FONT = "'Inter', 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

function Label({ children }) {
  return (
    <span style={{
      display: 'inline-block', minWidth: 112, color: MUTED, fontSize: FS.body,
      fontWeight: FW.bold, letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{children}</span>
  );
}

function InfoRow({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '2px 0', minWidth: 0 }}>
      <Label>{label}</Label>
      <span style={{ color: INK, fontSize: FS.bodyLg, lineHeight: LH.snug, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

// A level-2 heading for screen readers (role, not an <h2>: the glass theme
// forces every h1/h2 to its own size with !important). Same as the service report.
function SectionHeader({ children }) {
  return (
    <div role="heading" aria-level={2} className="doc-keep-with-next" style={{
      borderBottom: `2px solid ${NAVY}`, margin: '18px 0 8px', paddingBottom: 4,
      color: NAVY, fontSize: FS.body, fontWeight: FW.bold, letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{children}</div>
  );
}

const paragraphStyle = { margin: '0 0 8px', fontSize: FS.bodyLg, lineHeight: LH.body, color: INK, whiteSpace: 'pre-wrap' };

// One finding: bold label, then its value (the species row reads as a sentence).
function FindingRow({ label, children }) {
  return (
    <div className="doc-keep" style={{ margin: '0 0 10px' }}>
      <div style={{ fontSize: FS.bodyLg, fontWeight: FW.bold, color: INK }}>{label}</div>
      {children}
    </div>
  );
}

function BookingLine({ upcomingAppointment, text }) {
  if (upcomingAppointment) {
    const when = [upcomingAppointment.serviceType, formatAppointmentWindow(upcomingAppointment)].filter(Boolean).join(' - ');
    return (
      <p className="doc-keep" style={{ ...paragraphStyle, whiteSpace: 'normal' }}>
        <strong>Upcoming appointment:</strong> {when}
        {upcomingAppointment.technicianName ? ` · Technician: ${upcomingAppointment.technicianName}` : ''}
      </p>
    );
  }
  return (
    <p className="doc-keep" style={{ ...paragraphStyle, whiteSpace: 'normal' }}>
      <a href={BOOK_URL} target="_blank" rel="noreferrer" style={{ color: NAVY, fontWeight: FW.bold, textDecoration: 'underline' }}>
        {includesAny(text, ['rodent', 'exclusion', 'trap']) ? 'Request Exclusion Estimate' : 'Book an appointment'}
      </a>
    </p>
  );
}

function Narrative({ text, upcomingAppointment }) {
  const sections = parseSections(text);
  if (sections) {
    return sections.map((s) => (
      <div key={s.heading}>
        <SectionHeader>{titleCase(s.heading)}</SectionHeader>
        <p style={paragraphStyle}>{s.body}</p>
        {s.heading === 'WHAT WE RECOMMEND' && shouldShowBookingCta(s.body)
          && <BookingLine upcomingAppointment={upcomingAppointment} text={s.body} />}
      </div>
    ));
  }
  return (
    <div>
      <SectionHeader>Recommendations</SectionHeader>
      <p style={paragraphStyle}>{text}</p>
      {shouldShowBookingCta(text) && <BookingLine upcomingAppointment={upcomingAppointment} text={text} />}
    </div>
  );
}

function PhotoGrid({ photos, failed, onFail }) {
  return (
    <div className="doc-photo-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 13 }}>
      {photos.map((ph) => {
        const label = getPhotoLabel(ph);
        const missing = !ph.url || failed.has(ph.url);
        return (
          <figure key={ph.id || ph.url} className="doc-keep" style={{ margin: 0 }}>
            {missing ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
                width: '100%', height: 248, background: '#F7F8F9', borderRadius: 13,
                border: `1px dashed ${LINE}`, color: MUTED, fontSize: FS.body, padding: 10, boxSizing: 'border-box',
              }}>
                Photo unavailable right now
              </div>
            ) : (
              <a href={ph.url} target="_blank" rel="noreferrer">
                <img
                  src={ph.url}
                  alt={label}
                  onError={() => onFail(ph.url)}
                  style={{ display: 'block', width: '100%', height: 248, objectFit: 'contain', background: '#F7F8F9', borderRadius: 13, border: `1px solid ${HAIR}` }}
                />
              </a>
            )}
            <figcaption style={{ fontSize: FS.body, color: MUTED, lineHeight: LH.body, marginTop: 4, textTransform: 'capitalize' }}>{label}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function PrintButton() {
  if (isNativeApp()) return null;
  return (
    <div className="doc-noprint" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => window.print()}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 16px',
          borderRadius: 10, border: 0, background: NAVY, color: '#fff', fontWeight: FW.semibold, fontSize: FS.body,
          fontFamily: FONT, cursor: 'pointer',
        }}
      ><Printer size={17} aria-hidden="true" /> Print / Save as PDF</button>
    </div>
  );
}

function Letterhead() {
  return (
    <div className="doc-keep doc-letterhead" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 21 }}>
      <img src="/waves-logo.png" alt="Waves Pest Control" style={{ height: 83, display: 'block' }} />
      <div style={{ textAlign: 'right', fontSize: FS.body, lineHeight: LH.body, color: MUTED }}>
        <div style={{ color: NAVY, fontSize: FS.h4, fontWeight: FW.bold }}>Waves Pest Control, LLC</div>
        <div>{WAVES_SUPPORT_PHONE_DISPLAY} · wavespestcontrol.com</div>
        <div>contact@wavespestcontrol.com</div>
        <div>Licensed &amp; insured · {WAVES_FL_LICENSE_LINE}</div>
      </div>
    </div>
  );
}

function TitleRow({ typeLabel, dateLabel }) {
  return (
    <div className="doc-keep doc-title-row" style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      borderTop: `3px solid ${NAVY}`, marginTop: 16, paddingTop: 10,
    }}>
      <div role="heading" aria-level={1} style={{ color: NAVY, fontSize: FS.h2, fontWeight: FW.bold, lineHeight: LH.heading, letterSpacing: '0.02em' }}>
        {`${typeLabel} Report`.toUpperCase()}
      </div>
      {dateLabel ? <div style={{ fontSize: FS.body, color: MUTED }}>{dateLabel}</div> : null}
    </div>
  );
}

// Customer and Service blocks. The Technician row names the technician who
// PERFORMED the project's linked visit (performingTechnicianName, the
// applicator resolver's identity), never technicianName: that is the staffer
// who created the project record (codex P1 #6353). Unknown = no row.
function InfoGrid({ data, typeLabel, dateLabel }) {
  const title = String(data.title || '').trim();
  // The type is its own row in the Service column, so the glance list keeps the rest (follow-up).
  const glanceRows = buildAtAGlance({ data, typeLabel }).filter(([label]) => label !== 'Service type');
  const [customerName, customerAddress, customerPhone, customerEmail] = [
    data.customerName,
    data.customerAddress || data.cityState || '',
    formatCustomerPhone(data.customerPhone),
    data.customerEmail,
  ].map(displayContactLine);
  return (
    <div className="doc-keep doc-info-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.1fr', gap: '5px 29px', marginTop: 13 }}>
      <div style={{ minWidth: 0 }}>
        <SectionHeader>Customer</SectionHeader>
        <InfoRow label="Name">{customerName}</InfoRow>
        <InfoRow label="Address">{customerAddress}</InfoRow>
        <InfoRow label="Phone">{customerPhone}</InfoRow>
        <InfoRow label="Email">{customerEmail}</InfoRow>
      </div>
      <div style={{ minWidth: 0 }}>
        <SectionHeader>Service</SectionHeader>
        <InfoRow label="Service">{typeLabel}</InfoRow>
        <InfoRow label="Project">{title && title !== typeLabel ? title : null}</InfoRow>
        <InfoRow label="Technician">{data.performingTechnicianName}</InfoRow>
        <InfoRow label="Date">{dateLabel}</InfoRow>
        {glanceRows.map(([label, value]) => <InfoRow key={label} label={label}>{value}</InfoRow>)}
      </div>
    </div>
  );
}

// Findings, left out while the sectioned narrative carries the same content,
// then the termite compliance answers (FS 482.226 / FAC 5E-14): statutory, so
// they print even when the narrative stands in for the findings list.
function FindingsBlocks({ data }) {
  const { findingsEntries, suppressFindingsForNarrative, complianceSection, complianceEntries } = projectFindingsView(data);
  return (
    <>
      {!suppressFindingsForNarrative && findingsEntries.length > 0 && (
        <div>
          <SectionHeader>Findings</SectionHeader>
          {findingsEntries.map(([key, value]) => {
            const insight = getFindingInsight(key, value);
            return (
              <FindingRow key={key} label={key === 'species' ? 'Species' : humanizeKey(key)}>
                <p style={{ ...paragraphStyle, margin: 0 }}>{formatFindingValue(key, value)}</p>
                {insight && <p style={{ ...paragraphStyle, margin: '4px 0 0', whiteSpace: 'normal' }}>{insight}</p>}
              </FindingRow>
            );
          })}
        </div>
      )}
      {complianceEntries.length > 0 && (
        <div>
          <SectionHeader>{complianceSection.eyebrow}</SectionHeader>
          {complianceEntries.map(([label, value]) => (
            <FindingRow key={label} label={label}>
              <p style={{ ...paragraphStyle, margin: 0 }}>{String(value)}</p>
            </FindingRow>
          ))}
        </div>
      )}
    </>
  );
}

function FollowupSection({ data, failed, onFail }) {
  const followupPhotos = (data.photos || []).filter((p) => p.visit === 'followup');
  const followupFindings = Object.entries(data.followupFindings || {}).filter(([, v]) => v);
  if (!data.followupCompletedAt && followupFindings.length === 0 && followupPhotos.length === 0) return null;
  return (
    <div>
      <SectionHeader>Follow-up visit</SectionHeader>
      {data.followupCompletedAt ? (
        <p style={{ ...paragraphStyle, whiteSpace: 'normal' }}>{formatReportDate(data.followupCompletedAt)}</p>
      ) : null}
      {followupFindings.map(([key, value]) => (
        <FindingRow key={key} label={humanizeKey(key)}>
          <p style={{ ...paragraphStyle, margin: 0 }}>{String(value)}</p>
        </FindingRow>
      ))}
      {followupPhotos.length > 0 && <PhotoGrid photos={followupPhotos} failed={failed} onFail={onFail} />}
    </div>
  );
}

// The server's verdict (projectPoisonControl): typed treatment evidence for
// the visit or its follow-up, or a rodent bait-station visit. Never sent for
// the WDO / certificate documents.
function PoisonControlSection({ data }) {
  if (data.poisonControl !== true) return null;
  const applicatorLine = applicatorIdLine(data.applicatorName || data.technicianName, data.applicatorFdacsId);
  return (
    <div className="doc-keep" data-testid="project-poison-control">
      <SectionHeader>Poison Control</SectionHeader>
      <p style={{ ...paragraphStyle, whiteSpace: 'normal', color: MUTED }}>
        <PoisonControlCopy linkStyle={{ color: INK, fontWeight: FW.bold }} />
      </p>
      {applicatorLine && (
        <p data-testid="project-applicator-id" style={{ ...paragraphStyle, whiteSpace: 'normal', fontWeight: FW.semibold }}>{applicatorLine}</p>
      )}
    </div>
  );
}

function RecordFooter() {
  return (
    <div className="doc-keep" style={{ borderTop: `1px solid ${LINE}`, marginTop: 23, paddingTop: 10, textAlign: 'center' }}>
      <div style={{ fontSize: FS.body, color: MUTED, lineHeight: LH.body }}>
        Questions about today&apos;s service? Call {WAVES_SUPPORT_PHONE_DISPLAY}.<br />
        Every product we use and our safety protocol:{' '}
        <a href={`${WAVES_PRODUCTS_SAFETY_URL}#safety-protocol`} target="_blank" rel="noopener noreferrer" style={{ color: NAVY, textDecoration: 'underline' }}>{WAVES_PRODUCTS_SAFETY_URL}</a>
        <br />
        This report is provided for your records.
        <br />
        Waves Pest Control, LLC · Family-owned pest control and lawn care in Southwest Florida · Licensed &amp; insured · {WAVES_FL_LICENSE_LINE}
      </div>
    </div>
  );
}

export default function ProjectReportDocument({ data }) {
  // A photo whose signed link failed drops to the placeholder, as in the
  // service report document.
  const [failedImages, setFailedImages] = useState(() => new Set());
  const markImageFailed = (url) => setFailedImages((prev) => {
    if (!url || prev.has(url)) return prev;
    const next = new Set(prev);
    next.add(url);
    return next;
  });

  const typeLabel = TYPE_LABELS[data.projectType] || 'Project';
  const dateLabel = formatReportDate(data.projectDate || data.sentAt);
  const primaryPhotos = (data.photos || []).filter((p) => p.visit === 'primary');

  return (
    <div
      className="project-report-document is-web"
      style={{ background: '#fff', color: INK, fontFamily: FONT, minHeight: '100vh', flex: 1 }}
    >
      <style>{`
        .project-report-document { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .project-report-document .doc-page { max-width: 988px; margin: 0 auto; padding: 26px 16px 36px; }
        @media print {
          /* The document IS the artifact: no shell chrome, no button, no glass. */
          [data-waves-shell-header],
          footer[role="contentinfo"],
          .waves-skip-link,
          .project-report-document .doc-noprint { display: none !important; }
          html[data-glass-theme] .glass-scene-orbs,
          html[data-glass-theme] .glass-scene-grain { display: none !important; }
          .project-report-document .doc-page { padding: 0; max-width: none; }
          .project-report-document .doc-keep { break-inside: avoid; page-break-inside: avoid; }
          .project-report-document .doc-keep-with-next { break-after: avoid-page; page-break-after: avoid; }
        }
        @media (max-width: 640px) {
          .project-report-document.is-web .doc-info-grid { grid-template-columns: minmax(0, 1fr) !important; }
          .project-report-document.is-web .doc-letterhead,
          .project-report-document.is-web .doc-title-row { flex-direction: column; align-items: flex-start !important; gap: 10px !important; }
          .project-report-document.is-web .doc-letterhead > div { text-align: left !important; }
          .project-report-document.is-web .doc-photo-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }
      `}</style>
      <div className="doc-page">
        <PrintButton />
        <Letterhead />
        <TitleRow typeLabel={typeLabel} dateLabel={dateLabel} />
        <InfoGrid data={data} typeLabel={typeLabel} dateLabel={dateLabel} />
        <FindingsBlocks data={data} />
        {data.recommendations ? <Narrative text={String(data.recommendations)} upcomingAppointment={data.upcomingAppointment} /> : null}
        {primaryPhotos.length > 0 && (
          <div>
            <SectionHeader>Photos</SectionHeader>
            <PhotoGrid photos={primaryPhotos} failed={failedImages} onFail={markImageFailed} />
          </div>
        )}
        <FollowupSection data={data} failed={failedImages} onFail={markImageFailed} />
        <PoisonControlSection data={data} />
        <RecordFooter />
      </div>
    </div>
  );
}
