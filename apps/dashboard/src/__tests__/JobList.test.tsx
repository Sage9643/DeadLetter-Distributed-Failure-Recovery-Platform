import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import JobList from "../components/JobList";

const sampleJobs = [
  {
    id: "6d0addf3-921c-47f5-86bb-ca495545d415",
    type: "send_email",
    status: "COMPLETED",
    attempt_count: 1,
    max_attempts: 5,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
  },
];

describe("JobList", () => {
  it("renders an empty state with no jobs", () => {
    render(<JobList jobs={[]} onSelect={() => {}} />);
    expect(screen.getByText("No jobs yet.")).toBeInTheDocument();
  });

  it("renders a row per job and calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    render(<JobList jobs={sampleJobs} onSelect={onSelect} />);
    expect(screen.getByText("send_email")).toBeInTheDocument();
    fireEvent.click(screen.getByText("send_email"));
    expect(onSelect).toHaveBeenCalledWith("6d0addf3-921c-47f5-86bb-ca495545d415");
  });
});