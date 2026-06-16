import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../src/hooks/useAuth";
import type { PublicUser } from "../src/hooks/useAuth";

export function renderWithRouter(
  ui: React.ReactElement,
  { route = "/", withAuth = false }: { route?: string; withAuth?: boolean } = {},
  options?: RenderOptions
) {
  const content = withAuth ? <AuthProvider>{ui}</AuthProvider> : ui;

  return render(<MemoryRouter initialEntries={[route]}>{content}</MemoryRouter>, options);
}

export function renderWithMatchedRoute(
  routePath: string,
  url: string,
  element: React.ReactElement,
  options?: RenderOptions
) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={routePath} element={element} />
      </Routes>
    </MemoryRouter>,
    options
  );
}

export function createMockUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: "user-1",
    username: "testuser",
    email: "test@example.com",
    emailVerified: true,
    displayName: "Test User",
    createdAt: 1,
    ...overrides
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
