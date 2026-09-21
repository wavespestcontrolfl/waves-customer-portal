import React from "react";
import { Button } from "../ui";
import { formatETDateTime } from "../../lib/timezone";
import { subdivisionMedianPrefillSqFt, homeSqFtIsUnverifiedPlatMedian } from "../../lib/lookupPrefill";

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
  const value = saved ? Number(form[field.formKey]) : missing ? null : values[field.key];
  const noPrivateLot = field.key === "lotSize" && !value
    && /^(CONDO|CONDOMINIUM|CONDO UPPER|APARTMENT|HOA COMMON AREA)$/i.test(profile.propertyType);
  const requiresCheck = addressIssue || evidence.fieldVerify || !evidence.value;
  // Unassessed vacant parcel (new construction the roll hasn't posted): no
  // record for THIS home, but the server supplies the median of the plat's
  // assessed neighbors. Shown as an estimate — never as a sourced value —
  // and only while the record itself is empty.
  const platMedian = field.key === "squareFootage" && !value && !saved && !addressIssue
    ? subdivisionMedianPrefillSqFt(profile) : null;
  const status = noPrivateLot ? "No individual lot" : platMedian ? "Estimated from neighbors" : !value ? "Not found"
    : saved ? "Verified by you" : requiresCheck ? "Needs confirmation" : "Sourced";
  const sourceUrl = /^https?:\/\//i.test(evidence.winningSource) ? evidence.winningSource : null;
  const shown = value || platMedian;

  return (
    <div className="min-w-0 py-3">
      <dt className="text-sm text-ink-secondary">{field.label}</dt>
      <dd className="mt-1 text-base font-medium text-zinc-900 break-words">
        {shown ? [shown.toLocaleString("en-US"), field.unit].filter(Boolean).join(" ") : "—"}
      </dd>
      <dd className="mt-1 text-sm text-ink-secondary">{status}</dd>
      <dd className="mt-1 text-sm text-ink-secondary break-words">
        {saved ? "Field verification saved" : platMedian ? platMedianSourceLine(profile.subdivisionMedian) : evidence.sourceLabel || "No matching source returned"}
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-2 underline text-zinc-900">View source</a>}
      </dd>
    </div>
  );
}

function platMedianSourceLine(median) {
  const count = Number(median?.sampleCount) || 0;
  const min = Number(median?.minSqft) || 0;
  const max = Number(median?.maxSqft) || 0;
  const range = min > 0 && max > 0 ? ` (${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")} sq ft)` : "";
  return `Median of ${count.toLocaleString("en-US")} assessed homes in this plat${range} — not a record for this address; confirm with the customer`;
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
      {addressIssue && (
        <div className="mt-3 text-sm text-alert-fg">
          <p>We could not confirm this address. Check the house number, street suffix, direction, and ZIP before using property measurements.</p>
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
