import React, { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { safeRedirectPath } from "../safeRedirect";

export function LoginPage() {
  const { login, features, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const from = safeRedirectPath(
    typeof location.state === "object" && location.state && "from" in location.state
      ? location.state.from
      : undefined
  );
  const notice =
    typeof location.state === "object" && location.state && "message" in location.state
      ? String(location.state.message)
      : undefined;

  if (!isLoading && !features.loginEnabled) {
    return <Navigate to="/app" replace />;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      await login(username, password);
      navigate(from, { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthShell title="Log in" subtitle="Access your dashboard, projects, and hosted apps.">
      <form className="authForm" onSubmit={(event) => void submit(event)}>
        <label className="label" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          className="input"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
        />

        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />

        {notice ? <div className="publishMessage">{notice}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        <button className="btn" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Logging in…" : "Log in"}
        </button>
      </form>

      <p className="authFooter">
        Need an account? <Link to="/register">Create one</Link>
      </p>
    </AuthShell>
  );
}

export function AuthShell({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="page">
      <div className="bg" aria-hidden="true" />
      <main className="authMain">
        <section className="card authCard">
          <Link className="logo authLogo" to="/">
            prism0
          </Link>
          <h1>{title}</h1>
          <p className="authSubtitle">{subtitle}</p>
          {children}
        </section>
      </main>
    </div>
  );
}
