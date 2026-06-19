import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, features, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <div className="centeredMessage">Loading your session…</div>;
  }

  if (!features.loginEnabled) {
    return <>{children}</>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (features.emailEnabled && user.email && !user.emailVerified) {
    return <Navigate to="/verify-email" replace />;
  }

  return <>{children}</>;
}
