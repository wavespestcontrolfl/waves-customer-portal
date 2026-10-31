// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import OpportunityActions from "./OpportunityActions";
import { PIPELINE_STAGES } from "./pipelineStages";

afterEach(cleanup);

function Location() {
  const { pathname, search } = useLocation();
  return <output aria-label="Current route">{`${pathname}${search}`}</output>;
}

function createEstimateRoute(opportunity) {
  render(
    <MemoryRouter>
      <OpportunityActions opportunity={opportunity} onRefresh={vi.fn()} adminFetch={vi.fn()} />
      <Location />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Create Estimate" })[0]);
  return new URL(screen.getByLabelText("Current route").textContent, "http://localhost");
}

// The shape GET /admin/pipeline/opportunities returns (no rawLead / rawEstimate).
const opportunity = {
  opportunityId: "lead:synthetic-lead",
  leadId: "synthetic-lead",
  name: "Dana Sample",
  phone: "+15555550100",
  serviceInterest: "Pest Control",
  stage: PIPELINE_STAGES.CONTACTED,
};

it("Create Estimate sends the lead's street line with the lead's own city and ZIP", () => {
  const route = createEstimateRoute({ ...opportunity, address: "100 Test Palm Way", addressCity: "Parrish", addressZip: "34219" });
  expect(route.pathname).toBe("/admin/estimates");
  expect(route.searchParams.get("address")).toBe("100 Test Palm Way, Parrish, FL 34219");
});

it("Create Estimate keeps an address that carries no lead city or ZIP", () => {
  const route = createEstimateRoute({ ...opportunity, address: "200 Test Palm Way, Parrish, FL 34219", addressCity: null, addressZip: null });
  expect(route.searchParams.get("address")).toBe("200 Test Palm Way, Parrish, FL 34219");
});
