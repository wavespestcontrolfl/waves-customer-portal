// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomerGeocodeReviewForm from "./CustomerGeocodeReviewForm";

vi.mock("@react-google-maps/api", () => ({
  useJsApiLoader: () => ({ isLoaded: true, loadError: null }),
  GoogleMap: ({ children }) => <div>{children}</div>,
  Marker: () => null,
}));

function record(overrides = {}) {
  return {
    customer: {
      id: "customer-1",
      address_line1: "100 Test Ave",
      address_line2: "",
      city: "Bradenton",
      state: "FL",
      zip: "34205",
      latitude: 27.49,
      longitude: -82.57,
    },
    review: { status: "needs_pin" },
    revision: "revision-1",
    ...overrides,
  };
}

function renderForm(props = {}) {
  const handlers = {
    onResolve: vi.fn(),
    onCancel: vi.fn(),
    onAcknowledgeConflict: vi.fn(),
  };
  const view = render(
    <CustomerGeocodeReviewForm
      record={record()}
      saving={false}
      error=""
      conflicted={false}
      unavailable={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

afterEach(cleanup);

describe("CustomerGeocodeReviewForm", () => {
  it("submits a corrected address, point, source, evidence, and revision", () => {
    const { onResolve } = renderForm();
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "101 Corrected Ave" } });
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "27.5001" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-82.6002" } });
    fireEvent.change(screen.getByLabelText("Confirmation source"), { target: { value: "site_visit" } });
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Technician confirmed the front entry." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));

    expect(onResolve).toHaveBeenCalledWith({
      revision: "revision-1",
      action: "verify_pin",
      address: {
        address_line1: "101 Corrected Ave",
        address_line2: "",
        city: "Bradenton",
        state: "FL",
        zip: "34205",
      },
      latitude: 27.5001,
      longitude: -82.6002,
      source: "site_visit",
      evidence: "Technician confirmed the front entry.",
      confirmed: true,
    });
  });

  it("does not treat blank coordinates as zero and limits saved-address actions after an edit", () => {
    const withoutPin = record({ customer: { ...record().customer, latitude: null, longitude: null } });
    const { onResolve } = renderForm({ record: withoutPin });
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Address confirmed, pin still needed." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));

    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-82.57" } });
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry saved address" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mark saved address outside service area" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Mark saved address outside service area" }));
    expect(onResolve).toHaveBeenCalledWith({
      revision: "revision-1",
      action: "outside_service_area",
      source: "customer_confirmation",
      evidence: "Address confirmed, pin still needed.",
      confirmed: true,
    });

    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "101 Unsaved Ave" } });
    expect(screen.getByRole("button", { name: "Retry saved address" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark saved address outside service area" })).toBeDisabled();
  });

  it("withholds verification for implausible pins and incomplete street addresses", () => {
    const { onResolve } = renderForm();
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Confirmed with the customer." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    const verify = screen.getByRole("button", { name: "Verify pin" });
    expect(verify).toBeEnabled();

    for (const [label, invalid, corrected] of [
      ["Longitude", "82.57", "-82.57"],
      ["Latitude", "40.71", "27.49"],
      ["Address", "Main Street", "100 Main Street"],
      ["Address", "123", "123A Main Street"],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: invalid } });
      expect(verify).toBeDisabled();
      fireEvent.click(verify);
      expect(onResolve).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText(label), { target: { value: corrected } });
      expect(verify).toBeEnabled();
    }
    fireEvent.click(verify);
    expect(onResolve).toHaveBeenCalledOnce();
  });

  it("preserves the draft but withholds conflict acknowledgment while the saved record is unavailable", () => {
    const { rerender, onAcknowledgeConflict, onResolve, onCancel } = renderForm();
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Keep this note through recovery." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));

    rerender(
      <CustomerGeocodeReviewForm
        record={record({ revision: "revision-2" })}
        saving={false}
        error="Current review unavailable"
        conflicted
        unavailable
        onResolve={onResolve}
        onCancel={onCancel}
        onAcknowledgeConflict={onAcknowledgeConflict}
      />,
    );
    expect(screen.getByLabelText("Evidence")).toHaveValue("Keep this note through recovery.");
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "I reviewed the latest record" })).not.toBeInTheDocument();

    rerender(
      <CustomerGeocodeReviewForm
        record={record({ revision: "revision-2" })}
        saving={false}
        error=""
        conflicted
        unavailable={false}
        onResolve={onResolve}
        onCancel={onCancel}
        onAcknowledgeConflict={onAcknowledgeConflict}
      />,
    );
    expect(screen.getByRole("button", { name: "I reviewed the latest record" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I reviewed the latest record" }));
    expect(onAcknowledgeConflict).toHaveBeenCalledOnce();
  });
});
