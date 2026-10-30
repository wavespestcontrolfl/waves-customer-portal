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

const opportunity = {
  opportunityId: "lead:synthetic-lead",
  leadId: "synthetic-lead",
  name: "Dana Sample",
  phone: "+15555550100",
  serviceInterest: "Pest Control",
  stage: PIPELINE_STAGES.CONTACTED,
};

it("Create Estimate sends the lead's whole address when its city and ZIP sit in their own columns", () => {
  const route = createEstimateRoute({
    ...opportunity,
    address: "100 Test Palm Way",
    rawLead: { id: "synthetic-lead", address: "100 Test Palm Way", city: "Parrish", zip: "34219" },
  });
  expect(route.pathname).toBe("/admin/estimates");
  expect(route.searchParams.get("address")).toBe("100 Test Palm Way, Parrish, FL 34219");
});

it("Create Estimate keeps the estimate's address when the lead has none", () => {
  const route = createEstimateRoute({
    ...opportunity,
    address: "200 Test Palm Way, Parrish, FL 34219",
    rawLead: { id: "synthetic-lead", address: null, city: "Parrish", zip: "34219" },
  });
  expect(route.searchParams.get("address")).toBe("200 Test Palm Way, Parrish, FL 34219");
});
