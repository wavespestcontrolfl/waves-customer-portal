import Icon from '../components/Icon';
import { COLORS } from '../theme-brand';
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const WAVES_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_PHONE_TEL = '+19412975749';

function formatWindow(startIso, endIso) {
  if (!startIso) return '';
  try {
    const s = new Date(startIso);
    const e = endIso ? new Date(endIso) : null;
    const dateFmt = { weekday: 'short', month: 'short', day: 'numeric' };
    const timeFmt = { hour: 'numeric', minute: '2-digit' };
    const datePart = s.toLocaleDateString(undefined, dateFmt);
    const startT = s.toLocaleTimeString(undefined, timeFmt);
    if (!e) return `${datePart} at ${startT}`;
    const endT = e.toLocaleTimeString(undefined, timeFmt);
    return `${datePart}, ${startT}–${endT}`;
  } catch {
    return '';
  }
}

function formatCompleteDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  } catch {
    return '';
  }
}

function useElapsed(fromIso) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!fromIso) return;
    const tick = () => {
      const diffMs = Date.now() - new Date(fromIso).getTime();
      if (diffMs < 0) return setText('');
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) setText('just now');
      else if (mins === 1) setText('1 minute');
      else if (mins < 60) setText(`${mins} minutes`);
      else {
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        setText(rem ? `${hrs}h ${rem}m` : `${hrs}h`);
      }
    };
    tick();
    const id = setInterval(tick, 30 * 1000);
    return () => clearInterval(id);
  }, [fromIso]);
  return text;
}

// ── UI primitives ────────────────────────────────────────────────
function Page({ children }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: COLORS.offWhite,
      fontFamily: FONT_BODY,
      color: COLORS.navy,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ flex: 1, padding: '24px 16px 40px', maxWidth: 640, width: '100%', margin: '0 auto' }}>
        {children}
      </div>
      <BrandFooter />
    </div>
  );
}

function Card({ children, accent }) {
  return (
    <div style={{
      background: COLORS.white,
      borderRadius: 16,
      padding: 24,
      boxShadow: '0 2px 12px rgba(15, 23, 42, 0.06)',
      borderTop: accent ? `4px solid ${accent}` : 'none',
      marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function TechBlock({ tech, size = 'md' }) {
  const px = size === 'lg' ? 96 : 64;
  if (!tech) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: px, height: px, borderRadius: '50%',
          background: COLORS.blueLight,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: px * 0.5, color: COLORS.wavesBlue,
        }}></div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Your Waves technician</div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      {tech.photoUrl ? (
        <img
          src={tech.photoUrl}
          alt={tech.firstName || ''}
          style={{ width: px, height: px, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${COLORS.offWhite}` }}
        />
      ) : (
        <div style={{
          width: px, height: px, borderRadius: '50%',
          background: COLORS.blueDeeper, color: COLORS.white,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: px * 0.4, fontWeight: 600,
        }}>
          {(tech.firstName || '?').charAt(0).toUpperCase()}
        </div>
      )}
      <div>
        <div style={{ fontSize: size === 'lg' ? 22 : 18, fontWeight: 600, color: COLORS.navy }}>
          {tech.firstName || 'Your technician'}
        </div>
        {tech.yearsWithWaves ? (
          <div style={{ fontSize: 13, color: COLORS.textCaption }}>
            {tech.yearsWithWaves}+ years with Waves
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ServiceMeta({ data }) {
  const window = formatWindow(data.window?.start, data.window?.end);
  const addr = data.property?.addressLine1;
  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${COLORS.offWhite}` }}>
      <div style={{ fontSize: 13, color: COLORS.textCaption, marginBottom: 4 }}>Service</div>
      <div style={{ fontSize: 15, fontWeight: 500, color: COLORS.navy }}>{data.service?.type}</div>
      {window ? (
        <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 8 }}>{window}</div>
      ) : null}
      {addr ? (
        <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 4 }}>{addr}</div>
      ) : null}
    </div>
  );
}

// ── State cards ──────────────────────────────────────────────────
function ScheduledCard({ data }) {
  const techFirst = data.tech?.firstName || 'your tech';
  const window = formatWindow(data.window?.start, data.window?.end);
  return (
    <Card accent={COLORS.wavesBlue}>
      <div style={{ fontSize: 14, color: COLORS.textCaption, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Scheduled
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3 }}>
        {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}
        your {data.service?.type?.toLowerCase() || 'service'} is booked{window ? ` for ${window}` : ''}.
      </div>
      <div style={{ fontSize: 15, color: COLORS.textBody, marginTop: 12, lineHeight: 1.5 }}>
        You'll get a text as soon as {techFirst} is on the way.
      </div>
      {data.property?.addressLine1 ? (
        <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 16 }}>
          {data.property.addressLine1}
        </div>
      ) : null}
    </Card>
  );
}

function EnRouteCard({ data }) {
  const techFirst = data.tech?.firstName || 'Your technician';
  return (
    <Card accent={COLORS.wavesBlue}>
      <div style={{ fontSize: 14, color: COLORS.wavesBlue, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
        On the way
      </div>
      <TechBlock tech={data.tech} size="lg" />
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 20, lineHeight: 1.3 }}>
        {techFirst} is on the way.
      </div>
      <ServiceMeta data={data} />
    </Card>
  );
}

function OnPropertyCard({ data }) {
  const techFirst = data.tech?.firstName || 'Your technician';
  const elapsed = useElapsed(data.arrivedAt);
  return (
    <Card accent={COLORS.green}>
      <div style={{ fontSize: 14, color: COLORS.green, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
        On property
      </div>
      <TechBlock tech={data.tech} size="lg" />
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 20, lineHeight: 1.3 }}>
        {techFirst} is servicing your property.
      </div>
      {elapsed ? (
        <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 10 }}>
          On site for {elapsed}.
        </div>
      ) : null}
      <ServiceMeta data={data} />
    </Card>
  );
}

function CompleteCard({ data }) {
  const { summary = {} } = data;
  const photos = Array.isArray(summary.photos) ? summary.photos.slice(0, 6) : [];
  return (
    <>
      <Card accent={COLORS.green}>
        <div style={{ fontSize: 14, color: COLORS.green, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
          Service complete
        </div>
        <TechBlock tech={data.tech} size="lg" />
        <div style={{ fontSize: 22, fontWeight: 600, marginTop: 20, lineHeight: 1.3 }}>
          Thanks for choosing Waves
          {data.customerFirstName ? `, ${data.customerFirstName}` : ''}.
        </div>
        <div style={{ fontSize: 15, color: COLORS.textBody, marginTop: 8 }}>
          {data.service?.type} completed{summary.completedAt ? ` on ${formatCompleteDate(summary.completedAt)}` : ''}.
        </div>

        {photos.length > 0 ? (
          <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8 }}>
            {photos.map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`Service photo ${i + 1}`}
                style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8 }}
              />
            ))}
          </div>
        ) : null}
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {summary.serviceReportToken ? (
          <a
            href={`/report/${summary.serviceReportToken}`}
            style={{
              display: 'block', padding: '16px 20px', background: COLORS.wavesBlue, color: COLORS.white,
              textAlign: 'center', borderRadius: 12, fontWeight: 600, fontSize: 16,
              textDecoration: 'none',
            }}
          >View service report</a>
        ) : null}
        {summary.reviewUrl ? (
          <a
            href={summary.reviewUrl}
            style={{
              display: 'block', padding: '16px 20px', background: COLORS.yellow, color: COLORS.navy,
              textAlign: 'center', borderRadius: 12, fontWeight: 600, fontSize: 16,
              textDecoration: 'none',
            }}
          >Leave a 5-star review</a>
        ) : null}
        {summary.invoiceToken ? (
          <a
            href={`/pay/${summary.invoiceToken}`}
            style={{
              display: 'block', padding: '14px 20px', background: COLORS.white, color: COLORS.blueDark,
              textAlign: 'center', borderRadius: 12, fontWeight: 600, fontSize: 15,
              textDecoration: 'none', border: `1px solid ${COLORS.grayLight}`,
            }}
          >View invoice</a>
        ) : null}
      </div>
    </>
  );
}

function CancelledCard({ data }) {
  const when = data.window?.start ? formatCompleteDate(data.window.start) : null;
  const reason = data.cancellation?.reason || null;
  return (
    <Card accent={COLORS.red}>
      <div style={{ fontSize: 14, color: COLORS.red, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
        Cancelled
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>
        Your {data.service?.type?.toLowerCase() || 'service'}{when ? ` on ${when}` : ''} was cancelled.
      </div>
      {reason ? (
        <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 12 }}>
          <span style={{ color: COLORS.textCaption }}>Reason: </span>{reason}
        </div>
      ) : null}
      <a
        href={`tel:${WAVES_PHONE_TEL}`}
        style={{
          display: 'block', marginTop: 20, padding: '14px 20px',
          background: COLORS.wavesBlue, color: COLORS.white,
          textAlign: 'center', borderRadius: 12, fontWeight: 600, fontSize: 15,
          textDecoration: 'none',
        }}
      >Call to reschedule</a>
    </Card>
  );
}

// ── Loading + error states ───────────────────────────────────────
function SkeletonCard() {
  return (
    <Card>
      <div style={{ height: 12, width: 80, background: COLORS.offWhite, borderRadius: 4 }} />
      <div style={{ height: 24, width: '80%', background: COLORS.offWhite, borderRadius: 4, marginTop: 16 }} />
      <div style={{ height: 16, width: '60%', background: COLORS.offWhite, borderRadius: 4, marginTop: 12 }} />
    </Card>
  );
}

function NotFoundCard() {
  return (
    <Card>
      <div style={{ fontSize: 32, textAlign: 'center' }}></div>
      <div style={{ fontSize: 18, fontWeight: 600, textAlign: 'center', marginTop: 8 }}>
        Tracking link unavailable
      </div>
      <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>
        This tracking link has expired or isn't valid. Call us at{' '}
        <a href={`tel:${WAVES_PHONE_TEL}`} style={{ color: COLORS.blueDark }}>{WAVES_PHONE_DISPLAY}</a>{' '}
        if you need help with your service.
      </div>
    </Card>
  );
}

// ── Main ─────────────────────────────────────────────────────────
export default function TrackPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch(`${API_BASE}/public/track/${token}`)
      .then((r) => {
        if (r.status === 404) {
          setNotFound(true);
          setLoading(false);
          return null;
        }
        return r.json();
      })
      .then((body) => {
        if (body) setData(body);
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });

    // Phase 2: setInterval(fetchTrack, (data?.meta?.pollIntervalSeconds || 30) * 1000)
    // to refresh vehicle position + state transitions live.
  }, [token]);

  if (loading) return <Page><SkeletonCard /></Page>;
  if (notFound || !data) return <Page><NotFoundCard /></Page>;

  return (
    <Page>
      {data.state === 'scheduled' ? <ScheduledCard data={data} /> : null}
      {data.state === 'en_route' ? <EnRouteCard data={data} /> : null}
      {data.state === 'on_property' ? <OnPropertyCard data={data} /> : null}
      {data.state === 'complete' ? <CompleteCard data={data} /> : null}
      {data.state === 'cancelled' ? <CancelledCard data={data} /> : null}
    </Page>
  );
}
