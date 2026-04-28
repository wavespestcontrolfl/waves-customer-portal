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
import { COLORS, FONTS, GOLD_CTA } from '../theme-brand';
import BrandFooter from '../components/BrandFooter';

const FONT_BODY = FONTS.body;
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
const WAVES_SMS_TEL = '+19412975749';
const WAVES_PHONE_DISPLAY = '(941) 297-5749';

// ── Mock data ────────────────────────────────────────────────────
// Sarasota, FL — tech ~2.4 mi from property along US-41
const MOCK_TECH_COORDS    = { lat: 27.3364, lng: -82.5307 };
const MOCK_PROPERTY_COORDS = { lat: 27.3015, lng: -82.5104 };

function mockData(state) {
  const base = {
    state,
    customerFirstName: 'Sarah',
    tech: {
      firstName: 'Bryan',
      photoUrl: null,
      yearsWithWaves: 4,
    },
    window: {
      start: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 72 * 60 * 1000).toISOString(),
    },
    property: {
      ...MOCK_PROPERTY_COORDS,
      addressLine1: '1234 Bayshore Dr',
    },
    service: {
      type: 'Quarterly Pest Control',
      estimatedDurationMin: 60,
      summary: 'Interior/exterior perimeter treatment targeting roaches, ants, spiders, silverfish, and occasional invaders.',
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

function Card({ children, accent }) {
  return (
    <div style={{
      background: COLORS.white,
      borderRadius: 20,
      padding: 24,
      boxShadow: '0 4px 24px rgba(15, 23, 42, 0.06)',
      borderTop: accent ? `4px solid ${accent}` : 'none',
      marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function StatusPill({ label, color }) {
  return (
    <div style={{
      display: 'inline-block',
      fontSize: 12,
      fontWeight: 700,
      letterSpacing: '0.1em',
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
      <div style={{ fontSize: 16, color: COLORS.textBody, marginBottom: 4 }}>
        {techFirst} arrives in
      </div>
      <div style={{
        fontFamily: FONTS.display,
        fontSize: 'clamp(56px, 14vw, 88px)',
        fontWeight: 700,
        color: COLORS.blueDeeper,
        lineHeight: 1,
        letterSpacing: '0.02em',
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
      }}>
        <span>{display}</span>
        {showUnit ? (
          <span style={{
            fontSize: 22,
            color: COLORS.textCaption,
            fontFamily: FONTS.body,
            fontWeight: 600,
            letterSpacing: '0.02em',
          }}>
            min
          </span>
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

  // Maps not configured / failed → render a friendly placeholder so
  // the rest of the en-route card still works without a map key.
  if (!MAPS_KEY || loadError) {
    return (
      <div style={{
        marginTop: 20,
        height: 240,
        borderRadius: 16,
        background: `linear-gradient(135deg, ${COLORS.blueSurface} 0%, ${COLORS.blueLight} 100%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1px dashed ${COLORS.grayLight}`,
        fontSize: 14, color: COLORS.textCaption,
        textAlign: 'center', padding: 24,
      }}>
        Map preview — set <code style={{ background: COLORS.white, padding: '2px 6px', borderRadius: 4 }}>VITE_GOOGLE_MAPS_API_KEY</code> to render the live map.
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div style={{
        marginTop: 20, height: 240, borderRadius: 16,
        background: COLORS.offWhite,
      }} />
    );
  }

  return (
    <div style={{
      borderRadius: 16,
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
            border: `3px solid ${COLORS.white}`,
            boxShadow: `0 0 0 2px ${COLORS.blueLight}`,
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
        <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.navy, lineHeight: 1.2 }}>
          {tech.firstName}
        </div>
        {tech.yearsWithWaves ? (
          <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 2 }}>
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
  const summary = data.service?.summary;
  return (
    <div style={{
      marginTop: 16,
      paddingTop: 16,
      borderTop: `1px solid ${COLORS.offWhite}`,
    }}>
      <div style={{ fontSize: 14, color: COLORS.textCaption, marginBottom: 4 }}>Today's visit</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.navy }}>
        {data.service?.type}
      </div>
      {summary ? (
        <div style={{ fontSize: 15, color: COLORS.textBody, marginTop: 6, lineHeight: 1.5 }}>
          {summary}
        </div>
      ) : null}
      {window ? (
        <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 10 }}>{window}</div>
      ) : null}
      {addr ? (
        <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 2 }}>{addr}</div>
      ) : null}
    </div>
  );
}

function PrepChecklist() {
  const [open, setOpen] = useState(false);
  const items = [
    'Gates unlocked',
    'Pets inside or secured',
    'Sprinklers off until tonight',
  ];
  return (
    <div style={{
      marginTop: 16,
      padding: '14px 18px',
      background: COLORS.white,
      borderRadius: 12,
      border: `1px solid ${COLORS.slate200}`,
    }}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontFamily: FONTS.body,
          fontSize: 16,
          fontWeight: 600,
          color: COLORS.blueDeeper,
          padding: 0,
        }}
      >
        <span>Quick prep</span>
        <span style={{ fontSize: 14, color: COLORS.textCaption }}>{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <ul style={{
          margin: '12px 0 0',
          paddingLeft: 22,
          fontSize: 15,
          color: COLORS.textBody,
          lineHeight: 1.7,
        }}>
          {items.map((t) => <li key={t}>{t}</li>)}
        </ul>
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
        color: COLORS.blueDeeper,
      }}>
        {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}
        your {data.service?.type?.toLowerCase() || 'service'} is booked{window ? ` for ${window}` : ''}.
      </div>
      <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 12, lineHeight: 1.5 }}>
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
          href={`sms:${WAVES_SMS_TEL}`}
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
      <ServiceMeta data={data} />
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
      <div style={{ fontSize: 15, color: COLORS.textBody, marginTop: 8 }}>
        {data.service?.type} completed.
      </div>
      <div style={{ marginTop: 20 }}>
        <TechBlock tech={data.tech} size="lg" />
      </div>
      <a
        href={data.summary?.reviewUrl || '#'}
        style={{ ...GOLD_CTA, width: '100%', marginTop: 24, boxSizing: 'border-box' }}
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
    <div style={{
      display: 'flex',
      gap: 6,
      flexWrap: 'wrap',
      marginBottom: 16,
      padding: 10,
      background: COLORS.white,
      borderRadius: 12,
      border: `1px solid ${COLORS.slate200}`,
    }}>
      <div style={{
        fontSize: 12, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: COLORS.textCaption,
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
            border: `1.5px solid ${value === s ? COLORS.blueDeeper : COLORS.slate200}`,
            background: value === s ? COLORS.blueDeeper : COLORS.white,
            color: value === s ? COLORS.white : COLORS.textBody,
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
        fontSize: 12, color: COLORS.textCaption, marginTop: 16,
        textAlign: 'center', padding: '0 8px',
      }}>
        Preview only · mock data · {WAVES_PHONE_DISPLAY}
      </div>
    </Page>
  );
}
