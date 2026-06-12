import React, { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { AuthShell } from "./LoginPage";

function readVerificationToken(searchParams: URLSearchParams, locationHash: string): string | null {
  const hash = locationHash || window.location.hash;
  if (hash.startsWith("#token=")) {
    return decodeURIComponent(hash.slice("#token=".length));
  }
  return searchParams.get("token");
}

export function VerifyEmailPage() {
  const { verifyEmail, resendVerification } = useAuth();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [message, setMessage] = useState("Check your inbox for a verification link.");
  const [error, setError] = useState<string | undefined>();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const stateUsername =
    typeof location.state === "object" &&
    location.state &&
    "username" in location.state &&
    typeof location.state.username === "string"
      ? location.state.username
      : "";

  useEffect(() => {
    const token = readVerificationToken(searchParams, location.hash);
    if (!token) return;

    void verifyEmail(token)
      .then(() => {
        setMessage("Email verified. You can log in now.");
        setError(undefined);
      })
      .catch((verifyError) => {
        setError(verifyError instanceof Error ? verifyError.message : String(verifyError));
      });
  }, [location.hash, searchParams, verifyEmail]);

  const resend = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      const result = await resendVerification(username, password);
      setMessage(
        result.verificationToken
          ? `Verification email resent. Dev token: ${result.verificationToken}`
          : "Verification email resent."
      );
    } catch (resendError) {
      setError(resendError instanceof Error ? resendError.message : String(resendError));
    }
  };

  return (
    <AuthShell title="Verify your email" subtitle="We sent a secure verification link to your inbox.">
      <p className="authSubtitle">{message}</p>
      {error ? <div className="error">{error}</div> : null}

      <form className="authForm" onSubmit={(event) => void resend(event)}>
        <label className="label" htmlFor="verify-username">
          Resend with username
        </label>
        <input
          id="verify-username"
          className="input"
          value={username || stateUsername}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
        />
        <label className="label" htmlFor="verify-password">
          Password
        </label>
        <input
          id="verify-password"
          className="input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
        <button className="btn" type="submit">
          Resend verification email
        </button>
      </form>

      <p className="authFooter">
        <Link to="/login">Back to login</Link>
      </p>
    </AuthShell>
  );
}
