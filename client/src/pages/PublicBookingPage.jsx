import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import AddressAutocomplete from '../components/AddressAutocomplete';
import BrandFooter from '../components/BrandFooter';
import { Button } from '../components/Button';
import Icon from '../components/Icon';
import { WavesShell } from '../components/brand';
import { COLORS, FONTS } from '../theme-brand';
import { fireGlassConfetti } from '../glass/glass-engine';
import WavesAIScheduleSearch from '../components/booking/WavesAIScheduleSearch';
import { track, FUNNEL_EVENTS } from '../lib/analytics/events';
import { useAuth } from '../hooks/useAuth';
import { api } from '../utils/api';
import { ESTIMATE_QUOTE_URL } from '../lib/estimateMarketingRedirects';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const SERVICES = [
  { id: 'pest_control', label: 'Pest Control', duration: 60, icon: 'bug', desc: 'Quarterly interior + exterior treatment' },
  { id: 'lawn_care', label: 'Lawn Care', duration: 60, icon: 'sprout', desc: 'Fertilization + weed control program' },
  { id: 'mosquito', label: 'Mosquito Control', duration: 45, icon: 'bug', desc: 'WaveGuard barrier treatment' },
  { id: 'tree_shrub', label: 'Tree & Shrub', duration: 60, icon: 'tree', desc: 'Ornamental plant care' },
  { id: 'termite', label: 'Termite Inspection', duration: 90, icon: 'shield', desc: 'WDO inspection + treatment plan' },
  { id: 'rodent', label: 'Rodent Control', duration: 60, icon: 'mouse', desc: 'Exclusion + monitoring stations' },
  { id: 'bora_care', label: 'Bora-Care Wood Treatment', duration: 90, icon: 'shield', desc: 'Borate treatment for termites, beetles & wood-decay fungi' },
];

const ONE_TIME_BOOKING_SOURCES = new Set(['estimate-accept', 'quote-wizard-onetime']);
const RECURRING_SERVICE_PATTERNS = {
  pest_control: 'quarterly',
  lawn_care: 'quarterly',
  mosquito: 'monthly',
  tree_shrub: 'bimonthly',
};

function readCookie(name) {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}

// The arrival window promised to the customer is 2 HOURS from the slot start
// (owner directive; matches sms-time-format arrivalWindowRange and
// ReschedulePage). A slot's end_time/end_label is the job-duration block that
// sizes scheduling — never show it as the arrival window.
const ARRIVAL_WINDOW_MINUTES = 120;

function arrivalEndLabel(start24) {
  const [h, m] = String(start24 || '').split(':').map(Number);
  if (Number.isNaN(h)) return null;
  const total = (h * 60 + (m || 0) + ARRIVAL_WINDOW_MINUTES) % (24 * 60);
  const hour = Math.floor(total / 60);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(total % 60).padStart(2, '0')} ${suffix}`;
}

// Capture paid-click attribution from the current URL + Meta cookies so a direct
// /book?gclid=… / ?fbclid=… booking on the portal page is attributed the same way
// the astro funnel's BookingForm is. Mirrors the LeadAttribution shape the server
// reads (services/lead-estimate-link.js attributeSelfBooking). Current-URL only —
// the portal page is itself the landing for a direct ad click.
function captureBookingAttribution() {
  if (typeof window === 'undefined') return null;
  try {
    const p = new URLSearchParams(window.location.search);
    const utm = {
      source: p.get('utm_source') || null,
      medium: p.get('utm_medium') || null,
      campaign: p.get('utm_campaign') || null,
      term: p.get('utm_term') || null,
      content: p.get('utm_content') || null,
    };
    const hasUtm = Object.values(utm).some(Boolean);
    return {
      utm: hasUtm ? utm : null,
      gclid: p.get('gclid') || null,
      wbraid: p.get('wbraid') || null,
      gbraid: p.get('gbraid') || null,
      fbclid: p.get('fbclid') || null,
      fbc: readCookie('_fbc'),
      fbp: readCookie('_fbp'),
      referrer: document.referrer || null,
      landing_url: window.location.href || null,
      domain: (window.location.hostname || '').replace(/^www\./, '') || null,
    };
  } catch { return null; }
}

export default function PublicBookingPage() {
  // Marketing surface — standard wavespestcontrol.com warm chrome; the glass
  // scene stays on the tokened/portal customer surfaces only.
  const [searchParams] = useSearchParams();
  const source = searchParams.get('source') || 'direct';
  const serviceParam = searchParams.get('service') || 'pest_control';
  const quotedServiceLabel = (searchParams.get('service_label') || '').trim().slice(0, 120);
  // Quote→book handoff: the estimate this booking came from + its server-trusted
  // token. Passed through to /booking/confirm, which verifies the token before
  // pricing the visit from that exact estimate (pay-at-visit).
  const estimateIdParam = (searchParams.get('estimate_id') || '').trim() || null;
  const estimateTokenParam = (searchParams.get('estimate_token') || '').trim() || null;
  // Accepted-estimate booking links (estimate-accept SMS) carry a namespaced
  // HMAC instead of the quote-wizard pricing token — same customers-only-gate
  // bypass, verified server-side at /confirm, never a pricing input.
  const acceptTokenParam = (searchParams.get('accept_token') || '').trim() || null;
  // Token entries (estimate / accept links) carry their OWN identity — the
  // estimate's customer. They bypass the OTP gate, never attach the ambient
  // portal session, and never prefill from it: a signed-in household member
  // opening someone else's link must not re-point that booking.
  const tokenEntry = !!(estimateTokenParam || acceptTokenParam);
  const initialService = SERVICES.find(s => s.id === serviceParam) || SERVICES[0];
  const isEmbedded = window !== window.parent;

  // Post height updates to parent when embedded in an iframe
  useEffect(() => {
    if (!isEmbedded) return;
    const postHeight = () => {
      const h = document.documentElement.scrollHeight;
      try { window.parent.postMessage({ type: 'waves-book-resize', height: h }, '*'); } catch { /* cross-origin */ }
    };
    postHeight();
    const ro = new ResizeObserver(postHeight);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [isEmbedded]);

  // Customers-only gate (GATE_BOOKING_CUSTOMERS_ONLY, owner directive
  // 2026-07-23): self-scheduling is for current customers. Bare entries
  // (no estimate token) must verify with the portal OTP before the wizard;
  // estimate-token entries bypass (they're already estimate-bound and the
  // server verifies the token at confirm). The mode comes from
  // /booking/config; `null` = still loading. A config failure fails OPEN
  // client-side — the server enforces the gate at /confirm regardless, and
  // its refusal carries the quote link, so nothing insecure leaks through.
  const { customer: authCustomer, isAuthenticated, sendCode, verifyCode, clearError: clearAuthError, error: authError } = useAuth();
  const [customersOnly, setCustomersOnly] = useState(null);
  const [gatePhone, setGatePhone] = useState('');
  const [gateCode, setGateCode] = useState('');
  const [gateStep, setGateStep] = useState('phone');
  const [gateSending, setGateSending] = useState(false);
  // Failed-verify counter → "may not be on file" hint after 2 (mirrors the
  // login page; shown regardless of cause, so no account enumeration).
  const [gateFailedVerifies, setGateFailedVerifies] = useState(0);
  // Server customers-only refusal from /confirm — rendered as a card with
  // the quote-wizard handoff, never a dead end.
  const [refusal, setRefusal] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/booking/config`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((cfg) => { if (!cancelled) setCustomersOnly(cfg?.customers_only === true); })
      .catch(() => { if (!cancelled) setCustomersOnly(false); });
    return () => { cancelled = true; };
  }, []);

  const [step, setStep] = useState(1);
  const [service, setService] = useState(initialService);
  const [address, setAddress] = useState({ line1: '', line2: '', formatted: '', city: '', state: 'FL', zip: '' });
  const [coords, setCoords] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [contact, setContact] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [notes, setNotes] = useState('');
  const [existingCustomerId, setExistingCustomerId] = useState(null);
  const [addressMayMatchCustomer, setAddressMayMatchCustomer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confCode, setConfCode] = useState('');
  const [secureCardUrl, setSecureCardUrl] = useState(null);
  // Custom date/time finder — Waves AI search + 90-day date picker
  const [searchResult, setSearchResult] = useState(null);
  const [browseDays, setBrowseDays] = useState(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const [pickedDate, setPickedDate] = useState(null);
  // Day the customer has drilled into to see its 1-hour openings (null = day list)
  const [openDay, setOpenDay] = useState(null);
  const latestPickedDateRef = useRef(null);
  // Guards booking_availability_loaded against double-firing when a manually
  // typed address is geocoded server-side (setCoords re-runs loadAvailability).
  const availTrackedForRef = useRef(null);
  // Latest-wins guards for the async address/phone lookups and availability
  // fetch: a lookup started for address A can resolve AFTER the visitor edits
  // to address B, and without these it would re-bind A's customer id / coords
  // onto B's booking. Every address edit bumps the counter (see updateAddress),
  // and each fetch captures its value and discards a stale response. Mirrors
  // the latestPickedDateRef pattern already used for browse-days here and the
  // requestId guard in SlotPicker.
  const addressLookupSeqRef = useRef(0);
  // Phone edits invalidate the phone lookup independently of the address (the
  // match is resolved against phone + address), so a late lookup for an
  // earlier phone can't apply its customer/contact after the number changes.
  const phoneLookupSeqRef = useRef(0);
  // Proof-of-funnel token from the availability response; echoed to
  // /capture-intent so the public capture endpoint can't be abused.
  const captureTokenRef = useRef(null);
  // Stable per /book session — the capture upsert key, so a corrected phone (after
  // a mistyped first attempt) updates the SAME intent instead of orphaning the
  // wrong number as its own recovery-eligible row.
  const sessionIdRef = useRef(null);
  if (!sessionIdRef.current) {
    sessionIdRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  const updateAddress = useCallback((updater) => {
    setAddress((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      return next;
    });
    // Drop the previous address's geocode: coords otherwise survive an edit
    // (onSelect only sets them when Google returns them, so a manually typed
    // street keeps the OLD coordinates), and the confirm payload + slot_sig
    // location key would ship address B with address A's lat/lng. A fresh
    // geocode arrives from the autocomplete onSelect or the availability echo.
    setCoords(null);
    // Invalidate any in-flight address-scoped request (customer/phone lookup,
    // availability, AI search, browse-days) so a late response can't restore
    // the prior address's match, slots, search result, or capture token onto
    // this edited address — selecting one of those slots would then fail the
    // server's location-bound slot_sig check.
    addressLookupSeqRef.current += 1;
    // A pending onPickDate is keyed on its date; null the ref so its late
    // browse response is discarded too (the seq guard below is the primary
    // invalidator, this is belt-and-suspenders for the date-race path).
    latestPickedDateRef.current = null;
    setAvailability([]);
    setSelectedDate(null);
    setSelectedSlot(null);
    setExistingCustomerId(null);
    setAddressMayMatchCustomer(false);
    setContact({ firstName: '', lastName: '', phone: '', email: '' });
    setError('');
    setSearchResult(null);
    setBrowseDays(null);
    setBrowseError('');
    // A pending browse whose finally is now short-circuited by the seq bump
    // won't clear this itself — reset it here so returning to step 2 never
    // shows "Loading times…" forever with no active request.
    setBrowseLoading(false);
    setPickedDate(null);
    setOpenDay(null);
  }, []);

  // Step 2 → load availability whenever we enter it
  const loadAvailability = useCallback(async () => {
    if (!service || !address.line1) return;
    const seq = addressLookupSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const fullAddress = address.formatted || address.line1;
      const params = new URLSearchParams({
        address: fullAddress,
        service_type: service.id,
        duration_minutes: String(service.duration),
        // Expand each open day into its full block of 1-hour windows so the
        // day → time picker can show real per-day openings, not a single slot.
        expand: 'open',
      });
      if (coords?.lat && coords?.lng) {
        params.set('lat', String(coords.lat));
        params.set('lng', String(coords.lng));
      }
      const res = await fetch(`${API_BASE}/booking/availability?${params}`);
      // Address edited mid-flight: don't apply this address's slots, capture
      // token, geocode echo, error, OR loading state onto the new one — the
      // re-triggered load owns those now. Checked before the ok/throw branch
      // so a stale FAILURE can't clear the current request's availability
      // or surface a stale error either.
      if (seq !== addressLookupSeqRef.current) return;
      // Parse AFTER tolerating a non-JSON body (proxy 5xx, dropped
      // connection): the raw SyntaxError ("Unexpected end of JSON input")
      // used to land verbatim in the customer-facing banner (audit S3-17).
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "We couldn't load times right now. Try again in a moment, or call (941) 297-5749.");
      if (seq !== addressLookupSeqRef.current) return;
      if (data.capture_token) captureTokenRef.current = data.capture_token;
      setAvailability(data.days || []);
      // Fire once per resolved address: loadAvailability re-runs when the server
      // returns coords for a manually typed address (setCoords → new callback
      // identity → step-2 effect re-fetches), which would otherwise double-count
      // this step for manual-entry users.
      if (availTrackedForRef.current !== fullAddress) {
        availTrackedForRef.current = fullAddress;
        track(FUNNEL_EVENTS.BOOKING_AVAILABILITY_LOADED, {
          has_slots: (data.slots?.length || 0) > 0 || (data.days?.length || 0) > 0,
        });
      }
      if (data.lat && data.lng) {
        setCoords(current => (
          current?.lat === data.lat && current?.lng === data.lng
            ? current
            : { lat: data.lat, lng: data.lng }
        ));
      }
      if ((!data.slots || data.slots.length === 0) && (!data.days || data.days.length === 0)) {
        setError('No times available in the next 2 weeks. Call (941) 297-5749 and we\'ll get you on the schedule.');
      }
    } catch (err) {
      // A stale request's failure must not clear the current request's slots
      // or show its error.
      if (seq !== addressLookupSeqRef.current) return;
      setError(err.message);
      setAvailability([]);
    } finally {
      // Only the current request owns the loading flag.
      if (seq === addressLookupSeqRef.current) setLoading(false);
    }
  }, [service, address, coords]);

  const applyCustomer = useCallback((customer) => {
    setExistingCustomerId(customer.id);
    setContact(c => ({
      ...c,
      firstName: customer.first_name || '',
      lastName: customer.last_name || '',
      phone: customer.phone || '',
      email: customer.email || '',
    }));
  }, []);

  // Verified current customer (OTP gate passed, or already signed in to the
  // portal): bind the booking to their account and prefill contact. Identity
  // is re-derived server-side from the bearer at /confirm either way — these
  // fields are UX only. existingCustomerId is in the deps on purpose: an
  // address edit clears it (updateAddress's household reset), and for a
  // verified customer it must re-apply or the contact step would demand
  // fields the account already has.
  useEffect(() => {
    if (!customersOnly || !isAuthenticated || !authCustomer?.id || tokenEntry) return;
    if (existingCustomerId === authCustomer.id) return;
    applyCustomer({
      id: authCustomer.id,
      first_name: authCustomer.first_name || authCustomer.firstName || '',
      last_name: authCustomer.last_name || authCustomer.lastName || '',
      phone: authCustomer.phone || '',
      email: authCustomer.email || '',
    });
  }, [customersOnly, isAuthenticated, authCustomer, existingCustomerId, applyCustomer, tokenEntry]);

  const checkExistingCustomerByAddress = useCallback(async (nextAddress) => {
    // Always look up by the street-only line1 when we have it: formatted can
    // still carry a subpremise inline AFTER the visitor clears the unit box,
    // and a lookup on it would re-submit the stale unit and link the wrong
    // apartment's account. The unit travels only as its own param.
    const lookupAddress = nextAddress.line1 || nextAddress.formatted;
    if (!lookupAddress) return;
    const seq = addressLookupSeqRef.current;
    try {
      const params = new URLSearchParams({ address: lookupAddress });
      if (nextAddress.city) params.set('city', nextAddress.city);
      if (nextAddress.zip) params.set('zip', nextAddress.zip);
      if (nextAddress.line2) params.set('unit', nextAddress.line2);
      const res = await fetch(`${API_BASE}/booking/customer-lookup?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      // Discard if the address changed while this was in flight — otherwise
      // the prior address's match would re-bind onto the edited one.
      if (seq !== addressLookupSeqRef.current) return;
      setAddressMayMatchCustomer(!!data.possible_match);
      // Link a recognized returning customer to their account as early as
      // step 1 so a fast Confirm doesn't race the step-3 phone lookup and trip
      // the phone-on-file guard. The address lookup intentionally returns only
      // the opaque id (no PII), so don't run applyCustomer here — contact
      // fields are filled later by the phone lookup, which does return them.
      if (data.customer?.id) setExistingCustomerId(data.customer.id);
    } catch { /* best-effort */ }
  }, []);

  // Top of the booking funnel — fires once on mount.
  useEffect(() => {
    // `source` comes from the public query string — map to a known enum so a
    // crafted /book?source=<email-or-token> can't send raw PII as a property.
    const KNOWN_SOURCES = new Set(['direct', 'marketing-site', 'estimate-accept', 'quote-wizard', 'quote-wizard-onetime', 'newsletter-quiz']);
    const safeSource = KNOWN_SOURCES.has(source) ? source : 'other';
    track(FUNNEL_EVENTS.BOOKING_VIEWED, { source: safeSource, service: service.id });
    // Deliberately fires once on mount (funnel-top event).
  }, []);

  useEffect(() => {
    if (step === 2) loadAvailability();
  }, [step, loadAvailability]);

  // Detect existing customer by phone on step 3
  const checkExistingCustomer = useCallback(async (phone) => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) return;
    // The phone match depends on BOTH phone and address, so it's stale if
    // either changed while in flight.
    const addrSeq = addressLookupSeqRef.current;
    const phoneSeq = phoneLookupSeqRef.current;
    try {
      const params = new URLSearchParams({ phone: digits });
      // Same street-only preference as checkExistingCustomerByAddress — a
      // cleared unit box must not resurrect the subpremise inside formatted.
      const lookupAddress = address.line1 || address.formatted;
      if (lookupAddress) params.set('address', lookupAddress);
      if (address.city) params.set('city', address.city);
      if (address.zip) params.set('zip', address.zip);
      if (address.line2) params.set('unit', address.line2);
      const res = await fetch(`${API_BASE}/booking/customer-lookup?${params}`);
      if (res.ok) {
        const data = await res.json();
        // Discard if the address OR the phone changed under it — the match was
        // resolved against the old address + old phone.
        if (addrSeq !== addressLookupSeqRef.current || phoneSeq !== phoneLookupSeqRef.current) return;
        if (data.customer) {
          applyCustomer(data.customer);
        }
      }
    } catch { /* best-effort */ }
  }, [address, applyCustomer]);

  // Fire-and-forget partial capture: once a visitor has entered a phone + picked
  // a slot, record a booking_intent so the recovery cron can follow up if they
  // bail before confirming. keepalive so it survives the tab closing right after.
  const captureBookingIntent = () => {
    const digits = (contact.phone || '').replace(/\D/g, '');
    if (digits.length !== 10 || !selectedSlot || !captureTokenRef.current) return;
    try {
      fetch(`${API_BASE}/booking/capture-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          capture_token: captureTokenRef.current,
          session_id: sessionIdRef.current,
          capture_client_ts: Date.now(),
          // Quote→book handoff — persisted (HMAC-verified server-side) on the
          // intent so the recovery link re-carries it and a booking recovered
          // from the SMS/email still prices from this quote (pay-at-visit).
          pricing_estimate_id: estimateIdParam || undefined,
          estimate_token: estimateTokenParam || undefined,
          source,
          service_id: service.id,
          service_type: quotedServiceLabel || service.label,
          quoted_service_label: quotedServiceLabel || null,
          slot_date: selectedDate,
          slot_start: selectedSlot.start_time,
          slot_end: selectedSlot.end_time,
          attribution: captureBookingAttribution() || undefined,
          new_customer: {
            first_name: contact.firstName,
            last_name: contact.lastName,
            phone: digits,
            email: contact.email,
            address_line1: address.line1,
            address_line2: address.line2 || undefined,
            city: address.city,
            state: address.state,
            zip: address.zip,
            lat: coords?.lat,
            lng: coords?.lng,
          },
        }),
      }).catch(() => {});
    } catch { /* never block the funnel */ }
  };

  // Keep the captured intent in sync with the booking context. The blur handlers
  // only fire on contact edits, so a visitor who already entered a phone, then
  // changed slot / service / address and abandoned without re-blurring would
  // otherwise leave a STALE intent (recovery would name the wrong appointment).
  useEffect(() => {
    if ((contact.phone || '').replace(/\D/g, '').length === 10 && selectedSlot) captureBookingIntent();
    // Deliberately keyed on slot/service/address identity, not the callback.
  }, [selectedSlot?.start_time, selectedDate, service.id, address.line1, address.line2]);

  const recurringPattern = ONE_TIME_BOOKING_SOURCES.has(source)
    ? null
    : RECURRING_SERVICE_PATTERNS[service.id] || null;

  const handleConfirm = async () => {
    setLoading(true);
    setError('');
    setRefusal(null);
    try {
      // Prove "current customer" with the portal bearer whenever the visitor
      // is signed in — keyed on the SESSION, not on the config-derived
      // customersOnly flag, because /booking/config failing open must not
      // strip the header while the server's gate is actually on (a real
      // customer would eat the 403 quote card; Codex round-4 P2). Verified
      // sessions go through api.fetchRaw — the one client path that attaches
      // the bearer AND refreshes + retries on 401, so a customer who spends
      // >15 min picking a slot isn't refused on an expired access token
      // (the server answers that case with a refreshable TOKEN_EXPIRED 401).
      // Token entries (estimate / accept links) deliberately stay
      // unauthenticated even when the browser holds a portal session: the
      // server prefers bearer identity, so an ambient signed-in account
      // would otherwise hijack — or be address-refused on — a link that
      // belongs to the ESTIMATE's customer. Signed-out and token entries
      // keep the plain unauthenticated fetch; with the gate off the server
      // never reads the header either way.
      const doConfirmFetch = (isAuthenticated && !tokenEntry)
        ? (url, opts) => api.fetchRaw(url, opts)
        : (url, opts) => fetch(url, opts);
      const res = await doConfirmFetch(`${API_BASE}/booking/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: existingCustomerId || null,
          // Quote→book handoff — priced from this exact estimate (token-verified),
          // as pricing_estimate_id so it never influences identity resolution.
          pricing_estimate_id: estimateIdParam || undefined,
          estimate_token: estimateTokenParam || undefined,
          // Accepted-estimate gate pass — pure passthrough of the URL's
          // accept_token; only the customers-only gate reads it.
          accept_token: acceptTokenParam || undefined,
          // Accept-retry correlation — pure passthrough of the URL's
          // estimate_id; the server validates it (uuid shape + existence)
          // and stamps scheduled_services.source_estimate_id. Never used
          // for identity resolution.
          source_estimate_id: estimateIdParam || undefined,
          slot_date: selectedDate,
          slot_start: selectedSlot.start_time,
          slot_end: selectedSlot.end_time,
          technician_id: selectedSlot.technician_id,
          // Server-signed offer from the availability response — pure
          // passthrough; /confirm rejects slots it never offered without it.
          slot_sig: selectedSlot.slot_sig,
          // Catalog id the availability request was made with — the server
          // re-derives the signed service scope (and the visit duration)
          // from this, so it must match what step 2 fetched slots for.
          service_id: service.id,
          service_type: quotedServiceLabel || service.label,
          quoted_service_label: quotedServiceLabel || null,
          duration_minutes: service.duration,
          recurring_pattern: recurringPattern,
          customer_notes: notes,
          source,
          referrer_url: document.referrer || null,
          // Carry paid-click attribution so a portal /book?gclid=…/?fbclid=… booking
          // is attributed to its ad channel (server mints a won lead + PPC row).
          attribution: captureBookingAttribution() || undefined,
          // Server creates only when phone/name are present; address is also used to re-verify matched customers.
          new_customer: {
            first_name: contact.firstName,
            last_name: contact.lastName,
            phone: contact.phone.replace(/\D/g, ''),
            email: contact.email,
            address_line1: address.line1,
            address_line2: address.line2 || undefined,
            city: address.city,
            state: address.state,
            zip: address.zip,
            lat: coords?.lat,
            lng: coords?.lng,
          },
        }),
      });
      // Same non-JSON tolerance as loadAvailability (audit S3-17).
      const data = await res.json().catch(() => ({}));
      // Customers-only refusal: not an error banner — a card with the
      // quote-wizard handoff (and a re-verify path), never a dead end.
      if (res.status === 403 && data.customersOnly) {
        setRefusal({ message: data.error, quoteUrl: data.quoteUrl });
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(data.error || "We couldn't complete your booking. Try again in a moment, or call (941) 297-5749 and we'll get you scheduled.");
      setConfCode(data.confirmationCode || 'WPC-????');
      // Card-on-file step (dark until the funnel's gate flips): when the
      // server minted an inline capture link, the confirmation screen shows
      // the "secure your booking" step pointing at /secure/:token.
      setSecureCardUrl(data.secureCard?.url || null);
      track(FUNNEL_EVENTS.BOOKING_CONFIRMED, {
        service: service.id,
        is_existing_customer: !!existingCustomerId,
        recurring: !!recurringPattern,
      });
      setStep(4);
      // Celebration burst — no-ops when glass is off or reduced-motion.
      fireGlassConfetti(window.innerWidth / 2, window.innerHeight / 3);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  // ── customers-only gate handlers ──
  // Reuses the portal OTP endpoints via useAuth (send-code/verify-code keep
  // their existing rate limits and uniform anti-enumeration responses). A
  // successful verify flips isAuthenticated, the gate unmounts, and the
  // prefill effect binds the wizard to the verified account.
  // A pasted/autofilled E.164 number ("+1 (941) 555-1234") is 11 digits —
  // drop the US country code so autofill doesn't dead-end the gate.
  const gateDigitsRaw = gatePhone.replace(/\D/g, '');
  const gateDigits = gateDigitsRaw.length === 11 && gateDigitsRaw.startsWith('1')
    ? gateDigitsRaw.slice(1)
    : gateDigitsRaw;
  const handleGateSendCode = async () => {
    if (gateDigits.length !== 10 || gateSending) return;
    setGateSending(true);
    const ok = await sendCode(`+1${gateDigits}`);
    setGateSending(false);
    if (ok) {
      setGateCode('');
      setGateStep('code');
      setGateFailedVerifies(0);
    }
  };
  const handleGateVerify = async () => {
    if (gateCode.length !== 6 || gateSending) return;
    setGateSending(true);
    const ok = await verifyCode(`+1${gateDigits}`, gateCode);
    setGateSending(false);
    if (!ok) setGateFailedVerifies((n) => n + 1);
  };
  // Bare entries hold on a quiet loading block while the config resolves so
  // the wizard never flashes ahead of the gate; estimate-token entries,
  // accepted-estimate links, and already-signed-in customers skip the gate
  // entirely (the server re-verifies their tokens at /confirm either way).
  const gateChecking = customersOnly === null && !tokenEntry;
  const gateActive = customersOnly === true && !tokenEntry && !isAuthenticated;

  // ── shared styles ──
  // CTAs use <Button variant="primary"|"tertiary"> (see usages below).
  const inputStyle = {
    width: '100%', padding: '12px 14px', borderRadius: 8,
    border: `1.5px solid ${COLORS.grayLight}`, fontSize: 15,
    color: COLORS.navy, background: '#fff',
    transition: 'border-color 0.2s',
  };
  const labelStyle = {
    fontSize: 14, fontWeight: 500, color: COLORS.slate600,
    display: 'block', marginBottom: 6,
  };
  // ── custom date/time finder helpers ──
  const pad2 = (n) => String(n).padStart(2, '0');
  const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const browseMin = toYmd(new Date());
  const browseMax = (() => { const d = new Date(); d.setDate(d.getDate() + 90); return toYmd(d); })();

  const selectSlot = (date, slot) => { setSelectedDate(date); setSelectedSlot({ ...slot, date }); track(FUNNEL_EVENTS.BOOKING_SLOT_SELECTED, { date }); };
  const isSlotSelected = (date, slot) => selectedDate === date && selectedSlot?.start_time === slot.start_time;

  const slotSearchBody = () => ({
    address: address.formatted || address.line1,
    service_type: service.id,
    duration_minutes: service.duration,
    ...(coords?.lat && coords?.lng ? { lat: coords.lat, lng: coords.lng } : {}),
  });

  const runAiSearch = async (query) => {
    const seq = addressLookupSeqRef.current;
    const res = await fetch(`${API_BASE}/booking/find-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, ...slotSearchBody() }),
    });
    // Same non-JSON tolerance as loadAvailability (audit S3-17).
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "We couldn't run that search right now — try again in a moment.");
    // Address edited mid-search: don't restore this address's result or
    // capture token onto the new one.
    if (seq !== addressLookupSeqRef.current) return { summary: data.summary };
    if (data.capture_token) captureTokenRef.current = data.capture_token;
    setPickedDate(null);
    setSelectedDate(null);
    setSelectedSlot(null);
    setSearchResult({ summary: data.summary, nearby: data.nearby, days: data.days || [] });
    track(FUNNEL_EVENTS.BOOKING_AI_SEARCH_USED);
    return { summary: data.summary };
  };

  const onPickDate = async (date) => {
    latestPickedDateRef.current = date;
    // Also bind to the address: a same-date browse started for address A must
    // not restore A's days/capture token after the visitor edits to B.
    const seq = addressLookupSeqRef.current;
    const isCurrent = () => latestPickedDateRef.current === date && seq === addressLookupSeqRef.current;
    setSearchResult(null);
    setPickedDate(date);
    setBrowseDays(null);
    setBrowseError('');
    setSelectedDate(null);
    setSelectedSlot(null);
    if (!date) {
      setBrowseLoading(false);
      return;
    }
    setBrowseLoading(true);
    try {
      const params = new URLSearchParams({
        address: address.formatted || address.line1,
        service_type: service.id,
        duration_minutes: String(service.duration),
        expand: 'open',
        date_from: date,
        date_to: date,
      });
      if (coords?.lat && coords?.lng) { params.set('lat', String(coords.lat)); params.set('lng', String(coords.lng)); }
      const res = await fetch(`${API_BASE}/booking/availability?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not check that date');
      if (!isCurrent()) return;
      if (data.capture_token) captureTokenRef.current = data.capture_token;
      setBrowseDays(data.days || []);
    } catch {
      if (!isCurrent()) return;
      setBrowseDays(null);
      setBrowseError("We couldn't check that date right now. Try again in a moment.");
    } finally {
      if (isCurrent()) setBrowseLoading(false);
    }
  };

  const pickedDayObj = pickedDate && browseDays ? browseDays.find((d) => d.date === pickedDate) : null;
  const pickedDateHasNoOpenTimes = pickedDate && browseDays && !browseLoading && !browseError && !pickedDayObj;

  // Label for the selected day's recap — resilient to selections made via the
  // day list, the 90-day date picker, or the Waves AI search.
  const selectedDayLabel = (
    availability.find((d) => d.date === selectedDate)
    || (browseDays || []).find((d) => d.date === selectedDate)
    || (searchResult?.days || []).find((d) => d.date === selectedDate)
  )?.fullDate;
  // Slot length follows the service (60 → "1-hour", else "<n>-minute").
  const slotLenLabel = service.duration === 60 ? '1-hour' : `${service.duration}-minute`;
  // Only advance when the open day matches the selected slot — a stale selection
  // from another day must not advance while a different day is being viewed.
  const continueDisabled = !selectedSlot || (openDay !== null && openDay !== selectedDate);

  const SoftRouteBanner = () => (
    <div style={{
      background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10,
      padding: '10px 12px', fontSize: 14, color: '#9A3412', marginBottom: 12, lineHeight: 1.4,
    }}>
      No route near you that day yet — here&apos;s what&apos;s close.
    </div>
  );

  const renderDayGroups = (days) => days.map((day) => (
    <div key={day.date} style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.slate600 }}>{day.fullDate}</span>
        {/* Rain chip (GATE_BOOKING_RAIN_CHIPS): soft muted amber only, ≥40%
            days — NEVER red in this funnel. Field absent → nothing renders. */}
        {Number.isFinite(day.rainChance) && day.rainChance >= 40 && (
          <span style={{
            fontSize: 12, fontWeight: 600, color: '#B45309', background: '#FFF7ED',
            border: '1px solid #FED7AA', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
          }}>
            <Icon name="cloudRain" size={12} style={{ verticalAlign: '-2px', marginRight: 3 }} /> {Math.round(day.rainChance)}% rain
          </span>
        )}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {day.slots.map((slot, i) => {
          const sel = isSlotSelected(day.date, slot);
          return (
            <button
              key={`${day.date}-${slot.start_time}-${i}`}
              onClick={() => selectSlot(day.date, slot)}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
                background: sel ? COLORS.wavesBlue : COLORS.white,
                color: sel ? '#fff' : COLORS.glassNavy,
                border: `1.5px solid ${sel ? COLORS.wavesBlue : COLORS.slate200}`,
                textAlign: 'left', transition: 'background-color .15s, border-color .15s, color .15s',
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 2 }}>{slot.start_label}</div>
              <div style={{ fontSize: 14, color: sel ? 'rgba(255,255,255,.86)' : COLORS.slate600 }}>{slot.reason}</div>
            </button>
          );
        })}
      </div>
    </div>
  ));

  return (
    <WavesShell variant="customer" topBar="solid">
      <style>{`
        @keyframes slideUp { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
        @keyframes checkPop { 0% { transform:scale(0) } 60% { transform:scale(1.2) } 100% { transform:scale(1) } }
        @keyframes pulse { 0%,100% { transform:scale(1) } 50% { transform:scale(1.03) } }
        input:focus { border-color: ${COLORS.wavesBlue} !important; }
      `}</style>

      {/* Progress bar — steps 1 (address) → 2 (time) → 3 (contact) → 4 (done) */}
      {step < 4 && !gateActive && !gateChecking && (
        <div style={{ background: COLORS.slate200, height: 3 }}>
          <div style={{
            height: 3, background: COLORS.wavesBlue,
            width: `${(step / 3) * 100}%`,
            transition: 'width 0.5s cubic-bezier(.4,0,.2,1)',
          }} />
        </div>
      )}

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '24px 20px 60px' }}>

        {gateChecking && (
          <div style={{ textAlign: 'center', padding: 40, color: COLORS.slate600, fontSize: 14 }}>
            Loading…
          </div>
        )}

        {/* Customers-only verification gate (GATE_BOOKING_CUSTOMERS_ONLY) */}
        {gateActive && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.glassNavy, marginBottom: 8, letterSpacing: '-0.5px' }}>
              Book your next visit
            </h2>
            <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 20, lineHeight: 1.5 }}>
              Online self-scheduling is for current Waves customers. Verify your
              mobile number and we&rsquo;ll pull up your account — it takes one text.
            </p>

            {gateStep === 'phone' ? (
              <>
                <label htmlFor="gate-phone" style={labelStyle}>Mobile number</label>
                <input
                  id="gate-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  autoFocus
                  placeholder="(941) 555-1234"
                  value={gatePhone}
                  onChange={e => { clearAuthError?.(); setGatePhone(e.target.value); }}
                  className="waves-focus-ring"
                  style={inputStyle}
                />
                <div style={{ marginTop: 14 }}>
                  <Button
                    variant="primary"
                    onClick={handleGateSendCode}
                    disabled={gateDigits.length !== 10 || gateSending}
                    data-glass-accent=""
                    style={{ width: '100%', color: COLORS.glassNavy }}
                  >
                    {gateSending ? 'Sending code…' : 'Text me a sign-in code'}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <label htmlFor="gate-code" style={labelStyle}>
                  Enter the 6-digit code we texted {gatePhone || 'you'}
                </label>
                <input
                  id="gate-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={gateCode}
                  onChange={e => { clearAuthError?.(); setGateCode(e.target.value.replace(/\D/g, '').slice(0, 6)); }}
                  className="waves-focus-ring"
                  style={inputStyle}
                />
                <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
                  <Button
                    variant="primary"
                    onClick={handleGateVerify}
                    disabled={gateCode.length !== 6 || gateSending}
                    data-glass-accent=""
                    style={{ width: '100%', color: COLORS.glassNavy }}
                  >
                    {gateSending ? 'Verifying…' : 'Verify & continue'}
                  </Button>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <Button variant="tertiary" onClick={handleGateSendCode} disabled={gateSending} style={{ flex: 1 }}>
                      Resend code
                    </Button>
                    <Button
                      variant="tertiary"
                      onClick={() => { clearAuthError?.(); setGateStep('phone'); setGateCode(''); setGateFailedVerifies(0); }}
                      style={{ flex: 1 }}
                    >
                      Different number
                    </Button>
                  </div>
                </div>
              </>
            )}

            {authError && (
              <div role="alert" style={{
                marginTop: 14, background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 10, padding: 12, fontSize: 14, color: '#991B1B', lineHeight: 1.45,
              }}>{authError}</div>
            )}

            {gateFailedVerifies >= 2 && (
              <div style={{
                marginTop: 10, padding: '12px 14px', borderRadius: 10,
                background: '#FFF7ED', border: '1px solid #FED7AA',
                fontSize: 14, lineHeight: 1.5, color: COLORS.slate600,
              }}>
                Still not working? That number may not be on file — call{' '}
                <a href="tel:+19412975749" style={{ color: COLORS.glassNavy, fontWeight: 700, whiteSpace: 'nowrap' }}>(941) 297-5749</a>
                {' '}and we&rsquo;ll get it corrected.
              </div>
            )}

            {/* Standing new-customer path — always visible (never keyed to
                whether a number matched, so it leaks nothing) per the owner:
                refusals hand people the quote wizard, not a dead end. */}
            <div data-glass="soft" style={{
              position: 'relative', marginTop: 20, background: COLORS.white,
              border: `1px solid ${COLORS.slate200}`, borderRadius: 12,
              padding: 16, textAlign: 'center',
            }}>
              <div style={{ fontSize: 15, color: COLORS.slate600, marginBottom: 10 }}>
                Not a Waves customer yet?
              </div>
              <a
                href={ESTIMATE_QUOTE_URL}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minHeight: 44, padding: '0 20px', background: COLORS.glassNavy,
                  color: '#fff', borderRadius: 8, fontWeight: 800, fontSize: 15,
                  textDecoration: 'none',
                }}
                data-glass-accent=""
              >
                Get your free quote →
              </a>
            </div>
          </div>
        )}

        {!gateActive && !gateChecking && (<>

        {/* STEP 1 — Address */}
        {step === 1 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.glassNavy, marginBottom: 8, letterSpacing: '-0.5px' }}>
              Find a date &amp; time that works for you
            </h2>
            <div style={{ display: 'grid', gap: 14, marginBottom: 24, marginTop: 18 }}>
              <div>
                <AddressAutocomplete
                  autoFocus
                  value={address.line1}
                  onChange={(v) => updateAddress(a => ({ ...a, line1: v, line2: '', formatted: '' }))}
                  onSelect={(parts) => {
                    const nextAddress = {
                      // When Google returns a subpremise, keep line1 street-only —
                      // the unit lives in line2 and must not also ride inline in
                      // the stored street line (double-persist).
                      line1: parts.line2
                        ? (parts.line1 || parts.formatted || address.line1)
                        : (parts.formatted || parts.line1 || address.line1),
                      // Never carry a previous unit across a street selection — a
                      // stale apartment on an unrelated address would persist. A
                      // fresh subpremise wins; otherwise the unit box resets.
                      line2: parts.line2 || '',
                      formatted: parts.formatted || parts.line1 || address.formatted,
                      city: parts.city || address.city,
                      state: parts.state || address.state,
                      zip: parts.zip || address.zip,
                    };
                    updateAddress(a => ({
                      ...a,
                      ...nextAddress,
                    }));
                    if (parts.lat && parts.lng) setCoords({ lat: parts.lat, lng: parts.lng });
                    checkExistingCustomerByAddress(nextAddress);
                  }}
                  placeholder="Start typing your address"
                  className="waves-focus-ring" style={inputStyle}
                />
              </div>
              <div>
                {/* Availability/slots key off the street line, so typing here
                    must not reset them (plain setAddress, not updateAddress).
                    The address-matched account AND any phone-looked-up contact
                    MUST reset though — Apt B is not Apt A's household, and the
                    prior household's name/email must not prefill the contact
                    step. The match re-checks on blur with the unit included. */}
                <input
                  type="text"
                  value={address.line2}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAddress(a => ({ ...a, line2: v }));
                    // Invalidate any in-flight address/phone lookup: a late
                    // response for Apt A must not re-bind onto Apt B (and this
                    // handler just cleared the matched account + contact).
                    addressLookupSeqRef.current += 1;
                    phoneLookupSeqRef.current += 1;
                    // A pending browse's finally is now short-circuited by the
                    // seq bump — clear its loading flag so it can't stick.
                    setBrowseLoading(false);
                    setExistingCustomerId(null);
                    setAddressMayMatchCustomer(false);
                    setContact({ firstName: '', lastName: '', phone: '', email: '' });
                  }}
                  onBlur={() => { if (address.line1) checkExistingCustomerByAddress(address); }}
                  placeholder="Apt / Unit # (optional)"
                  className="waves-focus-ring" style={inputStyle}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button
                variant="primary"
                onClick={() => { track(FUNNEL_EVENTS.BOOKING_SERVICE_SELECTED, { service: service.id }); setStep(2); }}
                disabled={!address.line1}
                data-glass-accent=""
                style={{ width: '100%', color: COLORS.glassNavy }}
              >
                Find my best times →
              </Button>
            </div>
          </div>
        )}

        {/* STEP 2 — Times */}
        {step === 2 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            {!openDay ? (
              <>
                <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.glassNavy, marginBottom: 8, letterSpacing: '-0.5px' }}>
                  Pick a day
                </h2>
                <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 20, lineHeight: 1.5 }}>
                  Choose a day and we'll show the open 1-hour windows. Days where a tech is already working nearby are marked.
                </p>
              </>
            ) : (
              <button
                onClick={() => setOpenDay(null)}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: COLORS.wavesBlue, fontSize: 15, fontWeight: 600, marginBottom: 14,
                }}
              >
                ← Pick a different day
              </button>
            )}

            {loading && (
              <div style={{ textAlign: 'center', padding: 40, color: COLORS.slate600 }}>
                <div style={{ fontSize: 14 }}>Checking the route map…</div>
              </div>
            )}

            {error && !loading && (
              <div role="alert" style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 10, padding: 14, fontSize: 14, color: '#991B1B', marginBottom: 16,
              }}>{error}</div>
            )}

            {/* Selected-time recap — keeps the choice visible after drilling back to the day list */}
            {!loading && !openDay && selectedSlot && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
                background: COLORS.blueLight, border: `1px solid ${COLORS.wavesBlue}`,
                borderRadius: 10, padding: '10px 12px', fontSize: 14, color: COLORS.glassNavy,
              }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 700 }}>
                  <Icon name="check" size={14} strokeWidth={3} /> Selected
                </span>
                <span>{selectedDayLabel ? `${selectedDayLabel} · ` : ''}{selectedSlot.start_label}</span>
              </div>
            )}

            {/* STEP 2a — day list */}
            {!loading && !openDay && availability.length > 0 && (
              <div style={{ display: 'grid', gap: 10 }}>
                {availability.map((day) => {
                  const isSelectedDay = selectedDate === day.date;
                  const count = (day.slots || []).length;
                  return (
                    <button
                      key={day.date}
                      onClick={() => setOpenDay(day.date)}
                      style={{
                        width: '100%', padding: '14px 16px', borderRadius: 12, cursor: 'pointer',
                        background: COLORS.white,
                        border: `1.5px solid ${isSelectedDay ? COLORS.wavesBlue : COLORS.slate200}`,
                        textAlign: 'left', display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', gap: 12,
                        transition: 'border-color 0.15s',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 17, fontWeight: 700, color: COLORS.glassNavy }}>{day.fullDate}</div>
                        <div style={{ fontSize: 14, color: COLORS.slate600, marginTop: 2 }}>
                          {count} {count === 1 ? 'opening' : 'openings'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                        {day.nearby && (
                          <span style={{
                            fontSize: 12, fontWeight: 600, color: '#047857', background: '#ECFDF5',
                            border: '1px solid #A7F3D0', borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap',
                          }}>
                            tech nearby
                          </span>
                        )}
                        {/* Rain chip (GATE_BOOKING_RAIN_CHIPS): soft muted amber
                            only, ≥40% days — NEVER red in this funnel. Field
                            absent (gate off) → nothing renders. */}
                        {Number.isFinite(day.rainChance) && day.rainChance >= 40 && (
                          <span style={{
                            fontSize: 12, fontWeight: 600, color: '#B45309', background: '#FFF7ED',
                            border: '1px solid #FED7AA', borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap',
                          }}>
                            <Icon name="cloudRain" size={12} style={{ verticalAlign: '-2px', marginRight: 3 }} /> {Math.round(day.rainChance)}% rain
                          </span>
                        )}
                        <span style={{ fontSize: 22, color: COLORS.slate600, lineHeight: 1 }}>›</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* STEP 2b — the chosen day's 1-hour openings */}
            {!loading && openDay && (() => {
              const day = availability.find((d) => d.date === openDay);
              if (!day) {
                return (
                  <div style={{ fontSize: 14, color: COLORS.slate600, lineHeight: 1.45 }}>
                    That day is no longer open. Pick another day above.
                  </div>
                );
              }
              return (
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.glassNavy, marginBottom: 8, letterSpacing: '-0.5px' }}>
                    {day.fullDate}
                  </h2>
                  <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 16, lineHeight: 1.5 }}>
                    Choose a time — each is a {slotLenLabel} window.
                  </p>
                  {!day.nearby && <SoftRouteBanner />}
                  <div style={{ display: 'grid', gap: 8 }}>
                    {(day.slots || []).map((slot, i) => {
                      const sel = isSlotSelected(day.date, slot);
                      return (
                        <button
                          key={`${day.date}-${slot.start_time}-${i}`}
                          onClick={() => selectSlot(day.date, slot)}
                          style={{
                            width: '100%', padding: '14px 16px', borderRadius: 12, cursor: 'pointer',
                            background: sel ? COLORS.wavesBlue : COLORS.white,
                            color: sel ? '#fff' : COLORS.glassNavy,
                            border: `1.5px solid ${sel ? COLORS.wavesBlue : COLORS.slate200}`,
                            textAlign: 'left', transition: 'background-color .15s, border-color .15s, color .15s',
                          }}
                        >
                          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 3 }}>{slot.start_label}</div>
                          <div style={{ fontSize: 14, color: sel ? 'rgba(255,255,255,0.86)' : COLORS.slate600, lineHeight: 1.35 }}>
                            {slot.reason}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Secondary finders — only on the day list */}
            {!loading && !openDay && (
              <>
                <div data-glass="soft" style={{ position: 'relative', background: COLORS.white, border: `1px solid ${COLORS.slate200}`, borderRadius: 12, padding: 14, marginTop: 16 }}>
                  <label htmlFor="booking-custom-date" style={{ ...labelStyle, color: COLORS.glassNavy, fontWeight: 700 }}>
                    Need a date further out? Pick any day that works.
                  </label>
                  <input
                    id="booking-custom-date"
                    type="date"
                    min={browseMin}
                    max={browseMax}
                    placeholder="mm/dd/yyyy"
                    value={pickedDate || ''}
                    onChange={(e) => onPickDate(e.target.value)}
                    className="waves-focus-ring" style={inputStyle}
                  />
                  <div style={{ fontSize: 12, color: COLORS.slate600, marginTop: 8 }}>
                    We'll check open windows up to 90 days out.
                  </div>
                </div>

                {browseLoading && (
                  <div style={{ textAlign: 'center', padding: 20, color: COLORS.slate600, fontSize: 14 }}>Loading times…</div>
                )}
                {browseError && !browseLoading && (
                  <div role="alert" style={{ marginTop: 14, fontSize: 14, color: '#991B1B', lineHeight: 1.45 }}>
                    {browseError}{' '}
                    <button
                      type="button"
                      onClick={() => onPickDate(pickedDate)}
                      style={{ border: 0, padding: 0, background: 'none', color: COLORS.wavesBlue, font: 'inherit', fontWeight: 700, cursor: 'pointer' }}
                    >
                      Try again
                    </button>
                  </div>
                )}
                {pickedDayObj && (
                  <div style={{ marginTop: 14 }}>
                    {!pickedDayObj.nearby && <SoftRouteBanner />}
                    {renderDayGroups([pickedDayObj])}
                  </div>
                )}
                {pickedDateHasNoOpenTimes && (
                  <div style={{ marginTop: 14, fontSize: 14, color: COLORS.slate600, lineHeight: 1.45 }}>
                    No open times on that date. Try another day, or call (941) 297-5749 and we'll fit you in.
                  </div>
                )}

                {/* Waves AI date/time search */}
                <div style={{ marginTop: 20 }}>
                  <WavesAIScheduleSearch
                    theme={{ accent: COLORS.wavesBlue, accentText: '#fff', text: COLORS.glassNavy, muted: COLORS.slate600, border: '#CFE7F5', surface: COLORS.white, inputBg: '#F8FCFE' }}
                    onSearch={runAiSearch}
                  />
                </div>

                {searchResult && searchResult.days.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    {!searchResult.nearby && <SoftRouteBanner />}
                    {renderDayGroups(searchResult.days)}
                  </div>
                )}
                {searchResult && searchResult.days.length === 0 && (
                  <div style={{ marginTop: 12, fontSize: 14, color: COLORS.slate600 }}>
                    Nothing open for that search. Try another day, or call (941) 297-5749.
                  </div>
                )}
              </>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <Button variant="tertiary" onClick={() => setStep(1)}>← Back</Button>
              <Button
                variant="primary"
                onClick={() => { track(FUNNEL_EVENTS.BOOKING_CONTACT_STARTED, { is_existing_customer: !!existingCustomerId }); setStep(3); }}
                disabled={continueDisabled}
                data-glass-accent=""
                style={{ flex: 1, color: COLORS.glassNavy }}
              >
                Continue →
              </Button>
            </div>
          </div>
        )}

        {/* STEP 3 — Contact */}
        {step === 3 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.glassNavy, marginBottom: 8, letterSpacing: '-0.5px' }}>
              {existingCustomerId ? 'Confirm your booking' : 'Your info'}
            </h2>
            <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 20, lineHeight: 1.5 }}>
              {existingCustomerId
                ? 'We found the customer for this address. Confirm the details below.'
                : "We'll text you a confirmation right after you book."}
            </p>

            {/* Selected time summary */}
            <div style={{
              background: COLORS.blueLight, border: `1px solid ${COLORS.wavesBlue}`,
              borderRadius: 10, padding: 14, marginBottom: 20,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.blueDark, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                Your selected time
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.glassNavy }}>
                {selectedSlot?.fullDate || selectedDayLabel} · {selectedSlot?.start_label}
              </div>
              <div style={{ fontSize: 12, color: COLORS.slate600, marginTop: 2 }}>
                {service?.label}
              </div>
            </div>

            {addressMayMatchCustomer && !existingCustomerId && (
              <div style={{
                background: COLORS.blueLight,
                border: `1px solid ${COLORS.wavesBlue}`,
                borderRadius: 10,
                padding: 12,
                fontSize: 14,
                color: COLORS.blueDark,
                marginBottom: 14,
              }}>
                This address may already be on file. Enter your phone number and we'll link the appointment to that customer profile.
              </div>
            )}

            {existingCustomerId && (
              <div style={{
                background: COLORS.greenLight,
                border: `1px solid ${COLORS.green}`,
                borderRadius: 10,
                padding: 14,
                color: COLORS.green,
                marginBottom: 14,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 5 }}>
                  Customer found
                </div>
                <div className="ph-mask" style={{ fontSize: 17, fontWeight: 700, color: COLORS.glassNavy }}>
                  {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Customer on file'}
                </div>
                <div className="ph-mask" style={{ fontSize: 14, color: COLORS.slate600, marginTop: 4, lineHeight: 1.35 }}>
                  {address.line1}
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gap: 14, marginBottom: 20 }}>
              {/* htmlFor/id pairs: the sibling labels carried no programmatic
                  association, so screen readers announced bare unnamed
                  textboxes on the public booking funnel. */}
              {!existingCustomerId && <div>
                <label htmlFor="book-phone" style={labelStyle}>Phone number</label>
                <input
                  id="book-phone"
                  name="phone"
                  type="tel" autoFocus
                  autoComplete="tel"
                  inputMode="tel"
                  placeholder="(941) 555-1234"
                  value={contact.phone}
                  onChange={e => {
                    // Invalidate an in-flight phone lookup so a late match for
                    // an earlier number can't apply its contact/customer id.
                    phoneLookupSeqRef.current += 1;
                    setContact(c => ({ ...c, phone: e.target.value }));
                  }}
                  onBlur={() => { checkExistingCustomer(contact.phone); captureBookingIntent(); }}
                  className="waves-focus-ring" style={inputStyle}
                  disabled={!!existingCustomerId}
                />
              </div>}
              {!existingCustomerId && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label htmlFor="book-first-name" style={labelStyle}>First name</label>
                  <input
                    id="book-first-name"
                    name="firstName"
                    type="text"
                    autoComplete="given-name"
                    value={contact.firstName}
                    onChange={e => setContact(c => ({ ...c, firstName: e.target.value }))}
                    className="waves-focus-ring" style={inputStyle}
                  />
                </div>
                <div>
                  <label htmlFor="book-last-name" style={labelStyle}>Last name</label>
                  <input
                    id="book-last-name"
                    name="lastName"
                    type="text"
                    autoComplete="family-name"
                    value={contact.lastName}
                    onChange={e => setContact(c => ({ ...c, lastName: e.target.value }))}
                    className="waves-focus-ring" style={inputStyle}
                  />
                </div>
              </div>}
              {!existingCustomerId && <div>
                <label htmlFor="book-email" style={labelStyle}>Email (optional)</label>
                <input
                  id="book-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={contact.email}
                  onChange={e => setContact(c => ({ ...c, email: e.target.value }))}
                  onBlur={() => captureBookingIntent()}
                  className="waves-focus-ring" style={inputStyle}
                />
              </div>}
              <div>
                <label htmlFor="book-notes" style={labelStyle}>Notes for the tech (optional)</label>
                <textarea
                  id="book-notes"
                  rows={3}
                  placeholder="Gate code, pets, access instructions…"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  className="waves-focus-ring"
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: FONTS.body }}
                />
              </div>
            </div>

            {/* Customers-only refusal from /confirm — quote handoff, never a
                dead end (owner directive 2026-07-23). */}
            {refusal && (
              <div data-glass="card" style={{
                position: 'relative', background: COLORS.white,
                border: `1px solid ${COLORS.slate200}`, borderRadius: 12,
                padding: 18, marginBottom: 16,
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.glassNavy, marginBottom: 6 }}>
                  Self-scheduling is for current customers
                </div>
                <div style={{ fontSize: 15, color: COLORS.slate600, lineHeight: 1.5 }}>
                  {refusal.message || "New to Waves? Get your free quote and we'll take care of the rest."}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                  <a
                    href={refusal.quoteUrl || ESTIMATE_QUOTE_URL}
                    data-glass-accent=""
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      minHeight: 44, padding: '0 18px', background: COLORS.glassNavy,
                      color: '#fff', borderRadius: 8, fontWeight: 800, fontSize: 15,
                      textDecoration: 'none',
                    }}
                  >
                    Get a free quote
                  </a>
                  <a
                    href="tel:+19412975749"
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      minHeight: 44, padding: '0 18px', background: '#fff',
                      color: COLORS.glassNavy, border: `1px solid ${COLORS.slate200}`,
                      borderRadius: 8, fontWeight: 800, fontSize: 15, textDecoration: 'none',
                    }}
                  >
                    Call (941) 297-5749
                  </a>
                </div>
              </div>
            )}

            {error && (
              <div role="alert" style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 10, padding: 12, fontSize: 14, color: '#991B1B', marginBottom: 16,
              }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <Button variant="tertiary" onClick={() => setStep(2)}>← Back</Button>
              <Button
                variant="primary"
                onClick={handleConfirm}
                disabled={loading || (!existingCustomerId && (!contact.firstName || !contact.lastName || contact.phone.replace(/\D/g, '').length !== 10))}
                data-glass-accent=""
                style={{ flex: 1, color: COLORS.glassNavy }}
              >
                {loading ? 'Booking…' : 'Confirm booking'}
              </Button>
            </div>
          </div>
        )}

        {/* STEP 4 — Confirmation */}
        {step === 4 && (
          <div style={{ animation: 'slideUp 0.4s ease-out', textAlign: 'center', paddingTop: 20 }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%', background: COLORS.greenLight,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px', animation: 'checkPop 0.5s ease-out',
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={COLORS.green} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.glassNavy, marginBottom: 8, letterSpacing: '-0.5px' }}>
              You're booked!
            </h2>
            <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 24, lineHeight: 1.5 }}>
              We just texted a confirmation to {contact.phone || 'the phone number on file'}.
            </p>
            <div data-glass="card" style={{
              position: 'relative',
              background: COLORS.white, border: `1px solid ${COLORS.slate200}`,
              borderRadius: 12, padding: 18, marginBottom: 20, textAlign: 'left',
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.slate400, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 10 }}>
                Confirmation
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.wavesBlue, fontFamily: FONTS.mono, marginBottom: 14 }}>
                {confCode}
              </div>
              <div style={{ fontSize: 16, color: COLORS.slate600, lineHeight: 1.6 }}>
                <div><strong style={{ color: COLORS.glassNavy }}>{service?.label}</strong></div>
                <div>{selectedSlot?.fullDate || selectedDayLabel}</div>
                {/* Arrival window = start + 2h (owner rule) — never the
                    job-duration end_label the scheduler blocked out. */}
                <div>
                  {selectedSlot?.start_label}
                  {(() => {
                    const end = arrivalEndLabel(selectedSlot?.start_time || selectedSlot?.startTime24);
                    return end ? ` – ${end}` : '';
                  })()}
                </div>
                <div style={{ marginTop: 6 }}>{address.line1}{address.line2 ? ` · ${address.line2}` : ''}, {address.city} {address.zip}</div>
              </div>
            </div>
            {secureCardUrl ? (
              <div data-glass="card" style={{
                position: 'relative',
                background: COLORS.white, border: `1px solid ${COLORS.slate200}`,
                borderRadius: 12, padding: 18, marginBottom: 20, textAlign: 'left',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.slate400, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 10 }}>
                  One last step
                </div>
                <div style={{ fontSize: 16, color: COLORS.slate600, lineHeight: 1.6, marginBottom: 14 }}>
                  <strong style={{ color: COLORS.glassNavy }}>Add a card on file to secure your visit.</strong>{' '}
                  Nothing is charged today — your card is only charged after your
                  service is completed.
                </div>
                <a
                  href={secureCardUrl}
                  // _top, not self (Codex #2771 r3): /book embeds in the
                  // marketing-site iframe under the embeddable helmet policy,
                  // but /secure/:token serves under strictHelmet and is
                  // refused inside a frame — the CTA must break out to the
                  // top window (a no-op when not embedded).
                  target="_top"
                  rel="noopener"
                  data-glass-accent=""
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    minHeight: 48, padding: '0 20px', background: COLORS.glassNavy,
                    color: COLORS.white, border: `1px solid ${COLORS.glassNavy}`,
                    borderRadius: 8, fontWeight: 800, fontSize: 15, textDecoration: 'none',
                  }}
                >Secure my visit — $0 today</a>
              </div>
            ) : null}
            <p style={{ fontSize: 12, color: COLORS.slate400 }}>
              Need to change it? Text us at (941) 297-5749 or reply RESCHEDULE to the confirmation text.
            </p>
          </div>
        )}

        </>)}

        <BrandFooter />
      </div>
    </WavesShell>
  );
}
