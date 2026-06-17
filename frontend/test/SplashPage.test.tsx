import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { SplashPage } from "../src/ui/SplashPage";
import { renderWithRouter } from "./helpers";

const useAuthMock = vi.hoisted(() => vi.fn());

vi.mock("../src/hooks/useAuth", () => ({
  useAuth: useAuthMock
}));

describe("SplashPage", () => {
  beforeEach(() => {
    useAuthMock.mockReset();
  });

  it("renders hero content and auth links when login is enabled", () => {
    useAuthMock.mockReturnValue({
      features: { loginEnabled: true, emailEnabled: true },
      isLoading: false
    });

    renderWithRouter(<SplashPage />);

    expect(screen.getByRole("heading", { name: /turn prompts into polished browser apps/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /get started/i })).toHaveAttribute("href", "/register");
    expect(screen.getByRole("link", { name: /log in/i })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: /create account/i })).toHaveAttribute("href", "/register");
    expect(screen.getByText(/generate & validate/i)).toBeInTheDocument();
    expect(screen.getByText(/host & track/i)).toBeInTheDocument();
  });

  it("links directly to the generator when login is disabled", () => {
    useAuthMock.mockReturnValue({
      features: { loginEnabled: false, emailEnabled: false },
      isLoading: false
    });

    renderWithRouter(<SplashPage />);

    expect(screen.getByRole("link", { name: /open generator/i })).toHaveAttribute("href", "/app");
    expect(screen.queryByRole("link", { name: /log in/i })).not.toBeInTheDocument();
  });
});
