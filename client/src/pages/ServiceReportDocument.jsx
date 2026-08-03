import React from 'react';
import { WAVES_FL_LICENSE_LINE, WAVES_SUPPORT_PHONE_DISPLAY } from '../constants/business';

// Work-order style service report document (owner direction 2026-08-03,
// modeled on the TruGreen WO / All U Need service-notification formats):
// this is what renders whenever the report is captured as a PDF — the
// download, the share sheet, and the post-service email attachment all
// serve this document. The glass web report (mode 'live') is untouched.
//
// Content rules: strictly the data the interactive report already shows —
// no pricing (this is a service record, not an invoice), photos stay in
// the portal (a count + link renders instead), and product safety copy
// comes only from the approved per-product label facts.

const NAVY = '#04395E';
const INK = '#17242F';
const MUTED = '#5B6A77';
const LINE = '#C9CED4';
const HAIR = '#E2E6EA';
const TZ = 'America/New_York';
const PORTAL_BASE = 'https://portal.wavespestcontrol.com';

const FONT = "'Inter', 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

// serviceDate is a DATE serialized at UTC midnight — format in UTC so the
// calendar day never rolls back. Timestamps format in ET like every other
// customer surface.
function fmtServiceDate(value, opts = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric', ...opts,
  });
}

function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

// "10.000" -> "10", "0.49" -> "0.49"; units come through as snake_case
// ("fl_oz") from the application record.
function fmtAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value || '').trim();
  return String(parseFloat(num.toFixed(3)));
}

function fmtUnit(unit) {
  return String(unit || '').replace(/_/g, ' ').trim();
}

function fmtPhone(phone) {
  const raw = String(phone || '').replace(/\D/g, '');
  const digits = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw;
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return String(phone || '').trim();
}

const INTERACTION_LABELS = {
  tech_home_spoke_with_them: 'Spoke with someone at the home',
  tech_home_no_answer: 'Home — no answer at the door',
  tech_not_home: 'Customer not home during service',
  left_note: 'Left a note for the customer',
};

function reentryTargetLine(target) {
  const parts = [];
  if (Number(target.durationMin) > 0) {
    const hours = target.durationMin / 60;
    parts.push(`keep clear for ${hours >= 1 ? `${Math.round(hours * 10) / 10} hour${hours === 1 ? '' : 's'}` : `${target.durationMin} minutes`} after treatment`);
    const ready = fmtTime(target.readyAt);
    if (ready) parts.push(`ready after ${ready}`);
  } else {
    parts.push('no wait — ready for normal use');
  }
  return `${target.label}: ${parts.join(' · ')}`;
}

function zoneNames(app, zones) {
  const byId = new Map((zones || []).map((zone) => [String(zone.id), zone]));
  const ids = Array.isArray(app.zone_ids) ? app.zone_ids : [];
  const names = ids.map((id) => byId.get(String(id))?.label).filter(Boolean);
  if (!names.length) return 'Treated service areas';
  if (zones && zones.length > 1 && names.length === zones.length) return 'Whole property';
  return names.join(', ');
}

function Label({ children }) {
  return (
    <span style={{
      display: 'inline-block', minWidth: 86, color: MUTED, fontSize: 9.5,
      fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{children}</span>
  );
}

function InfoRow({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '1.5px 0' }}>
      <Label>{label}</Label>
      <span style={{ color: INK, fontSize: 11.5, lineHeight: 1.35 }}>{children}</span>
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div className="doc-keep-with-next" style={{
      borderBottom: `1.5px solid ${NAVY}`, margin: '14px 0 6px', paddingBottom: 3,
      color: NAVY, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{children}</div>
  );
}

function Bullet({ children }) {
  return (
    <div style={{ display: 'flex', gap: 7, padding: '1.5px 0', fontSize: 11.5, lineHeight: 1.45, color: INK }}>
      <span aria-hidden="true" style={{ color: MUTED }}>•</span>
      <span>{children}</span>
    </div>
  );
}

export default function ServiceReportDocument({ data, token }) {
  const typed = data.typedReport || null;
  const result = typed?.todaysResult || null;
  const findings = Array.isArray(typed?.findings) ? typed.findings.filter((f) => (f.customerValueLabel ?? f.value) != null && String(f.customerValueLabel ?? f.value).trim() !== '') : [];
  const activity = data.activity || null;
  const reentry = data.dynamicContext?.reentry || null;
  const rawConditions = data.conditions || null;
  const conditions = rawConditions
    && [rawConditions.temp_f, rawConditions.humidity_pct, rawConditions.wind_mph, rawConditions.rain_24h_in, rawConditions.sky]
      .some((value) => value != null && value !== '')
    ? rawConditions : null;
  const applications = Array.isArray(data.applications) ? data.applications : [];
  const photos = (data.photos || []).filter((photo) => photo && photo.url);
  const tracedMapUrl = data.treatmentMap?.traced?.snapshotUrl || null;
  // The generated map is a self-contained SVG (own <style> + xmlns), so it
  // renders identically as an <img> data URI — and an <img> cannot execute
  // script or fetch anything, so no markup from the payload is ever injected
  // into this document. Inline over the /map.svg endpoint: no network fetch
  // to race the PDF capture.
  const schematicSvg = data.treatmentMap?.schematic?.svg || data.mapSvg || null;
  const schematicSrc = schematicSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(schematicSvg)}`
    : null;
  const zoneLegend = (data.zones || [])
    .map((zone) => ({ letter: zone.letter, label: zone.label }))
    .filter((zone) => zone.label);
  const stationMap = data.stationMap?.available && Array.isArray(data.stationMap.stations) && data.stationMap.stations.length
    ? data.stationMap : null;
  const reportUrl = `${PORTAL_BASE}/report/${encodeURIComponent(token)}`;
  const reportNumber = String(data.serviceRecordId || token || '').replace(/-/g, '').slice(0, 10).toUpperCase();

  const summaryParagraphs = [];
  if (result?.headline) summaryParagraphs.push(String(result.headline).replace(/\.$/, '') + '.');
  const summaryBody = result?.body || data.summary || data.dynamicContext?.aiSummary?.body || '';
  if (summaryBody && !summaryParagraphs.includes(summaryBody)) summaryParagraphs.push(summaryBody);

  const recommendations = [];
  const pushRec = (text) => {
    const t = String(text || '').trim();
    if (t && !recommendations.includes(t)) recommendations.push(t);
  };
  pushRec(result?.nextStep);
  (typed?.nextStepChips || []).forEach((chip) => {
    // chips restate nextStep in shorthand — only add ones that say something new
    if (!recommendations.some((r) => r.toLowerCase().includes(String(chip).toLowerCase()))) pushRec(chip);
  });
  (data.recommendations || []).forEach((rec) => pushRec(rec?.text || rec));
  (data.protocol?.recommendations || []).forEach((rec) => pushRec(rec?.text || rec));
  // Lawn visits carry their guidance in the assessment + V2 aftercare
  // instead of typedReport — same section, same voice.
  const assessRecs = data.lawnAssessment?.recommendations?.recommendations;
  (Array.isArray(assessRecs) ? [...assessRecs].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)) : [])
    .forEach((rec) => pushRec(rec?.action || rec?.text || rec));
  pushRec(data.reportV2?.aftercare?.watering);

  // "(3 of 5 — baseline recorded today)" / "(3 of 5)" / " — baseline
  // recorded today" / "" depending on what the visit actually recorded.
  const activityScored = activity && activity.score != null && activity.maxScore != null;
  const activityBaselineNote = activity?.isBaseline ? ' — baseline recorded today' : '';
  const activityDetail = activityScored
    ? ` (${activity.score} of ${activity.maxScore}${activityBaselineNote})`
    : activityBaselineNote;

  const lawnObservations = String(data.lawnAssessment?.observations || '').trim() || null;
  const mowing = data.mowingHeight || null;
  const interaction = INTERACTION_LABELS[data.customerInteraction] || null;

  return (
    <div className="service-report-v1 service-report-document" style={{ background: '#fff', color: INK, fontFamily: FONT, minHeight: '100vh' }}>
      <style>{`
        .service-report-document { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .service-report-document .doc-page { max-width: 760px; margin: 0 auto; padding: 20px 16px 28px; }
        .service-report-document table { border-collapse: collapse; width: 100%; }
        @media print {
          /* The document IS the artifact — no shell chrome, no glass. */
          [data-waves-shell-header],
          footer[role="contentinfo"],
          .waves-skip-link { display: none !important; }
          html[data-glass-theme] .glass-scene-orbs,
          html[data-glass-theme] .glass-scene-grain { display: none !important; }
          .service-report-document .doc-page { padding: 0; max-width: none; }
          .service-report-document .doc-keep,
          .service-report-document .doc-product-row { break-inside: avoid; page-break-inside: avoid; }
          .service-report-document .doc-keep-with-next { break-after: avoid-page; page-break-after: avoid; }
        }
        .service-report-document .doc-map-frame svg { display: block; width: 100%; height: auto; }
        .service-report-document .doc-station-pin {
          position: absolute; transform: translate(-50%, -50%);
          width: 17px; height: 17px; border-radius: 50%;
          background: ${NAVY}; color: #fff; font-size: 9.5px; font-weight: 800;
          display: flex; align-items: center; justify-content: center;
          border: 1.5px solid #fff; box-shadow: 0 0 0 1px ${LINE};
        }
        .service-report-document .doc-station-pin.is-activity { background: #A33B2E; }
        .service-report-document .doc-station-pin.is-inaccessible { background: ${MUTED}; }
      `}</style>
      <div className="doc-page">

        {/* Letterhead */}
        <div className="doc-keep" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <img src="/waves-logo.png" alt="Waves Pest Control" style={{ height: 64, display: 'block' }} />
          <div style={{ textAlign: 'right', fontSize: 10.5, lineHeight: 1.5, color: MUTED }}>
            <div style={{ color: NAVY, fontSize: 12.5, fontWeight: 800 }}>Waves Pest Control, LLC</div>
            <div>{WAVES_SUPPORT_PHONE_DISPLAY} · wavespestcontrol.com</div>
            <div>contact@wavespestcontrol.com</div>
            <div>Licensed &amp; insured · {WAVES_FL_LICENSE_LINE}</div>
          </div>
        </div>

        {/* Title row */}
        <div className="doc-keep" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          borderTop: `2.5px solid ${NAVY}`, marginTop: 12, paddingTop: 8,
        }}>
          <div style={{ color: NAVY, fontSize: 21, fontWeight: 800, letterSpacing: '0.02em' }}>SERVICE REPORT</div>
          <div style={{ fontSize: 11, color: MUTED }}>
            Report #{reportNumber} · {fmtServiceDate(data.serviceDate)}
          </div>
        </div>

        {/* Info grid */}
        <div className="doc-keep" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.1fr 0.9fr', gap: '4px 22px', marginTop: 10 }}>
          <div>
            <SectionHeader>Customer</SectionHeader>
            <InfoRow label="Name">{data.customerName}</InfoRow>
            <InfoRow label="Address">{data.serviceAddress || data.propertyAddress}</InfoRow>
            <InfoRow label="Phone">{fmtPhone(data.customerPhone)}</InfoRow>
            <InfoRow label="Email">{data.customerEmail}</InfoRow>
          </div>
          <div>
            <SectionHeader>Service</SectionHeader>
            <InfoRow label="Service">{data.serviceDisplayName || data.serviceType}</InfoRow>
            <InfoRow label="Technician">{data.technicianName}</InfoRow>
            <InfoRow label="Time in">{fmtTime(data.visitTiming?.arrivedAt)}</InfoRow>
            <InfoRow label="Time out">{fmtTime(data.visitTiming?.exitedAt)}</InfoRow>
            <InfoRow label="Contact">{interaction}</InfoRow>
          </div>
          <div>
            <SectionHeader>Conditions</SectionHeader>
            {conditions ? (
              <>
                <InfoRow label="Temp">{conditions.temp_f != null ? `${conditions.temp_f} °F` : null}</InfoRow>
                <InfoRow label="Humidity">{conditions.humidity_pct != null ? `${conditions.humidity_pct}%` : null}</InfoRow>
                <InfoRow label="Wind">{conditions.wind_mph != null ? `${conditions.wind_mph} mph` : null}</InfoRow>
                <InfoRow label="Rain 24 hr">{conditions.rain_24h_in != null ? `${conditions.rain_24h_in} in` : null}</InfoRow>
                <InfoRow label="Sky">{conditions.sky}</InfoRow>
              </>
            ) : (
              <div style={{ fontSize: 11, color: MUTED, padding: '2px 0' }}>Not recorded for this visit.</div>
            )}
          </div>
        </div>

        {/* Summary */}
        {summaryParagraphs.length > 0 && (
          <div className="doc-keep">
            <SectionHeader>Summary of today&apos;s service</SectionHeader>
            {summaryParagraphs.map((paragraph) => (
              <p key={paragraph} style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>{paragraph}</p>
            ))}
          </div>
        )}

        {/* Findings */}
        {(findings.length > 0 || activity || lawnObservations || mowing) && (
          <div className="doc-keep">
            <SectionHeader>What we found</SectionHeader>
            {lawnObservations && <Bullet>{lawnObservations}</Bullet>}
            {mowing && mowing.heightIn != null && (
              <Bullet>
                <strong>Mowing height:</strong> {mowing.heightIn} in measured
                {mowing.bandLabel ? ` · target ${mowing.bandLabel}` : ''}
                {mowing.status === 'in_range' ? ' (in range)' : ''}
              </Bullet>
            )}
            {findings.map((finding) => (
              <Bullet key={finding.fieldKey || finding.customerLabel}>
                <strong>{finding.customerLabel}:</strong> {finding.customerValueLabel || finding.value}
              </Bullet>
            ))}
            {activity && activity.levelWord && (
              <Bullet>
                <strong>{activity.label}:</strong> {activity.levelWord}{activityDetail}
              </Bullet>
            )}
          </div>
        )}

        {/* Re-entry */}
        {(reentry || data.advisory?.pet_advisory) && (
          <div className="doc-keep">
            <SectionHeader>Re-entry &amp; precautions</SectionHeader>
            {reentry?.customerSummary && <Bullet>{reentry.customerSummary}</Bullet>}
            {(reentry?.targets || []).map((target) => (
              <Bullet key={target.key || target.label}>{reentryTargetLine(target)}</Bullet>
            ))}
            {(reentry?.petAdvisory || data.advisory?.pet_advisory) && (
              <Bullet>{reentry?.petAdvisory || data.advisory.pet_advisory}</Bullet>
            )}
            {Number(data.advisory?.irrigation_hold_hr) > 0 && (
              <Bullet>Hold irrigation for {data.advisory.irrigation_hold_hr} hours after treatment.</Bullet>
            )}
            {data.reportV2?.aftercare?.reentry && (
              <Bullet>{data.reportV2.aftercare.reentry}</Bullet>
            )}
          </div>
        )}

        {/* Recommendations */}
        {recommendations.length > 0 && (
          <div className="doc-keep">
            <SectionHeader>What we recommend</SectionHeader>
            {recommendations.map((rec) => <Bullet key={rec}>{rec}</Bullet>)}
          </div>
        )}

        {/* Products applied */}
        {applications.length > 0 && (
          <div>
            <SectionHeader>Products applied</SectionHeader>
            <table style={{ fontSize: 11 }}>
              <thead className="doc-keep-with-next">
                <tr>
                  {['Product', 'EPA Reg. No.', 'Rate', 'Total applied'].map((heading, i) => (
                    <th key={heading} style={{
                      textAlign: i === 0 ? 'left' : 'right', padding: '4px 6px 4px 0',
                      color: MUTED, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em',
                      textTransform: 'uppercase', borderBottom: `1px solid ${LINE}`,
                    }}>{heading}</th>
                  ))}
                </tr>
              </thead>
              {applications.map((app, index) => {
                  const product = app.product || {};
                  const name = product.name || app.productName || 'Product';
                  return (
                    <tbody className="doc-product-row" key={app.id || `${name}-${index}`}>
                      <tr>
                        <td style={{ padding: '6px 6px 1px 0', fontWeight: 700, color: INK }}>{name}</td>
                        <td style={{ padding: '6px 0 1px', textAlign: 'right', whiteSpace: 'nowrap' }}>{product.epa_reg || '—'}</td>
                        <td style={{ padding: '6px 0 1px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {app.rate ? `${fmtAmount(app.rate)}${app.rateUnit ? ` ${fmtUnit(app.rateUnit)}` : ''}` : '—'}
                        </td>
                        <td style={{ padding: '6px 0 1px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {app.totalAmount ? `${fmtAmount(app.totalAmount)}${app.amountUnit ? ` ${fmtUnit(app.amountUnit)}` : ''}` : '—'}
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={4} style={{ padding: `0 0 8px 0`, borderBottom: index < applications.length - 1 ? `1px solid ${HAIR}` : 'none' }}>
                          <div style={{ fontSize: 10.5, color: MUTED, lineHeight: 1.5 }}>
                            {product.active_ingredient && <div><strong style={{ color: INK, fontWeight: 600 }}>Active ingredient:</strong> {product.active_ingredient}</div>}
                            {app.methodLabel && <div><strong style={{ color: INK, fontWeight: 600 }}>Method:</strong> {app.methodLabel}</div>}
                            {Array.isArray(app.targets) && app.targets.length > 0 && (
                              <div><strong style={{ color: INK, fontWeight: 600 }}>Target:</strong> {app.targets.join(', ')}</div>
                            )}
                            <div><strong style={{ color: INK, fontWeight: 600 }}>Areas:</strong> {zoneNames(app, data.zones)}</div>
                            {(product.precaution_summary || product.reentry_summary) && (
                              <div><strong style={{ color: INK, fontWeight: 600 }}>Label safety:</strong> {[product.precaution_summary, product.reentry_summary].filter(Boolean).join(' ')}</div>
                            )}
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  );
              })}
            </table>
          </div>
        )}

        {/* Where we treated — the tech-traced spray snapshot when one exists
            (Waves-stored image), else the generated zone schematic. The
            satellite basemap never prints (provider ToS — long-standing
            rule), which these two Waves-owned renderings don't involve. */}
        {(tracedMapUrl || schematicSrc) && (
          <div className="doc-keep">
            <SectionHeader>Where we treated</SectionHeader>
            <div className="doc-map-frame" style={{ border: `1px solid ${HAIR}`, borderRadius: 6, overflow: 'hidden' }}>
              {tracedMapUrl
                ? <img src={tracedMapUrl} alt="Technician-traced treatment map" style={{ display: 'block', width: '100%' }} />
                : <img src={schematicSrc} alt="Treatment map of the serviced areas" style={{ display: 'block', width: '100%' }} />}
            </div>
            {!tracedMapUrl && zoneLegend.length > 0 && (
              <div style={{ marginTop: 5, fontSize: 10.5, color: MUTED, lineHeight: 1.5 }}>
                {zoneLegend.map(({ letter, label }) => `${letter ? `${letter} — ` : ''}${label}`).join(' · ')}
              </div>
            )}
            {data.treatmentMap?.footer && (
              <div style={{ marginTop: 4, fontSize: 9.5, color: MUTED }}>{data.treatmentMap.footer}</div>
            )}
          </div>
        )}

        {/* Station / trap placement — pin geometry only, drawn on a neutral
            frame. The Google satellite image in the payload must NOT print
            (provider ToS); the online report carries the satellite view. */}
        {stationMap && (
          <div className="doc-keep">
            <SectionHeader>{stationMap.program === 'trapping' ? 'Trap placement' : 'Bait station placement'}</SectionHeader>
            <div style={{
              position: 'relative', width: '100%', aspectRatio: '32 / 17',
              background: '#F4F6F8', border: `1px solid ${HAIR}`, borderRadius: 6,
            }}>
              {stationMap.stations.map((station) => (
                <span
                  key={station.id || station.number}
                  className={`doc-station-pin${station.status === 'activity' ? ' is-activity' : ''}${station.status === 'inaccessible' ? ' is-inaccessible' : ''}`}
                  style={{ left: `${(station.cx * 100).toFixed(2)}%`, top: `${(station.cy * 100).toFixed(2)}%` }}
                >{station.number}</span>
              ))}
            </div>
            {stationMap.summary && (
              <div style={{ marginTop: 5, fontSize: 10.5, color: MUTED }}>
                {[
                  `${stationMap.summary.total} ${stationMap.program === 'trapping' ? 'traps' : 'stations'}`,
                  stationMap.summary.checked != null ? `${stationMap.summary.checked} checked` : null,
                  stationMap.summary.activity != null ? `${stationMap.summary.activity} with activity` : null,
                  stationMap.summary.inaccessible ? `${stationMap.summary.inaccessible} inaccessible` : null,
                ].filter(Boolean).join(' · ')}
                {' '}· positions to scale — satellite view in your online report
              </div>
            )}
          </div>
        )}

        {/* Service photos — embedded (owner 2026-08-03, supersedes the
            portal-link-only call earlier the same day). */}
        {photos.length > 0 && (
          <div>
            <SectionHeader>Service photos</SectionHeader>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              {photos.map((photo) => (
                <figure key={photo.id || photo.url} className="doc-keep" style={{ margin: 0 }}>
                  {/* fixed-height contain thumbnails: a portrait field photo
                      at natural size ran taller than the page and split
                      across a break. Full resolution stays in the portal. */}
                  <img
                    src={photo.url}
                    alt={photo.caption || 'Service photo'}
                    style={{ display: 'block', width: '100%', height: 190, objectFit: 'contain', background: '#F7F8F9', borderRadius: 4, border: `1px solid ${HAIR}` }}
                  />
                  {(photo.caption || photo.stateBadge) && (
                    <figcaption style={{ fontSize: 9.5, color: MUTED, lineHeight: 1.45, marginTop: 3 }}>
                      {photo.caption || photo.stateBadge}
                    </figcaption>
                  )}
                </figure>
              ))}
            </div>
          </div>
        )}

        {/* Record footer */}
        <div className="doc-keep" style={{ borderTop: `1px solid ${LINE}`, marginTop: 18, paddingTop: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: MUTED, lineHeight: 1.6 }}>
            Questions about today&apos;s service? Ask Waves in your online report or call {WAVES_SUPPORT_PHONE_DISPLAY}.
            <br />
            Full interactive report: {reportUrl}
            <br />
            This report is provided for your records. This is not an invoice.
            {data.photoChain?.valid === true ? ' Photos hash-chained and tamper-evident.' : ''}
            <br />
            Waves Pest Control, LLC · Family-owned pest control and lawn care in Southwest Florida · Licensed &amp; insured · {WAVES_FL_LICENSE_LINE}
          </div>
        </div>

      </div>
    </div>
  );
}
