import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch, readApiError } from "../api";

export type PublicUser = {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  createdAt: number;
};

export type DashboardData = {
  user: PublicUser;
  projects: HostedProject[];
  history: GenerationHistoryEntry[];
  tokenSummary: TokenSummary;
};

export type HostedProject = {
  id: string;
  userId: string;
  name: string;
  slug: string;
  editToken: string;
  currentVersionId: string | null;
  createdAt: number;
  updatedAt: number;
  pageViews: number;
  publicUrl: string;
  manageUrl: string;
};

export type GenerationHistoryEntry = {
  id: string;
  userId: string;
  projectId: string | null;
  runId: string;
  idea: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  updatedAt: number;
};

export type TokenSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  generationCount: number;
};

type AuthContextValue = {
  user: PublicUser | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (
    username: string,
    email: string,
    password: string
  ) => Promise<{ verificationToken?: string }>;
  logout: () => Promise<void>;
  loadDashboard: () => Promise<DashboardData>;
  updateProfile: (displayName: string | null) => Promise<PublicUser>;
  changeEmail: (email: string, password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
  verifyEmail: (token: string) => Promise<PublicUser>;
  resendVerification: (username: string, password: string) => Promise<{ verificationToken?: string }>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) {
      setUser(null);
      return;
    }
    const json = (await res.json()) as { authenticated: boolean; user?: PublicUser };
    setUser(json.authenticated && json.user ? json.user : null);
  }, []);

  useEffect(() => {
    void refresh().finally(() => setIsLoading(false));
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiFetch("/api/auth/login", { method: "POST", json: { username, password } });
    if (!res.ok) throw new Error(await readApiError(res));
    const json = (await res.json()) as { user: PublicUser };
    setUser(json.user);
  }, []);

  const register = useCallback(async (username: string, email: string, password: string) => {
    const res = await apiFetch("/api/auth/register", {
      method: "POST",
      json: { username, email, password }
    });
    if (!res.ok) throw new Error(await readApiError(res));
    return (await res.json()) as { verificationToken?: string };
  }, []);

  const logout = useCallback(async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  const loadDashboard = useCallback(async () => {
    const res = await apiFetch("/api/dashboard");
    if (!res.ok) throw new Error(await readApiError(res));
    return (await res.json()) as DashboardData;
  }, []);

  const updateProfile = useCallback(async (displayName: string | null) => {
    const res = await apiFetch("/api/auth/profile", {
      method: "PATCH",
      json: { displayName }
    });
    if (!res.ok) throw new Error(await readApiError(res));
    const json = (await res.json()) as { user: PublicUser };
    setUser(json.user);
    return json.user;
  }, []);

  const changeEmail = useCallback(async (email: string, password: string) => {
    const res = await apiFetch("/api/auth/change-email", {
      method: "POST",
      json: { email, password }
    });
    if (!res.ok) throw new Error(await readApiError(res));
    setUser(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await apiFetch("/api/auth/change-password", {
      method: "POST",
      json: { currentPassword, newPassword }
    });
    if (!res.ok) throw new Error(await readApiError(res));
    setUser(null);
  }, []);

  const deleteAccount = useCallback(async (password: string) => {
    const res = await apiFetch("/api/auth/account", { method: "DELETE", json: { password } });
    if (!res.ok) throw new Error(await readApiError(res));
    setUser(null);
  }, []);

  const verifyEmail = useCallback(async (token: string) => {
    const res = await apiFetch("/api/auth/verify-email", { method: "POST", json: { token } });
    if (!res.ok) throw new Error(await readApiError(res));
    const json = (await res.json()) as { user: PublicUser };
    setUser(json.user);
    return json.user;
  }, []);

  const resendVerification = useCallback(async (username: string, password: string) => {
    const res = await apiFetch("/api/auth/resend-verification", {
      method: "POST",
      json: { username, password }
    });
    if (!res.ok) throw new Error(await readApiError(res));
    return (await res.json()) as { verificationToken?: string };
  }, []);

  const value = useMemo(
    () => ({
      user,
      isLoading,
      refresh,
      login,
      register,
      logout,
      loadDashboard,
      updateProfile,
      changeEmail,
      changePassword,
      deleteAccount,
      verifyEmail,
      resendVerification
    }),
    [
      user,
      isLoading,
      refresh,
      login,
      register,
      logout,
      loadDashboard,
      updateProfile,
      changeEmail,
      changePassword,
      deleteAccount,
      verifyEmail,
      resendVerification
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
