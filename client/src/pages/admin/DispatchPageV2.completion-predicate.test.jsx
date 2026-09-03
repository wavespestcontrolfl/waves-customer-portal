import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DispatchPageV2 pulls the whole SchedulePage module for CompletionPanel;
// only the resume-marker reader matters for this predicate.
vi.mock("./SchedulePage", () => ({
  CompletionPanel: () => null,
  RescheduleModal: () => null,
  EditServiceModal: () => null,
  ProtocolPanel: () => null,
  completionResumeOwed: (id) => id === "svc-resume",
}));

import { CLOSEOUT_OWED_LABEL, completedVisitOwesCompletion, owedStopMember, stopStatusBadge } from "./DispatchPageV2";

describe("completedVisitOwesCompletion", () => {
  it("opens completion for a completed visit with NO service record (status-only completion)", () => {
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "completed", has_service_record: false })).toBe(true);
  });
  it("keeps a completed visit WITH a service record closed", () => {
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "completed", has_service_record: true })).toBe(false);
  });
  it("fails closed when the payload carries no flag (legacy shape) and no resume marker", () => {
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "completed" })).toBe(false);
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "completed", has_service_record: null })).toBe(false);
  });
  it("still honors the invoice-mint resume marker", () => {
    expect(completedVisitOwesCompletion({ id: "svc-resume", status: "completed", has_service_record: true })).toBe(true);
  });
  it("never applies to non-completed statuses", () => {
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "cancelled", has_service_record: false })).toBe(false);
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "on_site", has_service_record: false })).toBe(false);
  });
});

describe("stopStatusBadge", () => {
  it("reads 'Closeout owed' in the alert tone when a completed visit still owes its closeout", () => {
    expect(stopStatusBadge({ id: "svc-resume", status: "completed", has_service_record: true }))
      .toEqual({ tone: "alert", label: CLOSEOUT_OWED_LABEL });
    expect(stopStatusBadge({ id: "svc-1", status: "completed", has_service_record: false }))
      .toEqual({ tone: "alert", label: CLOSEOUT_OWED_LABEL });
  });
  it("keeps the plain status badge for a finished completion and for every other status", () => {
    expect(stopStatusBadge({ id: "svc-1", status: "completed", has_service_record: true }))
      .toEqual({ tone: "strong", label: "Completed" });
    expect(stopStatusBadge({ id: "svc-resume", status: "on_site" }))
      .toEqual({ tone: "neutral", label: "On Site" });
  });
});

describe("completedVisitOwesCompletion — project-backed visits", () => {
  it("never flags a completed project-backed visit, even with the marker or no service record", () => {
    const projectBacked = { completionProfile: { projectBacked: true } };
    expect(completedVisitOwesCompletion({ id: "svc-resume", status: "completed", has_service_record: true, ...projectBacked })).toBe(false);
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "completed", has_service_record: false, ...projectBacked })).toBe(false);
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "completed", has_service_record: false, linkedProject: { id: "proj-1" } })).toBe(false);
  });
  it("keeps flagging a typed (non-project) profile", () => {
    expect(completedVisitOwesCompletion({ id: "svc-1", status: "completed", has_service_record: false, completionProfile: { projectBacked: false } })).toBe(true);
  });
});

describe("owedStopMember — consolidated multi-service stops", () => {
  it("finds the owed secondary row behind a fully closed primary and badges the stop", () => {
    const primary = { id: "svc-1", status: "completed", has_service_record: true };
    const secondary = { id: "svc-2", status: "completed", has_service_record: false };
    const stop = { ...primary, _multiServices: [primary, secondary] };
    expect(owedStopMember(stop)).toBe(secondary);
    expect(stopStatusBadge(stop)).toEqual({ tone: "alert", label: CLOSEOUT_OWED_LABEL });
  });
  it("returns null when every member is closed, and falls back to the row itself without a group", () => {
    const a = { id: "svc-1", status: "completed", has_service_record: true };
    expect(owedStopMember({ ...a, _multiServices: [a, { ...a, id: "svc-2" }] })).toBeNull();
    const owed = { id: "svc-1", status: "completed", has_service_record: false };
    expect(owedStopMember(owed)).toBe(owed);
  });
});
