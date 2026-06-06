import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { formatTokenRate, formatTokens, UsageMetricsPanel } from "../src/ui/UsageMetrics";
import type { RunUsageMetrics } from "../src/hooks/useGeneration";

const metrics: RunUsageMetrics = {
  inputTokens: 1200,
  outputTokens: 345,
  totalTokens: 1545,
  contextWindowTokens: 128000,
  contextUsedTokens: 1545,
  contextUsedPercent: 1.207,
  outputTokensPerSecond: 17.25,
  buckets: [
    {
      kind: "generate",
      label: "LLM generate",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500
    },
    {
      kind: "thinking",
      label: "LLM thinking",
      inputTokens: 0,
      outputTokens: 45,
      totalTokens: 45
    }
  ]
};

describe("UsageMetricsPanel", () => {
  it("renders an empty state before usage arrives", () => {
    render(<UsageMetricsPanel />);
    expect(screen.getByText("LLM usage")).toBeInTheDocument();
    expect(screen.getByText(/will appear once streaming begins/i)).toBeInTheDocument();
  });

  it("renders token counts, speed, context, and usage buckets", () => {
    render(<UsageMetricsPanel metrics={metrics} />);

    expect(screen.getByLabelText("LLM usage metrics")).toBeInTheDocument();
    expect(screen.getByText("17.3 tok/s")).toBeInTheDocument();
    expect(screen.getByText(/1,545 \/ 128,000 context tokens \(1.2%\)/i)).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(screen.getByText("345")).toBeInTheDocument();
    expect(screen.getByText("LLM generate")).toBeInTheDocument();
    expect(screen.getByText("LLM thinking")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /context window used/i })).toHaveAttribute(
      "aria-valuenow",
      String(metrics.contextUsedPercent)
    );
  });
});

describe("usage metric formatting", () => {
  it("formats token counts and rates", () => {
    expect(formatTokens(12345)).toBe("12,345");
    expect(formatTokenRate(4.44)).toBe("4.4 tok/s");
  });
});
