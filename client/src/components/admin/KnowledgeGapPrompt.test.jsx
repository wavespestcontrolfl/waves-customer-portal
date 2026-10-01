// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import KnowledgeGapPrompt from "./KnowledgeGapPrompt";

afterEach(cleanup);

describe("KnowledgeGapPrompt", () => {
  it("renders nothing without misses (the payload omits knowledgeMisses)", () => {
    const { container } = render(<KnowledgeGapPrompt misses={undefined} save={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<KnowledgeGapPrompt misses={[]} save={vi.fn()} variant="light" />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it("saves nothing until the operator taps, then saves the edited text", async () => {
    const save = vi.fn(async () => ({ success: true }));
    render(<KnowledgeGapPrompt misses={["Smith chinch bugs zoysia"]} save={save} />);
    expect(save).not.toHaveBeenCalled();
    const box = screen.getByRole("textbox", { name: "Knowledge gap" });
    expect(box).toHaveValue("Smith chinch bugs zoysia");
    fireEvent.change(box, { target: { value: "  chinch bugs   zoysia " } });
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    await waitFor(() => expect(screen.getByText(/Added to Monday's knowledge-gaps email/)).toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("chinch bugs zoysia", expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  });

  it("a retry after a failed save sends the same request key", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ success: true });
    render(<KnowledgeGapPrompt misses={["chinch bugs"]} save={save} />);
    const button = screen.getByRole("button", { name: "Add to knowledge gaps" });
    fireEvent.click(button);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][1]).toBe(save.mock.calls[0][1]);
  });

  it("the mobile box is 16px so Safari does not zoom on focus", () => {
    render(<KnowledgeGapPrompt misses={["chinch bugs"]} save={vi.fn()} variant="light" />);
    expect(screen.getByRole("textbox", { name: "Knowledge gap" }).style.fontSize).toBe("16px");
  });

  it("keeps the box and shows the error when the save fails", async () => {
    const save = vi.fn(async () => { throw new Error("Admin access required"); });
    render(<KnowledgeGapPrompt misses={["chinch bugs"]} save={save} variant="light" />);
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Admin access required");
    expect(screen.getByRole("textbox", { name: "Knowledge gap" })).toHaveValue("chinch bugs");
  });

  it("disables the button when the text is under 3 characters", () => {
    render(<KnowledgeGapPrompt misses={["chinch bugs"]} save={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Knowledge gap" }), { target: { value: " a " } });
    expect(screen.getByRole("button", { name: "Add to knowledge gaps" })).toBeDisabled();
  });
});
