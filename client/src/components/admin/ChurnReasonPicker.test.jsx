// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChurnReasonPicker, {
  EditChurnReasonField,
  applyChurnReasonToPayload,
  initialEditableChurnReasonCode,
  isChurnReasonMissing,
} from "./ChurnReasonPicker";

describe("ChurnReasonPicker", () => {
  afterEach(cleanup);

  it("lets staff pick a reason via one-tap chip or select dropdown", () => {
    const onChange = vi.fn();
    render(<ChurnReasonPicker value="" onChange={onChange} required />);
    expect(screen.getByText(/Pick a churn reason before saving/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Moving" }));
    expect(onChange).toHaveBeenCalledWith("moving");

    fireEvent.change(screen.getByLabelText("Churn reason"), { target: { value: "financial" } });
    expect(onChange).toHaveBeenCalledWith("financial");
  });

  it("requires a fresh pick when transitioning into churned (even from dormant with stale code) and submits it", () => {
    expect(initialEditableChurnReasonCode("dormant", "price")).toBe("");
    expect(initialEditableChurnReasonCode("churned", "unclassified")).toBe("");
    expect(initialEditableChurnReasonCode("churned", "price")).toBe("price");

    expect(isChurnReasonMissing("active_customer", "active_customer", "")).toBe(false);
    expect(isChurnReasonMissing("churned", "active_customer", "")).toBe(true);
    expect(isChurnReasonMissing("churned", "dormant", "unclassified")).toBe(true);
    expect(isChurnReasonMissing("churned", "active_customer", "price")).toBe(false);
    // Already-churned legacy rows remain editable without blocking unrelated phone/note fixes.
    expect(isChurnReasonMissing("churned", "churned", "")).toBe(false);

    // Transitioning into churned always includes the chosen code in the payload.
    expect(
      applyChurnReasonToPayload(
        { pipelineStage: "churned" },
        { pipelineStage: "churned", churnReasonCode: "moving" },
        { pipelineStage: "dormant", churnReasonCode: "" },
      ),
    ).toEqual({ pipelineStage: "churned", churnReasonCode: "moving" });

    // Editing an already-churned customer without changing the reason omits churnReasonCode.
    expect(
      applyChurnReasonToPayload(
        { phone: "9415551234", churnReasonCode: "price" },
        { pipelineStage: "churned", churnReasonCode: "price" },
        { pipelineStage: "churned", churnReasonCode: "price" },
      ),
    ).toEqual({ phone: "9415551234" });

    const { rerender } = render(
      <EditChurnReasonField stage="active_customer" initialStage="active_customer" value="" onChange={vi.fn()} />,
    );
    expect(screen.queryByLabelText("Churn reason")).not.toBeInTheDocument();

    rerender(
      <EditChurnReasonField stage="churned" initialStage="active_customer" value="" onChange={vi.fn()} />,
    );
    expect(screen.getByText(/Churn reason \(required\)/)).toBeInTheDocument();

    rerender(
      <EditChurnReasonField stage="churned" initialStage="churned" value="" onChange={vi.fn()} />,
    );
    expect(screen.getByText(/Churn reason \(optional\)/)).toBeInTheDocument();
  });
});
