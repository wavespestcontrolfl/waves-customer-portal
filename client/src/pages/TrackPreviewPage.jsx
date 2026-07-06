// Preview/mockup of the redesigned customer-facing tracking page.
// Renders the new En Route experience (live ETA + map + tech card +
// SMS CTA + prep checklist) against mock data. Pull state via the
// `?state=` query param: scheduled | en_route | on_property | complete.
// Defaults to en_route since that's the new design's centerpiece.
//
// This file deliberately doesn't import or fork TrackPage — it stands
// alone so the existing /track/:token surface stays untouched until
// we sign off on the redesign.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GoogleMap, useJsApiLoader, Marker } from '@react-google-maps/api';
import { COLORS, FONTS } from '../theme-brand';
import BrandFooter from '../components/BrandFooter';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { WavesShell } from '../components/brand';
import { useGlassSurface, portalGlassInitial, watchPortalGlassDefault } from '../glass/glass-engine';
import {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_SMS_TEL,
} from '../constants/business';

const FONT_BODY = FONTS.body;
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
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

// ── Mock data ────────────────────────────────────────────────────
// Sarasota, FL — tech ~2.4 mi from property along US-41
const MOCK_TECH_COORDS    = { lat: 27.3364, lng: -82.5307 };
const MOCK_PROPERTY_COORDS = { lat: 27.3015, lng: -82.5104 };

function mockData(state) {
  const base = {
    state,
    customerFirstName: 'Sarah',
    customer: {
      name: 'Sarah Mitchell',
      email: 'sarah.mitchell@example.com',
      phone: '(941) 555-0182',
    },
    tech: {
      firstName: 'Adam',
      photoUrl: null,
    },
    window: {
      start: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 72 * 60 * 1000).toISOString(),
    },
    property: {
      ...MOCK_PROPERTY_COORDS,
      addressLine1: '1234 Bayshore Dr',
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
    },
    service: {
      type: 'Quarterly Pest Control',
      estimatedDurationMin: 60,
    },
    vehicle: null,
    summary: null,
    cancellation: null,
    meta: { pollIntervalSeconds: 0 },
  };

  if (state === 'en_route') {
    base.vehicle = {
      ...MOCK_TECH_COORDS,
      lastReportedAt: new Date(Date.now() - 18 * 1000).toISOString(),
      stale: false,
      etaMinutes: 12,
      etaSource: 'google',
    };
    base.meta.pollIntervalSeconds = 30;
  }

  if (state === 'on_property') {
    base.arrivedAt = new Date(Date.now() - 14 * 60 * 1000).toISOString();
  }

  if (state === 'complete') {
    base.summary = {
      completedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      photos: [],
      reviewUrl: '#',
      invoiceToken: null,
      serviceReportToken: null,
    };
  }

  return base;
}

// ── Helpers ──────────────────────────────────────────────────────
function distanceMiles(a, b) {
  if (!a || !b) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function statusFromDistance(miles) {
  if (miles == null) return { label: 'On the way', color: COLORS.wavesBlue };
  if (miles < 0.3) return { label: 'Arriving now', color: COLORS.green };
  if (miles < 3)   return { label: 'Nearby',       color: COLORS.wavesBlue };
  return                  { label: 'On the way',   color: COLORS.wavesBlue };
}

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

function StatusPill({ label, color }) {
  return (
    <div data-glass="chip" data-glass-pill="" style={{
      display: 'inline-block',
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: 0,
      textTransform: 'uppercase',
      color,
      background: `${color}1A`,
      padding: '6px 12px',
      borderRadius: 9999,
    }}>
      <span style={{
        display: 'inline-block',
        width: 6, height: 6, borderRadius: '50%',
        background: color, marginRight: 8,
        verticalAlign: 'middle',
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
        fontWeight: 600,
        color: TRACK_SURFACE.text,
        lineHeight: 1,
        letterSpacing: 0,
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
      }}>
        <span>{display}</span>
        {showUnit ? (
          <span style={{
            fontSize: 22,
            color: TRACK_SURFACE.muted,
            fontFamily: FONTS.body,
            fontWeight: 600,
            letterSpacing: 0,
          }}>
            min
          </span>
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

  // Maps not configured / failed → render a friendly placeholder so
  // the rest of the en-route card still works without a map key.
  if (!MAPS_KEY || loadError) {
    return (
      <div data-glass="soft" style={{
        marginTop: 20,
        height: 240,
        borderRadius: 8,
        background: TRACK_SURFACE.soft,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1px dashed ${TRACK_SURFACE.softBorder}`,
        fontSize: 14, color: TRACK_SURFACE.muted,
        textAlign: 'center', padding: 24,
      }}>
        Map preview unavailable.
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div style={{
        marginTop: 20, height: 240, borderRadius: 8,
        background: TRACK_SURFACE.soft,
      }} />
    );
  }

  return (
    <div style={{
      borderRadius: 8,
      overflow: 'hidden',
      marginTop: 20,
      boxShadow: '0 2px 12px rgba(15, 23, 42, 0.08)',
    }}>
      <GoogleMap
        center={center}
        zoom={12}
        mapContainerStyle={{ width: '100%', height: 320 }}
        options={{
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'cooperative',
          clickableIcons: false,
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
            scale: 11,
            fillColor: COLORS.wavesBlue,
            fillOpacity: 1,
            strokeColor: COLORS.white,
            strokeWeight: 4,
          }}
          title="Your Waves tech"
          zIndex={2}
        />
        <Marker
          position={property}
          icon={{
            path: 'M -10,4 L -10,-4 L 0,-12 L 10,-4 L 10,4 Z',
            scale: 1,
            fillColor: COLORS.blueDeeper,
            fillOpacity: 1,
            strokeColor: COLORS.white,
            strokeWeight: 2,
          }}
          title="Your property"
          zIndex={1}
        />
      </GoogleMap>
    </div>
  );
}

function TechBlock({ tech, size = 'md' }) {
  const px = size === 'lg' ? 64 : 48;
  if (!tech) return null;
  const initial = (tech.firstName || '?').charAt(0).toUpperCase();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      {tech.photoUrl ? (
        <img
          src={tech.photoUrl}
          alt={tech.firstName || ''}
          style={{
            width: px, height: px, borderRadius: '50%',
            objectFit: 'cover',
            border: `3px solid ${TRACK_SURFACE.surface}`,
            boxShadow: `0 0 0 2px ${TRACK_SURFACE.border}`,
          }}
        />
      ) : (
        <div style={{
          width: px, height: px, borderRadius: '50%',
          background: COLORS.blueDeeper, color: COLORS.white,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: px * 0.4, fontWeight: 700,
        }}>
          {initial}
        </div>
      )}
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: TRACK_SURFACE.text, lineHeight: 1.2 }}>
          {tech.firstName}
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
  const p = data.property || {};
  const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const addrLines = [p.addressLine1, p.addressLine2, cityLine].filter(Boolean);
  if (!c.name && addrLines.length === 0 && !c.email && !c.phone) return null;
  return (
    <div style={{
      marginTop: 16,
      paddingTop: 16,
      borderTop: `1px solid ${TRACK_SURFACE.border}`,
    }}>
      {c.name ? (
        <div style={{ fontSize: 16, fontWeight: 600, color: TRACK_SURFACE.text }}>{c.name}</div>
      ) : null}
      {addrLines.length > 0 ? (
        <div style={{ fontSize: 14, color: TRACK_SURFACE.body, marginTop: 6, lineHeight: 1.5 }}>
          {addrLines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      ) : null}
      {c.email ? (
        <div style={{ fontSize: 14, marginTop: 6 }}>
          <a href={`mailto:${c.email}`} style={{ color: TRACK_SURFACE.body, textDecoration: 'none' }}>{c.email}</a>
        </div>
      ) : null}
      {c.phone ? (
        <div style={{ fontSize: 14, marginTop: 4 }}>
          <a href={`tel:${c.phone}`} style={{ color: TRACK_SURFACE.body, textDecoration: 'none' }}>{c.phone}</a>
        </div>
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
      <StatusPill label="Scheduled" color={COLORS.wavesBlue} />
      <div style={{
        fontFamily: FONTS.heading,
        fontSize: 24,
        fontWeight: 700,
        marginTop: 16,
        lineHeight: 1.25,
        color: TRACK_SURFACE.text,
      }}>
        {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}
        your {data.service?.type?.toLowerCase() || 'service'} is booked{window ? ` for ${window}` : ''}.
      </div>
      <div style={{ fontSize: 16, color: TRACK_SURFACE.body, marginTop: 12, lineHeight: 1.5 }}>
        You'll get a text as soon as {techFirst} is on the way.
      </div>
      {data.property?.addressLine1 ? (
        <div style={{ fontSize: 14, color: TRACK_SURFACE.muted, marginTop: 16 }}>
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
          TEXT {(data.tech?.firstName || 'ADAM').toUpperCase()}
        </a>
      </Card>

    </>
  );
}

function OnPropertyCard({ data }) {
  const techFirst = data.tech?.firstName || 'Your technician';
  return (
    <Card accent={COLORS.green}>
      <StatusPill label="On property" color={COLORS.green} />
      <div style={{
        fontFamily: FONTS.heading,
        fontSize: 24, fontWeight: 700, marginTop: 16, lineHeight: 1.25,
        color: COLORS.blueDeeper,
      }}>
        {techFirst} is servicing your property.
      </div>
      <div style={{ marginTop: 20 }}>
        <TechBlock tech={data.tech} size="lg" />
      </div>
      <ClientMeta data={data} />
    </Card>
  );
}

function CompleteCard({ data }) {
  return (
    <Card accent={COLORS.green}>
      <StatusPill label="Service complete" color={COLORS.green} />
      <div style={{
        fontFamily: FONTS.heading,
        fontSize: 24, fontWeight: 700, marginTop: 16, lineHeight: 1.25,
        color: COLORS.blueDeeper,
      }}>
        Thanks for choosing Waves
        {data.customerFirstName ? `, ${data.customerFirstName}` : ''}.
      </div>
      <div style={{ fontSize: 15, color: TRACK_SURFACE.body, marginTop: 8 }}>
        {data.service?.type} completed.
      </div>
      <div style={{ marginTop: 20 }}>
        <TechBlock tech={data.tech} size="lg" />
      </div>
      <a
        href={data.summary?.reviewUrl || '#'}
        data-glass-accent=""
        style={{ ...TRACK_PRIMARY_CTA, width: '100%', marginTop: 24, boxSizing: 'border-box' }}
      >
        LEAVE A 5-STAR REVIEW
      </a>
    </Card>
  );
}

// ── State switcher (preview-only chrome) ─────────────────────────
function StateSwitcher({ value, onChange }) {
  const states = ['scheduled', 'en_route', 'on_property', 'complete'];
  return (
    <div data-glass="soft" style={{
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap',
      marginBottom: 16,
      padding: 10,
      background: TRACK_SURFACE.surface,
      borderRadius: 8,
      border: `1px solid ${TRACK_SURFACE.border}`,
    }}>
      <div style={{
        fontSize: 12, fontWeight: 700, letterSpacing: 0,
        textTransform: 'uppercase', color: TRACK_SURFACE.muted,
        width: '100%', marginBottom: 4,
      }}>
        Preview state
      </div>
      {states.map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          style={{
            padding: '6px 12px',
            borderRadius: 9999,
            fontSize: 14,
            fontWeight: 600,
            fontFamily: FONTS.body,
            border: `1.5px solid ${value === s ? COLORS.blueDeeper : TRACK_SURFACE.border}`,
            background: value === s ? COLORS.blueDeeper : TRACK_SURFACE.surface,
            color: value === s ? COLORS.white : TRACK_SURFACE.body,
            cursor: 'pointer',
          }}
        >
          {s.replace('_', ' ')}
        </button>
      ))}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────
export default function TrackPreviewPage() {
  // Glass release (GATE_PORTAL_GLASS): cached server default resolves
  // synchronously (no legacy flash on repeat visits), the ui-flags fetch
  // keeps it fresh, ?glass=1 / ?glass=0 keep param precedence.
  const [glassActive, setGlassActive] = useState(portalGlassInitial);
  useEffect(() => watchPortalGlassDefault(setGlassActive), []);
  useGlassSurface(glassActive, 'full');

  const [params, setParams] = useSearchParams();
  const state = params.get('state') || 'en_route';
  const data = useMemo(() => mockData(state), [state]);

  const setState = (s) => {
    const next = new URLSearchParams(params);
    next.set('state', s);
    setParams(next, { replace: true });
  };

  return (
    <Page>
      <StateSwitcher value={state} onChange={setState} />
      {state === 'scheduled'   ? <ScheduledCard   data={data} /> : null}
      {state === 'en_route'    ? <EnRouteCard     data={data} /> : null}
      {state === 'on_property' ? <OnPropertyCard  data={data} /> : null}
      {state === 'complete'    ? <CompleteCard    data={data} /> : null}
      <div style={{
        fontSize: 12, color: TRACK_SURFACE.muted, marginTop: 16,
        textAlign: 'center', padding: '0 8px',
      }}>
        Preview only · mock data · {WAVES_SUPPORT_PHONE_DISPLAY}
      </div>
    </Page>
  );
}
