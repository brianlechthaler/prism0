import React, { useEffect, useMemo, useRef } from "react";
import { useGeneration } from "../hooks/useGeneration";

const DEFAULT_IDEA = "make a tiny tetris-like game";
export const PREVIEW_ERROR_MESSAGE_TYPE = "prism0-preview-error";
const LazySandpack = React.lazy(async () => {
  const { Sandpack } = await import("@codesandbox/sandpack-react");
  return { default: Sandpack };
});

type PreviewRuntimeError = {
  type: typeof PREVIEW_ERROR_MESSAGE_TYPE;
  runId: string;
  message: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
};

function isPreviewRuntimeError(data: unknown): data is PreviewRuntimeError {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Partial<PreviewRuntimeError>;
  return (
    candidate.type === PREVIEW_ERROR_MESSAGE_TYPE &&
    typeof candidate.runId === "string" &&
    typeof candidate.message === "string"
  );
}

export function formatPreviewRuntimeError(error: PreviewRuntimeError): string {
  const location =
    error.filename && error.lineno
      ? `Location: ${error.filename}:${error.lineno}${error.colno ? `:${error.colno}` : ""}`
      : undefined;

  return [error.message, error.stack, location].filter(Boolean).join("\n");
}

function buildPreviewErrorReporter(runId: string): string {
  return `<script>
(function () {
  var runId = ${JSON.stringify(runId)};
  function send(message, detail) {
    window.parent.postMessage(Object.assign({
      type: ${JSON.stringify(PREVIEW_ERROR_MESSAGE_TYPE)},
      runId: runId,
      message: message || "Generated app crashed"
    }, detail || {}), "*");
  }

  window.addEventListener("error", function (event) {
    send(event.message, {
      stack: event.error && event.error.stack,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    send(reason && reason.message ? reason.message : String(reason || "Unhandled promise rejection"), {
      stack: reason && reason.stack
    });
  });
})();
</script>`;
}

export function withPreviewErrorReporter(
  files: Record<string, string>,
  runId: string
): Record<string, string> {
  const html = files["index.html"];
  if (!html || html.includes(PREVIEW_ERROR_MESSAGE_TYPE)) return files;

  const reporter = buildPreviewErrorReporter(runId);
  const insertionPoint = /<\/head>/i.test(html)
    ? "</head>"
    : /<\/body>/i.test(html)
      ? "</body>"
      : undefined;

  return {
    ...files,
    "index.html": insertionPoint
      ? html.replace(new RegExp(insertionPoint, "i"), `${reporter}\n${insertionPoint}`)
      : `${reporter}\n${html}`
  };
}

export function App() {
  const [idea, setIdea] = React.useState(DEFAULT_IDEA);
  const [isIdeaMultiline, setIsIdeaMultiline] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<PreviewRuntimeError | null>(null);
  const { state, start, repair } = useGeneration();
  const logRef = useRef<HTMLDivElement | null>(null);
  const ideaTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeRunId = "runId" in state ? state.runId : "";

  useEffect(() => {
    if (!isIdeaMultiline) return;
    ideaTextAreaRef.current?.focus();
  }, [isIdeaMultiline]);

  useEffect(() => {
    if (!logRef.current || !("logs" in state)) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state]);

  useEffect(() => {
    setPreviewError(null);
  }, [activeRunId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isPreviewRuntimeError(event.data)) return;
      if (state.kind !== "ready" || event.data.runId !== state.runId) return;
      setPreviewError(event.data);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [state]);

  const downloadHref =
    state.kind === "ready" ? `/api/project/${encodeURIComponent(state.runId)}/download` : undefined;

  const sandpackFiles = useMemo(() => {
    if (state.kind !== "ready") return undefined;
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(withPreviewErrorReporter(state.files, state.runId))) {
      files[`/${k}`] = v;
    }
    return files;
  }, [state]);

  const previewErrorText = previewError ? formatPreviewRuntimeError(previewError) : undefined;

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
            {isIdeaMultiline ? (
              <textarea
                id="idea"
                ref={ideaTextAreaRef}
                className="input inputMultiline"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder='e.g. "make a tetris game"'
                rows={4}
              />
            ) : (
              <input
                id="idea"
                className="input"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                onFocus={() => setIsIdeaMultiline(true)}
                placeholder='e.g. "make a tetris game"'
              />
            )}
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
              <>
                <React.Suspense fallback={<div className="placeholder">Loading editor…</div>}>
                  <LazySandpack
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
                </React.Suspense>
                {previewErrorText && state.kind === "ready" ? (
                  <div className="runtimeError" role="alert">
                    <div className="runtimeErrorTitle">Generated app crashed</div>
                    <pre>{previewErrorText}</pre>
                    <button
                      className="btn runtimeFixButton"
                      onClick={() => void repair(state.runId, previewErrorText)}
                    >
                      Fix with LLM
                    </button>
                  </div>
                ) : null}
              </>
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
