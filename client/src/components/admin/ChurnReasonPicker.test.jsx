// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChurnReasonPicker, { EditChurnReasonField, isChurnReasonMissing } from "./ChurnReasonPicker";

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

  it("hides when stage is not churned and requires a pick only when transitioning into churned", () => {
    expect(isChurnReasonMissing("active_customer", "active_customer", "")).toBe(false);
    expect(isChurnReasonMissing("churned", "active_customer", "")).toBe(true);
    expect(isChurnReasonMissing("churned", "active_customer", "price")).toBe(false);
    // Already-churned legacy rows remain editable without blocking unrelated phone/note fixes.
    expect(isChurnReasonMissing("churned", "churned", "")).toBe(false);

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
