import { z } from "zod";

export const WORKSPACE_DIFF_MAX_FILES = 1000;
export const WORKSPACE_DIFF_MAX_BYTES = 1024 * 1024;
export const WORKSPACE_DIFF_MAX_REPOSITORIES = 16;

export type WorkspaceDiffLineKind = "metadata" | "hunk" | "context" | "addition" | "deletion";

/** Create fresh state for each patch. Combined diffs have one prefix column per parent. */
export function createWorkspaceDiffLineClassifier(): (line: string) => WorkspaceDiffLineKind {
  let columns = 0;
  return (line) => {
    if (/^diff --(?:git|cc|combined) /.test(line)) columns = 0;
    const hunk = /^(@{2,}) /.exec(line);
    if (hunk) {
      columns = hunk[1]!.length - 1;
      return "hunk";
    }
    if (!columns) return "metadata";
    const prefix = line.slice(0, columns);
    if (prefix.length === columns && /^[ +-]+$/.test(prefix)) {
      if (prefix.includes("+")) return "addition";
      if (prefix.includes("-")) return "deletion";
    }
    return "context";
  };
}

export const workspaceDiffGroupSchema = z.enum(["staged", "unstaged", "untracked"]);
export const workspaceDiffPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    "expected a relative Workspace file path",
  );
export const workspaceDiffFileQuerySchema = z.object({
  path: workspaceDiffPathSchema,
  group: workspaceDiffGroupSchema,
});
export const workspaceDiffParamsSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .startsWith("/")
    .refine((path) => !path.includes("\0")),
});
export const workspaceDiffFileParamsSchema = workspaceDiffParamsSchema.extend({
  file: workspaceDiffFileQuerySchema,
});
export const workspaceDiffEntrySchema = workspaceDiffFileQuerySchema.extend({
  /** Relative repository root; omitted for the repository containing the Workspace root. */
  repositoryPath: workspaceDiffPathSchema.optional(),
  oldPath: workspaceDiffPathSchema.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "conflicted", "untracked"]),
});
export const workspaceDiffRemoteUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value), "expected a single-line Git remote URL");
export const workspaceDiffRepositorySchema = z.object({
  /** Relative repository root; omitted for the repository containing the Workspace root. */
  repositoryPath: workspaceDiffPathSchema.optional(),
  /** null means that the repository has no configured remote. */
  remoteUrl: workspaceDiffRemoteUrlSchema.nullable(),
});
export const workspaceDiffResultSchema = z.object({
  isGit: z.boolean(),
  files: z.array(workspaceDiffEntrySchema).max(WORKSPACE_DIFF_MAX_FILES),
  /** Optional for compatibility with Agents that predate repository metadata. */
  repositories: z
    .array(workspaceDiffRepositorySchema)
    .max(WORKSPACE_DIFF_MAX_REPOSITORIES)
    .optional(),
  truncated: z.boolean(),
  /** Discovery stopped at a depth, directory, repository, or time budget. */
  scanTruncated: z.boolean().optional(),
});
export const workspaceDiffFileResultSchema = z.object({
  patch: z.string().max(WORKSPACE_DIFF_MAX_BYTES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  submodule: z.boolean(),
  truncated: z.boolean(),
});
export type WorkspaceDiffEntry = z.infer<typeof workspaceDiffEntrySchema>;
export type WorkspaceDiffRepository = z.infer<typeof workspaceDiffRepositorySchema>;
export type WorkspaceDiffResult = z.infer<typeof workspaceDiffResultSchema>;
export type WorkspaceDiffFileQuery = z.infer<typeof workspaceDiffFileQuerySchema>;
export type WorkspaceDiffFileResult = z.infer<typeof workspaceDiffFileResultSchema>;
