import React from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AuthProvider } from "../hooks/useAuth";
import { DashboardPage } from "./DashboardPage";
import { ExperimentalBanner } from "./ExperimentalBanner";
import { GeneratorApp } from "./GeneratorApp";
import { LoginPage } from "./LoginPage";
import { ProjectManagePage } from "./ProjectManagePage";
import { ProtectedRoute } from "./ProtectedRoute";
import { RegisterPage } from "./RegisterPage";
import { SplashPage } from "./SplashPage";
import { VerifyEmailPage } from "./VerifyEmailPage";

function GeneratorRoute({ projectId }: { projectId?: string }) {
  return (
    <ProtectedRoute>
      <GeneratorApp projectId={projectId} />
    </ProtectedRoute>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="topBar">
          <ExperimentalBanner />
        </div>
        <Routes>
          <Route path="/" element={<SplashPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/manage/:editToken" element={<ProjectManagePage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
          <Route path="/app" element={<GeneratorRoute />} />
          <Route path="/app/:projectId" element={<GeneratorRouteWithProject />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

function GeneratorRouteWithProject() {
  const { projectId } = useParams();
  return <GeneratorRoute projectId={projectId} />;
}
