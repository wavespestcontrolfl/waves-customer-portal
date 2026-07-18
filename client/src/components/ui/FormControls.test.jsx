// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Input, Select, Textarea } from ".";

afterEach(cleanup);

describe("shared form-control rendering contract", () => {
  it("keeps inputs inside their containers at both responsive sizes", () => {
    render(
      <>
        <Input aria-label="Default input" />
        <Input aria-label="Compact input" size="sm" />
      </>,
    );

    expect(screen.getByLabelText("Default input")).toHaveClass(
      "box-border",
      "min-w-0",
      "h-11",
      "text-16",
      "md:h-9",
      "md:text-13",
    );
    expect(screen.getByLabelText("Compact input")).toHaveClass(
      "h-11",
      "text-16",
      "md:h-7",
      "md:text-12",
    );
  });

  it("reserves select space for its native caret without overriding it", () => {
    render(
      <Select aria-label="Status" defaultValue="active">
        <option value="active">Active</option>
      </Select>,
    );

    const select = screen.getByLabelText("Status");
    expect(select).toHaveClass(
      "box-border",
      "pr-8",
      "pl-3",
      "h-11",
      "md:h-9",
    );
    expect(select).not.toHaveClass("px-3");
    expect(select.style.getPropertyValue("--select-caret")).toContain("svg");
  });

  it("keeps textareas contained, resizable, and mobile-readable", () => {
    render(<Textarea aria-label="Notes" rows={6} />);

    expect(screen.getByLabelText("Notes")).toHaveAttribute("rows", "6");
    expect(screen.getByLabelText("Notes")).toHaveClass(
      "box-border",
      "min-h-11",
      "min-w-0",
      "text-16",
      "md:text-13",
      "resize-y",
    );
  });
});
