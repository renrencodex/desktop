import { chromium, expect } from "@playwright/test";

// Chromium regression only: this checks the browser behavior expected from Tauri's native window
// theme propagation, but does not exercise Tauri IPC or a real Windows WebView2 instance.
const browser = await chromium.launch({ headless: true });
try {
  for (const system of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme: system });
    await context.route("https://preview-theme.local/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<style>
          body { background: white; color: black }
          @media (prefers-color-scheme: dark) { body { background: black; color: white } }
          #fixed { background: white }
        </style><input id="draft"><div id="fixed">Fixed website color</div>
        <script>document.documentElement.dataset.initialDark = String(matchMedia('(prefers-color-scheme: dark)').matches)</script>`,
      }),
    );
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    for (const page of pages) {
      const selected = system === "light" ? "dark" : "light";
      const setTheme = (theme: "light" | "dark") => page.emulateMedia({ colorScheme: theme });
      await setTheme(selected);
      await page.goto("https://preview-theme.local/first");
      await expect(page.locator("html")).toHaveAttribute(
        "data-initial-dark",
        String(selected === "dark"),
      );
      await page.locator("#draft").fill("unsaved draft");
      for (const theme of ["dark", "light", "dark"] as const) {
        await setTheme(theme);
        await expect(page.locator("body")).toHaveCSS(
          "background-color",
          theme === "dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
        );
        await expect(page.locator("#draft")).toHaveValue("unsaved draft");
        await expect(page.locator("#fixed")).toHaveCSS("background-color", "rgb(255, 255, 255)");
      }
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-initial-dark", "true");
      await page.goto("https://preview-theme.local/next");
      await expect(page.locator("html")).toHaveAttribute("data-initial-dark", "true");
    }
    await context.close();
    console.log(
      `PASS: ${system} host preference: initial load, two pages, live changes, draft preservation, reload and navigation`,
    );
  }
} finally {
  await browser.close();
}
