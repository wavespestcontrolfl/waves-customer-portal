// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobCardGoverned } from "./SchedulePage";

afterEach(cleanup);

const D = { text: "#000", muted: "#666", heading: "#000" };
const base = { area: "Treated square feet.", limit: "Repeat no sooner than 8 weeks.", safety: "The applicator must carry the 2(ee) sheet." };

// What the technician reads on an area add-on's product card (Codex r6): what was sold, the
// grass the estimate priced, the label rate (or why it is withheld), the area basis, the
// yearly limit and the safety line.
describe("area add-on label text on the job card", () => {
  it("shows what was sold, the grass on the estimate and the rate", () => {
    render(<JobCardGoverned D={D} governed={{ ...base, sold: "Sold: up to 2,000 sq ft of treated lawn", grass: "Grass on the estimate: St. Augustine", rate: "0.147 oz per 1,000 sq ft", rateNote: null }} />);
    expect(screen.getByText("Sold: up to 2,000 sq ft of treated lawn")).toBeInTheDocument();
    expect(screen.getByText("Grass on the estimate: St. Augustine")).toBeInTheDocument();
    expect(screen.getByText("Rate: 0.147 oz per 1,000 sq ft")).toBeInTheDocument();
    expect(screen.getByText("Area: Treated square feet.")).toBeInTheDocument();
    expect(screen.getByText("Limit: Repeat no sooner than 8 weeks.")).toBeInTheDocument();
    expect(screen.getByText("Safety: The applicator must carry the 2(ee) sheet.")).toBeInTheDocument();
  });

  it("with no grass evidence the rate is replaced by the reason; area, limit and safety stay", () => {
    render(<JobCardGoverned D={D} governed={{ ...base, sold: "Sold: up to 1,000 sq ft of treated lawn", grass: null, rate: null, rateNote: "Grass on the estimate is not on this visit (the rate is St. Augustine only) — rate withheld" }} />);
    expect(screen.getByText(/Grass on the estimate is not on this visit/)).toBeInTheDocument();
    expect(screen.queryByText(/^Rate:/)).toBeNull();
    expect(screen.queryByText(/Grass on the estimate: /)).toBeNull();
    expect(screen.getByText("Area: Treated square feet.")).toBeInTheDocument();
    expect(screen.getByText(/Safety:/)).toBeInTheDocument();
  });

  it("renders nothing for an ordinary product", () => {
    const { container } = render(<JobCardGoverned D={D} governed={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
