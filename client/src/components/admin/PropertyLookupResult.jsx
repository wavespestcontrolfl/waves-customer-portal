import React from "react";
import { Button } from "../ui";
import { formatETDateTime } from "../../lib/timezone";
import { subdivisionMedianPrefillSqFt, permitPlanPrefillSqFt, homeSqFtIsUnverifiedPlatMedian } from "../../lib/lookupPrefill";

const FIELDS = [
  { key: "squareFootage", formKey: "homeSqFt", label: "Home living area", unit: "sq ft" },
  { key: "lotSize", formKey: "lotSqFt", label: "Lot area", unit: "sq ft" },
  { key: "stories", formKey: "stories", label: "Stories" },
  { key: "propertyType", label: "Property type" },
];

const VERIFICATION_LABELS = { saving: "Saving…", saved: "Verification saved", error: "Save failed — retry" };

function PropertyMeasurement({ field, profile, form, addressIssue, verification }) {
  const evidence = (profile.fieldEvidence || {})[field.key] || {};
  const saved = verification[field.key] === "saved";
  const missing = (profile.propertyDataQuality?.missingCriticalFields || []).includes(field.key);
  const values = { squareFootage: profile.homeSqFt, lotSize: profile.lotSqFt, stories: profile.stories, propertyType: profile.propertyType };
  // A permit-sourced story count is the server's explicit fallback for a
  // record with none: the record field is still listed as missing, but the
  // profile value is real and the panel must say where it came from.
  const permitStoriesValue = field.key === "stories" && profile.storiesSource === "permit" && Number(profile.stories) > 0;
  const value = saved ? Number(form[field.formKey]) : missing && !permitStoriesValue ? null : values[field.key];
  const noPrivateLot = field.key === "lotSize" && !value
    && /^(CONDO|CONDOMINIUM|CONDO UPPER|APARTMENT|HOA COMMON AREA)$/i.test(profile.propertyType);
  const requiresCheck = addressIssue || evidence.fieldVerify || !evidence.value;
  // Unassessed vacant parcel (new construction the roll hasn't posted): no
  // record for THIS home, but the server supplies the median of the plat's
  // assessed neighbors. Shown as an estimate — never as a sourced value —
  // and only while the record itself is empty.
  const platMedianRaw = field.key === "squareFootage" && !value && !saved && !addressIssue
    ? subdivisionMedianPrefillSqFt(profile) : null;
  // The home's own building permit is a stronger estimate than the plat
  // median and wins when both are present. Same guards: only while the
  // record is empty, and never for an unconfirmed address.
  const permitPlan = field.key === "squareFootage" && !value && !saved && !addressIssue
    ? permitPlanPrefillSqFt(profile) : null;
  const platMedian = permitPlan ? null : platMedianRaw;
  // The story count came off the permit (the record had none).
  const permitStories = field.key === "stories" && !saved && !!value && profile.storiesSource === "permit";
  const status = noPrivateLot ? "No individual lot" : permitPlan || permitStories ? "From building permit"
    : platMedian ? "Estimated from neighbors" : !value ? "Not found"
    : saved ? "Verified by you" : requiresCheck ? "Needs confirmation" : "Sourced";
  const sourceUrl = /^https?:\/\//i.test(evidence.winningSource) ? evidence.winningSource : null;
  const shown = value || permitPlan || platMedian;

  return (
    <div className="min-w-0 py-3">
      <dt className="text-sm text-ink-secondary">{field.label}</dt>
      <dd className="mt-1 text-base font-medium text-zinc-900 break-words">
        {shown ? [shown.toLocaleString("en-US"), field.unit].filter(Boolean).join(" ") : "—"}
      </dd>
      <dd className="mt-1 text-sm text-ink-secondary">{status}</dd>
      <dd className="mt-1 text-sm text-ink-secondary break-words">
        {saved ? "Field verification saved" : permitPlan ? permitPlanSourceLine(profile.permitBuildingFacts, permitPlan)
          : permitStories ? permitStoriesSourceLine(profile.permitBuildingFacts)
          : platMedian ? platMedianSourceLine(profile.subdivisionMedian) : evidence.sourceLabel || "No matching source returned"}
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-2 underline text-zinc-900">View source</a>}
      </dd>
    </div>
  );
}

function permitPlanSourceLine(facts, conditionedSqFt) {
  const underRoof = Math.round(Number(facts?.underRoofSqft)) || 0;
  const stories = Number(facts?.stories) || 0;
  return `${facts?.sourceLabel || "Manatee building permit"}: ${conditionedSqFt.toLocaleString("en-US")} sq ft conditioned`
    + `${underRoof > 0 ? `, ${underRoof.toLocaleString("en-US")} under roof` : ""}`
    + `${stories > 0 ? `, ${stories.toLocaleString("en-US")} stories` : ""}`
    + " — not on the county roll yet; confirm with the customer";
}

function permitStoriesSourceLine(facts) {
  return `${facts?.sourceLabel || "Manatee building permit"} — confirm with the customer`;
}

const ADDRESS_STATUS_LABELS = {
  confirmed: "Address confirmed",
  unit_missing: "Building confirmed, unit missing",
  needs_confirmation: "Address needs confirmation",
  outside_service_area: "Outside the service area",
  unavailable: "Validation unavailable",
};

// One line: what the address itself is (Google Address Validation), then
// Google's own business / residential classification when it gave one (its
// metadata, not USPS data), then the county roll's own answer. Absent
// (null) when the lookup carried no status: the panel is unchanged.
function addressStatusLine(status) {
  const label = status && ADDRESS_STATUS_LABELS[status.state];
  if (!label) return null;
  const parts = [status.state === "confirmed" && status.corrected ? `${label} (corrected by Google)` : label];
  if (status.use?.business === true) parts.push("Google: business address");
  else if (status.use?.residential === true) parts.push("Google: residential address");
  if (status.countyRoll === "not_found") parts.push("Not on the county roll");
  return parts.join(" · ");
}

function statusOf(meta) {
  return meta ? meta.addressStatus : null;
}

function AddressStatusLine({ meta }) {
  const line = addressStatusLine(statusOf(meta));
  return line ? <p className="mt-1 text-sm text-ink-secondary">{line}</p> : null;
}

// "Could not confirm" belongs to an address that needs confirmation (or to a
// lookup with no status, as before). When the address itself is confirmed or
// validation did not answer, the open question is the county roll's.
function addressIssueCopy(status) {
  if (!status || !ADDRESS_STATUS_LABELS[status.state] || status.state === "needs_confirmation" || status.state === "outside_service_area") {
    return "We could not confirm this address. Check the house number, street suffix, direction, and ZIP before using property measurements.";
  }
  // The address flag also goes up when a record WAS found but may belong to
  // another house number (a snapped match): say "no record" only when the
  // lookup itself found none.
  if (status.countyRoll === "unknown") {
    return "The county roll did not answer for this address. Check the house number, street suffix, direction, and ZIP before using property measurements.";
  }
  if (status.countyRoll !== "not_found") {
    return "The property record found may be for a different house number. Check the house number, street suffix, direction, and ZIP before using property measurements.";
  }
  if (status.state === "unit_missing") {
    return "The building is confirmed, but no unit was given and the county roll has no record for this entry. Add the unit or suite, then check the measurements.";
  }
  return "The county roll has no record for this house number. Check the house number, street suffix, direction, and ZIP before using property measurements.";
}

function platMedianSourceLine(median) {
  const count = Number(median?.sampleCount) || 0;
  const min = Number(median?.minSqft) || 0;
  const max = Number(median?.maxSqft) || 0;
  const range = min > 0 && max > 0 ? ` (${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")} sq ft)` : "";
  const sample = median?.lotBanded ? "assessed homes on similar-size lots in this plat" : "assessed homes in this plat";
  return `Median of ${count.toLocaleString("en-US")} ${sample}${range} — not a record for this address; confirm with the customer`;
}

export default function PropertyLookupResult({ profile, form, meta, refreshing, onRefresh, onEditAddress, onVerify, verification }) {
  const fields = [{ ...FIELDS[0], label: form.isCommercial === "YES" ? "Building area" : "Home living area" }, ...FIELDS.slice(1)];
  const addressIssue = profile.fieldVerifyFlags?.some((flag) => flag?.field === "address");
  const checkedAt = Number.isNaN(Date.parse(meta?.checkedAt))
    ? null : formatETDateTime(meta.checkedAt);

  return (
    <section aria-label="Property lookup results" className="mb-3 rounded-xs border-hairline border-zinc-300 bg-white p-4">
      <h3 className="text-base font-medium text-zinc-900">Property details</h3>
      <p className="mt-1 text-sm text-ink-secondary break-words">
        {addressIssue ? "Address to confirm: " : meta?.matchedAddress ? "Record address: " : "Searched address: "}
        {addressIssue ? form.address : meta?.matchedAddress || form.address}
      </p>
      {checkedAt && <p className="mt-1 text-sm text-ink-secondary">Records retrieved {checkedAt}{meta?.cache === "hit" ? " · Saved lookup" : ""}</p>}
      <AddressStatusLine meta={meta} />
      {addressIssue && (
        <div className="mt-3 text-sm text-alert-fg">
          <p>{addressIssueCopy(statusOf(meta))}</p>
          <button type="button" className="mt-2 min-h-11 border-0 bg-transparent p-0 text-left underline" onClick={onEditAddress}>Check address</button>
        </div>
      )}
      <dl className="mt-2 grid grid-cols-1 divide-y divide-zinc-200 sm:grid-cols-2 sm:gap-x-6">
        {fields.map((field) => (
          <PropertyMeasurement key={field.key} field={field} profile={profile} form={form}
            addressIssue={addressIssue} verification={verification} />
        ))}
      </dl>
      <p className="mt-2 text-sm text-ink-secondary">Enter corrections in the property fields below. Save only measurements you have checked for this address.</p>
      {!addressIssue && (
        <div className="mt-3 flex flex-col items-start gap-2">
          {fields.filter((field) => field.formKey).map((field) => {
            const value = Number(form[field.formKey]);
            const unknownStories = field.key === "stories" && !form._storiesEdited && profile.storiesSource === "default";
            // A plat-median prefill is an estimate: no one-click "verify"
            // until the operator has typed a size they checked.
            const unverifiedMedian = field.key === "squareFootage" && homeSqFtIsUnverifiedPlatMedian(form, profile);
            if (!(value > 0) || unknownStories || unverifiedMedian) return null;
            const state = verification[field.key];
            return (
              <button key={field.key} type="button" onClick={() => onVerify(field.key)}
                disabled={state === "saving" || state === "saved"}
                className="min-h-11 border-0 bg-transparent p-0 text-left text-sm text-zinc-900 underline disabled:no-underline disabled:text-ink-secondary">
                {VERIFICATION_LABELS[state] || `Verify ${field.label.toLowerCase()}: ${value.toLocaleString("en-US")} ${field.unit || ""}`}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-3">
        <Button variant="secondary" size="md" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing records…" : "Refresh property records"}
        </Button>
      </div>
      {meta?.errors?.length > 0 && (
        <details className="mt-3 text-sm text-ink-secondary">
          <summary className="cursor-pointer text-zinc-900">Lookup details</summary>
          <ul className="mt-2 space-y-1 break-words">
            {meta.errors.map((error, index) => <li key={index}>{error.message}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
