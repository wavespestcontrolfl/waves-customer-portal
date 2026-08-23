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

import { completedVisitOwesCompletion } from "./DispatchPageV2";

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
