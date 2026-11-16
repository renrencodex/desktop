import { z } from "zod";
import { FS_MAX_PATH_LENGTH, cmpErrorSchema } from "./cmp";

/** Whole editable/searchable UTF-8 file, independent of the 2 MiB RPC chunk limit. */
export const FS_TEXT_MAX_BYTES = 5 * 1024 * 1024;
export const FS_SEARCH_MAX_MATCHES = 1_000;
export const FS_SEARCH_MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const FS_SEARCH_MAX_BATCH_BYTES = 64 * 1024;
export const FS_SEARCH_MAX_BATCH_ITEMS = 50;
export const FS_SEARCH_MAX_CONCURRENT = 2;
export const FS_SEARCH_TIMEOUT_MS = 30_000;
export const FS_SEARCH_MAX_ENTRIES = 100_000;
export const FS_SEARCH_MAX_DEPTH = 128;
export const FS_SEARCH_QUERY_MAX_LENGTH = 512;

const absolutePath = z
  .string()
  .min(1)
  .max(FS_MAX_PATH_LENGTH)
  .startsWith("/")
  .refine((value) => !value.includes("\0"));
const relativePath = z
  .string()
  .min(1)
  .max(FS_MAX_PATH_LENGTH)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
export const fileSearchOptionsSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(FS_SEARCH_QUERY_MAX_LENGTH)
      .refine((value) => value.trim().length > 0 && !/[\r\n\0]/.test(value)),
    mode: z.enum(["name", "content"]),
    caseSensitive: z.boolean(),
    includeIgnored: z.boolean(),
  })
  .strict();
export type FileSearchOptions = z.infer<typeof fileSearchOptionsSchema>;

export const fsSearchOpenParamsSchema = fileSearchOptionsSchema.extend({
  searchId: z.string().uuid(),
  rootPath: absolutePath,
});
export const fsSearchIdSchema = z.object({ searchId: z.string().uuid() }).strict();
export const fsSearchOpenResultSchema = fsSearchIdSchema;

const fileMatch = z.object({ kind: z.literal("file"), path: relativePath }).strict();
const contentMatch = z
  .object({
    kind: z.literal("content"),
    path: relativePath,
    /** One-based UTF-16 columns after stripping a leading UTF-8 BOM; endColumn is exclusive. */
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    endColumn: z.number().int().positive(),
    previewColumn: z.number().int().positive(),
    preview: z.string().max(2048),
  })
  .strict()
  .refine(
    (value) =>
      value.endColumn > value.column &&
      value.previewColumn <= value.column &&
      value.endColumn - value.previewColumn <= value.preview.length,
  );
export const fileSearchMatchSchema = z.discriminatedUnion("kind", [fileMatch, contentMatch]);
export type FileSearchMatch = z.infer<typeof fileSearchMatchSchema>;
export type FileSearchContentMatch = Extract<FileSearchMatch, { kind: "content" }>;
export const fsSearchBatchSchema = z
  .object({
    searchId: z.string().uuid(),
    rootPath: absolutePath,
    items: z.array(fileSearchMatchSchema).max(FS_SEARCH_MAX_BATCH_ITEMS),
  })
  .strict();
export const fileSearchSummarySchema = z
  .object({
    reason: z.enum(["complete", "cancelled", "limit", "timeout", "error"]),
    limit: z.enum(["matches", "bytes", "entries", "depth"]).optional(),
    scannedFiles: z.number().int().nonnegative(),
    matchedFiles: z.number().int().nonnegative(),
    matchCount: z.number().int().nonnegative().max(FS_SEARCH_MAX_MATCHES),
    skippedBinary: z.number().int().nonnegative(),
    skippedLarge: z.number().int().nonnegative(),
    skippedUnreadable: z.number().int().nonnegative(),
    skippedChanged: z.number().int().nonnegative(),
    error: cmpErrorSchema.optional(),
  })
  .strict();
export type FileSearchSummary = z.infer<typeof fileSearchSummarySchema>;
export const fsSearchDoneSchema = fileSearchSummarySchema.extend({
  searchId: z.string().uuid(),
});
export const fileSearchClientMessageSchema = z.discriminatedUnion("type", [
  fileSearchOptionsSchema.extend({
    type: z.literal("search"),
    workspaceId: z.string().min(1).max(128),
  }),
  z.object({ type: z.literal("cancel") }).strict(),
]);
export const fileSearchServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), rootPath: absolutePath }).strict(),
  z
    .object({
      type: z.literal("results"),
      rootPath: absolutePath,
      items: z.array(fileSearchMatchSchema).max(FS_SEARCH_MAX_BATCH_ITEMS),
    })
    .strict(),
  z.object({ type: z.literal("done"), summary: fileSearchSummarySchema }).strict(),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }).strict(),
]);
export type FileSearchServerMessage = z.infer<typeof fileSearchServerMessageSchema>;
