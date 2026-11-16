import { chromium, expect, type Page } from "@playwright/test";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import type {} from "./theme-menu.fixture";

// Actual Desktop CSS/components. No application server, DB or Windows runtime is involved.
const root = fileURLToPath(new URL("../", import.meta.url));
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
  entrypoints: [fileURLToPath(new URL("./theme-menu.fixture.tsx", import.meta.url))],
  target: "browser",
  format: "iife",
  write: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!bundle.success) throw Error(bundle.logs.join("\n"));
const script = await bundle.outputs[0]!.text();
const browser = await chromium.launch({ headless: true });
async function scenario(
  name: string,
  run: (page: Page) => Promise<void>,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
) {
  const page = await browser.newPage({ reducedMotion });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.route("https://theme-menu.local/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" }),
    );
    await page.goto("https://theme-menu.local/");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    await run(page);
    expect(errors).toEqual([]);
    console.log(`PASS: ${name}`);
  } finally {
    await page.close();
  }
}
const trigger = (page: Page) => page.getByRole("button", { name: /选择主题/ });
try {
  await scenario(
    "selection preserves closing palette/position and commits once after exit",
    async (page) => {
      await trigger(page).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      // Stretch only duration so the closing interval is deterministic even on a busy CI runner.
      await page.addStyleTag({ content: ".cm-theme-menu[data-closed]{animation-duration:400ms}" });
      const before = await menu.boundingBox();
      await page.getByRole("menuitemradio", { name: /^绿苔/ }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "ink-white");
      expect(await page.evaluate(() => window.themeMenuFixture.blocked())).toBe(true);
      expect(await menu.boundingBox()).toEqual(before);
      await expect(menu).toHaveCSS("transform", "none");
      await expect(menu).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "night-moss");
      expect(await page.evaluate(() => window.themeMenuFixture.changes)).toEqual(["night-moss"]);
      expect(await page.evaluate(() => window.themeMenuFixture.blocked())).toBe(false);
      await expect(trigger(page)).toBeFocused();
    },
  );

  await scenario("Escape dismisses without changing theme", async (page) => {
    await trigger(page).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.getByRole("menuitemradio", { name: /^绿苔/ }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await page.evaluate(() => window.themeMenuFixture.changes)).toEqual([]);
  });

  await scenario(
    "keyboard selection works with reduced motion",
    async (page) => {
      await trigger(page).focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menu")).toBeVisible();
      await page.getByRole("menuitemradio", { name: /^绿苔/ }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "night-moss");
      expect(await page.evaluate(() => window.themeMenuFixture.changes)).toEqual(["night-moss"]);
    },
    "reduce",
  );

  await scenario("reopening during exit cancels the old selection", async (page) => {
    await trigger(page).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.addStyleTag({ content: ".cm-theme-menu[data-closed]{animation-duration:400ms}" });
    await page.getByRole("menuitemradio", { name: /^绿苔/ }).click();
    await trigger(page).evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.getByRole("menu")).toHaveAttribute("data-open", "");
    await page.getByRole("menuitemradio", { name: /^墨白/ }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await page.evaluate(() => window.themeMenuFixture.changes)).toEqual([]);
    expect(await page.evaluate(() => window.themeMenuFixture.blocked())).toBe(false);
  });

  await scenario(
    "unmount during exit discards pending selection and releases occlusion",
    async (page) => {
      await trigger(page).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.addStyleTag({ content: ".cm-theme-menu[data-closed]{animation-duration:400ms}" });
      await page.getByRole("menuitemradio", { name: /^绿苔/ }).click();
      await page.evaluate(() => window.themeMenuFixture.unmount());
      await expect(page.getByRole("menu")).toHaveCount(0);
      expect(await page.evaluate(() => window.themeMenuFixture.changes)).toEqual([]);
      expect(await page.evaluate(() => window.themeMenuFixture.blocked())).toBe(false);
    },
  );
} finally {
  await browser.close();
}
