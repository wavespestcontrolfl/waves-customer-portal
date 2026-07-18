// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AdminCommandHeader from "./AdminCommandHeader";

afterEach(cleanup);

describe("AdminCommandHeader heading hierarchy", () => {
  it("uses a primary heading and sticky behavior by default", () => {
    const { container } = render(<AdminCommandHeader title="Services" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Services" }),
    ).toHaveClass("text-22");
    expect(container.firstChild).toHaveClass("md:sticky");
    expect(container.querySelector(".border-b")).not.toBeInTheDocument();
  });

  it("supports a non-sticky second-level hub header", () => {
    const { container } = render(
      <AdminCommandHeader
        title="Protocol & Readiness"
        headingLevel={2}
        sticky={false}
      />,
    );

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Protocol & Readiness",
      }),
    ).toHaveClass("text-18");
    expect(container.firstChild).not.toHaveClass("md:sticky");
  });

  it("keeps section targets touch-safe and compact on larger screens", () => {
    const { container } = render(
      <AdminCommandHeader
        title="Schedule"
        sections={[
          { key: "calendar", label: "Calendar" },
          { key: "dispatch", label: "Auto Dispatch" },
        ]}
        activeKey="calendar"
      />,
    );

    expect(screen.getByRole("navigation", { name: "Schedule section" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calendar" }))
      .toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Auto Dispatch" }))
      .toHaveClass("h-11", "sm:h-9", "leading-tight");
    expect(container.querySelector(".border-b")).toBeInTheDocument();
  });
});
