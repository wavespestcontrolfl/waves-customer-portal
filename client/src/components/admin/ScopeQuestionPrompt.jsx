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

// The admin-only line saying WHY the lookup is asking: the business Google
// lists at the street number (name + type). Absent when no business matched.
function businessLine(identity) {
  if (!identity) return null;
  const kind = TYPE_LABELS[identity.type] || TYPE_LABELS.office_retail;
  if (identity.name) return `Google lists ${identity.name}, ${kind}, at this address.`;
  if (Number(identity.tenantsAtNumber) > 1) return `Google lists ${identity.tenantsAtNumber} businesses at this street number.`;
  return null;
}

/**
 * Business-identity scope question (GATE_LOOKUP_BUSINESS_IDENTITY): shown in
 * the admin estimate tool when the lookup found a business but cannot tell
 * whether the job is one suite or the whole building. While `question` is set
 * the estimate cannot be priced; answering re-runs the lookup with the answer.
 */
export default function ScopeQuestionPrompt({ profile, question, answer, busy, onAnswer }) {
  const line = businessLine(profile?.businessIdentity);
  if (!question && !line) return null;
  return (
    <section
      aria-label="Scope question"
      className="mb-2.5 rounded-xs border-hairline border-zinc-300 bg-zinc-50 px-3 py-2 text-14 text-zinc-900"
    >
      {line && <p className="m-0">{line}</p>}
      {question && <p className="m-0 mt-1 font-medium">{question}</p>}
      {(question || answer) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={answer === "suite" ? "primary" : "secondary"}
            disabled={busy}
            aria-pressed={answer === "suite"}
            onClick={() => onAnswer("suite")}
          >
            Just their space
          </Button>
          <Button
            size="sm"
            variant={answer === "building" ? "primary" : "secondary"}
            disabled={busy}
            aria-pressed={answer === "building"}
            onClick={() => onAnswer("building")}
          >
            The whole building
          </Button>
        </div>
      )}
    </section>
  );
}
