import { createRoot } from "react-dom/client";
import {
  FilePreview,
  type FilePreviewProps,
} from "@cloud-machine/native-client-ui/components/FilePreview";
import { ClientUiProvider, type ClientHostConfig } from "@cloud-machine/native-client-ui/host";

export interface FilePreviewFixture {
  set(changes: Partial<FilePreviewProps>): void;
  reopen(): void;
}
declare global {
  interface Window {
    filePreviewFixture: FilePreviewFixture;
  }
}

const host = { platform: { openExternal: async () => {} } } as unknown as ClientHostConfig;
let generation = 0;
let props: FilePreviewProps = {
  previewScopeKey: "machine/workspace/explorer",
  path: "/workspace/readme.md",
  rootPath: "/workspace",
  format: { kind: "markdown", mime: "text/markdown" },
  text: "# Preview",
  active: true,
  readResource: async () => new Uint8Array([1]),
  onOpenFile: () => {},
};
const root = createRoot(document.getElementById("root")!);
function render() {
  root.render(
    <ClientUiProvider host={host}>
      <div className="h-full" data-preview-active={props.active} hidden={!props.active}>
        <FilePreview key={generation} {...props} />
      </div>
    </ClientUiProvider>,
  );
}
window.filePreviewFixture = {
  set(changes) {
    props = { ...props, ...changes };
    render();
  },
  reopen() {
    generation++;
    render();
  },
};
render();
