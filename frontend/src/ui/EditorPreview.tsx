import React, { useEffect } from "react";
import {
  SandpackCodeEditor,
  SandpackLayout,
  SandpackPreview,
  SandpackProvider,
  useSandpack
} from "@codesandbox/sandpack-react";

function SandpackErrorWatcher({ onError }: { onError: (message: string) => void }) {
  const { sandpack } = useSandpack();

  useEffect(() => {
    const error = sandpack.error;
    if (!error) return;

    const location =
      error.path && error.line
        ? `Location: ${error.path}:${error.line}${error.column ? `:${error.column}` : ""}`
        : undefined;

    onError([error.title, error.message, location].filter(Boolean).join("\n"));
  }, [sandpack.error, onError]);

  return null;
}

export type EditorPreviewProps = {
  files: Record<string, string>;
  onBundlerError?: (message: string) => void;
};

export function EditorPreview({ files, onBundlerError }: EditorPreviewProps) {
  return (
    <SandpackProvider
      template="vanilla"
      theme="dark"
      files={files}
      options={{
        autorun: true,
        autoReload: true
      }}
    >
      {onBundlerError ? <SandpackErrorWatcher onError={onBundlerError} /> : null}
      <SandpackLayout>
        <SandpackCodeEditor showLineNumbers wrapContent />
        <SandpackPreview showOpenInCodeSandbox={false} showRefreshButton />
      </SandpackLayout>
    </SandpackProvider>
  );
}
