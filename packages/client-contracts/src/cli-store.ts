import { z } from "zod";

export const cliAppIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export type CliAppId = z.infer<typeof cliAppIdSchema>;
export const cliStoreActionSchema = z.enum(["install", "uninstall"]);

export const cliIconSchema = z
  .object({
    viewBox: z
      .string()
      .max(128)
      .regex(/^\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)?$/),
    path: z
      .string()
      .min(1)
      .max(65536)
      .regex(/^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+ \t\r\n-]+$/),
  })
  .strict();

const httpsUrlSchema = z
  .string()
  .max(4096)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !value.includes("#");
  }, "must be an HTTPS URL without credentials or fragment");

export const cliAppSchema = z
  .object({
    id: cliAppIdSchema,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000),
    homepage: httpsUrlSchema,
    version: z.string().trim().min(1).max(128),
    icon: cliIconSchema.optional(),
  })
  .strict();
export type CliApp = z.infer<typeof cliAppSchema>;

const cliArgumentSchema = z
  .string()
  .max(256)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );

const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      value.split("/").every((part) => {
        if (!part || part === "." || part === "..") return false;
        return [...part].every((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127 && character !== "\\";
        });
      }) &&
      value.split("/")[0] !== ".installer",
    "must be a normalized relative path",
  );

export const cliSourceSchema = z
  .object({
    url: httpsUrlSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
  })
  .strict();
export type CliSource = z.infer<typeof cliSourceSchema>;

const cliEnvironmentValueSchema = z.union([
  z.object({ literal: cliArgumentSchema }).strict(),
  z.object({ installPath: relativePathSchema }).strict(),
]);

const cliEnvironmentSchema = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), cliEnvironmentValueSchema)
  .refine((value) => Object.keys(value).length <= 32, "too many environment variables")
  .refine(
    (value) =>
      Object.keys(value).every(
        (key) =>
          !["HOME", "PATH", "SHELL", "BASH_ENV", "ENV", "IFS"].includes(key) &&
          !key.startsWith("XDG_") &&
          !key.startsWith("LD_"),
      ),
    "reserved environment variable",
  );

const cliRequirementsSchema = z
  .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.+-]{0,63}$/))
  .max(16)
  .refine((value) => new Set(value).size === value.length);

const cliRetryOutputSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );

export const cliScriptRetrySchema = z
  .object({
    maxAttempts: z.number().int().min(2).max(5),
    exitCodes: z
      .array(z.number().int().min(1).max(254))
      .max(16)
      .default([])
      .refine((value) => new Set(value).size === value.length, "duplicate retry exit code"),
    outputContains: z
      .array(cliRetryOutputSchema)
      .max(16)
      .default([])
      .refine((value) => new Set(value).size === value.length, "duplicate retry output marker"),
  })
  .strict()
  .refine((value) => value.exitCodes.length > 0 || value.outputContains.length > 0, {
    message: "retry policy requires an exit code or output marker",
  });
export type CliScriptRetry = z.infer<typeof cliScriptRetrySchema>;

const cliScriptInstallerSchema = z
  .object({
    kind: z.literal("script"),
    source: cliSourceSchema.refine((value) => value.size <= 2 * 1024 * 1024, {
      message: "script exceeds 2 MiB",
    }),
    shell: z.enum(["sh", "bash"]),
    args: z.array(cliArgumentSchema).max(16).default([]),
    env: cliEnvironmentSchema.default({}),
    requirements: cliRequirementsSchema.default([]),
    retry: cliScriptRetrySchema.optional(),
  })
  .strict();

const cliBinaryInstallerSchema = z
  .object({
    kind: z.literal("binary"),
    source: cliSourceSchema,
    destination: relativePathSchema,
  })
  .strict();

const cliArchiveInstallerSchema = z
  .object({
    kind: z.literal("archive"),
    source: cliSourceSchema,
    format: z.literal("tar.gz"),
    destination: relativePathSchema,
    stripComponents: z.number().int().min(0).max(4).default(0),
  })
  .strict();

export const cliInstallerSchema = z.discriminatedUnion("kind", [
  cliScriptInstallerSchema,
  cliBinaryInstallerSchema,
  cliArchiveInstallerSchema,
]);
export type CliInstaller = z.infer<typeof cliInstallerSchema>;

export const cliEntrypointSchema = z
  .object({
    command: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    path: relativePathSchema,
    args: z.array(cliArgumentSchema).max(16).default([]),
  })
  .strict();

const cliLaunchSchema = z
  .object({
    runArgs: z.array(cliArgumentSchema).max(16).default([]),
    loginArgs: z.array(cliArgumentSchema).max(16).optional(),
  })
  .strict();

export const cliVersionProbeSchema = z
  .object({
    entrypoint: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    args: z.array(cliArgumentSchema).max(16),
    stream: z.enum(["stdout", "stderr", "combined"]).default("combined"),
  })
  .strict();

export const cliRecipeSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    platform: z.literal("linux-x64"),
    app: cliAppSchema,
    installer: cliInstallerSchema,
    entrypoints: z.array(cliEntrypointSchema).min(1).max(8),
    detectionPaths: z.array(relativePathSchema).max(16).default([]),
    primaryCommand: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    launch: cliLaunchSchema,
    versionProbe: cliVersionProbeSchema,
  })
  .strict()
  .superRefine((recipe, ctx) => {
    if (recipe.schemaVersion === 1 && recipe.installer.kind === "script" && recipe.installer.retry)
      ctx.addIssue({
        code: "custom",
        path: ["installer", "retry"],
        message: "script retry requires recipe schema version 2",
      });
    const commands = recipe.entrypoints.map(({ command }) => command);
    if (new Set(commands).size !== commands.length)
      ctx.addIssue({ code: "custom", message: "duplicate entrypoint command" });
    if (!commands.includes(recipe.primaryCommand))
      ctx.addIssue({ code: "custom", message: "primaryCommand must name an entrypoint" });
    if (!commands.includes(recipe.versionProbe.entrypoint))
      ctx.addIssue({ code: "custom", message: "versionProbe must name an entrypoint" });
    if (new Set(recipe.detectionPaths).size !== recipe.detectionPaths.length)
      ctx.addIssue({ code: "custom", message: "duplicate detection path" });
    for (const path of recipe.detectionPaths) {
      const command = path.split("/").at(-1);
      if (!command || !commands.includes(command))
        ctx.addIssue({ code: "custom", message: "detection path must name an entrypoint" });
    }
  });
export type CliRecipe = z.infer<typeof cliRecipeSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function cliRecipeJson(value: unknown): string {
  return JSON.stringify(canonical(cliRecipeSchema.parse(value)));
}

export const cliDefinitionSchema = z
  .object({
    revisionId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    recipe: cliRecipeSchema,
  })
  .strict();
export type CliDefinition = z.infer<typeof cliDefinitionSchema>;

export const cliProbeSchema = z
  .object({
    appId: cliAppIdSchema,
    commands: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/))
      .min(1)
      .max(8),
    paths: z.array(relativePathSchema).max(16).default([]),
  })
  .strict()
  .superRefine((probe, ctx) => {
    if (new Set(probe.paths).size !== probe.paths.length)
      ctx.addIssue({ code: "custom", message: "duplicate probe path" });
    for (const path of probe.paths) {
      const command = path.split("/").at(-1);
      if (!command || !probe.commands.includes(command))
        ctx.addIssue({ code: "custom", message: "probe path must name a probed command" });
    }
  });
export type CliProbe = z.infer<typeof cliProbeSchema>;
export const CLI_STORE_MAX_PROBES = 128;
export const cliInventoryParamsSchema = z
  .object({ probes: z.array(cliProbeSchema).max(CLI_STORE_MAX_PROBES).default([]) })
  .strict()
  .refine((value) => new Set(value.probes.map(({ appId }) => appId)).size === value.probes.length, {
    message: "duplicate app probe",
  });

export const cliCapabilitiesSchema = z
  .object({
    recipeSchemaVersions: z.array(z.number().int()),
    installerKinds: z.array(z.enum(["script", "binary", "archive"])),
    archiveFormats: z.array(z.literal("tar.gz")),
    platform: z.string(),
  })
  .strict();
export type CliCapabilities = z.infer<typeof cliCapabilitiesSchema>;

export const cliInstallationSchema = z.object({
  appId: cliAppIdSchema,
  installed: z.boolean(),
  /** 排序元数据损坏时单独降级，不能让旧响应/缓存中的时间拖垮整份库存。 */
  installedAt: z
    .string()
    .datetime({ offset: true })
    .refine((value) => Number.isFinite(Date.parse(value)))
    .nullable()
    .optional()
    .catch(null),
  installSupported: z.boolean().optional(),
  managed: z.boolean(),
  version: z.string().nullable(),
  error: z.string().nullable(),
  app: cliAppSchema.optional(),
  revisionId: z.string().optional(),
  digest: z.string().optional(),
});
export type CliInstallation = z.infer<typeof cliInstallationSchema>;
export const cliInventorySchema = z.object({
  supported: z.boolean(),
  installations: z.array(cliInstallationSchema),
  capabilities: cliCapabilitiesSchema.optional(),
});

export const cliOperationStartSchema = z
  .object({
    operationId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    appId: cliAppIdSchema,
    action: cliStoreActionSchema,
  })
  .strict();
export type CliOperationStart = z.infer<typeof cliOperationStartSchema>;
export const cliAgentOperationStartSchema = cliOperationStartSchema
  .extend({ definition: cliDefinitionSchema.optional() })
  .superRefine((value, ctx) => {
    if (value.action === "install" && !value.definition)
      ctx.addIssue({ code: "custom", message: "install requires a frozen definition" });
    if (value.action === "uninstall" && value.definition)
      ctx.addIssue({ code: "custom", message: "uninstall cannot carry a definition" });
    if (value.definition && value.definition.recipe.app.id !== value.appId)
      ctx.addIssue({ code: "custom", message: "definition appId mismatch" });
  });
export type CliAgentOperationStart = z.infer<typeof cliAgentOperationStartSchema>;
export type CliStoreOperationInput = Pick<CliOperationStart, "appId" | "action">;
export const cliOperationStatusParamsSchema = cliOperationStartSchema.pick({ operationId: true });
export const cliOperationSchema = cliOperationStartSchema
  .extend({
    state: z.enum(["queued", "running", "completed", "failed"]),
    stage: z.enum([
      "queued",
      "checking",
      "downloading",
      "installing",
      "uninstalling",
      "verifying",
      "completed",
      "failed",
    ]),
    output: z.array(z.string().max(4096)).max(256),
    error: z.string().nullable(),
    updatedAt: z.string(),
    cancelRequested: z.boolean().default(false),
    cancelled: z.boolean().default(false),
  })
  .strip()
  .superRefine((operation, ctx) => {
    if (operation.cancelRequested && operation.action !== "install")
      ctx.addIssue({ code: "custom", message: "only installs can request cancellation" });
    if (operation.cancelled && !operation.cancelRequested)
      ctx.addIssue({ code: "custom", message: "cancelled operation must record cancel request" });
    if (operation.cancelled && (operation.state !== "failed" || operation.stage !== "failed"))
      ctx.addIssue({
        code: "custom",
        message: "cancelled operation must use failed terminal state",
      });
    if (operation.cancelled && operation.error !== null)
      ctx.addIssue({ code: "custom", message: "cancelled operation must not carry an error" });
  });
export type CliOperation = z.infer<typeof cliOperationSchema>;
export const cliOperationCancelParamsSchema = cliOperationStatusParamsSchema;
export const cliOperationCancelResultSchema = z
  .object({
    accepted: z.boolean(),
    operation: cliOperationSchema,
  })
  .strict();
export type CliOperationCancelResult = z.infer<typeof cliOperationCancelResultSchema>;

export const machineCliInventorySchema = cliInventorySchema.extend({
  agentContractVersion: z.number().int().nonnegative().optional(),
  online: z.boolean(),
  verifiedAt: z.string().nullable(),
  operation: cliOperationSchema.nullable(),
});
export type MachineCliInventory = z.infer<typeof machineCliInventorySchema>;

export const cliLaunchProfileSchema = z
  .object({
    appId: cliAppIdSchema,
    mode: z.enum(["run", "login"]).default("run"),
  })
  .strict();
export type CliLaunchProfile = z.infer<typeof cliLaunchProfileSchema>;

export const applicationInstanceSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^app_[A-Za-z0-9_-]+$/),
  appId: cliAppIdSchema,
  mode: z.enum(["run", "login"]).default("run"),
});
export const applicationPaneSchema = z
  .object({
    collapsed: z.boolean(),
    compactView: z.enum(["applications", "workspace"]).default("workspace"),
    size: z.number().min(20).max(70),
    instances: z.array(applicationInstanceSchema).max(16),
    activeInstanceId: z.string().nullable(),
  })
  .superRefine((pane, ctx) => {
    const ids = new Set(pane.instances.map((instance) => instance.id));
    if (ids.size !== pane.instances.length)
      ctx.addIssue({ code: "custom", message: "duplicate application instance" });
    if (pane.activeInstanceId !== null && !ids.has(pane.activeInstanceId))
      ctx.addIssue({ code: "custom", message: "unknown active application instance" });
  });
export type ApplicationPane = z.infer<typeof applicationPaneSchema>;
export const DEFAULT_APPLICATION_PANE: ApplicationPane = {
  collapsed: false,
  compactView: "workspace",
  size: 40,
  instances: [],
  activeInstanceId: null,
};

export const CLI_STORE_MIN_CONTRACT_VERSION = 13;
export const CLI_STORE_CANCEL_MIN_CONTRACT_VERSION = 14;
export const CLI_STORE_RETRY_MIN_CONTRACT_VERSION = 16;
export function supportsCliRecipe(
  recipe: CliRecipe,
  contractVersion: number,
  capabilities?: CliCapabilities,
): boolean {
  if (contractVersion < CLI_STORE_MIN_CONTRACT_VERSION || !capabilities) return false;
  if (recipe.schemaVersion >= 2 && contractVersion < CLI_STORE_RETRY_MIN_CONTRACT_VERSION)
    return false;
  return (
    capabilities.platform === recipe.platform &&
    capabilities.recipeSchemaVersions.includes(recipe.schemaVersion) &&
    capabilities.installerKinds.includes(recipe.installer.kind) &&
    (recipe.installer.kind !== "archive" ||
      capabilities.archiveFormats.includes(recipe.installer.format))
  );
}
