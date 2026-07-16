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

    expect(screen.getByRole("heading", { level: 1, name: "Services" }))
      .toBeInTheDocument();
    expect(container.firstChild).toHaveClass("md:sticky");
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
    ).toBeInTheDocument();
    expect(container.firstChild).not.toHaveClass("md:sticky");
  });
});
