import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExperimentalBanner } from "../src/ui/ExperimentalBanner";

describe("ExperimentalBanner", () => {
  it("warns that prism0 is experimental software", () => {
    render(<ExperimentalBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/experimental software/i);
    expect(screen.getByRole("status")).toHaveTextContent(/use at your own risk/i);
  });
});
