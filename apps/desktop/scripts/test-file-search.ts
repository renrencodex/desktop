import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { THEME_DEFINITIONS } from "@cloud-machine/native-client-ui/lib/themes";
import type {} from "./file-search.fixture";

// Render the shared component with each client's actual CSS, without API/DB/VM access.
const clients = [
  { name: "Web", root: new URL("../../web/", import.meta.url) },
  { name: "Desktop", root: new URL("../", import.meta.url) },
];
const viewports = [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "tablet-portrait", width: 820, height: 1180, touch: true },
  { name: "tablet-landscape", width: 1180, height: 820, touch: true },
  { name: "mobile", width: 390, height: 844, touch: true },
  { name: "mobile-small", width: 360, height: 800, touch: true },
];
const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./file-search.fixture.tsx", import.meta.url))],
  target: "browser",
  format: "iife",
  write: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!bundle.success) throw Error(bundle.logs.join("\n"));
const script = await bundle.outputs[0]!.text();
const browser = await chromium.launch({ headless: true });
try {
  for (const client of clients) {
    const server = await createServer({
      configFile: false,
      root: fileURLToPath(client.root),
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
    for (const viewport of viewports) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        isMobile: viewport.width < 640,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.route("https://file-search.local/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>',
          }),
        );
        await page.goto("https://file-search.local/");
        await page.addStyleTag({ content: css });
        if (client.name === "Web") {
          // Next's root layout normally supplies these variables; keep its fallback stack valid.
          await page.addStyleTag({
            content: ':root { --font-geist-sans: "Geist"; --font-geist-mono: "Geist Mono"; }',
          });
        }
        // Minimal Linux runners may not have a CJK font; visual inspection can supply one
        // without installing fonts or changing the real application's assets.
        if (process.env.FILE_SEARCH_FONT_FILE) {
          await page.route("https://file-search.local/test-font.otf", (route) =>
            route.fulfill({ contentType: "font/otf", path: process.env.FILE_SEARCH_FONT_FILE! }),
          );
          await page.addStyleTag({
            content:
              '@font-face { font-family: "Noto Sans SC"; src: url("/test-font.otf") format("opentype"); }',
          });
          await page.evaluate(() => document.fonts.load('12px "Noto Sans SC"'));
        }
        await page.addScriptTag({ content: script });
        const panel = page.getByRole("region", { name: "工作区文件搜索" });
        const query = panel.getByRole("textbox", { name: "搜索关键字" });
        const submit = panel.getByRole("button", { name: "搜索", exact: true });
        const caseSensitive = panel.getByRole("button", { name: "区分大小写", exact: true });
        const includeIgnored = panel.getByRole("button", { name: "包含忽略项", exact: true });
        await expect(query).toBeFocused();
        await expect(submit).toBeDisabled();

        for (const theme of THEME_DEFINITIONS) {
          await page.locator("html").evaluate(
            (element, value) => {
              element.dataset.theme = value.id;
              element.classList.toggle("light", value.colorScheme === "light");
              element.classList.toggle("dark", value.colorScheme === "dark");
            },
            { id: theme.id, colorScheme: theme.colorScheme },
          );
          await query.focus();
          await expect(query).toHaveCSS("border-top-width", "1px");
          await expect(query).toHaveCSS("outline-style", "none");
          await expect(query).toHaveCSS("box-shadow", "none");
          const border = await query.evaluate((element) => getComputedStyle(element).borderColor);
          await query.fill("needle");
          await submit.focus();
          expect(await query.evaluate((element) => getComputedStyle(element).borderColor)).not.toBe(
            border,
          );
          await expect(submit).toHaveCSS("height", viewport.touch ? "32px" : "24px");
          await expect(submit).toHaveCSS("font-size", "11px");
          expect((await submit.boundingBox())!.width).toBeLessThan(50);

          const before = await includeIgnored.boundingBox();
          await caseSensitive.focus();
          await caseSensitive.press("Space");
          await expect(caseSensitive).toHaveAttribute("aria-pressed", "true");
          await expect(caseSensitive.locator("svg")).toHaveCSS("opacity", "1");
          expect(await includeIgnored.boundingBox()).toEqual(before);
          await includeIgnored.click();
          await expect(includeIgnored).toHaveAttribute("aria-pressed", "true");
          await expect(query).toHaveValue("needle");
          expect(await page.evaluate(() => window.fileSearchFixture.submissions)).toHaveLength(0);
          if (process.env.FILE_SEARCH_SCREENSHOTS_DIR && viewport.name === "desktop") {
            await query.focus();
            await panel.screenshot({
              path: join(process.env.FILE_SEARCH_SCREENSHOTS_DIR, `${client.name}-${theme.id}.png`),
            });
          }
          await caseSensitive.click();
          await includeIgnored.click();
          await expect(caseSensitive).toHaveAttribute("aria-pressed", "false");
          await expect(includeIgnored).toHaveAttribute("aria-pressed", "false");
          await expect(caseSensitive.locator("svg")).toHaveCSS("opacity", "0");
        }

        await caseSensitive.click();
        await includeIgnored.click();
        await panel.getByRole("combobox", { name: "搜索类型" }).selectOption("name");
        await query.press("Enter");
        expect(await page.evaluate(() => window.fileSearchFixture.submissions)).toEqual([
          { query: "needle", mode: "name", caseSensitive: true, includeIgnored: true },
        ]);
        await expect(panel.getByRole("button", { name: "停止", exact: true })).toBeVisible();
        // Narrow resource panes must fit even while both Search and Stop are present.
        await page
          .getByTestId("search-host")
          .evaluate((element) => (element.style.width = "220px"));
        for (const element of [
          panel,
          panel.locator(".cm-file-search-query-row"),
          panel.locator(".cm-file-search-filters"),
        ]) {
          expect(
            await element.evaluate((node) => node.scrollWidth - node.clientWidth),
          ).toBeLessThanOrEqual(1);
        }
        await query.press("Escape");
        await expect(panel.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
        await expect(query).toHaveValue("needle");
        expect(await page.evaluate(() => window.fileSearchFixture.backCount)).toBe(1);
        expect(errors).toEqual([]);
        console.log(
          `PASS: ${client.name} ${viewport.name}, ${THEME_DEFINITIONS.length} themes, focus/options/compact layout`,
        );
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
