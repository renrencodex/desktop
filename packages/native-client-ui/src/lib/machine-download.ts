import {
  downloadBinaryDirectory,
  downloadBinaryFile,
  type BinaryDownloadSink,
  type BinaryFileDownloadOptions,
  type DirectoryDownloadCompletion,
} from "@cloud-machine/workspace-ui/binary-file-download";
import { hasCapability, type NativeFileWriter } from "@cloud-machine/platform-api";

import { gatewayWebSocketUrl, getClientHost } from "../host";
import { createMachineConnectionTicket } from "./connection-ticket";

type MachineDownloadOptions = Omit<
  BinaryFileDownloadOptions,
  "kind" | "path" | "fileName" | "createSocket"
>;

function nativeDownloadSink(writer: NativeFileWriter): BinaryDownloadSink {
  return {
    get position() {
      return writer.position;
    },
    write: (chunk) => writer.write(chunk),
    async complete() {
      await writer.complete();
      return { blob: new Blob(), size: writer.position, dispose: async () => {} };
    },
    reset: () => writer.reset(),
    discard: () => writer.discard(),
  };
}

async function nativeDownloadOptions(
  fileName: string,
  mimeType: string,
): Promise<{
  writer: NativeFileWriter;
  options: Pick<BinaryFileDownloadOptions, "createSink" | "saveArtifact">;
} | null> {
  const platform = getClientHost().platform;
  if (!hasCapability(platform, "file-save")) return null;
  const writer = await platform.downloads.createFile(fileName, mimeType);
  return {
    writer,
    options: {
      createSink: async () => nativeDownloadSink(writer),
      saveArtifact: false,
    },
  };
}

export async function downloadMachineFile(
  machineId: string,
  path: string,
  fileName: string,
  options: MachineDownloadOptions = {},
): Promise<number> {
  const native = options.createSink
    ? null
    : await nativeDownloadOptions(fileName, "application/octet-stream");
  try {
    return await downloadBinaryFile({
      ...options,
      ...(native?.options ?? {}),
      path,
      fileName,
      createSocket: async (signal) => {
        signal?.throwIfAborted();
        const ticket = await createMachineConnectionTicket(machineId, "download");
        signal?.throwIfAborted();
        return new WebSocket(
          gatewayWebSocketUrl(
            `/machines/${encodeURIComponent(machineId)}/download?ticket=${encodeURIComponent(ticket)}`,
          ),
        );
      },
    });
  } catch (error) {
    if (native) await native.writer.discard().catch(() => {});
    throw error;
  }
}

export async function downloadMachineDirectory(
  machineId: string,
  path: string,
  fileName: string,
  options: MachineDownloadOptions = {},
): Promise<DirectoryDownloadCompletion> {
  const native = options.createSink
    ? null
    : await nativeDownloadOptions(fileName, "application/zip");
  try {
    return await downloadBinaryDirectory({
      ...options,
      ...(native?.options ?? {}),
      path,
      fileName,
      createSocket: async (signal) => {
        signal?.throwIfAborted();
        const ticket = await createMachineConnectionTicket(machineId, "download");
        signal?.throwIfAborted();
        return new WebSocket(
          gatewayWebSocketUrl(
            `/machines/${encodeURIComponent(machineId)}/download?ticket=${encodeURIComponent(ticket)}`,
          ),
        );
      },
    });
  } catch (error) {
    if (native) await native.writer.discard().catch(() => {});
    throw error;
  }
}
