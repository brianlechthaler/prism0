import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardData } from "../hooks/useAuth";
import { useAuth } from "../hooks/useAuth";

export function DashboardPage() {
  const { user, loadDashboard, logout, updateProfile, changeEmail, changePassword, deleteAccount, features } =
    useAuth();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [profileMessage, setProfileMessage] = useState<string | undefined>();

  useEffect(() => {
    void loadDashboard()
      .then((data) => {
        setDashboard(data);
        setDisplayName(data.user.displayName ?? "");
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
  }, [loadDashboard]);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setProfileMessage(undefined);
    try {
      await updateProfile(displayName.trim() || null);
      setProfileMessage("Profile updated.");
    } catch (profileError) {
      setProfileMessage(profileError instanceof Error ? profileError.message : String(profileError));
    }
  };

  return (
    <div className="page">
      <div className="bg" aria-hidden="true" />
      <header className="header">
        <div className="brand">
          <div className="logo">prism0</div>
          <div className="tag">dashboard</div>
        </div>
        <nav className="headerNav">
          <Link className="pillLink" to="/app">
            Create app
          </Link>
          <button className="pillLink buttonLink" type="button" onClick={() => void logout()}>
            Log out
          </button>
        </nav>
      </header>

      <main className="dashboardMain">
        {error ? <div className="error">{error}</div> : null}

        <section className="card dashboardCard">
          <h1>Welcome{user?.displayName ? `, ${user.displayName}` : user ? `, ${user.username}` : ""}</h1>
          <p className="authSubtitle">
            Token usage: {dashboard?.tokenSummary.totalTokens ?? 0} total across{" "}
            {dashboard?.tokenSummary.generationCount ?? 0} runs.
          </p>
          <div className="dashboardStats">
            <div className="pill">Input {dashboard?.tokenSummary.inputTokens ?? 0}</div>
            <div className="pill">Output {dashboard?.tokenSummary.outputTokens ?? 0}</div>
          </div>
        </section>

        <section className="card dashboardCard">
          <div className="panelTitle">Hosted projects</div>
          {dashboard?.projects.length ? (
            <ul className="projectList">
              {dashboard.projects.map((project) => (
                <li key={project.id} className="projectListItem">
                  <div>
                    <strong>{project.name}</strong>
                    <div className="mutedSmall">{project.pageViews} page views</div>
                  </div>
                  <div className="projectActions">
                    <a className="pillLink" href={project.publicUrl} target="_blank" rel="noreferrer">
                      Open site
                    </a>
                    <Link className="pillLink" to={`/manage/${project.editToken}`}>
                      Manage
                    </Link>
                    <Link className="pillLink" to={`/app/${project.id}`}>
                      Edit
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="placeholder">No hosted projects yet. Create an app and publish it.</p>
          )}
        </section>

        <section className="card dashboardCard">
          <div className="panelTitle">Recent generation history</div>
          {dashboard?.history.length ? (
            <ul className="historyList">
              {dashboard.history.map((entry) => (
                <li key={entry.id}>
                  <div>{entry.idea}</div>
                  <div className="mutedSmall">
                    {entry.status} · {entry.inputTokens + entry.outputTokens} tokens
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="placeholder">Your chat history will appear here after you generate apps.</p>
          )}
        </section>

        <ProfileSettings
          emailEnabled={features.emailEnabled}
          currentEmail={dashboard?.user.email ?? user?.email ?? null}
          displayName={displayName}
          onDisplayNameChange={setDisplayName}
          onSaveProfile={(event) => void saveProfile(event)}
          profileMessage={profileMessage}
          onChangeEmail={changeEmail}
          onChangePassword={changePassword}
          onDeleteAccount={deleteAccount}
        />
      </main>
    </div>
  );
}

function ProfileSettings({
  emailEnabled,
  currentEmail,
  displayName,
  onDisplayNameChange,
  onSaveProfile,
  profileMessage,
  onChangeEmail,
  onChangePassword,
  onDeleteAccount
}: {
  emailEnabled: boolean;
  currentEmail: string | null;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  onSaveProfile: (event: React.FormEvent) => void;
  profileMessage?: string;
  onChangeEmail: (email: string, password: string) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onDeleteAccount: (password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [message, setMessage] = useState<string | undefined>();

  return (
    <section className="card dashboardCard">
      <div className="panelTitle">Profile settings</div>

      <form className="authForm" onSubmit={onSaveProfile}>
        <label className="label" htmlFor="display-name">
          Display name
        </label>
        <input
          id="display-name"
          className="input"
          value={displayName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
        />
        <button className="btn" type="submit">
          Save display name
        </button>
        {profileMessage ? <div className="publishMessage">{profileMessage}</div> : null}
      </form>

      {emailEnabled ? (
      <form
        className="authForm"
        onSubmit={(event) => {
          event.preventDefault();
          void onChangeEmail(email, emailPassword)
            .then(() =>
              setMessage(
                currentEmail
                  ? "Email updated. Verify your new address and log in again."
                  : "Email added. Verify your address and log in again."
              )
            )
            .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
        }}
      >
        <label className="label" htmlFor="new-email">
          {currentEmail ? "Change email" : "Add email"}
        </label>
        <input
          id="new-email"
          className="input"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="Current password"
          value={emailPassword}
          onChange={(event) => setEmailPassword(event.target.value)}
        />
        <button className="btn" type="submit">
          Update email
        </button>
      </form>
      ) : null}

      <form
        className="authForm"
        onSubmit={(event) => {
          event.preventDefault();
          void onChangePassword(currentPassword, newPassword)
            .then(() => setMessage("Password changed. Log in again."))
            .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
        }}
      >
        <label className="label" htmlFor="new-password">
          Change password
        </label>
        <input
          className="input"
          type="password"
          placeholder="Current password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <input
          id="new-password"
          className="input"
          type="password"
          placeholder="New password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <button className="btn" type="submit">
          Update password
        </button>
      </form>

      <form
        className="authForm"
        onSubmit={(event) => {
          event.preventDefault();
          void onDeleteAccount(deletePassword)
            .then(() => setMessage("Account deleted."))
            .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
        }}
      >
        <label className="label" htmlFor="delete-password">
          Delete account
        </label>
        <input
          id="delete-password"
          className="input"
          type="password"
          placeholder="Confirm with password"
          value={deletePassword}
          onChange={(event) => setDeletePassword(event.target.value)}
        />
        <button className="btn btnDanger" type="submit">
          Delete account
        </button>
        {message ? <div className="publishMessage">{message}</div> : null}
      </form>
    </section>
  );
}
