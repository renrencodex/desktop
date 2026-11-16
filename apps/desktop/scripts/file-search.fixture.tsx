import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileSearchOptions } from "@cloud-machine/client-contracts";
import { FileSearchPanel, type FileSearchState } from "@cloud-machine/workspace-ui/file-search";

const submissions: FileSearchOptions[] = [];
window.fileSearchFixture = { submissions, backCount: 0 };
declare global {
  interface Window {
    fileSearchFixture: { submissions: FileSearchOptions[]; backCount: number };
  }
}

function Fixture() {
  const [state, setState] = useState<FileSearchState>({
    view: "search",
    draft: { query: "", mode: "content", caseSensitive: false, includeIgnored: false },
    submitted: null,
    items: [],
    rootPath: "/workspace",
    running: false,
    summary: null,
    error: null,
    stopped: false,
  });
  return (
    <main
      data-testid="search-host"
      style={{ width: "min(280px, 100vw)", height: 420, background: "var(--cm-surface-panel)" }}
    >
      <FileSearchPanel
        state={state}
        disabled={false}
        visible
        onDraft={(patch) =>
          setState((current) => ({ ...current, draft: { ...current.draft, ...patch } }))
        }
        onSubmit={() => {
          submissions.push({ ...state.draft });
          setState((current) => ({ ...current, running: true, submitted: current.draft }));
        }}
        onCancel={() => setState((current) => ({ ...current, running: false, stopped: true }))}
        onBack={() => {
          window.fileSearchFixture.backCount += 1;
        }}
        onOpen={() => {}}
        onReveal={() => {}}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
