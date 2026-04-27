import Icon from '../components/Icon';
import { COLORS, FONTS, GOLD_CTA } from '../theme-brand';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { GoogleMap, useJsApiLoader, Marker } from '@react-google-maps/api';
import BrandFooter from '../components/BrandFooter';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Same shape as useDispatchBoard's socketOrigin helper. If API_BASE
// is a relative path, return undefined → io() defaults to same-origin
// (works in production + Vite dev with the /socket.io ws proxy). If
// API_BASE is a full URL, return its origin so the socket handshake
// hits the same backend the HTTP fetches do.
function socketOrigin() {
  if (!API_BASE || API_BASE.startsWith('/')) return undefined;
  try {
    return new URL(API_BASE).origin;
  } catch {
    return undefined;
  }
}

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

// ── Helpers (en-route map + ETA) ─────────────────────────────────
function distanceMiles(a, b) {
  if (!a || !b) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function statusFromDistance(miles) {
  if (miles == null) return { label: 'On the way', color: COLORS.wavesBlue };
  if (miles < 0.3) return { label: 'Arriving now', color: COLORS.green };
  if (miles < 3) return { label: 'Nearby', color: COLORS.wavesBlue };
  return { label: 'On the way', color: COLORS.wavesBlue };
}

function useLastUpdated(iso) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!iso) return;
    const tick = () => {
      const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (sec < 10) setText('Updated just now');
      else if (sec < 60) setText(`Updated ${sec}s ago`);
      else if (sec < 3600) setText(`Updated ${Math.floor(sec / 60)} min ago`);
      else setText(`Updated ${Math.floor(sec / 3600)}h ago`);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [iso]);
  return text;
}

// ── UI primitives ────────────────────────────────────────────────
function Page({ children }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: COLORS.sand,
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

function StatusPill({ label, color }) {
  return (
    <div style={{
      display: 'inline-block',
      fontSize: 12, fontWeight: 700,
      letterSpacing: '0.1em', textTransform: 'uppercase',
      color, background: `${color}1A`,
      padding: '6px 12px', borderRadius: 9999,
    }}>
      <span style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
        background: color, marginRight: 8, verticalAlign: 'middle',
      }} />
      {label}
    </div>
  );
}

function EtaHero({ minutes, techFirst, source }) {
  const isNow = minutes != null && minutes < 1;
  const display = minutes == null ? '—' : isNow ? 'Now' : `${minutes}`;
  const showUnit = !isNow && minutes != null;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 16, color: COLORS.textBody, marginBottom: 4 }}>
        {techFirst} arrives in
      </div>
      <div style={{
        fontFamily: FONTS.display,
        fontSize: 'clamp(56px, 14vw, 88px)',
        fontWeight: 700, color: COLORS.blueDeeper,
        lineHeight: 1, letterSpacing: '0.02em',
        display: 'flex', alignItems: 'baseline', gap: 12,
      }}>
        <span>{display}</span>
        {showUnit ? (
          <span style={{
            fontSize: 22, color: COLORS.textCaption,
            fontFamily: FONTS.body, fontWeight: 600, letterSpacing: '0.02em',
          }}>min</span>
        ) : null}
      </div>
      {source === 'haversine' ? (
        <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 6 }}>
          Estimated based on distance
        </div>
      ) : null}
    </div>
  );
}

function TrackerMap({ tech, property }) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'waves-track-map',
    googleMapsApiKey: MAPS_KEY,
  });
  const center = useMemo(() => ({
    lat: (tech.lat + property.lat) / 2,
    lng: (tech.lng + property.lng) / 2,
  }), [tech, property]);

  if (!MAPS_KEY || loadError) {
    return (
      <div style={{
        marginTop: 20, height: 200, borderRadius: 16,
        background: `linear-gradient(135deg, ${COLORS.blueSurface} 0%, ${COLORS.blueLight} 100%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1px dashed ${COLORS.grayLight}`,
        fontSize: 14, color: COLORS.textCaption,
        textAlign: 'center', padding: 24,
      }}>
        Live map unavailable.
      </div>
    );
  }

  if (!isLoaded) {
    return <div style={{ marginTop: 20, height: 320, borderRadius: 16, background: COLORS.offWhite }} />;
  }

  return (
    <div style={{
      borderRadius: 16, overflow: 'hidden', marginTop: 20,
      boxShadow: '0 2px 12px rgba(15, 23, 42, 0.08)',
    }}>
      <GoogleMap
        center={center}
        zoom={12}
        mapContainerStyle={{ width: '100%', height: 320 }}
        options={{
          disableDefaultUI: true, zoomControl: true,
          gestureHandling: 'cooperative', clickableIcons: false,
          styles: [
            { featureType: 'poi', stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
          ],
        }}
        onLoad={(map) => {
          const bounds = new window.google.maps.LatLngBounds();
          bounds.extend(tech);
          bounds.extend(property);
          map.fitBounds(bounds, 80);
        }}
      >
        <Marker
          position={tech}
          icon={{
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 11, fillColor: COLORS.wavesBlue, fillOpacity: 1,
            strokeColor: COLORS.white, strokeWeight: 4,
          }}
          title="Your Waves tech"
          zIndex={2}
        />
        <Marker
          position={property}
          icon={{
            path: 'M -10,4 L -10,-4 L 0,-12 L 10,-4 L 10,4 Z',
            scale: 1, fillColor: COLORS.blueDeeper, fillOpacity: 1,
            strokeColor: COLORS.white, strokeWeight: 2,
          }}
          title="Your property"
          zIndex={1}
        />
      </GoogleMap>
    </div>
  );
}

function PrepChecklist() {
  const [open, setOpen] = useState(false);
  const items = ['Gates unlocked', 'Pets inside or secured', 'Sprinklers off until tonight'];
  return (
    <div style={{
      marginTop: 16, padding: '14px 18px', background: COLORS.white,
      borderRadius: 12, border: `1px solid ${COLORS.slate200}`,
    }}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', background: 'none', border: 'none',
          cursor: 'pointer', fontFamily: FONT_BODY, fontSize: 16,
          fontWeight: 600, color: COLORS.blueDeeper, padding: 0,
        }}
      >
        <span>Quick prep</span>
        <span style={{ fontSize: 14, color: COLORS.textCaption }}>{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <ul style={{
          margin: '12px 0 0', paddingLeft: 22, fontSize: 15,
          color: COLORS.textBody, lineHeight: 1.7,
        }}>
          {items.map((t) => <li key={t}>{t}</li>)}
        </ul>
      ) : null}
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
          <div style={{ fontSize: 14, color: COLORS.textCaption }}>
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
      <div style={{ fontSize: 14, color: COLORS.textCaption, marginBottom: 4 }}>Service</div>
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
  const v = data.vehicle;
  const property = data.property?.lat != null
    ? { lat: data.property.lat, lng: data.property.lng }
    : null;
  const techCoords = v?.lat != null ? { lat: v.lat, lng: v.lng } : null;

  const miles = techCoords && property ? distanceMiles(techCoords, property) : null;
  const status = statusFromDistance(miles);
  const lastUpdated = useLastUpdated(v?.lastReportedAt);

  return (
    <>
      <Card accent={status.color}>
        <StatusPill label={status.label} color={status.color} />
        <EtaHero minutes={v?.etaMinutes} techFirst={techFirst} source={v?.etaSource} />

        {techCoords && property ? (
          <>
            <TrackerMap tech={techCoords} property={property} />
            {lastUpdated ? (
              <div style={{
                fontSize: 14, color: COLORS.textCaption,
                marginTop: 10, textAlign: 'right',
              }}>
                {lastUpdated}{v?.stale ? ' · GPS reconnecting' : ''}
              </div>
            ) : null}
          </>
        ) : (
          <div style={{
            marginTop: 20, padding: 14, background: COLORS.blueSurface,
            borderRadius: 10, fontSize: 14, color: COLORS.textBody,
          }}>
            {techFirst} is on the way. We'll update once GPS reconnects.
          </div>
        )}

        <div style={{
          marginTop: 24, paddingTop: 20,
          borderTop: `1px solid ${COLORS.offWhite}`,
        }}>
          <TechBlock tech={data.tech} size="lg" />
        </div>

        <ServiceMeta data={data} />

        <a
          href={`sms:${WAVES_PHONE_TEL}`}
          style={{ ...GOLD_CTA, width: '100%', marginTop: 20, boxSizing: 'border-box' }}
        >
          TEXT WAVES
        </a>
      </Card>

      <PrepChecklist />
    </>
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
      <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>
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

  // Refetch the public track endpoint. Used both for the initial mount
  // and as the wake-up handler when a customer:job_update broadcast
  // lands on the socket. The broadcast payload is intentionally narrow
  // (PII boundary in services/job-status.js — job_id, status, eta,
  // tech_id, tech_first_name, updated_at) and the page renders a much
  // richer state object (window, property, vehicle, summary,
  // cancellation, etc.). Refetching gives us the full state without
  // having to merge a narrow payload into a rich UI.
  const fetchTrack = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/public/track/${token}`);
      if (r.status === 404) {
        setNotFound(true);
        return;
      }
      const body = await r.json();
      if (body) setData(body);
    } catch {
      // Don't clobber an existing render on a transient network blip;
      // the next broadcast (or page refresh) will recover.
    }
  }, [token]);

  // Initial fetch on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchTrack();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fetchTrack]);

  // Live socket subscription. Authenticates with the public track
  // token (PR adding socket auth's trackToken path); server resolves
  // it to a customer_id and joins the socket to customer:<id>.
  // Receives customer:job_update broadcasts whenever any job belonging
  // to this customer transitions; we just refetch on each.
  //
  // Filtering by job_id on the client is possible (the broadcast
  // payload carries job_id) but in practice a customer rarely has
  // multiple active jobs, and a spurious refetch is cheap. Skip the
  // filter for v1.
  //
  // Best-effort: if the socket can't connect (network issue, server
  // restart, etc.), the user still gets the initial fetch's data and
  // a refresh restores live updates. We don't surface socket errors
  // to the UI.
  useEffect(() => {
    if (!token || notFound) return undefined;
    const origin = socketOrigin();
    const socket = origin
      ? io(origin, { auth: { trackToken: token }, transports: ['websocket', 'polling'], reconnection: true })
      : io({ auth: { trackToken: token }, transports: ['websocket', 'polling'], reconnection: true });

    function handleJobUpdate() {
      fetchTrack();
    }
    socket.on('customer:job_update', handleJobUpdate);

    return () => {
      socket.off('customer:job_update', handleJobUpdate);
      socket.disconnect();
    };
  }, [token, notFound, fetchTrack]);

  // Server-driven polling cadence. While en-route the response sets
  // pollIntervalSeconds=30 so we refresh vehicle coords + ETA between
  // the larger socket-driven state transitions; every other state
  // returns 0, which disables the interval entirely.
  useEffect(() => {
    const sec = data?.meta?.pollIntervalSeconds || 0;
    if (!sec || notFound) return undefined;
    const id = setInterval(fetchTrack, sec * 1000);
    return () => clearInterval(id);
  }, [data?.meta?.pollIntervalSeconds, fetchTrack, notFound]);

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
