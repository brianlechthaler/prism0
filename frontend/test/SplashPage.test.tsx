import React from "react";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SplashPage } from "../src/ui/SplashPage";
import { renderWithRouter } from "./helpers";

describe("SplashPage", () => {
  it("renders hero content and auth links", () => {
    renderWithRouter(<SplashPage />);

    expect(screen.getByRole("heading", { name: /turn prompts into polished browser apps/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /get started/i })).toHaveAttribute("href", "/register");
    expect(screen.getByRole("link", { name: /log in/i })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: /create account/i })).toHaveAttribute("href", "/register");
    expect(screen.getByText(/generate & validate/i)).toBeInTheDocument();
    expect(screen.getByText(/host & track/i)).toBeInTheDocument();
  });
});
