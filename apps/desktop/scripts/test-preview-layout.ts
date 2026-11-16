import { chromium, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import type {} from "./preview-layout.fixture";

// Actual Desktop CSS/components; only native/API capabilities are mocked.
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../", import.meta.url)),
  plugins: [tailwindcss()],
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: null },
});
let desktopCss: string;
try {
  desktopCss = (await server.transformRequest("/src/app.css?direct"))!.code;
} finally {
  await server.close();
}
const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./preview-layout.fixture.tsx", import.meta.url))],
  target: "browser",
  format: "iife",
  write: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const script = await bundle.outputs[0]!.text();
const terminalCss = (
  await Promise.all(
    bundle.outputs.filter((output) => output.path.endsWith(".css")).map((output) => output.text()),
  )
).join("\n");
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const css = `
html,body{margin:0} #layout{height:700px;width:1200px;display:flex;margin-left:20px;margin-top:20px}
.h-full{height:100%}.w-full{width:100%}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.min-w-0{min-width:0}.shrink-0{flex-shrink:0}.relative{position:relative}.overflow-hidden{overflow:hidden}
.cm-workspace-surface{background:white}.cm-workbench-browser-toolbar{height:40px;min-height:40px;box-sizing:border-box}
#panes{display:flex;height:100%}#panes[hidden]{display:none}#panes>.cm-workspace-surface{flex:1;min-width:0}
[data-isolated-preview] img{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
#theme{position:fixed;top:90px;left:1000px;z-index:5}[data-slot=dropdown-menu-content]{width:208px;background:#ddd}[data-slot=dropdown-menu-radio-item]{height:36px;display:flex}
`;
const image = (page: Page) => page.locator("[data-isolated-preview] img");
const calls = (page: Page) => page.evaluate(() => window.previewFixture.calls);
const width = (page: Page) =>
  page
    .locator("[data-isolated-preview]")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
const sidebarWidth = (page: Page) =>
  page.locator("#sidebar").evaluate((el) => el.getBoundingClientRect().width);
async function scenario(name: string, check: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.route("https://preview-test.local/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/wasm/ghostty-vt-0.4.0.wasm") {
        await route.fulfill({
          body: Buffer.from(
            await Bun.file(
              fileURLToPath(import.meta.resolve("ghostty-web/ghostty-vt.wasm")),
            ).arrayBuffer(),
          ),
          contentType: "application/wasm",
        });
      } else await route.fulfill({ body: "<html></html>", contentType: "text/html" });
    });
    await page.goto("https://preview-test.local/");
    await page.setContent(
      `<style>${desktopCss}\n${terminalCss}\n${css}</style><div id="root"></div>`,
    );
    await page.addScriptTag({ content: script });
    await page.waitForFunction(() => window.previewFixture.calls.some((c) => c.kind === "open"));
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      window.previewFixture.calls = [];
    });
    await check(page);
    expect(errors).toEqual([]);
    console.log(`PASS: ${name}`);
  } finally {
    await page.close();
  }
}
try {
  await scenario("resource divider uses the shared workspace resize affordance", async (page) => {
    const separator = page.getByRole("separator", { name: "调整资源侧边栏宽度" });
    await expect(separator).toHaveCount(1);
    await expect(separator).toHaveClass(/cursor-col-resize/);
    await expect(separator).toHaveClass(/before:w-\[2px\]/);
  });
  for (const previewActive of [true, false]) {
    await scenario(
      `manual sidebar resizing and collapse win until pointer release (preview=${previewActive})`,
      async (page) => {
        await page.evaluate((active) => window.previewFixture.activate(active), previewActive);
        const separator = page.getByRole("separator", { name: "调整资源侧边栏宽度" });
        let rect = (await separator.boundingBox())!;
        await page.mouse.move(rect.x + rect.width / 2, rect.y + 80);
        await page.mouse.down();
        await page.mouse.move(rect.x + 100, rect.y + 80, { steps: 8 });
        const expanded = await sidebarWidth(page);
        expect(expanded).toBeGreaterThan(300);
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await page.waitForTimeout(300);
        expect(await sidebarWidth(page)).toBe(expanded);
        expect(await page.evaluate(() => window.previewFixture.layoutWrites)).toEqual([]);
        await page.mouse.up();
        await expect
          .poll(() => page.evaluate(() => window.previewFixture.layoutWrites.length))
          .toBe(1);

        rect = (await separator.boundingBox())!;
        await page.mouse.move(rect.x + rect.width / 2, rect.y + 80);
        await page.mouse.down();
        await page.mouse.move(25, rect.y + 80, { steps: 10 });
        await expect.poll(() => sidebarWidth(page)).toBe(0);
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        await page.waitForTimeout(350);
        expect(await sidebarWidth(page)).toBe(0);
        expect(await page.evaluate(() => window.previewFixture.layoutWrites.length)).toBe(1);
        await page.mouse.up();
        await expect
          .poll(() => page.evaluate(() => window.previewFixture.layoutWrites.at(-1)))
          .toBe(0);
        await page.waitForTimeout(150);
        expect(await sidebarWidth(page)).toBe(0);

        await page.locator("#toggle").click();
        await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(300);
        await separator.focus();
        await page.keyboard.press("Home");
        await expect.poll(() => sidebarWidth(page)).toBe(0);
      },
    );
  }
  await scenario("a recovery awaiting preview preparation yields to a new drag", async (page) => {
    await page.evaluate(() => {
      document.getElementById("layout")!.style.width = "100px";
    });
    await expect.poll(() => sidebarWidth(page)).toBe(0);
    await page.evaluate(() => {
      window.previewFixture.calls = [];
      window.previewFixture.captureDelay = 150;
      document.getElementById("layout")!.style.width = "1200px";
    });
    await page.waitForFunction(() => window.previewFixture.calls.some((c) => c.kind === "capture"));
    const rect = (await page.getByRole("separator", { name: "调整资源侧边栏宽度" }).boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 80);
    await page.mouse.down();
    await page.mouse.move(350, rect.y + 80);
    const dragged = await sidebarWidth(page);
    expect(dragged).toBeGreaterThan(300);
    await page.waitForTimeout(350);
    expect(await sidebarWidth(page)).toBe(dragged);
    await page.mouse.up();
    await expect
      .poll(async () => Math.abs((await sidebarWidth(page)) - dragged))
      .toBeLessThanOrEqual(1);
    await expect(image(page)).toHaveCount(0);
  });
  for (const release of ["pointerup", "pointercancel", "blur"] as const) {
    await scenario(`sidebar recovery resumes after ${release}`, async (page) => {
      await page.evaluate(() => {
        window.previewFixture.activate(false);
        document.querySelector("#desktop-workbench-shell main")!.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerId: 71,
            isPrimary: true,
            button: 0,
            buttons: 1,
            clientX: 600,
            clientY: 400,
          }),
        );
        document.getElementById("layout")!.style.width = "100px";
      });
      await expect.poll(() => sidebarWidth(page)).toBe(0);
      await page.evaluate(() => {
        document.getElementById("layout")!.style.width = "1200px";
      });
      await page.waitForTimeout(150);
      expect(await sidebarWidth(page)).toBe(0);
      await page.evaluate((release) => {
        if (release === "blur") window.dispatchEvent(new Event("blur"));
        else {
          const target = document.querySelector("#desktop-workbench-shell main")!;
          // Child widgets can consume the event; the outer shell must still release its gate.
          target.addEventListener(release, (event) => event.stopPropagation(), { once: true });
          target.dispatchEvent(new PointerEvent(release, { bubbles: true, pointerId: 71 }));
        }
      }, release);
      await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);
      expect(await page.evaluate(() => window.previewFixture.layoutWrites)).toEqual([]);
    });
  }
  for (const pauseAt of ["bounds", "show", "cover"] as const) {
    await scenario(`minimize fences preview completion during ${pauseAt}`, async (page) => {
      await page.evaluate((pauseAt) => {
        window.previewFixture.bindViewport();
        if (pauseAt === "bounds") window.previewFixture.boundsDelay = 500;
        else {
          window.previewFixture.onPreviewShow = () => {
            window.previewFixture.onPreviewShow = () => {};
            if (pauseAt === "show") window.previewFixture.minimize();
            else setTimeout(() => window.previewFixture.minimize(), 0);
          };
        }
        window.previewFixture.toggle();
      }, pauseAt);
      if (pauseAt === "bounds") {
        await page.waitForFunction(() =>
          window.previewFixture.calls.some((c) => c.kind === "bounds"),
        );
        await page.evaluate(() => window.previewFixture.minimize());
      }
      await expect
        .poll(() => page.evaluate(() => window.previewFixture.layoutState().phase))
        .toBe("suspended");
      await page.setViewportSize({ width: 160, height: 60 });
      await page.waitForTimeout(650);
      await expect(image(page)).toHaveCount(1);
      expect((await calls(page)).filter((c) => c.kind === "show")).toHaveLength(
        pauseAt === "bounds" ? 0 : 1,
      );
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => {
        window.previewFixture.native.minimized = false;
        window.previewFixture.syncNative();
      });
      await expect
        .poll(() => page.evaluate(() => window.previewFixture.layoutState().phase))
        .toBe("active");
      await expect(image(page)).toHaveCount(0);
      expect((await calls(page)).filter((c) => c.kind === "show")).toHaveLength(1);
      expect((await calls(page)).some((c) => c.kind === "open" || c.kind === "close")).toBe(false);
    });
  }
  await scenario(
    "a native reply spanning a full minimize cycle waits for fresh bounds",
    async (page) => {
      await page.addStyleTag({ content: "#layout{margin:0;width:var(--cm-viewport-width,100vw)}" });
      await page.waitForTimeout(80);
      await page.evaluate(() => {
        window.previewFixture.bindViewport();
        window.previewFixture.calls = [];
        window.previewFixture.boundsDelay = 500;
        window.previewFixture.toggle();
      });
      await page.waitForFunction(() =>
        window.previewFixture.calls.some((c) => c.kind === "bounds"),
      );
      await page.evaluate(() => window.previewFixture.minimize());
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.evaluate(() => {
        window.previewFixture.native.width = 1440;
        window.previewFixture.native.minimized = false;
        window.previewFixture.syncNative();
      });
      await expect
        .poll(() => page.evaluate(() => window.previewFixture.layoutState().phase))
        .toBe("active");
      await expect(image(page)).toHaveCount(0);
      const log = await calls(page);
      expect(log.map((c) => c.kind)).toEqual(["capture", "hide", "bounds", "bounds", "show"]);
      expect(log[3]!.bounds!.width).toBe(await width(page));
    },
  );
  for (const [address, error] of [
    ["http://localhost:65534", "当前电脑未检测到 65534 端口"],
    ["javascript:alert(1)", "浏览器标签只允许 HTTP 或 HTTPS 地址"],
    ["https://[", "请输入有效的网址"],
  ]) {
    await scenario(
      `rejected address keeps existing preview geometry live: ${address}`,
      async (page) => {
        await page.getByRole("textbox", { name: "浏览器地址" }).fill(address!);
        await page.getByRole("button", { name: "打开", exact: true }).click();
        await expect(page.getByText(error!, { exact: true })).toBeVisible();
        const rect = await page.locator("[data-isolated-preview]").evaluate((el) => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return { x, y, width, height };
        });
        await expect
          .poll(async () => (await calls(page)).filter((c) => c.kind === "bounds").at(-1)?.bounds)
          .toEqual(rect);
        await page.evaluate(() => {
          document.getElementById("layout")!.style.width = "1050px";
        });
        await expect
          .poll(
            async () =>
              (await calls(page)).filter((c) => c.kind === "bounds").at(-1)?.bounds?.width,
          )
          .toBe(rect.width - 150);
        await page.locator("#toggle").click();
        await expect
          .poll(async () => (await calls(page)).some((c) => c.kind === "show"))
          .toBe(true);
        await expect(image(page)).toHaveCount(0);
        expect((await calls(page)).some((c) => c.kind === "open" || c.kind === "close")).toBe(
          false,
        );
      },
    );
  }
  await scenario(
    "legacy WebView without AbortSignal.any supports layout and menu handoff",
    async (page) => {
      await page.evaluate(() =>
        Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true }),
      );
      await page.locator("#toggle").click();
      await expect
        .poll(async () => (await calls(page)).map((c) => c.kind))
        .toEqual(["capture", "hide", "bounds", "show"]);
      await expect(image(page)).toHaveCount(0);
      await page.evaluate(() => {
        window.previewFixture.calls = [];
      });
      await page.getByRole("button", { name: /选择主题/ }).click();
      await expect.poll(async () => (await calls(page)).some((c) => c.kind === "hide")).toBe(true);
      await expect(image(page)).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await calls(page)).some((c) => c.kind === "show")).toBe(true);
      await expect(image(page)).toHaveCount(0);
      await expect(
        page.getByText("内嵌预览加载失败，请重试或在系统浏览器中打开", { exact: true }),
      ).toHaveCount(0);
    },
  );
  await scenario("slow geometry coalesces to latest bounds without repeated show", async (page) => {
    await page.evaluate(() => {
      window.previewFixture.boundsDelay = 120;
      document.getElementById("layout")!.style.width = "1150px";
    });
    await page.waitForFunction(() => window.previewFixture.calls.some((c) => c.kind === "bounds"));
    await page.evaluate(() => {
      document.getElementById("layout")!.style.width = "1100px";
    });
    await page.waitForTimeout(35);
    await page.evaluate(() => {
      document.getElementById("layout")!.style.width = "1050px";
    });
    await page.waitForTimeout(350);
    const log = await calls(page);
    expect(log.map((c) => c.kind)).toEqual(["bounds", "bounds"]);
    expect(log[1]!.bounds!.width).toBe(await width(page));
    expect(log[1]!.bounds!.width).toBeLessThan(log[0]!.bounds!.width);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(80);
    expect(await calls(page)).toEqual(log);
  });
  await scenario("cover precedes hide; resize and restore do not navigate", async (page) => {
    await page.locator("#toggle").click();
    await expect.poll(() => width(page)).toBeGreaterThan(1100);
    await expect(image(page)).toHaveCount(0);
    await expect
      .poll(async () => (await calls(page)).map((c) => c.kind))
      .toEqual(["capture", "hide", "bounds", "show"]);
    expect(
      (await calls(page))
        .filter((c) => ["hide", "bounds", "show"].includes(c.kind))
        .every((c) => c.cover),
    ).toBe(true);
    await page.evaluate(() => {
      window.previewFixture.calls = [];
    });
    await page.locator("#toggle").click();
    await expect.poll(() => width(page)).toBeLessThan(1000);
    await expect(image(page)).toHaveCount(0);
    expect((await calls(page)).some((c) => c.kind === "open" || c.kind === "close")).toBe(false);
  });
  await scenario("restoring a minimized layout preserves an expanded sidebar", async (page) => {
    await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);
    await page.evaluate(() => {
      document.getElementById("layout")!.style.width = "100px";
      window.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => sidebarWidth(page)).toBe(0);
    await page.evaluate(() => {
      window.previewFixture.calls = [];
      document.getElementById("layout")!.style.width = "1200px";
      window.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);
    await expect.poll(async () => (await calls(page)).some((c) => c.kind === "show")).toBe(true);
    await expect
      .poll(
        async () => (await calls(page)).filter((c) => c.kind === "bounds").at(-1)?.bounds?.width,
      )
      .toBe(await width(page));
    await expect(image(page)).toHaveCount(0);
    expect((await calls(page)).some((c) => c.kind === "open" || c.kind === "close")).toBe(false);

    await page.locator("#toggle").click();
    await expect.poll(() => sidebarWidth(page)).toBe(0);
  });
  await scenario("restoring a minimized layout keeps an intentional collapse", async (page) => {
    await page.locator("#toggle").click();
    await expect.poll(() => sidebarWidth(page)).toBe(0);
    await page.evaluate(() => {
      document.getElementById("layout")!.style.width = "100px";
      window.dispatchEvent(new Event("resize"));
    });
    await page.evaluate(() => {
      document.getElementById("layout")!.style.width = "1200px";
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(300);
    expect(await sidebarWidth(page)).toBe(0);

    await page.locator("#toggle").click();
    await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);
  });
  await scenario(
    "native minimize keeps the last desktop breakpoint until restored",
    async (page) => {
      await expect(page.locator("#responsive-mode")).toHaveText("desktop");
      await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);

      await page.evaluate(() => window.previewFixture.suspendViewport(true));
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await page.evaluate(() => matchMedia("(max-width: 639px)").matches)).toBe(true);
      await expect(page.locator("#responsive-mode")).toHaveText("desktop");
      await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => window.previewFixture.suspendViewport(false));
      await expect(page.locator("#responsive-mode")).toHaveText("desktop");
      await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);

      await page.locator("#toggle").click();
      await expect.poll(() => sidebarWidth(page)).toBe(0);
    },
  );
  for (const savedSize of [null, 24]) {
    for (const previewActive of [true, false]) {
      await scenario(
        "native restore retains pixel width: " + savedSize + ", preview=" + previewActive,
        async (page) => {
          await page.addStyleTag({
            content: "#layout{margin:0;width:var(--cm-viewport-width,100vw);height:700px}",
          });
          await page.evaluate(
            ({ savedSize, previewActive }) => {
              if (savedSize !== null) window.previewFixture.setSidebarSize(savedSize);
              window.previewFixture.activate(previewActive);
              window.previewFixture.bindViewport();
            },
            { savedSize, previewActive },
          );
          await page.waitForTimeout(150);
          const before = await sidebarWidth(page);
          // A normal resize preserves pixels; the saved percentage is now deliberately stale.
          await page.evaluate(() => {
            window.previewFixture.native.width = 1440;
          });
          await page.setViewportSize({ width: 1440, height: 800 });
          await expect
            .poll(async () => Math.abs((await sidebarWidth(page)) - before))
            .toBeLessThanOrEqual(1);
          await page.evaluate(() => {
            window.previewFixture.calls = [];
            window.previewFixture.minimize();
          });
          await page.setViewportSize({ width: 160, height: 60 });
          await expect(page.locator("#responsive-mode")).toHaveText("desktop");
          await expect
            .poll(async () => Math.abs((await sidebarWidth(page)) - before))
            .toBeLessThanOrEqual(1);
          await page.evaluate(() => {
            // Native focus/restore arrives before the WebView receives its usable bounds.
            window.previewFixture.native.minimized = false;
            window.previewFixture.syncNative();
          });
          await page.waitForTimeout(150);
          expect(await page.evaluate(() => window.previewFixture.layoutState().phase)).not.toBe(
            "active",
          );
          expect((await calls(page)).filter((c) => c.kind === "bounds")).toEqual([]);
          await page.setViewportSize({ width: 1440, height: 800 });
          await expect
            .poll(() => page.evaluate(() => window.previewFixture.layoutState().phase))
            .toBe("active");
          await expect
            .poll(async () => Math.abs((await sidebarWidth(page)) - before))
            .toBeLessThanOrEqual(1);
          expect(await page.evaluate(() => window.previewFixture.layoutWrites)).toEqual([]);
          expect((await calls(page)).some((c) => c.kind === "open" || c.kind === "close")).toBe(
            false,
          );
          // Repeat without a user focus/click to prove recovery is self-contained.
          await page.evaluate(() => window.previewFixture.minimize());
          await page.setViewportSize({ width: 160, height: 60 });
          await page.setViewportSize({ width: 1440, height: 800 });
          await page.evaluate(() => {
            window.previewFixture.native.minimized = false;
            window.previewFixture.syncNative();
          });
          await expect
            .poll(() => page.evaluate(() => window.previewFixture.layoutState().phase))
            .toBe("active");
          await expect
            .poll(async () => Math.abs((await sidebarWidth(page)) - before))
            .toBeLessThanOrEqual(1);
        },
      );
    }
  }
  await scenario(
    "latest intentional collapse wins while native restoration is pending",
    async (page) => {
      await page.addStyleTag({ content: "#layout{margin:0;width:var(--cm-viewport-width,100vw)}" });
      await page.evaluate(() => {
        window.previewFixture.bindViewport();
        window.previewFixture.minimize();
      });
      await page.setViewportSize({ width: 160, height: 60 });
      await page.evaluate(() => window.previewFixture.toggle());
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => {
        window.previewFixture.native.minimized = false;
        window.previewFixture.syncNative();
      });
      await expect
        .poll(() => page.evaluate(() => window.previewFixture.layoutState().phase))
        .toBe("active");
      await expect.poll(() => sidebarWidth(page)).toBe(0);
      await page.waitForTimeout(400);
      expect(await sidebarWidth(page)).toBe(0);
      await page.locator("#toggle").click();
      await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);
    },
  );
  await scenario(
    "recovery rechecks constraints after async preview work even without another focus",
    async (page) => {
      // Exercise the corrective path independently of the native viewport freeze.
      await page.addStyleTag({ content: "#layout{margin:0;width:100vw}" });
      await page.evaluate(() => window.previewFixture.setSidebarSize(24));
      await page.waitForTimeout(100);
      const before = await sidebarWidth(page);
      await page.setViewportSize({ width: 160, height: 60 });
      await expect(page.locator("#responsive-mode")).toHaveText("phone");
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(page.locator("#responsive-mode")).toHaveText("desktop");
      await expect
        .poll(async () => Math.abs((await sidebarWidth(page)) - before))
        .toBeLessThanOrEqual(1);
      await expect(image(page)).toHaveCount(0);
      expect(await page.evaluate(() => window.previewFixture.layoutWrites)).toEqual([]);
    },
  );
  await scenario(
    "native lifecycle preserves an already closed sidebar and permits real narrow windows",
    async (page) => {
      await page.addStyleTag({ content: "#layout{margin:0;width:var(--cm-viewport-width,100vw)}" });
      await page.locator("#toggle").click();
      await expect.poll(() => sidebarWidth(page)).toBe(0);
      await page.evaluate(() => {
        window.previewFixture.bindViewport();
        window.previewFixture.minimize();
      });
      await page.setViewportSize({ width: 160, height: 60 });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => {
        window.previewFixture.native.minimized = false;
        window.previewFixture.syncNative();
      });
      await expect
        .poll(() => page.evaluate(() => window.previewFixture.layoutState().phase))
        .toBe("active");
      expect(await sidebarWidth(page)).toBe(0);
      await page.locator("#toggle").click();
      await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);
      await page.evaluate(() => {
        window.previewFixture.native.width = 960;
      });
      await page.setViewportSize({ width: 960, height: 800 });
      await expect(page.locator("#responsive-mode")).toHaveText("tablet");
      await expect.poll(() => sidebarWidth(page)).toBe(0);
      await page.evaluate(() => {
        window.previewFixture.native.width = 1280;
      });
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(page.locator("#responsive-mode")).toHaveText("desktop");
      await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(200);
    },
  );
  await scenario("capture failure preserves visibility without pause notice", async (page) => {
    await page.evaluate(() => {
      window.previewFixture.captureFails = true;
    });
    await page.locator("#toggle").click();
    await expect.poll(() => width(page)).toBeGreaterThan(1100);
    await expect
      .poll(async () => (await calls(page)).map((c) => c.kind))
      .toEqual(["capture", "bounds"]);
    await expect(image(page)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
  });
  for (const backend of ["auto", "xterm"] as const) {
    await scenario(
      "terminal keeps its grid and output across native minimize: " + backend,
      async (page) => {
        await page.evaluate(async (backend) => {
          window.previewFixture.bindViewport();
          await window.previewFixture.openTerminal(backend);
          window.previewFixture.writeTerminal("LAYOUT_PRESERVED\r\n");
        }, backend);
        const before = await page.evaluate(() => window.previewFixture.terminalSize());
        expect(before.backend).toBe(backend === "auto" ? "ghostty" : "xterm");
        expect(before.cols).toBeGreaterThan(100);
        await page.evaluate(() => {
          window.previewFixture.terminalResizes = [];
          window.previewFixture.minimize();
        });
        await page.setViewportSize({ width: 160, height: 60 });
        await page.evaluate(() => {
          window.previewFixture.fitTerminal();
          window.previewFixture.writeTerminal("BACKGROUND_OUTPUT\r\n");
          document.dispatchEvent(new Event("visibilitychange"));
          window.previewFixture.native.minimized = false;
          window.previewFixture.syncNative();
        });
        await page.waitForTimeout(150);
        expect(await page.evaluate(() => window.previewFixture.terminalSize())).toEqual(before);
        expect(await page.evaluate(() => window.previewFixture.terminalResizes)).toEqual([]);
        await page.setViewportSize({ width: 1280, height: 800 });
        await expect
          .poll(() => page.evaluate(() => window.previewFixture.layoutState().phase))
          .toBe("active");
        expect(await page.evaluate(() => window.previewFixture.terminalSize())).toEqual(before);
        // Select both original and background output using actual terminal mouse handling.
        const rect = await page.locator("#terminal-probe").boundingBox();
        await page.mouse.move(rect!.x + 1, rect!.y + 8);
        await page.mouse.down();
        await page.mouse.move(rect!.x + 230, rect!.y + 26, { steps: 8 });
        await page.mouse.up();
        await expect
          .poll(() => page.evaluate(() => window.previewFixture.terminalSelection()))
          .toContain("LAYOUT_PRESERVED");
        await expect
          .poll(() => page.evaluate(() => window.previewFixture.terminalSelection()))
          .toContain("BACKGROUND_OUTPUT");
        await page.evaluate(() => window.previewFixture.focusTerminal());
        await page.keyboard.type("input-ok");
        expect((await page.evaluate(() => window.previewFixture.terminalInput)).join("")).toContain(
          "input-ok",
        );
        await page.evaluate(() => window.previewFixture.unmount());
      },
    );
  }
  await scenario("200 ms preparation deadline ignores a late snapshot", async (page) => {
    await page.evaluate(() => {
      window.previewFixture.captureDelay = 900;
    });
    await page.locator("#toggle").click();
    await page.waitForFunction(
      () => document.querySelector("[data-isolated-preview]")!.getBoundingClientRect().width > 1100,
      undefined,
      { timeout: 600 },
    );
    await page.waitForTimeout(950);
    expect((await calls(page)).map((c) => c.kind)).toEqual(["capture", "bounds"]);
    await expect(image(page)).toHaveCount(0);
  });
  await scenario("rapid opposing intents discard the old sidebar request", async (page) => {
    await page.evaluate(() => {
      window.previewFixture.captureDelay = 120;
      window.previewFixture.toggle();
    });
    await page.waitForFunction(() => window.previewFixture.calls.some((c) => c.kind === "capture"));
    await page.evaluate(() => window.previewFixture.toggle());
    await page.waitForTimeout(350);
    expect(await width(page)).toBeLessThan(1000);
    expect((await calls(page)).map((c) => c.kind)).toEqual(["capture"]);
    await expect(image(page)).toHaveCount(0);
  });
  await scenario(
    "overlapping theme menu holds the preview hidden after layout finishes",
    async (page) => {
      await page.getByRole("button", { name: /选择主题/ }).click();
      await page.waitForFunction(() => window.previewFixture.calls.some((c) => c.kind === "hide"));
      await page.evaluate(() => {
        window.previewFixture.calls = [];
        window.previewFixture.toggle();
      });
      await expect.poll(() => width(page)).toBeGreaterThan(1100);
      await page.waitForTimeout(150);
      expect((await calls(page)).some((c) => c.kind === "show")).toBe(false);
      await expect(image(page)).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await calls(page)).some((c) => c.kind === "show")).toBe(true);
      await expect(image(page)).toHaveCount(0);
    },
  );
  for (const action of ["activate", "unmount"] as const) {
    await scenario(
      `${action} cancels capture without waiting or restoring stale content`,
      async (page) => {
        await page.evaluate(() => {
          window.previewFixture.captureDelay = 900;
          window.previewFixture.toggle();
        });
        await page.waitForFunction(() =>
          window.previewFixture.calls.some((c) => c.kind === "capture"),
        );
        await page.evaluate((action) => {
          if (action === "activate") window.previewFixture.activate(false);
          else window.previewFixture.unmount();
        }, action);
        await page.waitForFunction(
          (kind) => window.previewFixture.calls.some((c) => c.kind === kind),
          action === "activate" ? "hide" : "close",
          { timeout: 350 },
        );
        await page.waitForTimeout(950);
        expect((await calls(page)).some((c) => c.kind === "show")).toBe(false);
        await expect(image(page)).toHaveCount(0);
      },
    );
  }
  await scenario("split panes capture in parallel and each recover independently", async (page) => {
    await page.evaluate(() => window.previewFixture.split());
    await expect(page.locator("[data-isolated-preview]")).toHaveCount(2);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      window.previewFixture.calls = [];
      window.previewFixture.captureDelay = 80;
    });
    await page.locator("#toggle").click();
    await expect
      .poll(async () => (await calls(page)).filter((c) => c.kind === "show").length)
      .toBe(2);
    const log = await calls(page);
    expect(log.filter((c) => c.kind === "capture").length).toBe(2);
    expect(log.filter((c) => c.kind === "hide").every((c) => c.cover)).toBe(true);
    expect(
      log
        .filter((c) => c.kind === "capture")
        .every((c) => c.time < log.find((c) => c.kind === "hide")!.time),
    ).toBe(true);
    await expect(image(page)).toHaveCount(0);
  });
} finally {
  await browser.close();
}
console.log("Native APIs were mocked; Windows compositor/MSI visual acceptance remains separate.");
