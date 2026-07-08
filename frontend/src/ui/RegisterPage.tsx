import React, { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { AuthShell } from "./LoginPage";

export function RegisterPage() {
  const { register, features, isLoading } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [verificationToken, setVerificationToken] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isLoading && !features.loginEnabled) {
    return <Navigate to="/app" replace />;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      const trimmedEmail = features.emailEnabled ? email.trim() : "";
      const result = await register(username, trimmedEmail || undefined, password);
      setVerificationToken(result.verificationToken);
      if (features.emailEnabled && trimmedEmail) {
        navigate("/verify-email", {
          replace: true,
          state: { username, verificationToken: result.verificationToken }
        });
      } else {
        navigate("/login", {
          replace: true,
          state: { message: "Account created. Log in to continue." }
        });
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Create account"
      subtitle={
        features.emailEnabled
          ? "Email is optional. Add one to verify your account and enable recovery."
          : "Create a username and password to get started."
      }
    >
      <form className="authForm" onSubmit={(event) => void submit(event)}>
        <label className="label" htmlFor="register-username">
          Username
        </label>
        <input
          id="register-username"
          className="input"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
        />

        {features.emailEnabled ? (
          <>
            <label className="label" htmlFor="register-email">
              Email (optional)
            </label>
            <input
              id="register-email"
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
          </>
        ) : null}

        <label className="label" htmlFor="register-password">
          Password
        </label>
        <input
          id="register-password"
          className="input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />

        {error ? <div className="error">{error}</div> : null}
        {verificationToken ? (
          <div className="publishMessage">Dev verification token: {verificationToken}</div>
        ) : null}

        <button className="btn" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="authFooter">
        Already registered? <Link to="/login">Log in</Link>
      </p>
    </AuthShell>
  );
}
