import React, { useEffect, useMemo, useRef } from "react";
import { Sandpack } from "@codesandbox/sandpack-react";
import { useGeneration } from "../hooks/useGeneration";

const DEFAULT_IDEA = "make a tiny tetris-like game";

export function App() {
  const [idea, setIdea] = React.useState(DEFAULT_IDEA);
  const { state, start } = useGeneration();
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!logRef.current || !("logs" in state)) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state]);

  const downloadHref =
    state.kind === "ready" ? `/api/project/${encodeURIComponent(state.runId)}/download` : undefined;

  const sandpackFiles = useMemo(() => {
    if (state.kind !== "ready") return undefined;
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.files)) {
      files[`/${k}`] = v;
    }
    return files;
  }, [state]);

  return (
    <div className="page">
      <div className="bg" aria-hidden="true" />
      <div className="sparkles" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <header className="header">
        <div className="brand">
          <div className="logo">prism0</div>
          <div className="tag">ideas → apps, with a little sparkle</div>
        </div>
      </header>

      <main className="main">
        <section className="card">
          <label className="label" htmlFor="idea">
            What should we build?
          </label>
          <div className="row">
            <input
              id="idea"
              className="input"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder='e.g. "make a tetris game"'
            />
            <button className="btn" onClick={() => void start(idea)} disabled={state.kind === "generating"}>
              {state.kind === "generating" ? "Generating…" : "Submit"}
            </button>
          </div>

          <div className="metaRow">
            <div className="pill">{state.kind === "idle" ? "idle" : state.kind}</div>
            {downloadHref ? (
              <a className="pillLink" href={downloadHref}>
                download zip
              </a>
            ) : null}
          </div>
        </section>

        <section className="grid">
          <div className="panel">
            <div className="panelTitle">Verbose progress</div>
            <div className="log" role="log" aria-live="polite" ref={logRef}>
              {"logs" in state ? state.logs.join("\n") : "Enter an idea and hit Submit."}
            </div>
            {state.kind === "error" ? <div className="error">Error: {state.message}</div> : null}
          </div>

          <div className="panel panelEditor">
            <div className="panelTitle">Editor + Preview</div>
            {sandpackFiles ? (
              <Sandpack
                template="vanilla"
                theme="dark"
                files={sandpackFiles}
                options={{
                  showLineNumbers: true,
                  wrapContent: true,
                  editorHeight: 360,
                  layout: "preview"
                }}
              />
            ) : (
              <div className="placeholder">
                When generation finishes, you’ll get a live editor + preview here.
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
