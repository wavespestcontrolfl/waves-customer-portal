import React from "react";
import { Button } from "../ui";

// The server's question (server/services/property-lookup/business-scope.js
// OCCUPANCY_QUESTION) — used when a 409 arrives without one on the profile.
export const SCOPE_QUESTION = "Are we treating just your space or the whole building?";

// The server's commercial subtype vocabulary (business-identity.js), in words.
const TYPE_LABELS = {
  restaurant_food_service: "a restaurant or food business",
  salon_spa: "a salon or spa",
  medical_office: "a medical or dental office",
  veterinary_clinic: "a veterinary clinic",
  school_daycare: "a school or daycare",
  office_retail: "a business",
};

// The admin-only line saying WHY the lookup is asking: the business listed
// at the street number (name + type). Absent when no business matched. The
// source is named by the "Google Maps" attribution under it, which the
// Places API policies require wherever this content is shown without a map.
function businessLine(identity) {
  if (!identity) return null;
  const kind = TYPE_LABELS[identity.type] || TYPE_LABELS.office_retail;
  if (identity.name) return `${identity.name}, ${kind}, is listed at this address.`;
  if (Number(identity.tenantsAtNumber) > 1) return `${identity.tenantsAtNumber} businesses are listed at this street number.`;
  return null;
}

// What the lookup would guess, shown as a hint only. It is never a pressed
// button: only staff's own answer is.
const SUGGESTION_HINTS = {
  suite: "Looks like one space of a shared building.",
  building: "Looks like a stand-alone building.",
};

const ANSWERS = [
  { value: "suite", label: "Just their space" },
  { value: "building", label: "The whole building" },
  { value: "none", label: "Not this business" },
];

/**
 * Business-identity scope question (GATE_LOOKUP_BUSINESS_IDENTITY): shown in
 * the admin estimate tool when the lookup found a business at the address.
 * Google only suggests; `answer` is the staff answer the profile carries
 * (suite, building or none) and is the only thing that reads as chosen. While
 * `question` is set the estimate cannot be priced; answering re-runs the
 * lookup with the answer.
 */
export default function ScopeQuestionPrompt({ profile, question, answer, busy, onAnswer }) {
  const line = businessLine(profile?.businessIdentity);
  if (!question && !line && !answer) return null;
  const hint = answer ? null : SUGGESTION_HINTS[profile?.serviceScopeSuggestion];
  return (
    <section
      aria-label="Scope question"
      className="mb-2.5 rounded-xs border-hairline border-zinc-300 bg-zinc-50 px-3 py-2 text-14 text-zinc-900"
    >
      {line && (
        <>
          <p className="m-0">{line}</p>
          <p className="m-0 text-12 text-zinc-600" translate="no">Google Maps</p>
        </>
      )}
      {question && <p className="m-0 mt-1 font-medium">{question}</p>}
      {hint && <p className="m-0 mt-1 text-12 text-zinc-600">{hint}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {ANSWERS.map((a) => (
          <Button
            key={a.value}
            size="sm"
            variant={answer === a.value ? "primary" : "secondary"}
            disabled={busy}
            aria-pressed={answer === a.value}
            onClick={() => onAnswer(a.value)}
          >
            {a.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
