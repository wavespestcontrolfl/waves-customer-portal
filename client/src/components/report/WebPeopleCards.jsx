// GATE_REPORT_WEB_PEOPLE (owner 2026-10-20): the people cards of the simple web service report.
// The server sends `data.webPeople` only while the gate is live; every sentence below is fixed copy, with a name or a
// date filled in. Nothing here writes: "Works" only confirms on the page, "Move it" opens the signed-in portal schedule, and the review card links to Google.
import { useState } from 'react';
import { FS } from '../../theme-doc';
import TracedTreatmentZoneMap from './TracedTreatmentZoneMap';
import {
  formatNextAppointmentLabel, trackReportEvent, tracedVariantFallback,
} from '../../pages/ReportViewPage';

const NAVY = '#04395E';
const INK = '#1F2A33';
const MUTED = '#4A5A66';

// The map's own rules, from the web report sheet: the frame keeps the photo's 4:3 shape and the caption stays 14px.
const MAP_CSS = `
  .web-people-map .service-coverage-map { position: relative; overflow: hidden; border: 1px solid rgba(4,57,94,.16); border-radius: 12px; background: #eef2f1; }
  .web-people-map .service-coverage-map.traced-zone-map { aspect-ratio: 4 / 3; }
  .web-people-map .traced-zone-image { display: block; width: 100%; height: 100%; object-fit: cover; }
  .web-people-map .traced-zone-caption { margin: 8px 0 0; color: ${MUTED}; font-size: ${FS.body}px; line-height: 1.4; }
`;

const buttonStyle = (filled) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: 44, padding: '0 18px',
  borderRadius: 10, fontSize: FS.bodyLg, fontWeight: 600, textDecoration: 'none', cursor: 'pointer',
  background: filled ? NAVY : 'transparent', color: filled ? '#fff' : NAVY, border: `1.5px solid ${NAVY}`,
});

function PeopleCard({ glass, label, children, className }) {
  return (
    <section
      {...(glass ? { 'data-glass': 'card' } : {})}
      className={className}
      style={{
        margin: '12px 0', padding: '14px 16px', borderRadius: 12, boxSizing: 'border-box', minWidth: 0,
        color: INK, fontSize: FS.bodyLg, lineHeight: 1.45,
        ...(glass ? {} : { background: '#fff', border: '1px solid rgba(4,57,94,0.12)' }),
      }}
    >
      {/* A role, not an h2: the glass theme forces every h2 to its own size. */}
      {label ? <div role="heading" aria-level={2} style={{ margin: '0 0 8px', fontSize: FS.sub, fontWeight: 700, color: NAVY }}>{label}</div> : null}
      {children}
    </section>
  );
}

function Shell({ children }) {
  return <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 16px' }}>{children}</div>;
}

function TechStrip({ tech, glass }) {
  const initial = tech.firstName.slice(0, 1).toUpperCase();
  // An expired or missing signed photo falls back to the initial, as the tech note card does.
  const [photoFailed, setPhotoFailed] = useState(false);
  const lines = [
    `${tech.firstName} was your technician today.`,
    tech.visitsAtHome ? `${tech.firstName} has treated your home ${tech.visitsAtHome} times.` : null,
    tech.fdacsId ? `FDACS ID card #${tech.fdacsId}` : null,
  ].filter(Boolean);
  return (
    <PeopleCard glass={glass} className="web-people-tech">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {tech.photoUrl && !photoFailed ? (
          <img src={tech.photoUrl} alt={`${tech.firstName}, your technician`} width={56} height={56} onError={() => setPhotoFailed(true)} style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', flex: 'none' }} />
        ) : (
          <div aria-hidden="true" style={{ width: 56, height: 56, borderRadius: '50%', flex: 'none', background: NAVY, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700 }}>{initial}</div>
        )}
        <div style={{ minWidth: 0 }}>
          {lines.map((line, i) => (
            <div key={line} style={i === 0 ? { fontWeight: 700 } : { color: MUTED, fontSize: FS.body }}>{line}</div>
          ))}
        </div>
      </div>
    </PeopleCard>
  );
}

function TreatedMap({ data, glass, onFailed }) {
  const traced = data.treatmentMap?.traced;
  if (!traced?.snapshotUrl) return null;
  return (
    <PeopleCard glass={glass} label={data.serviceLine === 'lawn' ? 'Where we treated your lawn' : 'Where we treated'} className="web-people-map">
      <style>{MAP_CSS}</style>
      <TracedTreatmentZoneMap traced={traced} live variant={tracedVariantFallback(traced, data.serviceLine)} onImageError={onFailed} />
    </PeopleCard>
  );
}

// Tech strip and the traced map: the top of the report. The document leaves out its own flat map while this shows.
// mapFailed: the snapshot did not load; the card goes away (onMapFailed told the page, which hands the document its own map back).
export function WebPeopleTop({ data, glass, mapFailed = false, onMapFailed }) {
  const people = data.webPeople;
  if (!people) return null;
  const showMap = !mapFailed && people.treatedMap === true && Boolean(data.treatmentMap?.traced?.snapshotUrl);
  if (!people.tech && !showMap) return null;
  return (
    <Shell>
      {people.tech ? <TechStrip tech={people.tech} glass={glass} /> : null}
      {showMap ? <TreatedMap data={data} glass={glass} onFailed={onMapFailed} /> : null}
    </Shell>
  );
}

function NextVisit({ visit, glass }) {
  const [works, setWorks] = useState(false);
  const label = formatNextAppointmentLabel(visit);
  if (!label) return null;
  return (
    <PeopleCard glass={glass} label="Your next visit" className="web-people-next-visit">
      <div style={{ fontWeight: 600 }}>{label}</div>
      {works ? (
        <p role="status" style={{ margin: '10px 0 0' }}>Great. We will see you then.</p>
      ) : (
        <>
          <p style={{ margin: '8px 0 12px', color: MUTED }}>Does this time work for you?</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button type="button" style={buttonStyle(true)} onClick={() => setWorks(true)}>Works</button>
            {/* The signed-in portal schedule, never a token link: a forwarded report must not carry the visit's reschedule capability. */}
            <a href="/?tab=schedule" style={buttonStyle(false)}>Move it</a>
          </div>
        </>
      )}
    </PeopleCard>
  );
}

function ReviewAsk({ data, review, token, glass }) {
  // Only the server-validated name: a placeholder label ("Your Waves technician") never becomes "How did Your do".
  const tech = data.webPeople?.tech?.firstName || 'we';
  const name = String(data.customerFirstName || '').trim();
  return (
    <PeopleCard glass={glass} className="web-people-review">
      <h3 style={{ margin: '0 0 10px', fontSize: FS.sub, fontWeight: 700, color: NAVY }}>{`How did ${tech} do today${name ? `, ${name}` : ''}?`}</h3>
      <a
        href={review.url}
        target="_blank"
        rel="noreferrer"
        style={buttonStyle(true)}
        onClick={() => trackReportEvent(token, 'review_request_clicked', { location: review.locationId, placement: 'web_people' })}
      >
        Rate today&rsquo;s visit
      </a>
    </PeopleCard>
  );
}

// Next-visit card and the review link: the foot of the report.
export function WebPeopleBottom({ data, token, glass }) {
  const people = data.webPeople;
  if (!people || (!people.nextVisit && !people.review)) return null;
  return (
    <Shell>
      {people.nextVisit ? <NextVisit visit={people.nextVisit} glass={glass} /> : null}
      {people.review?.url ? <ReviewAsk data={data} review={people.review} token={token} glass={glass} /> : null}
    </Shell>
  );
}
