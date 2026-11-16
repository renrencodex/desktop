import { z } from "zod";

export const CLIENT_CMP_METHODS = {
  SYSTEM_INFO: "system.info",
  SYSTEM_METRICS: "system.metrics",
  FS_STAT: "fs.stat",
  FS_RESOLVE: "fs.resolve",
  FS_LIST: "fs.list",
  FS_READ: "fs.read",
  FS_WRITE: "fs.write",
  FS_MKDIR: "fs.mkdir",
  FS_RENAME: "fs.rename",
  FS_REMOVE: "fs.remove",
} as const;

/** Client-visible method names; agent-only methods stay in the private protocol package. */
export const CMP_METHODS = CLIENT_CMP_METHODS;
export type ClientCmpMethod = (typeof CLIENT_CMP_METHODS)[keyof typeof CLIENT_CMP_METHODS];

export const cmpErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});

// --- system.info ---
export const systemInfoResultSchema = z.object({
  hostname: z.string(),
  /** 操作系统标识，如 "linux"。 */
  os: z.string(),
  /** 内核版本，如 "6.8.0-…"。 */
  kernel: z.string(),
  arch: z.string(),
  /** 秒。 */
  uptimeSeconds: z.number().nonnegative(),
  cpuCount: z.number().int().positive(),
  /** 字节。 */
  memoryTotalBytes: z.number().int().nonnegative(),
  agentVersion: z.string(),
});

export type SystemInfoResult = z.infer<typeof systemInfoResultSchema>;

// --- system.metrics ---
export const systemMetricsResultSchema = z.object({
  /** 0..1，采样窗口内的 CPU 使用率。 */
  cpuUsage: z.number().min(0).max(1),
  loadAvg: z.tuple([z.number(), z.number(), z.number()]),
  memoryTotalBytes: z.number().int().nonnegative(),
  memoryUsedBytes: z.number().int().nonnegative(),
  /** 根文件系统容量。 */
  diskTotalBytes: z.number().int().nonnegative(),
  /** 根文件系统已使用容量。 */
  diskUsedBytes: z.number().int().nonnegative(),
  /** IPv4/IPv6 主路由表默认路由网卡集合在采样窗口内的每秒接收字节数。 */
  networkReceiveBytesPerSecond: z.number().int().nonnegative(),
  /** IPv4/IPv6 主路由表默认路由网卡集合在采样窗口内的每秒发送字节数。 */
  networkTransmitBytesPerSecond: z.number().int().nonnegative(),
  /** 秒。 */
  uptimeSeconds: z.number().nonnegative(),
});

export type SystemMetricsResult = z.infer<typeof systemMetricsResultSchema>;

export const TERMINAL_SCROLLBACK_MAX_LINES = 10_000;

export const terminalScrollbackStateSchema = z.object({ inScrollback: z.boolean() });

/** Current agents report enough information to render and seek persistent terminal history. */
export const terminalScrollPositionStateSchema = terminalScrollbackStateSchema.extend({
  offsetLines: z.number().int().min(0).max(TERMINAL_SCROLLBACK_MAX_LINES),
  historyLines: z.number().int().min(0).max(TERMINAL_SCROLLBACK_MAX_LINES),
  viewportRows: z.number().int().min(1).max(1000),
  alternateScreen: z.boolean(),
});

export type TerminalScrollbackState = z.infer<typeof terminalScrollbackStateSchema>;
export type TerminalScrollPositionState = z.infer<typeof terminalScrollPositionStateSchema>;

// ---------------------------------------------------------------------------
// fs namespace（Phase 3 切片 2，设计文档 12.1 fs + 15 文件管理）
// ---------------------------------------------------------------------------
//
// upload 由客户端用 fs.write（首块 truncate，后续块 offset 追加）实现；
// download 自 v18 起由 fs.download 建立控制面，数据通过 CMP WebSocket 二进制帧传输。

/** 单块原始字节上限：2MiB（base64 后 ≈2.8MB，连信封仍低于 gateway 4MB maxPayload）。 */
export const FS_MAX_CHUNK_BYTES = 2 * 1024 * 1024;
/** 路径长度上限（字符）。 */
export const FS_MAX_PATH_LENGTH = 4096;
/** 单块 base64 文本长度上限（对应 FS_MAX_CHUNK_BYTES）。 */
export const FS_MAX_BASE64_LENGTH = Math.ceil(FS_MAX_CHUNK_BYTES / 3) * 4;

/** fs.* 业务错误码（agentd 经 RpcError 透传，gateway/web 据此区分错误类型）。 */
export const FS_ERROR_NOT_FOUND = "FS_NOT_FOUND";
export const FS_ERROR_FORBIDDEN = "FS_FORBIDDEN";
export const FS_ERROR_TOO_LARGE = "FS_TOO_LARGE";
export const FS_ERROR_NOT_DIRECTORY = "FS_NOT_DIRECTORY";
export const FS_ERROR_IS_DIRECTORY = "FS_IS_DIRECTORY";
export const FS_ERROR_ALREADY_EXISTS = "FS_ALREADY_EXISTS";
export const FS_ERROR_INVALID = "FS_INVALID";
export const FS_DOWNLOAD_ERROR_CHANGED = "FILE_DOWNLOAD_CHANGED";
export const FS_DOWNLOAD_ERROR_LIMIT_REACHED = "FILE_DOWNLOAD_LIMIT_REACHED";
export const FS_DOWNLOAD_ERROR_INVALID = "FILE_DOWNLOAD_INVALID";

/** 独立下载流单个 payload 上限；二进制帧不做 base64 编码。 */
export const FS_DOWNLOAD_CHUNK_BYTES = 64 * 1024;
/** 未收到浏览器落盘确认前，agentd 最多可发送的 payload 字节数。 */
export const FS_DOWNLOAD_WINDOW_BYTES = 1024 * 1024;
/** 每台机器同时存在的下载句柄上限（Gateway 与 Agent 双重执行）。 */
export const FS_DOWNLOAD_MAX_CONCURRENT = 8;
/** 每台机器同时只允许一个目录打包任务，避免压缩挤占 VM CPU/IO。 */
export const FS_DIRECTORY_DOWNLOAD_MAX_CONCURRENT = 1;
/** 客户端收帧与 Agent 发送/ACK 共用的滑动无进度期限。 */
export const FS_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/** 单个目录归档最多包含的文件系统条目数。 */
export const FS_ARCHIVE_MAX_ENTRIES = 100_000;
/** 目录归档的最大递归深度。 */
export const FS_ARCHIVE_MAX_DEPTH = 128;
/** 目录打包进度最快发送间隔。 */
export const FS_ARCHIVE_PROGRESS_INTERVAL_MS = 500;
/** RCFD + version + raw UUID。 */
export const FS_DOWNLOAD_BINARY_MAGIC = "RCFD";
export const FS_DOWNLOAD_BINARY_VERSION = 1;
export const FS_DOWNLOAD_BINARY_HEADER_BYTES = 4 + 1 + 16;

export const FS_UPLOAD_ERROR_LIMIT_REACHED = "FILE_UPLOAD_LIMIT_REACHED";
export const FS_UPLOAD_ERROR_INVALID = "FILE_UPLOAD_INVALID";
export const FS_UPLOAD_ERROR_STALLED = "FILE_UPLOAD_STALLED";
export const FS_UPLOAD_ERROR_CANCELLED = "FILE_UPLOAD_CANCELLED";
/** 浏览器和 Gateway/Agent 间除末块外均使用 64 KiB payload，避免小帧放大或大帧阻塞。 */
export const FS_UPLOAD_CHUNK_BYTES = 64 * 1024;
/** 单文件最多 4 MiB 已发送但尚未由 Agent 确认写入的数据。 */
export const FS_UPLOAD_WINDOW_BYTES = 4 * 1024 * 1024;
/** 单个浏览器批量上传通道最多同时传输三个文件。 */
export const FS_UPLOAD_CLIENT_MAX_CONCURRENT = 3;
/** 每台机器同时存在的上传句柄上限（Gateway 与 Agent 双重执行）。 */
export const FS_UPLOAD_MAX_CONCURRENT = 8;
/** 握手、数据、暂存或提交阶段连续无进度的滑动期限。 */
export const FS_UPLOAD_IDLE_TIMEOUT_MS = 60_000;
export const FS_UPLOAD_BINARY_MAGIC = "RCFU";
export const FS_UPLOAD_BINARY_VERSION = 1;
/** RCFU + version + raw UUID。 */
export const FS_UPLOAD_BINARY_HEADER_BYTES = 4 + 1 + 16;
export const FILE_UPLOAD_PROTOCOL_VERSION = 1;

/** 每台电脑同时存在的活动文件监听上限（Gateway 与 Agent 双重执行）。 */
export const FS_WATCH_MAX_CONCURRENT = 16;
/** 连续文件系统事件的静默合并窗口。 */
export const FS_WATCH_DEBOUNCE_MS = 100;
/** 持续写入时也必须在该期限内发出一次失效通知。 */
export const FS_WATCH_MAX_DELAY_MS = 500;

const fsPathSchema = z.string().min(1).max(FS_MAX_PATH_LENGTH);

export const fsEntryTypeSchema = z.enum(["file", "directory", "symlink", "other"]);
export type FsEntryType = z.infer<typeof fsEntryTypeSchema>;

// --- fs.stat ---
export const fsStatParamsSchema = z.object({ path: fsPathSchema });

export const fsStatResultSchema = z.object({
  exists: z.boolean(),
  /** exists=false 时以下字段缺省。 */
  type: fsEntryTypeSchema.optional(),
  /** 字节。 */
  size: z.number().int().nonnegative().optional(),
  /** epoch ms。 */
  mtime: z.number().int().nonnegative().optional(),
  /** unix mode（权限位，如 0o644 → 420）。 */
  mode: z.number().int().nonnegative().optional(),
});

// --- fs.resolve ---
// 只读解析：API 用它登记开发目录；canonicalPath 永远已通过 agentd 沙箱校验。
export const fsResolveParamsSchema = z.object({ path: fsPathSchema });

export const fsResolveResultSchema = z.object({
  canonicalPath: fsPathSchema,
  exists: z.boolean(),
  type: fsEntryTypeSchema.optional(),
});

// --- fs.list ---
export const fsListParamsSchema = z.object({ path: fsPathSchema });

export const fsEntrySchema = z.object({
  name: z.string().min(1),
  type: fsEntryTypeSchema,
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});

export const fsListResultSchema = z.object({
  entries: z.array(fsEntrySchema).max(100_000),
});

// --- fs.read ---
export const fsReadParamsSchema = z.object({
  path: fsPathSchema,
  offset: z.number().int().nonnegative().optional(),
  /** 缺省读到块上限；agentd 侧再按 FS_MAX_CHUNK_BYTES 钳制。 */
  length: z.number().int().positive().max(FS_MAX_CHUNK_BYTES).optional(),
});

export const fsReadResultSchema = z.object({
  data: z.string().base64().max(FS_MAX_BASE64_LENGTH),
  totalSize: z.number().int().nonnegative(),
  /** offset+本块字节数 已到达 totalSize。 */
  eof: z.boolean(),
});

// --- fs.watch（事件驱动的单文件失效通知） ---
const fsWatchIdSchema = z.uuid();
const fsWatchSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const fsWatchPathSchema = fsPathSchema.startsWith("/").refine((value) => !/[\0\r\n]/.test(value));

export const fsWatchOpenParamsSchema = z
  .object({
    watchId: fsWatchIdSchema,
    path: fsWatchPathSchema,
  })
  .strict();

export const fsWatchOpenResultSchema = z.object({ watchId: fsWatchIdSchema }).strict();
export const fsWatchIdEventDataSchema = z.object({ watchId: fsWatchIdSchema }).strict();
export const fsWatchChangedEventDataSchema = z
  .object({
    watchId: fsWatchIdSchema,
    sequence: fsWatchSequenceSchema,
    /** inotify 队列溢出、CMP 背压或序号不连续时要求客户端无条件重新同步。 */
    resync: z.boolean(),
  })
  .strict();

/** 浏览器 → Gateway：每条鉴权通道只允许声明一个目标文件。 */
export const fileWatchClientMessageSchema = z
  .object({
    type: z.literal("watch"),
    path: fsWatchPathSchema,
  })
  .strict();

/** Gateway → 浏览器：事件只表示缓存失效，文件内容仍经普通 fs.* RPC 读取。 */
export const fileWatchServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z
    .object({
      type: z.literal("changed"),
      sequence: fsWatchSequenceSchema,
      resync: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("error"), code: z.string().min(1), message: z.string() }).strict(),
]);

// --- fs.download（二进制数据面） ---
const fsDownloadIdSchema = z.uuid();
const fsDownloadPositionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fsDownloadIdentitySchema = z.string().regex(/^[0-9a-f]{64}$/);

function requireCompleteDownloadIdentity(
  params: {
    offset?: number;
    expectedSize?: number;
    expectedMtime?: number;
    expectedIdentity?: string;
  },
  ctx: z.RefinementCtx,
): void {
  const supplied = [params.expectedSize, params.expectedMtime, params.expectedIdentity].filter(
    (value) => value !== undefined,
  ).length;
  if (supplied !== 0 && supplied !== 3) {
    ctx.addIssue({
      code: "custom",
      message: "expectedSize, expectedMtime and expectedIdentity must be supplied together",
    });
    return;
  }
  if ((params.offset ?? 0) > 0 && supplied !== 3) {
    ctx.addIssue({
      code: "custom",
      message: "non-zero offset requires expectedSize, expectedMtime and expectedIdentity",
    });
  }
}

const fsFileDownloadOpenParamsSchema = z
  .object({
    downloadId: fsDownloadIdSchema,
    kind: z.literal("file").optional(),
    path: fsPathSchema,
    offset: fsDownloadPositionSchema.optional(),
    expectedSize: fsDownloadPositionSchema.optional(),
    expectedMtime: fsDownloadPositionSchema.optional(),
    expectedIdentity: fsDownloadIdentitySchema.optional(),
  })
  .superRefine(requireCompleteDownloadIdentity);

const fsDirectoryDownloadOpenParamsSchema = z
  .object({
    downloadId: fsDownloadIdSchema,
    kind: z.literal("directory"),
    archiveFormat: z.literal("zip"),
    path: fsPathSchema,
  })
  .strict();

export const fsDownloadOpenParamsSchema = z.union([
  fsDirectoryDownloadOpenParamsSchema,
  fsFileDownloadOpenParamsSchema,
]);

export const fsDownloadOpenResultSchema = z.union([
  z.object({
    downloadId: fsDownloadIdSchema,
    kind: z.literal("file").optional(),
    size: fsDownloadPositionSchema,
    mtime: fsDownloadPositionSchema,
    identity: fsDownloadIdentitySchema,
    offset: fsDownloadPositionSchema,
  }),
  z
    .object({
      downloadId: fsDownloadIdSchema,
      kind: z.literal("directory"),
      archiveFormat: z.literal("zip"),
    })
    .strict(),
]);

export const fsDownloadStartEventDataSchema = z.object({ downloadId: fsDownloadIdSchema });
export const fsDownloadAckEventDataSchema = z.object({
  downloadId: fsDownloadIdSchema,
  bytes: z.number().int().positive().max(FS_DOWNLOAD_WINDOW_BYTES),
});
export const fsDownloadCancelEventDataSchema = z.object({ downloadId: fsDownloadIdSchema });
export const fsDownloadProgressEventDataSchema = z
  .object({
    downloadId: fsDownloadIdSchema,
    processedEntries: fsDownloadPositionSchema,
    sourceBytes: fsDownloadPositionSchema,
    skippedEntries: fsDownloadPositionSchema,
  })
  .strict();
export const fsDownloadCloseEventDataSchema = z.union([
  z
    .object({
      downloadId: fsDownloadIdSchema,
      ok: z.literal(true),
      kind: z.literal("file"),
      /** 完整文件大小；断线续传时不是本轮剩余 payload 大小。 */
      size: fsDownloadPositionSchema,
    })
    .strict(),
  z
    .object({
      downloadId: fsDownloadIdSchema,
      ok: z.literal(true),
      kind: z.literal("directory"),
      /** 本次流式生成的完整 ZIP 大小。 */
      size: fsDownloadPositionSchema,
      processedEntries: fsDownloadPositionSchema,
      sourceBytes: fsDownloadPositionSchema,
      skippedEntries: fsDownloadPositionSchema,
    })
    .strict(),
  z.object({
    downloadId: fsDownloadIdSchema,
    ok: z.literal(false),
    error: cmpErrorSchema,
  }),
]);

/** 浏览器 ↔ Gateway 的文件/目录下载控制消息；内容只允许走二进制帧。 */
export const fileDownloadClientMessageSchema = z.union([
  z
    .object({
      type: z.literal("open"),
      kind: z.literal("file").optional(),
      path: fsPathSchema,
      offset: fsDownloadPositionSchema.optional(),
      expectedSize: fsDownloadPositionSchema.optional(),
      expectedMtime: fsDownloadPositionSchema.optional(),
      expectedIdentity: fsDownloadIdentitySchema.optional(),
    })
    .superRefine(requireCompleteDownloadIdentity),
  z
    .object({
      type: z.literal("open"),
      kind: z.literal("directory"),
      archiveFormat: z.literal("zip"),
      path: fsPathSchema,
    })
    .strict(),
  z.object({ type: z.literal("start") }).strict(),
  z
    .object({
      type: z.literal("ack"),
      bytes: z.number().int().positive().max(FS_DOWNLOAD_WINDOW_BYTES),
    })
    .strict(),
  z.object({ type: z.literal("cancel") }).strict(),
]);

export const fileDownloadServerMessageSchema = z.union([
  z.object({
    type: z.literal("ready"),
    kind: z.literal("file").optional(),
    size: fsDownloadPositionSchema,
    mtime: fsDownloadPositionSchema,
    identity: fsDownloadIdentitySchema,
    offset: fsDownloadPositionSchema,
  }),
  z
    .object({
      type: z.literal("ready"),
      kind: z.literal("directory"),
      archiveFormat: z.literal("zip"),
      offset: z.literal(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      processedEntries: fsDownloadPositionSchema,
      sourceBytes: fsDownloadPositionSchema,
      skippedEntries: fsDownloadPositionSchema,
    })
    .strict(),
  z.object({
    type: z.literal("complete"),
    kind: z.enum(["file", "directory"]).optional(),
    size: fsDownloadPositionSchema.optional(),
    processedEntries: fsDownloadPositionSchema.optional(),
    sourceBytes: fsDownloadPositionSchema.optional(),
    skippedEntries: fsDownloadPositionSchema.optional(),
  }),
  z.object({ type: z.literal("error"), code: z.string().min(1), message: z.string() }),
]);

// --- fs.upload（二进制数据面） ---
const fsUploadIdSchema = z.uuid();
const fsUploadPositionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const fsUploadOpenParamsSchema = z.object({
  uploadId: fsUploadIdSchema,
  path: fsPathSchema,
  size: fsUploadPositionSchema,
});

export const fsUploadOpenResultSchema = z.object({
  uploadId: fsUploadIdSchema,
  size: fsUploadPositionSchema,
});

export const fsUploadIdEventDataSchema = z.object({ uploadId: fsUploadIdSchema });
export const fsUploadAckEventDataSchema = z.object({
  uploadId: fsUploadIdSchema,
  bytes: z.number().int().positive().max(FS_UPLOAD_WINDOW_BYTES),
});
export const fsUploadCloseEventDataSchema = z.discriminatedUnion("ok", [
  z.object({ uploadId: fsUploadIdSchema, ok: z.literal(true) }),
  z.object({ uploadId: fsUploadIdSchema, ok: z.literal(false), error: cmpErrorSchema }),
]);

const fileUploadTransferIdSchema = z.uuid();
const fileUploadTransferControlSchema = z.object({ transferId: fileUploadTransferIdSchema });

/** 浏览器 → Gateway 的批量上传控制消息；文件内容只允许走带 transferId 的二进制帧。 */
export const fileUploadClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("open"),
    transferId: fileUploadTransferIdSchema,
    path: fsPathSchema,
    size: fsUploadPositionSchema,
  }),
  fileUploadTransferControlSchema.extend({ type: z.literal("finish") }),
  fileUploadTransferControlSchema.extend({ type: z.literal("commit") }),
  fileUploadTransferControlSchema.extend({ type: z.literal("cancel") }),
]);

/** Gateway → 浏览器的批量上传控制消息。 */
export const fileUploadServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(FILE_UPLOAD_PROTOCOL_VERSION),
    chunkBytes: z.literal(FS_UPLOAD_CHUNK_BYTES),
    windowBytes: z.literal(FS_UPLOAD_WINDOW_BYTES),
    maxConcurrent: z.literal(FS_UPLOAD_CLIENT_MAX_CONCURRENT),
  }),
  fileUploadTransferControlSchema.extend({ type: z.literal("ready") }),
  fileUploadTransferControlSchema.extend({
    type: z.literal("ack"),
    bytes: z.number().int().positive().max(FS_UPLOAD_WINDOW_BYTES),
  }),
  fileUploadTransferControlSchema.extend({ type: z.literal("staged") }),
  fileUploadTransferControlSchema.extend({ type: z.literal("complete") }),
  fileUploadTransferControlSchema.extend({
    type: z.literal("fileError"),
    code: z.string().min(1),
    message: z.string(),
  }),
  z.object({ type: z.literal("error"), code: z.string().min(1), message: z.string() }),
]);

// --- fs.write ---
export const fsWriteParamsSchema = z
  .object({
    path: fsPathSchema,
    /** base64 编码的块数据。 */
    data: z.string().base64().max(FS_MAX_BASE64_LENGTH),
    /** 指定则按偏移定位写（分块上传追加）；与 truncate 互斥。 */
    offset: z.number().int().nonnegative().optional(),
    /** 缺省 true（offset 缺省时）：原子覆盖（临时文件 + rename）。 */
    truncate: z.boolean().optional(),
  })
  .superRefine((params, ctx) => {
    // offset 非 0 的定位写与 truncate 整文件覆盖语义冲突：同时传会被静默按
    // 覆盖处理（agentd 侧 truncate 分支优先），有数据丢失风险，schema 级拒绝。
    if (params.offset !== undefined && params.offset > 0 && params.truncate === true) {
      ctx.addIssue({ code: "custom", message: "offset and truncate are mutually exclusive" });
    }
  });

export const fsWriteResultSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
});

// --- fs.mkdir ---
export const fsMkdirParamsSchema = z.object({
  path: fsPathSchema,
  recursive: z.boolean().optional(),
});

// --- fs.rename ---
export const fsRenameParamsSchema = z.object({
  from: fsPathSchema,
  to: fsPathSchema,
  /** 缺省 false：目标已存在时拒绝，只有用户显式确认后才允许覆盖。 */
  overwrite: z.boolean().optional(),
});

// --- fs.remove ---
export const fsRemoveParamsSchema = z.object({
  path: fsPathSchema,
  /** true 才允许删除非空目录。 */
  recursive: z.boolean().optional(),
});

export type FsStatParams = z.infer<typeof fsStatParamsSchema>;
export type FsStatResult = z.infer<typeof fsStatResultSchema>;
export type FsResolveParams = z.infer<typeof fsResolveParamsSchema>;
export type FsResolveResult = z.infer<typeof fsResolveResultSchema>;
export type FsListParams = z.infer<typeof fsListParamsSchema>;
export type FsEntry = z.infer<typeof fsEntrySchema>;
export type FsListResult = z.infer<typeof fsListResultSchema>;
export type FsReadParams = z.infer<typeof fsReadParamsSchema>;
export type FsReadResult = z.infer<typeof fsReadResultSchema>;
export type FsWatchOpenParams = z.infer<typeof fsWatchOpenParamsSchema>;
export type FsWatchOpenResult = z.infer<typeof fsWatchOpenResultSchema>;
export type FsWatchChangedEventData = z.infer<typeof fsWatchChangedEventDataSchema>;
export type FileWatchClientMessage = z.infer<typeof fileWatchClientMessageSchema>;
export type FileWatchServerMessage = z.infer<typeof fileWatchServerMessageSchema>;
export type FsDownloadOpenParams = z.infer<typeof fsDownloadOpenParamsSchema>;
export type FsDownloadOpenResult = z.infer<typeof fsDownloadOpenResultSchema>;
export type FsDownloadAckEventData = z.infer<typeof fsDownloadAckEventDataSchema>;
export type FsDownloadCloseEventData = z.infer<typeof fsDownloadCloseEventDataSchema>;
export type FileDownloadClientMessage = z.infer<typeof fileDownloadClientMessageSchema>;
export type FileDownloadServerMessage = z.infer<typeof fileDownloadServerMessageSchema>;
export type FsUploadOpenParams = z.infer<typeof fsUploadOpenParamsSchema>;
export type FsUploadOpenResult = z.infer<typeof fsUploadOpenResultSchema>;
export type FsUploadAckEventData = z.infer<typeof fsUploadAckEventDataSchema>;
export type FsUploadCloseEventData = z.infer<typeof fsUploadCloseEventDataSchema>;
export type FileUploadClientMessage = z.infer<typeof fileUploadClientMessageSchema>;
export type FileUploadServerMessage = z.infer<typeof fileUploadServerMessageSchema>;
export type FsWriteParams = z.infer<typeof fsWriteParamsSchema>;
export type FsWriteResult = z.infer<typeof fsWriteResultSchema>;
export type FsMkdirParams = z.infer<typeof fsMkdirParamsSchema>;
export type FsRenameParams = z.infer<typeof fsRenameParamsSchema>;
export type FsRemoveParams = z.infer<typeof fsRemoveParamsSchema>;

// ---------------------------------------------------------------------------
