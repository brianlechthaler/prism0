import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch, readApiError } from "../api";
import {
  emptyRunStreams,
  extractValidationErrorFromLogs,
  isYoloRun,
  useGeneration,
  useModelOptions
} from "../hooks/useGeneration";
import { ProgressPanel } from "./ProgressPanel";

const DEFAULT_IDEA = "make a tiny tetris-like game";
export const PREVIEW_ERROR_MESSAGE_TYPE = "prism0-preview-error";
const LazyEditorPreview = React.lazy(async () => {
  const { EditorPreview } = await import("./EditorPreview");
  return { default: EditorPreview };
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

type ReadySubmissionMode = "follow-up" | "new";

export function shouldSubmitIdeaOnKeyDown(event: {
  key: string;
  code: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  if (event.isComposing) return false;
  if (event.key !== "Enter" && event.code !== "Enter") return false;
  return event.shiftKey;
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

type GeneratorAppProps = {
  projectId?: string;
};

export function GeneratorApp({ projectId }: GeneratorAppProps) {
  const [idea, setIdea] = React.useState(DEFAULT_IDEA);
  const [isIdeaMultiline, setIsIdeaMultiline] = React.useState(false);
  const [readySubmissionMode, setReadySubmissionMode] =
    React.useState<ReadySubmissionMode>("follow-up");
  const [yoloMode, setYoloMode] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<PreviewRuntimeError | null>(null);
  const [bundlerError, setBundlerError] = React.useState<string | undefined>();
  const [publishName, setPublishName] = useState("");
  const [publishMessage, setPublishMessage] = useState<string | undefined>();
  const [isPublishing, setIsPublishing] = useState(false);
  const { state, start, repair, repairValidation, followUp } = useGeneration();
  const modelOptions = useModelOptions();
  const [selectedModel, setSelectedModel] = React.useState("");
  const ideaTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeRunId = "runId" in state ? state.runId : "";
  const usage = "usage" in state ? state.usage : undefined;
  const canFollowUp = state.kind === "ready";
  const isGenerating = state.kind === "generating";
  const trimmedIdea = idea.trim();
  const activeModel = modelOptions.enabled
    ? selectedModel || modelOptions.defaultModel || modelOptions.models[0] || ""
    : undefined;
  const hasMultipleModels = modelOptions.models.length > 1;

  useEffect(() => {
    if (!isIdeaMultiline) return;
    ideaTextAreaRef.current?.focus();
  }, [isIdeaMultiline]);

  useEffect(() => {
    setPreviewError(null);
    setBundlerError(undefined);
  }, [activeRunId]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    setIdea("");
    setReadySubmissionMode("follow-up");
  }, [state.kind, state.kind === "ready" ? state.runId : ""]);

  useEffect(() => {
    if (!modelOptions.enabled || !selectedModel || modelOptions.models.includes(selectedModel)) return;
    setSelectedModel(modelOptions.defaultModel || modelOptions.models[0] || "");
  }, [modelOptions.defaultModel, modelOptions.enabled, modelOptions.models, selectedModel]);

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

  const editorFiles = useMemo(() => {
    if (state.kind !== "ready" && !(state.kind === "error" && state.files)) {
      return undefined;
    }

    const runId = state.runId;
    const sourceFiles = state.files;
    if (!runId || !sourceFiles) return undefined;

    const files: Record<string, string> = {};
    for (const [key, value] of Object.entries(withPreviewErrorReporter(sourceFiles, runId))) {
      files[`/${key}`] = value;
    }
    return files;
  }, [state]);

  const previewErrorText = previewError ? formatPreviewRuntimeError(previewError) : undefined;
  const repairErrorText = previewErrorText ?? bundlerError;
  const validationRepairError =
    state.kind === "error" && state.repairable && state.runId && state.files
      ? extractValidationErrorFromLogs(state.logs, state.message)
      : undefined;
  const yoloRunActive = state.kind === "ready" && isYoloRun(state.logs);
  const generationOptions = yoloMode ? { yolo: true as const } : undefined;
  const handleBundlerError = useCallback((message: string) => {
    setBundlerError(message);
  }, []);
  const promptLabel =
    canFollowUp && readySubmissionMode === "follow-up"
      ? "What should we add or change?"
      : "What should we build?";
  const submitLabel = isGenerating
    ? "Generating…"
    : canFollowUp && readySubmissionMode === "follow-up"
      ? "Update app"
      : "Submit";

  const submitPrompt = () => {
    if (isGenerating || !trimmedIdea) return;

    if (state.kind === "ready" && readySubmissionMode === "follow-up") {
      void followUp(
        state.runId,
        trimmedIdea,
        activeModel,
        projectId ? { ...generationOptions, projectId } : generationOptions
      );
      return;
    }

    void start(
      trimmedIdea,
      activeModel,
      projectId ? { ...generationOptions, projectId } : generationOptions
    );
  };

  const publishProject = async () => {
    /* v8 ignore start */
    if (state.kind !== "ready" || !publishName.trim()) {
      return;
    }
    /* v8 ignore stop */
    setIsPublishing(true);
    setPublishMessage(undefined);
    try {
      const res = await apiFetch("/api/projects", {
        method: "POST",
        json: { runId: state.runId, name: publishName.trim() }
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const json = (await res.json()) as { project: { publicUrl: string; manageUrl: string } };
      setPublishMessage(`Published at ${json.project.publicUrl}`);
    } catch (error) {
      setPublishMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPublishing(false);
    }
  };

  const saveProjectVersion = async () => {
    /* v8 ignore start */
    if (state.kind !== "ready" || !projectId) {
      return;
    }
    /* v8 ignore stop */
    setIsPublishing(true);
    setPublishMessage(undefined);
    try {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/versions`, {
        method: "POST",
        json: { runId: state.runId }
      });
      if (!res.ok) throw new Error(await readApiError(res));
      setPublishMessage("Saved a new hosted version.");
    } catch (error) {
      setPublishMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPublishing(false);
    }
  };

  const expandIdeaField = () => {
    setIsIdeaMultiline(true);
  };

  const handleIdeaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitIdeaOnKeyDown(event.nativeEvent)) return;

    event.preventDefault();
    event.stopPropagation();
    submitPrompt();
  };

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
        <nav className="headerNav">
          <Link className="pillLink" to="/dashboard">
            Dashboard
          </Link>
        </nav>
      </header>

      <main className="main">
        <section className="card">
          <label className="label" htmlFor="idea">
            {promptLabel}
          </label>
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              submitPrompt();
            }}
          >
            <textarea
              id="idea"
              ref={ideaTextAreaRef}
              className={`input ${isIdeaMultiline ? "inputMultiline" : "inputCompact"}`}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onFocus={expandIdeaField}
              onKeyDown={handleIdeaKeyDown}
              placeholder={
                canFollowUp && readySubmissionMode === "follow-up"
                  ? 'e.g. "add keyboard controls and a score history"'
                  : 'e.g. "make a tetris game"'
              }
              rows={isIdeaMultiline ? 4 : 1}
            />
            <button type="submit" className="btn" disabled={isGenerating || !trimmedIdea}>
              {submitLabel}
            </button>
          </form>

          {modelOptions.enabled ? (
            <div className="modelRow">
              <label className="modelPicker" htmlFor="model">
                <span>Model</span>
                <select
                  id="model"
                  value={activeModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={isGenerating || modelOptions.models.length === 0}
                >
                  {modelOptions.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
              <div className="modelHint">
                {modelOptions.isLoading
                  ? "Loading configured models…"
                  : modelOptions.error
                    ? `Could not load models: ${modelOptions.error}`
                    : hasMultipleModels
                      ? "If the selected model fails, the backend will try the other configured models."
                      : "Only one backend model is configured."}
              </div>
            </div>
          ) : null}

          {modelOptions.yoloModeEnabled ? (
            <div className="yoloRow">
              <label className="yoloToggle">
                <input
                  type="checkbox"
                  checked={yoloMode}
                  onChange={(e) => setYoloMode(e.target.checked)}
                  disabled={isGenerating}
                />
                <span>YOLO mode — skip lint/tests</span>
              </label>
              <div className="yoloWarning" role="note">
                Faster generation without the backend validation harness. Code may be unsafe, broken,
                or fail in the preview. Use only when you accept unverified output.
              </div>
            </div>
          ) : null}

          {canFollowUp ? (
            <fieldset className="promptMode" aria-label="Prompt behavior">
              <legend>Use this prompt to:</legend>
              <label>
                <input
                  type="radio"
                  name="prompt-mode"
                  checked={readySubmissionMode === "follow-up"}
                  onChange={() => setReadySubmissionMode("follow-up")}
                />
                Update the current app
              </label>
              <label>
                <input
                  type="radio"
                  name="prompt-mode"
                  checked={readySubmissionMode === "new"}
                  onChange={() => setReadySubmissionMode("new")}
                />
                Start a new app instead
              </label>
            </fieldset>
          ) : null}

          <div className="metaRow">
            <div className="pill">{state.kind === "idle" ? "idle" : state.kind}</div>
            {downloadHref ? (
              <a className="pillLink" href={downloadHref}>
                download zip
              </a>
            ) : null}
          </div>

          {state.kind === "ready" ? (
            <div className="publishRow">
              {projectId ? (
                <button
                  type="button"
                  className="btn"
                  disabled={isPublishing}
                  onClick={() => void saveProjectVersion()}
                >
                  {isPublishing ? "Saving…" : "Save hosted version"}
                </button>
              ) : (
                <>
                  <input
                    className="input inputCompact"
                    value={publishName}
                    onChange={(event) => setPublishName(event.target.value)}
                    placeholder="Project name for hosting"
                    aria-label="Hosted project name"
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={isPublishing || !publishName.trim()}
                    onClick={() => void publishProject()}
                  >
                    {isPublishing ? "Publishing…" : "Publish hosted URL"}
                  </button>
                </>
              )}
              {publishMessage ? <div className="publishMessage">{publishMessage}</div> : null}
            </div>
          ) : null}
        </section>

        <section className="grid">
          <div className="panel">
            <div className="panelTitle">Verbose progress</div>
            {"logs" in state ? (
              <ProgressPanel logs={state.logs} streams={state.streams} usage={usage} />
            ) : (
              <ProgressPanel
                logs={[]}
                streams={emptyRunStreams()}
                placeholder="Enter an idea and hit Submit."
              />
            )}
            {state.kind === "error" ? <div className="error">Error: {state.message}</div> : null}
            {validationRepairError && state.kind === "error" && state.runId ? (
              <div className="runtimeError" role="alert">
                <div className="runtimeErrorTitle">Generated code failed validation</div>
                <pre>{validationRepairError}</pre>
                <button
                  className="btn runtimeFixButton"
                  onClick={() =>
                    void repairValidation(state.runId!, validationRepairError, activeModel)
                  }
                >
                  Fix with LLM
                </button>
              </div>
            ) : null}
          </div>

          <div className="panel panelEditor">
            <div className="panelTitle">Editor + Preview</div>
            {editorFiles ? (
              <>
                {yoloRunActive ? (
                  <div className="yoloBanner" role="alert">
                    <div className="yoloBannerTitle">Generated without validation (YOLO mode)</div>
                    <p>
                      ESLint and Vitest were not run. The preview may crash, tests may be missing,
                      and the code may not work as expected.
                    </p>
                  </div>
                ) : null}
                <React.Suspense fallback={<div className="placeholder">Loading editor…</div>}>
                  <LazyEditorPreview files={editorFiles} onBundlerError={handleBundlerError} />
                </React.Suspense>
                {repairErrorText && state.kind === "ready" ? (
                  <div className="runtimeError" role="alert">
                    <div className="runtimeErrorTitle">Generated app has an error</div>
                    <pre>{repairErrorText}</pre>
                    <button
                      className="btn runtimeFixButton"
                      onClick={() => void repair(state.runId, repairErrorText, activeModel)}
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
