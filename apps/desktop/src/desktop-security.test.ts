import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_THEME_ID } from "@cloud-machine/native-client-ui/lib/themes";
import { PREVIEW_IMAGE_CSP } from "@cloud-machine/workspace-ui/file-preview-policy";

interface TauriWindowConfig {
  label: string;
  center?: boolean;
  maximized?: boolean;
  dragDropEnabled?: boolean;
  [key: string]: unknown;
}

interface TauriConfig {
  app: { security: { csp: string }; windows: TauriWindowConfig[] };
  bundle: { icon: string[]; windows: { wix: { template: string } } };
  productName: string;
  version: string;
}

interface TauriPlatformConfig {
  app: { windows: TauriWindowConfig[] };
}

function cspDirectives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name!, sources]),
  );
}

describe("Desktop preview CSP", () => {
  test("lets the main webview handle local file and directory drops", async () => {
    const raw = await readFile(resolve(import.meta.dir, "../src-tauri/tauri.conf.json"), "utf8");
    const config = JSON.parse(raw) as TauriConfig;

    expect(config.app.windows.find((window) => window.label === "main")?.dragDropEnabled).toBe(
      false,
    );
  });

  test("only permits HTTPS images while keeping remote frames and scripts isolated", async () => {
    const raw = await readFile(resolve(import.meta.dir, "../src-tauri/tauri.conf.json"), "utf8");
    const config = JSON.parse(raw) as TauriConfig;
    const directives = cspDirectives(config.app.security.csp);

    expect(directives.get("img-src")).toEqual(cspDirectives(PREVIEW_IMAGE_CSP).get("img-src"));
    expect(directives.get("media-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(directives.get("frame-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get("connect-src")).toEqual([
      "'self'",
      "https://renrencodex.com",
      "wss://renrencodex.com",
      "http://localhost:*",
      "ws://localhost:*",
      "http://127.0.0.1:*",
      "ws://127.0.0.1:*",
    ]);
  });

  test("binds native permissions to the main webview instead of every child in its window", async () => {
    const raw = await readFile(
      resolve(import.meta.dir, "../src-tauri/capabilities/main.json"),
      "utf8",
    );
    const capability = JSON.parse(raw) as {
      windows?: string[];
      webviews?: string[];
      permissions?: string[];
    };

    expect(capability.webviews).toEqual(["main"]);
    expect(capability.windows).toBeUndefined();
    expect(capability.permissions).toContain("core:window:allow-set-theme");
    expect(capability.permissions).toContain("core:window:allow-hide");
    expect(capability.permissions).not.toContain("core:window:allow-minimize");
    expect(capability.permissions).not.toContain("core:window:allow-close");
    expect(capability.permissions).not.toContain("core:window:allow-destroy");
  });

  test("renders port previews through native isolation rather than a remote iframe", async () => {
    const source = await readFile(
      resolve(
        import.meta.dir,
        "../../../packages/native-client-ui/src/components/WorkbenchBrowser.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("useState(createIsolatedPreviewId)");
    expect(source).toContain("platform.isolatedPreview.open");
    expect(source).toContain("platform.isolatedPreview.setVisible");
    expect(source).toContain("platform.isolatedPreview.close");
    expect(source).not.toContain("<iframe");
  });

  test("cleans previews on main webview reload and denies sensitive browser APIs", async () => {
    const nativeSource = await readFile(
      resolve(import.meta.dir, "../src-tauri/src/lib.rs"),
      "utf8",
    );
    const permissionGuard = await readFile(
      resolve(import.meta.dir, "../src-tauri/src/preview-permission-guard.txt"),
      "utf8",
    );

    expect(nativeSource).toContain("close_registered_previews(webview.app_handle())");
    expect(nativeSource).toContain("payload.event() == PageLoadEvent::Started");
    expect(nativeSource).toContain(
      "initialization_script_for_all_frames(PREVIEW_PERMISSION_GUARD)",
    );
    for (const api of [
      "getUserMedia",
      "getDisplayMedia",
      "geolocation",
      "clipboard",
      "requestDevice",
      "requestPort",
      "requestMIDIAccess",
      "requestFullscreen",
    ]) {
      expect(permissionGuard).toContain(api);
    }
  });
});

describe("Desktop Windows startup", () => {
  test("creates Windows hidden and unmaximized so Native can prepare it without flashing", async () => {
    const configDirectory = resolve(import.meta.dir, "../src-tauri");
    const config = JSON.parse(
      await readFile(resolve(configDirectory, "tauri.conf.json"), "utf8"),
    ) as TauriConfig;
    const windowsConfig = JSON.parse(
      await readFile(resolve(configDirectory, "tauri.windows.conf.json"), "utf8"),
    ) as TauriPlatformConfig;
    const mainWindow = config.app.windows.find((window) => window.label === "main");
    const windowsMainWindow = windowsConfig.app.windows.find((window) => window.label === "main");

    if (!mainWindow || !windowsMainWindow) {
      throw new Error("Desktop main window configuration is missing");
    }

    expect(mainWindow.center).toBeUndefined();
    expect(mainWindow.maximized).toBeUndefined();
    expect(mainWindow.visible).toBeUndefined();
    expect(mainWindow.focus).toBeUndefined();
    expect(windowsMainWindow).toEqual({
      ...mainWindow,
      center: true,
      visible: false,
      focus: false,
      maximized: false,
    });
  });
});

describe("Desktop Windows installer branding", () => {
  test("uses the current brand artwork in the UI and every configured native icon", async () => {
    const configPath = resolve(import.meta.dir, "../src-tauri/tauri.conf.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as TauriConfig;
    const logoSource = await readFile(
      resolve(import.meta.dir, "../../../packages/native-client-ui/src/components/BrandLogo.tsx"),
      "utf8",
    );
    const uiLogo = await readFile(
      resolve(import.meta.dir, "../../../packages/native-client-ui/public/brand/256x256.png"),
    );

    expect(logoSource).toContain('src="/brand/256x256.png"');
    expect(uiLogo.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    for (const icon of config.bundle.icon) {
      expect((await readFile(resolve(configPath, "..", icon))).byteLength).toBeGreaterThan(0);
    }
  });

  test("keeps the display name while using an ASCII installation directory", async () => {
    const configPath = resolve(import.meta.dir, "../src-tauri/tauri.conf.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as TauriConfig;
    const wixTemplate = await readFile(
      resolve(configPath, "..", config.bundle.windows.wix.template),
      "utf8",
    );
    const pathComponent = wixTemplate.match(/<Component Id="Path"[\s\S]*?<\/Component>/)?.[0];
    const binaryComponents = wixTemplate.match(
      /{{#each binaries as \|bin\| ~}}[\s\S]*?{{\/each~}}/,
    )?.[0];

    expect(config.productName).toBe("人人Codex");
    expect(config.version).toBe("../package.json");
    expect(wixTemplate).toContain(
      '<Product\n            Id="*"\n            Name="{{product_name}}"',
    );
    expect(wixTemplate).toContain('<Directory Id="INSTALLDIR" Name="renrencodex"/>');
    expect(wixTemplate).toContain('InstallScope="perUser"');
    expect(wixTemplate).toContain('<Directory Id="LocalAppDataFolder">');
    expect(wixTemplate).toContain('Root="HKCU" Key="Software\\Classes\\\\{{protocol}}"');
    expect(pathComponent).toContain(
      '<File Id="Path" Source="{{main_binary_path}}" Checksum="yes"/>',
    );
    expect(pathComponent).toContain('Root="HKCU"');
    expect(pathComponent).toContain('Name="Executable Component"');
    expect(pathComponent).toContain('KeyPath="yes"');
    expect(wixTemplate).toContain('Directory="UserProgramsFolder"');
    expect(pathComponent).not.toContain(
      '<File Id="Path" Source="{{main_binary_path}}" KeyPath="yes"',
    );
    expect(binaryComponents).toContain('<File Id="Bin_{{ bin.id }}" Source="{{bin.path}}"/>');
    expect(binaryComponents).not.toContain('Source="{{bin.path}}" KeyPath="yes"');
    expect(binaryComponents).toContain('Root="HKCU"');
    expect(binaryComponents).toContain('Name="Binary {{ bin.id }} Component"');
    expect(binaryComponents).toContain('KeyPath="yes"');
    expect(wixTemplate).not.toContain('InstallScope="perMachine"');
    expect(wixTemplate).toContain(
      '<Directory Id="ApplicationProgramsFolder" Name="{{product_name}}"/>',
    );
  });

  test("only release builds create signed updater artifacts and never embed a private key", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(import.meta.dir, "../package.json"), "utf8"),
    ) as { scripts: { "release:build": string } };
    const releaseBuildScript = await readFile(
      resolve(import.meta.dir, "../scripts/build-windows-release.ts"),
      "utf8",
    );
    const buildScript = await readFile(resolve(import.meta.dir, "../src-tauri/build.rs"), "utf8");
    const nativeSource = await readFile(
      resolve(import.meta.dir, "../src-tauri/src/lib.rs"),
      "utf8",
    );
    const frontendSource = await readFile(resolve(import.meta.dir, "main.tsx"), "utf8");
    const manifestSource = await readFile(
      resolve(import.meta.dir, "../scripts/release-manifest.ts"),
      "utf8",
    );
    const capability = await readFile(
      resolve(import.meta.dir, "../src-tauri/capabilities/main.json"),
      "utf8",
    );

    expect(packageJson.scripts["release:build"]).toContain("build-windows-release.ts");
    expect(releaseBuildScript).toContain("createUpdaterArtifacts: true");
    expect(releaseBuildScript).toContain("RENRENCODEX_UPDATER_PUBLIC_KEY");
    expect(releaseBuildScript).not.toMatch(/PRIVATE_KEY\s*=\s*"/);
    expect(buildScript).toContain("RENRENCODEX_UPDATER_PUBLIC_KEY");
    expect(buildScript).not.toMatch(/PRIVATE_KEY\s*=\s*"/);
    expect(nativeSource).toContain("ensure_main_webview(webview.label())?");
    expect(nativeSource).toContain("https://renrencodex.com/downloads/desktop/stable/latest.json");
    expect(nativeSource).toContain("DesktopUpdateTarget::MacosUniversal");
    expect(nativeSource).toContain("DesktopUpdateTarget::LinuxX86_64");
    expect(frontendSource).toContain("appUpdateEnabled: true");
    expect(manifestSource).toContain('"darwin-aarch64"');
    expect(manifestSource).toContain('"darwin-x86_64"');
    expect(manifestSource).toContain('"linux-x86_64"');
    expect(capability).not.toContain("updater:");
  });
});

describe("Desktop Windows executable", () => {
  test("uses the GUI subsystem for release builds only", async () => {
    const mainSource = await readFile(resolve(import.meta.dir, "../src-tauri/src/main.rs"), "utf8");

    expect(mainSource).toContain(
      'all(not(debug_assertions), target_os = "windows"),\n    windows_subsystem = "windows"',
    );
  });
});

describe("Desktop download directory", () => {
  test("opens only the host-resolved download directory from the main webview", async () => {
    const nativeSource = await readFile(
      resolve(import.meta.dir, "../src-tauri/src/lib.rs"),
      "utf8",
    );
    const command = nativeSource.match(
      /fn open_download_directory\([\s\S]*?\n}\n\n\/\/\/ 仅允许主 WebView/,
    )?.[0];

    expect(command).toContain("ensure_main_webview(webview.label())?");
    expect(command).toContain("app.path().download_dir()");
    expect(command).toContain(".open_path(directory, None::<&str>)");
    expect(command).not.toContain("path: String");
  });
});

describe("Desktop initial theme", () => {
  test("uses ink-white before the application restores a saved preference", async () => {
    const html = await readFile(resolve(import.meta.dir, "../index.html"), "utf8");

    expect(DEFAULT_THEME_ID).toBe("ink-white");
    expect(html).toContain(
      '<html lang="zh-CN" class="light" data-theme="ink-white" style="color-scheme: light">',
    );
  });
});
