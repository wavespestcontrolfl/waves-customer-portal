import Icon from '../components/Icon';
import BrandFooter from '../components/BrandFooter';
import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { GoogleMap, useJsApiLoader, Marker } from '@react-google-maps/api';
import { WavesShell } from '../components/brand';
import { useGlassSurface } from '../glass/glass-engine';
import {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
} from '../constants/business';

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
// Values from the shared customer palette (muted was drifted gray-500).
const TRACK_SURFACE = { ...CUSTOMER_SURFACE, surface: '#FFFFFF' };

const TRACK_PRIMARY_CTA = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 48,
  padding: '0 20px',
  background: COLORS.blueDeeper,
  color: COLORS.white,
  border: `1px solid ${COLORS.blueDeeper}`,
  borderRadius: 8,
  fontFamily: FONTS.ui,
  fontWeight: 800,
  fontSize: 15,
  letterSpacing: 0,
  textDecoration: 'none',
};

// The arrival window quoted to customers is ALWAYS start + 2 hours (owner
// directive — see server/utils/sms-time-format.js). The API's window.end is
// the internal job-duration block and never renders on customer surfaces.
function formatWindow(startIso) {
  if (!startIso) return '';
  try {
    const s = new Date(startIso);
    const e = Number.isNaN(s.getTime()) ? null : new Date(s.getTime() + 120 * 60000);
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
    // completed_at is a real UTC instant; render its ET calendar day so the
    // date matches the visit regardless of the viewer's device timezone.
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
    });
  } catch {
    return '';
  }
}

// Build the property-address lines from the public-track payload. Returns
// the visible lines in order: [line1, line2?, "City, ST Zip"]. Empty
// strings filtered out so a missing line2 just collapses cleanly.
function fullAddressLines(property) {
  if (!property) return [];
  const cityStateZip = [
    property.city,
    [property.state, property.zip].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  return [property.addressLine1, property.addressLine2, cityStateZip].filter(Boolean);
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
    <WavesShell variant="customer" topBar="solid">
      <div data-glass-clear="" style={{ flex: 1, padding: '24px 16px 40px', maxWidth: 640, width: '100%', margin: '0 auto', fontFamily: FONT_BODY, color: TRACK_SURFACE.text }}>
        {children}
        <BrandFooter />
      </div>
    </WavesShell>
  );
}

function StatusPill({ label, color }) {
  return (
    <div data-glass="chip" data-glass-pill="" style={{
      display: 'inline-block',
      fontSize: 12, fontWeight: 700,
      letterSpacing: 0, textTransform: 'uppercase',
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
      <div style={{ fontSize: 16, color: TRACK_SURFACE.body, marginBottom: 4 }}>
        {techFirst} arrives in
      </div>
      <div style={{
        fontFamily: FONTS.serif,
        fontSize: 64,
        fontWeight: 600, color: TRACK_SURFACE.text,
        lineHeight: 1, letterSpacing: 0,
        display: 'flex', alignItems: 'baseline', gap: 12,
      }}>
        <span>{display}</span>
        {showUnit ? (
          <span style={{
            fontSize: 22, color: TRACK_SURFACE.muted,
            fontFamily: FONTS.body, fontWeight: 600, letterSpacing: 0,
          }}>min</span>
        ) : null}
      </div>
      {source === 'haversine' ? (
        <div style={{ fontSize: 14, color: TRACK_SURFACE.muted, marginTop: 6 }}>
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
      <div data-glass="soft" style={{
        marginTop: 20, height: 200, borderRadius: 8,
        background: TRACK_SURFACE.soft,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1px dashed ${TRACK_SURFACE.softBorder}`,
        fontSize: 14, color: TRACK_SURFACE.muted,
        textAlign: 'center', padding: 24,
      }}>
        Live map unavailable.
      </div>
    );
  }

  if (!isLoaded) {
    return <div style={{ marginTop: 20, height: 320, borderRadius: 8, background: TRACK_SURFACE.soft }} />;
  }

  return (
    <div style={{
      borderRadius: 8, overflow: 'hidden', marginTop: 20,
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

function Card({ children, accent }) {
  return (
    <div data-glass="card" style={{
      background: TRACK_SURFACE.surface,
      borderRadius: 8,
      padding: 24,
      boxShadow: 'none',
      border: `1px solid ${TRACK_SURFACE.border}`,
      borderTop: accent ? `3px solid ${accent}` : `1px solid ${TRACK_SURFACE.border}`,
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
      background: TRACK_SURFACE.soft,
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
          style={{ width: px, height: px, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${TRACK_SURFACE.border}` }}
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
        <div style={{ fontSize: size === 'lg' ? 22 : 18, fontWeight: 600, color: TRACK_SURFACE.text }}>
          {tech.firstName || 'Your technician'}
        </div>
      </div>
    </div>
  );
}

// Client identity block (owner spec 2026-07-06): replaces the old
// "Today's visit" service-description/window/address meta — the card
// shows WHO the visit is for (name, address, email, phone).
function ClientMeta({ data }) {
  const c = data.customer || {};
  const addrLines = fullAddressLines(data.property);
  if (!c.name && addrLines.length === 0 && !c.email && !c.phone) return null;
  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${TRACK_SURFACE.border}` }}>
      {c.name ? (
        <div style={{ fontSize: 16, fontWeight: 600, color: TRACK_SURFACE.text }}>{c.name}</div>
      ) : null}
      {addrLines.length > 0 ? (
        <div style={{ fontSize: 14, color: TRACK_SURFACE.body, marginTop: 6, lineHeight: 1.5 }}>
          {addrLines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      ) : null}
      {c.email ? (
        <div style={{ fontSize: 14, marginTop: 6, color: TRACK_SURFACE.body }}>{c.email}</div>
      ) : null}
      {c.phone ? (
        <div style={{ fontSize: 14, marginTop: 4, color: TRACK_SURFACE.body }}>{c.phone}</div>
      ) : null}
    </div>
  );
}

// ── State cards ──────────────────────────────────────────────────
function ScheduledCard({ data }) {
  const techFirst = data.tech?.firstName || 'your tech';
  const window = formatWindow(data.window?.start);
  return (
    <Card accent={COLORS.wavesBlue}>
      <div style={{ fontSize: 14, color: TRACK_SURFACE.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0 }}>
        Scheduled
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3 }}>
        {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}
        your {data.service?.type?.toLowerCase() || 'service'} is booked{window ? ` for ${window}` : ''}.
      </div>
      <div style={{ fontSize: 15, color: TRACK_SURFACE.body, marginTop: 12, lineHeight: 1.5 }}>
        You'll get a text as soon as {techFirst} is on the way.
      </div>
      <ClientMeta data={data} />
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
                fontSize: 14, color: TRACK_SURFACE.muted,
                marginTop: 10, textAlign: 'right',
              }}>
                {lastUpdated}{v?.stale ? ' · GPS reconnecting' : ''}
              </div>
            ) : null}
          </>
        ) : (
          <div data-glass="soft" style={{
            marginTop: 20, padding: 14, background: TRACK_SURFACE.soft,
            borderRadius: 8, fontSize: 14, color: TRACK_SURFACE.body,
          }}>
            {techFirst} is on the way. We'll update once GPS reconnects.
          </div>
        )}

        <div style={{
          marginTop: 24, paddingTop: 20,
          borderTop: `1px solid ${TRACK_SURFACE.border}`,
        }}>
          <TechBlock tech={data.tech} size="lg" />
        </div>

        <ClientMeta data={data} />

        <a
          href={WAVES_SUPPORT_SMS_TEL}
          data-glass-accent=""
          style={{ ...TRACK_PRIMARY_CTA, width: '100%', marginTop: 20, boxSizing: 'border-box' }}
        >
          TEXT {techFirst.toUpperCase()}
        </a>
        </Card>
    </>
  );
}

function OnPropertyCard({ data }) {
  const techFirst = data.tech?.firstName || 'Your technician';
  const elapsed = useElapsed(data.arrivedAt);
  return (
    <Card accent={COLORS.green}>
      <div style={{ fontSize: 14, color: COLORS.green, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0, fontWeight: 600 }}>
        On property
      </div>
      <TechBlock tech={data.tech} size="lg" />
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 20, lineHeight: 1.3 }}>
        {techFirst} is servicing your property.
      </div>
      {elapsed ? (
        <div style={{ fontSize: 14, color: TRACK_SURFACE.body, marginTop: 10 }}>
          On site for {elapsed}.
        </div>
      ) : null}
      <ClientMeta data={data} />
    </Card>
  );
}

function CompleteCard({ data }) {
  const { summary = {} } = data;
  const photos = Array.isArray(summary.photos) ? summary.photos.slice(0, 6) : [];
  return (
    <>
      <Card accent={COLORS.green}>
        <div style={{ fontSize: 14, color: COLORS.green, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0, fontWeight: 600 }}>
          Service complete
        </div>
        <TechBlock tech={data.tech} size="lg" />
        <div style={{ fontSize: 22, fontWeight: 600, marginTop: 20, lineHeight: 1.3 }}>
          Thanks for choosing Waves
          {data.customerFirstName ? `, ${data.customerFirstName}` : ''}.
        </div>
        <div style={{ fontSize: 15, color: TRACK_SURFACE.body, marginTop: 8 }}>
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
            data-glass-accent=""
            style={{
              display: 'block', padding: '16px 20px', background: COLORS.blueDeeper, color: COLORS.white,
              textAlign: 'center', borderRadius: 8, fontWeight: 600, fontSize: 16,
              textDecoration: 'none',
            }}
          >View service report</a>
        ) : null}
        {summary.reviewUrl ? (
          <a
            href={summary.reviewUrl}
            data-glass-accent=""
            style={{
              display: 'block', padding: '16px 20px', background: COLORS.blueDeeper, color: COLORS.white,
              textAlign: 'center', borderRadius: 8, fontWeight: 600, fontSize: 16,
              textDecoration: 'none',
            }}
          >Leave a 5-star review</a>
        ) : null}
        {summary.invoiceToken ? (
          <a
            href={`/pay/${summary.invoiceToken}`}
            data-glass="chip"
            style={{
              display: 'block', padding: '14px 20px', background: TRACK_SURFACE.surface, color: TRACK_SURFACE.text,
              textAlign: 'center', borderRadius: 8, fontWeight: 600, fontSize: 15,
              textDecoration: 'none', border: `1px solid ${TRACK_SURFACE.border}`,
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
      <div style={{ fontSize: 14, color: COLORS.red, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0, fontWeight: 600 }}>
        Cancelled
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>
        Your {data.service?.type?.toLowerCase() || 'service'}{when ? ` on ${when}` : ''} was cancelled.
      </div>
      {reason ? (
        <div style={{ fontSize: 14, color: TRACK_SURFACE.body, marginTop: 12 }}>
          <span style={{ color: TRACK_SURFACE.muted }}>Reason: </span>{reason}
        </div>
      ) : null}
      <a
        href={WAVES_SUPPORT_PHONE_TEL}
        data-glass-accent=""
        style={{
          display: 'block', marginTop: 20, padding: '14px 20px',
          background: COLORS.blueDeeper, color: COLORS.white,
          textAlign: 'center', borderRadius: 8, fontWeight: 600, fontSize: 15,
          textDecoration: 'none',
        }}
      >Call to reschedule</a>
    </Card>
  );
}

function NoShowCard({ data }) {
  const when = data.window?.start ? formatCompleteDate(data.window.start) : null;
  return (
    <Card accent={COLORS.orange}>
      <div style={{ fontSize: 14, color: COLORS.orange, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0, fontWeight: 600 }}>
        Missed visit
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.3 }}>
        We missed you{data.customerFirstName ? `, ${data.customerFirstName}` : ''}.
      </div>
      <div style={{ fontSize: 15, color: TRACK_SURFACE.body, marginTop: 12, lineHeight: 1.5 }}>
        We weren't able to complete your {data.service?.type?.toLowerCase() || 'service'}
        {when ? ` on ${when}` : ' today'}. Let's get you back on the schedule — reschedule any time and we'll find a slot that works for you.
      </div>
      <a
        href={WAVES_SUPPORT_PHONE_TEL}
        data-glass-accent=""
        style={{
          display: 'block', marginTop: 20, padding: '14px 20px',
          background: COLORS.blueDeeper, color: COLORS.white,
          textAlign: 'center', borderRadius: 8, fontWeight: 600, fontSize: 15,
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
      <div style={{ height: 12, width: 80, background: TRACK_SURFACE.soft, borderRadius: 4 }} />
      <div style={{ height: 24, width: '80%', background: TRACK_SURFACE.soft, borderRadius: 4, marginTop: 16 }} />
      <div style={{ height: 16, width: '60%', background: TRACK_SURFACE.soft, borderRadius: 4, marginTop: 12 }} />
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
      <div style={{ fontSize: 16, color: TRACK_SURFACE.body, marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>
        This tracking link has expired or isn't valid. Call us at{' '}
        <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: TRACK_SURFACE.text }}>{WAVES_SUPPORT_PHONE_DISPLAY}</a>{' '}
        if you need help with your service.
      </div>
    </Card>
  );
}

// A valid token that hit a server hiccup (500/502/429) is NOT an expired
// link — telling the customer their link is invalid during an outage sends
// them to the phone line for nothing. Offer a retry instead.
function TransientErrorCard({ onRetry }) {
  return (
    <Card>
      <div style={{ fontSize: 18, fontWeight: 600, textAlign: 'center', marginTop: 8 }}>
        We couldn&rsquo;t load your tracker
      </div>
      <div style={{ fontSize: 16, color: TRACK_SURFACE.body, marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>
        Something went wrong on our end — your tracking link is still good.
        Try again in a moment, or call us at{' '}
        <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: TRACK_SURFACE.text }}>{WAVES_SUPPORT_PHONE_DISPLAY}</a>.
      </div>
      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <button
          type="button"
          onClick={onRetry}
          style={{
            minHeight: 44, padding: '0 24px', borderRadius: 10, border: 'none',
            background: TRACK_SURFACE.text, color: '#fff',
            fontSize: 15, fontWeight: 700, cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </div>
    </Card>
  );
}

// ── Main ─────────────────────────────────────────────────────────
export default function TrackPage() {
  useGlassSurface(true, 'full');

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
      // Non-OK bodies (500s, expired-token JSON errors) must never become
      // tracker state — that blanked the page and could clobber a live
      // en-route render. Only accept payloads with a recognized state.
      if (!r.ok) return;
      const body = await r.json();
      if (body?.state) setData(body);
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
  if (notFound) return <Page><NotFoundCard /></Page>;
  if (!data) {
    // No 404 and no data: either a transient failure (retryable) or an
    // unrecognized payload — only a real 404 earns the "expired" card.
    return (
      <Page>
        <TransientErrorCard
          onRetry={async () => {
            setLoading(true);
            await fetchTrack();
            setLoading(false);
          }}
        />
      </Page>
    );
  }

  return (
    <Page>
      {data.state === 'scheduled' ? <ScheduledCard data={data} /> : null}
      {data.state === 'en_route' ? <EnRouteCard data={data} /> : null}
      {data.state === 'on_property' ? <OnPropertyCard data={data} /> : null}
      {data.state === 'complete' ? <CompleteCard data={data} /> : null}
      {data.state === 'cancelled' ? <CancelledCard data={data} /> : null}
      {data.state === 'no_show' ? <NoShowCard data={data} /> : null}
    </Page>
  );
}
