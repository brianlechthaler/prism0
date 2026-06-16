import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch, readApiError } from "../api";
import type { HostedProject } from "../hooks/useAuth";
import { useAuth } from "../hooks/useAuth";

type ProjectVersion = {
  id: string;
  projectId: string;
  versionNumber: number;
  idea: string | null;
  runId: string | null;
  createdAt: number;
};

type ManageResponse = {
  project: HostedProject;
  versions: ProjectVersion[];
  canEdit: boolean;
};

export function ProjectManagePage() {
  const { editToken = "" } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState<ManageResponse | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  const load = async () => {
    const res = await apiFetch(`/api/projects/manage/${encodeURIComponent(editToken)}`);
    if (!res.ok) throw new Error(await readApiError(res));
    setData((await res.json()) as ManageResponse);
  };

  useEffect(() => {
    void load().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, [editToken]);

  const revertVersion = async (versionId: string) => {
    setMessage(undefined);
    try {
      const res = await apiFetch(`/api/projects/manage/${encodeURIComponent(editToken)}/revert`, {
        method: "POST",
        json: { versionId }
      });
      if (!res.ok) throw new Error(await readApiError(res));
      await load();
      setMessage("Reverted to the selected version.");
    } catch (revertError) {
      setMessage(revertError instanceof Error ? revertError.message : String(revertError));
    }
  };

  const deleteProject = async () => {
    setMessage(undefined);
    try {
      const res = await apiFetch(`/api/projects/manage/${encodeURIComponent(editToken)}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error(await readApiError(res));
      setMessage("Project deleted.");
      setData(null);
    } catch (deleteError) {
      setMessage(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  return (
    <div className="page">
      <div className="bg" aria-hidden="true" />
      <header className="header">
        <div className="brand">
          <div className="logo">prism0</div>
          <div className="tag">project dashboard</div>
        </div>
        <nav className="headerNav">
          {user ? (
            <Link className="pillLink" to="/dashboard">
              Dashboard
            </Link>
          ) : (
            <Link className="pillLink" to="/login">
              Log in
            </Link>
          )}
        </nav>
      </header>

      <main className="dashboardMain">
        {error ? <div className="error">{error}</div> : null}
        {message ? <div className="publishMessage">{message}</div> : null}

        {data ? (
          <>
            <section className="card dashboardCard">
              <h1>{data.project.name}</h1>
              <p className="authSubtitle">{data.project.pageViews} page views</p>
              <div className="projectActions">
                <a className="pillLink" href={data.project.publicUrl} target="_blank" rel="noreferrer">
                  Public URL
                </a>
                {data.canEdit ? (
                  <Link className="pillLink" to={`/app/${data.project.id}`}>
                    Open editor
                  </Link>
                ) : null}
              </div>
            </section>

            <section className="card dashboardCard">
              <div className="panelTitle">Versions</div>
              <ul className="historyList">
                {data.versions.map((version) => (
                  <li key={version.id} className="projectListItem">
                    <div>
                      <strong>v{version.versionNumber}</strong>
                      <div className="mutedSmall">{version.idea ?? "No prompt recorded"}</div>
                    </div>
                    {data.canEdit ? (
                      <button className="btn btnSmall" type="button" onClick={() => void revertVersion(version.id)}>
                        Revert
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            {data.canEdit ? (
              <section className="card dashboardCard">
                <div className="panelTitle">Danger zone</div>
                <button className="btn btnDanger" type="button" onClick={() => void deleteProject()}>
                  Delete hosted project
                </button>
              </section>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
