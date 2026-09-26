import { useState } from "react";
import { GoogleMap, Marker, useJsApiLoader } from "@react-google-maps/api";
import {
  Button,
  Checkbox,
  Input,
  Select,
  Textarea,
} from "../ui";

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
const DEFAULT_CENTER = { lat: 27.4989, lng: -82.5748 };
const ADDRESS_FIELDS = ["address_line1", "address_line2", "city", "state", "zip"];

function coordinate(value, min, max) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function hasCompletePin(customer) {
  const latitude = coordinate(customer?.latitude, -90, 90);
  const longitude = coordinate(customer?.longitude, -180, 180);
  return latitude !== null && longitude !== null && latitude !== 0 && longitude !== 0;
}

export function canRevokePin(record) {
  if (!["verified", "geocoded"].includes(record.review?.status) || !hasCompletePin(record.customer)) return false;
  const customerLat = coordinate(record.customer.latitude, -90, 90);
  const customerLng = coordinate(record.customer.longitude, -180, 180);
  const reviewLat = coordinate(record.review?.latitude, -90, 90);
  const reviewLng = coordinate(record.review?.longitude, -180, 180);
  return reviewLat !== null && reviewLng !== null && reviewLat === customerLat && reviewLng === customerLng;
}

function addressText(customer) {
  return [
    customer?.address_line1,
    customer?.address_line2,
    customer?.city,
    customer?.state,
    customer?.zip,
  ].filter(Boolean).join(", ");
}

function initialDraft(record) {
  const customer = record?.customer || {};
  return {
    ...Object.fromEntries(ADDRESS_FIELDS.map((key) => [key, String(customer[key] || "")])),
    latitude: customer.latitude ?? "",
    longitude: customer.longitude ?? "",
    source: "customer_confirmation",
    evidence: "",
    confirmed: false,
  };
}

function GooglePinPicker({ latitude, longitude, onChange }) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: MAPS_KEY,
  });
  if (loadError) return <div className="text-14 text-alert-fg">Map could not load. Enter coordinates below.</div>;
  if (!isLoaded) return <div className="h-48 grid place-items-center text-14 text-ink-secondary">Loading map…</div>;
  const parsedLatitude = coordinate(latitude, -90, 90);
  const parsedLongitude = coordinate(longitude, -180, 180);
  const hasPoint = parsedLatitude !== null && parsedLongitude !== null;
  const point = hasPoint ? { lat: parsedLatitude, lng: parsedLongitude } : DEFAULT_CENTER;
  return (
    <div className="h-52 overflow-hidden rounded-sm border-hairline border-zinc-200">
      <GoogleMap
        mapContainerStyle={{ width: "100%", height: "100%" }}
        center={point}
        zoom={hasPoint ? 18 : 10}
        onClick={(event) => onChange(event.latLng.lat(), event.latLng.lng())}
        options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false }}
      >
        {hasPoint && (
          <Marker
            position={point}
            draggable
            onDragEnd={(event) => onChange(event.latLng.lat(), event.latLng.lng())}
          />
        )}
      </GoogleMap>
    </div>
  );
}

export default function CustomerGeocodeReviewForm({
  record,
  saving,
  error,
  conflicted,
  unavailable,
  onAcknowledgeConflict,
  onResolve,
  onCancel,
}) {
  const [draft, setDraft] = useState(() => initialDraft(record));
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const latitude = coordinate(draft.latitude, -90, 90);
  const longitude = coordinate(draft.longitude, -180, 180);
  const address = Object.fromEntries(ADDRESS_FIELDS.map((key) => [key, draft[key].trim()]));
  const originalAddress = initialDraft(record);
  const addressChanged = ADDRESS_FIELDS.some((key) => address[key] !== originalAddress[key].trim());
  const addressComplete = ["address_line1", "city", "state", "zip"].every((key) => address[key])
    && /^\d+[A-Za-z-]*\s+\S/.test(address.address_line1);
  // Match server/services/service-area.js; this is a routing sanity check.
  const coordinatesValid = coordinate(draft.latitude, 26.3, 27.95) !== null
    && coordinate(draft.longitude, -82.9, -81.5) !== null;
  const canConfirmOutsideArea = !conflicted && !unavailable && draft.evidence.trim() && draft.confirmed;
  const canVerify = canConfirmOutsideArea && addressComplete && coordinatesValid;
  const retryAvailable = !hasCompletePin(record.customer);
  const mapQuery = addressText({ ...record.customer, ...draft });

  const verify = () => onResolve({
    revision: record.revision,
    action: "verify_pin",
    ...(addressChanged ? { address } : {}),
    latitude,
    longitude,
    source: draft.source,
    evidence: draft.evidence.trim(),
    confirmed: true,
  });

  return (
    <div className="mt-3 pt-3 border-t border-hairline border-zinc-200 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="sm:col-span-2 text-14 text-zinc-900">Address
          <Input aria-label="Address" value={draft.address_line1} onChange={(event) => set("address_line1", event.target.value)} />
        </label>
        <label className="sm:col-span-2 text-14 text-zinc-900">Address line 2
          <Input aria-label="Address line 2" value={draft.address_line2} onChange={(event) => set("address_line2", event.target.value)} />
        </label>
        <label className="text-14 text-zinc-900">City
          <Input aria-label="City" value={draft.city} onChange={(event) => set("city", event.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-14 text-zinc-900">State
            <Input aria-label="State" value={draft.state} onChange={(event) => set("state", event.target.value)} />
          </label>
          <label className="text-14 text-zinc-900">ZIP
            <Input aria-label="ZIP" value={draft.zip} onChange={(event) => set("zip", event.target.value)} />
          </label>
        </div>
      </div>
      {MAPS_KEY ? (
        <GooglePinPicker latitude={draft.latitude} longitude={draft.longitude} onChange={(lat, lng) => {
          setDraft((current) => ({ ...current, latitude: lat.toFixed(7), longitude: lng.toFixed(7) }));
        }} />
      ) : (
        <div className="rounded-sm bg-zinc-50 border-hairline border-zinc-200 p-3 text-14 text-ink-secondary">
          Map selection is unavailable. Enter coordinates below.
          {mapQuery && <a className="ml-2 text-zinc-900 underline" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`} target="_blank" rel="noopener noreferrer">Open address in Google Maps</a>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-14 text-zinc-900">Latitude
          <Input aria-label="Latitude" inputMode="decimal" value={draft.latitude} onChange={(event) => set("latitude", event.target.value)} />
        </label>
        <label className="text-14 text-zinc-900">Longitude
          <Input aria-label="Longitude" inputMode="decimal" value={draft.longitude} onChange={(event) => set("longitude", event.target.value)} />
        </label>
      </div>
      <label className="block text-14 text-zinc-900">Confirmation source
        <Select aria-label="Confirmation source" value={draft.source} onChange={(event) => set("source", event.target.value)}>
          <option value="customer_confirmation">Customer confirmation</option>
          <option value="county_records">County records</option>
          <option value="site_visit">Site visit</option>
        </Select>
      </label>
      <label className="block text-14 text-zinc-900">Evidence
        <Textarea aria-label="Evidence" rows={2} value={draft.evidence} onChange={(event) => set("evidence", event.target.value)} placeholder="What confirms this primary service location?" />
      </label>
      <Checkbox id={`geocode-confirm-${record.customer.id}`} checked={draft.confirmed} onChange={(event) => set("confirmed", event.target.checked)} label="I confirmed this is the primary service location" />
      {error && <div role="alert" className="text-14 text-alert-fg">{error}</div>}
      {conflicted && !unavailable && (
        <div className="rounded-sm border-hairline border-zinc-300 bg-zinc-50 p-3 text-14 text-zinc-900">
          The saved address or pin changed while this form was open. Compare the latest record above with your preserved entries before continuing.
          <div className="mt-2"><Button variant="secondary" onClick={onAcknowledgeConflict}>I reviewed the latest record</Button></div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={verify} disabled={!canVerify} loading={saving}>Verify pin</Button>
        <Button
          variant="secondary"
          disabled={!canConfirmOutsideArea || saving || addressChanged}
          onClick={() => onResolve({
            revision: record.revision,
            action: "outside_service_area",
            source: draft.source,
            evidence: draft.evidence.trim(),
            confirmed: true,
          })}
        >
          Mark saved address outside service area
        </Button>
        {retryAvailable && (
          <Button variant="secondary" onClick={() => onResolve({ revision: record.revision, action: "retry" })} disabled={saving || conflicted || unavailable || addressChanged}>Retry saved address</Button>
        )}
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}
