import { chromium, expect, type Page } from "@playwright/test";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import type {} from "./file-preview.fixture";
import {
  checkPreviewImageRetries,
  mockPreviewImageRetries,
  retryPreviewMarkdown,
  retryPreviewSvg,
} from "./file-preview-retry";

// Real Desktop components/styles/CSP; mocked image servers, no native/VM/database operations.
const root = fileURLToPath(new URL("../", import.meta.url));
const config = await Bun.file(new URL("../src-tauri/tauri.conf.json", import.meta.url)).json();
const server = await createServer({
  configFile: false,
  root,
  plugins: [tailwindcss()],
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: null },
});
let css: string;
try {
  css = (await server.transformRequest("/src/app.css?direct"))!.code;
} finally {
  await server.close();
}
const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./file-preview.fixture.tsx", import.meta.url))],
  target: "browser",
  format: "esm",
  write: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!bundle.success) throw Error(bundle.logs.join("\n"));
const script = await bundle.outputs[0]!.text();
const references = [
  "https://goreportcard.com/badge/github.com/p4gefau1t/trojan-go",
  "https://img.shields.io/github/downloads/p4gefau1t/trojan-go/total?label=downloads&logo=github&style=flat",
  "https://starchart.cc/p4gefau1t/trojan-go.svg",
];
const markdown = references.map((url, i) => `![badge${i}](${url})`).join("\n\n");
const browser = await chromium.launch({ headless: true });
async function scenario(
  name: string,
  run: (page: Page, requests: string[]) => Promise<void>,
  options: { clock?: boolean } = {},
) {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    if (options.clock) await page.clock.install();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url === "https://desktop-preview.example/")
        return route.fulfill({
          contentType: "text/html",
          headers: { "Content-Security-Policy": config.app.security.csp },
          body: '<html><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/fixture.js"></script></body></html>',
        });
      if (url === "https://desktop-preview.example/fixture.js")
        return route.fulfill({ contentType: "text/javascript", body: script });
      if (url === "https://desktop-preview.example/fonts/Geist-Variable.woff2")
        return route.fulfill({
          contentType: "font/woff2",
          path: fileURLToPath(
            new URL(
              "../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
              import.meta.url,
            ),
          ),
        });
      if (url === "https://desktop-preview.example/fonts/GeistMono-Variable.woff2")
        return route.fulfill({
          contentType: "font/woff2",
          path: fileURLToPath(
            new URL(
              "../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
              import.meta.url,
            ),
          ),
        });
      requests.push(url);
      expect(route.request().headers().referer).toBeUndefined();
      expect(route.request().headers().origin).toBeUndefined();
      if (url.endsWith("sprite.svg"))
        return route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 200 100" preserveAspectRatio="none"><view id="left" viewBox="0 0 100 100"/><view id="right" viewBox="100 0 100 100"/><rect width="100" height="100" fill="red"/><rect x="100" width="100" height="100" fill="blue"/></svg>',
        });
      if (url.endsWith("broken"))
        return route.fulfill({ contentType: "image/png", body: "invalid" });
      if (url.endsWith("offline")) return route.abort();
      if (url.endsWith("redirect"))
        return route.fulfill({
          status: 302,
          headers: { Location: "http://images.example.com/downgraded" },
        });
      return route.fulfill({
        contentType: "image/svg+xml",
        headers: { "Cache-Control": "no-store" },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><script>parent.document.title="COMPROMISED"</script><image href="https://images.example.com/nested"/><rect width="32" height="16" fill="green"/></svg>',
      });
    });
    await page.goto("https://desktop-preview.example/");
    expect(errors).toEqual([]);
    await page.waitForFunction(() => Boolean(window.filePreviewFixture));
    await page.addStyleTag({ content: css });
    await run(page, requests);
    expect(errors).toEqual([]);
    console.log(`PASS: ${name}`);
  } finally {
    await page.close();
  }
}
const status = (page: Page) => page.locator('[role="status"]');
const allow = (page: Page) => page.getByRole("button", { name: "本次允许加载" });
try {
  await scenario(
    "inactive preview makes zero external requests and resumes automatically",
    async (page, requests) => {
      await page.evaluate(
        (text) => window.filePreviewFixture.set({ text, active: false }),
        markdown,
      );
      await expect(page.locator("[data-preview-active]")).toHaveAttribute(
        "data-preview-active",
        "false",
      );
      await expect(
        page.getByRole("region", { name: "文件预览", exact: true, includeHidden: true }),
      ).toHaveAttribute("aria-busy", "false");
      await expect(page.locator('img[src^="https:"]')).toHaveCount(0);
      await expect(allow(page)).toHaveCount(0);
      expect(requests).toEqual([]);
      await page.evaluate(() => window.filePreviewFixture.set({ active: true }));
      await expect
        .poll(() =>
          page
            .locator('img[src^="https:"]')
            .evaluateAll(
              (images) =>
                images.length === 3 &&
                images.every((image) => (image as HTMLImageElement).naturalWidth === 32),
            ),
        )
        .toBe(true);
      expect(requests.sort()).toEqual([...references].sort());
      await expect(allow(page)).toHaveCount(0);
    },
  );
  for (const withExternal of [false, true]) {
    await scenario(
      `retained reading position/local image; external images resume automatically: ${withExternal}`,
      async (page) => {
        const text = [
          "![local](local.svg)",
          ...Array.from({ length: 150 }, (_, i) => `## Paragraph ${i}\n\nReading content ${i}.`),
          ...(withExternal ? [markdown] : []),
        ].join("\n\n");
        await page.evaluate(
          (text) =>
            window.filePreviewFixture.set({
              text,
              readResource: async () =>
                new TextEncoder().encode(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>',
                ),
            }),
          text,
        );
        const local = page.getByRole("img", { name: "local", exact: true, includeHidden: true });
        await expect
          .poll(() => local.evaluate((image) => (image as HTMLImageElement).naturalWidth))
          .toBe(16);
        const reading = page.locator(".cm-markdown");
        const originalReading = await reading.elementHandle();
        const originalLocal = await local.elementHandle();
        await reading.evaluate((element) => (element.scrollTop = 1200));
        for (const active of [false, true]) {
          await page.evaluate((active) => window.filePreviewFixture.set({ active }), active);
          await expect(page.locator("[data-preview-active]")).toHaveAttribute(
            "data-preview-active",
            String(active),
          );
          await expect(status(page)).toHaveCount(0);
          await expect(page.locator('img[src^="https:"]')).toHaveCount(
            active && withExternal ? 3 : 0,
          );
          expect(
            await reading.evaluate((element, saved) => element === saved, originalReading),
          ).toBe(true);
          expect(await local.evaluate((element, saved) => element === saved, originalLocal)).toBe(
            true,
          );
          if (active)
            await expect.poll(() => reading.evaluate((element) => element.scrollTop)).toBe(1200);
        }
        if (withExternal) {
          await expect(page.locator('img[src^="https:"]')).toHaveCount(3);
          await expect(status(page)).toHaveCount(0);
        }
      },
    );
  }
  await scenario(
    "SVG fragment views render differently and share one request budget entry",
    async (page, requests) => {
      const url = "https://images.example.com/sprite.svg";
      await page.evaluate(
        (url) =>
          window.filePreviewFixture.set({ text: `![left](${url}#left)\n\n![right](${url}#right)` }),
        url,
      );
      await expect(allow(page)).toHaveCount(0);
      const left = page.getByRole("img", { name: "left", exact: true });
      const right = page.getByRole("img", { name: "right", exact: true });
      for (const [image, fragment] of [
        [left, "left"],
        [right, "right"],
      ] as const) {
        await expect(image).toHaveAttribute("src", `${url}#${fragment}`);
        await expect
          .poll(() => image.evaluate((image) => (image as HTMLImageElement).naturalWidth))
          .toBe(100);
      }
      expect((await left.screenshot()).equals(await right.screenshot())).toBe(false);
      expect([...new Set(requests)]).toEqual([url]);
    },
  );
  await scenario(
    "default image loading without confirmation under actual Desktop CSP",
    async (page, requests) => {
      await page.evaluate((text) => window.filePreviewFixture.set({ text }), markdown);
      await expect(allow(page)).toHaveCount(0);
      for (let i = 0; i < 3; i++)
        await expect
          .poll(() =>
            page
              .getByRole("img", { name: `badge${i}` })
              .evaluate((image) => (image as HTMLImageElement).naturalWidth),
          )
          .toBe(32);
      expect(requests.sort()).toEqual([...references].sort());
      expect(await page.title()).not.toBe("COMPROMISED");
      await page.setViewportSize({ width: 1100, height: 780 });
      await page.evaluate(() => (document.documentElement.dataset.theme = "night-moss"));
      await expect(allow(page)).toHaveCount(0);
      expect(requests).toHaveLength(3);
      await page.evaluate(() => window.filePreviewFixture.reopen());
      await expect
        .poll(() =>
          page
            .locator('img[src^="https:"]')
            .evaluateAll(
              (images) =>
                images.length === 3 &&
                images.every((image) => (image as HTMLImageElement).naturalWidth === 32),
            ),
        )
        .toBe(true);
      await expect(allow(page)).toHaveCount(0);
      await expect(status(page)).toHaveCount(0);
      expect([...new Set(requests)].sort()).toEqual([...references].sort());
    },
  );
  await scenario(
    "failure and HTTP downgrade stay isolated; long details fit the panel",
    async (page, requests) => {
      const text = ["broken", "offline", "redirect"]
        .map((path) => `![${path}](https://images.example.com/${path})`)
        .join("\n\n");
      await page.evaluate(
        (text) =>
          window.filePreviewFixture.set({
            text: text + "\n\n![invalid](http://images.example.com/" + "long".repeat(200) + ")",
          }),
        text,
      );
      await expect(status(page)).toHaveText("3 个外部图片加载失败；1 个资源未加载");
      await expect(page.locator("details")).not.toHaveAttribute("open", "");
      await page.locator("summary").click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(status(page)).toHaveText("3 个外部图片加载失败；1 个资源未加载");
      await expect(page.locator("img")).toHaveCount(0);
      expect(requests).toHaveLength(3);
      expect(requests.every((url) => url.startsWith("https:"))).toBe(true);
    },
  );
  await scenario(
    "manual retry recovers HTTP/non-image/offline failures without resetting reading",
    async (page) => {
      const requests = await mockPreviewImageRetries(page);
      await page.evaluate(
        ({ text, svg }) =>
          window.filePreviewFixture.set({
            text,
            readResource: async () => new TextEncoder().encode(svg),
          }),
        { text: retryPreviewMarkdown, svg: retryPreviewSvg },
      );
      await checkPreviewImageRetries(
        page,
        page.getByRole("region", { name: "文件预览", exact: true }),
        requests,
      );
    },
  );
  for (const shift of [-10_000, 3_600_000]) {
    await scenario(
      `wall-clock ${shift < 0 ? "rollback" : "forward jump"} cannot strand cooldown or change timeout`,
      async (page) => {
        let pending = false;
        let requests = 0;
        await page.route("https://images.example.com/clock.svg", (route) => {
          requests++;
          // Deliberately leave the third image request pending until the UI times out.
          if (pending) return;
          return route.abort();
        });
        await page.evaluate(() =>
          window.filePreviewFixture.set({ text: "![clock](https://images.example.com/clock.svg)" }),
        );
        const retry = page.getByRole("button", { name: "重试失败图片", exact: true });
        await expect(retry).toBeEnabled();
        await retry.click();
        await expect.poll(() => requests).toBe(2);
        await expect(retry).toBeDisabled();
        await page.clock.setSystemTime(await page.evaluate((shift) => Date.now() + shift, shift));
        await page.clock.fastForward(6_000);
        await expect(retry).toBeEnabled();
        expect(requests).toBe(2);

        pending = true;
        await retry.click();
        await expect.poll(() => requests).toBe(3);
        await page.clock.setSystemTime(await page.evaluate((shift) => Date.now() + shift, shift));
        await page.clock.fastForward(6_000);
        await expect(page.getByRole("button", { name: "重试中…", exact: true })).toBeDisabled();
        await expect(page.locator("details")).not.toContainText("重试超时");
        await page.clock.fastForward(25_000);
        await expect(retry).toBeEnabled();
        await expect(page.locator("details")).toContainText("重试超时（30 秒）");
        await expect(page.locator('img[src^="https:"]')).toHaveCount(0);
        expect(requests).toBe(3);
      },
      { clock: true },
    );
  }
  await scenario(
    "HTML retains sandbox/CSP despite automatic Markdown image loading",
    async (page, requests) => {
      await page.evaluate((text) => window.filePreviewFixture.set({ text }), markdown);
      await expect.poll(() => requests.length).toBe(3);
      await page.evaluate(() =>
        window.filePreviewFixture.set({
          path: "/workspace/a.html",
          format: { kind: "html", mime: "text/html" },
          text: '<h1>Safe HTML</h1><img src="https://images.example.com/html"><style>body{background:url(https://images.example.com/css)}</style><script>parent.document.title="COMPROMISED"</script>',
        }),
      );
      await expect(status(page)).toHaveText("已阻止 2 个外部资源");
      await expect(allow(page)).toHaveCount(0);
      await expect(page.frameLocator("iframe").getByRole("heading")).toHaveText("Safe HTML");
      await expect(page.locator("iframe")).toHaveAttribute("sandbox", "");
      expect(
        await page
          .locator("iframe")
          .evaluate((frame) => (frame as HTMLIFrameElement).contentDocument),
      ).toBeNull();
      expect(requests).toHaveLength(3);
    },
  );
} finally {
  await browser.close();
}
