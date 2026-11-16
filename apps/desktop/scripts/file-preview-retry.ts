import { expect, type Locator, type Page } from "@playwright/test";

const origin = "https://retry-images.example.com";
const failures = ["rate400", "rate429", "invalid", "offline"];
const imageUrl = (name: string) => `${origin}/${name}.svg?theme=dark#chart`;
const networkUrl = (name: string) => imageUrl(name).split("#")[0]!;
export const retryPreviewSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="green"/></svg>';
export const retryPreviewMarkdown = [
  "# Reading during retry",
  `![good](${imageUrl("good")})`,
  "![local](local.svg)",
  ...Array.from({ length: 150 }, (_, i) => `## Paragraph ${i}\n\nReading content ${i}.`),
  ...failures.map((name) => `![${name}](${imageUrl(name)})`),
].join("\n\n");

/** First load fails in four different ways; an explicit retry receives a valid SVG. */
export async function mockPreviewImageRetries(page: Page): Promise<string[]> {
  const requests: string[] = [];
  await page.route(`${origin}/**`, (route) => {
    const url = route.request().url();
    const first = !requests.includes(url);
    requests.push(url);
    expect(route.request().headers().referer).toBeUndefined();
    expect(route.request().headers().origin).toBeUndefined();
    const headers = { "Cache-Control": "no-store" };
    if (first && (url === networkUrl("rate400") || url === networkUrl("rate429")))
      return route.fulfill({
        status: url === networkUrl("rate400") ? 400 : 429,
        contentType: "text/plain",
        headers,
        body: '{"error":"rate limited, please try again later"}',
      });
    if (first && url === networkUrl("invalid"))
      return route.fulfill({ contentType: "image/svg+xml", headers, body: "not an image" });
    if (first && url === networkUrl("offline")) return route.abort();
    return route.fulfill({ contentType: "image/svg+xml", headers, body: retryPreviewSvg });
  });
  return requests;
}

/** Same assertions run against the full Web workbench and actual Desktop preview/CSP. */
export async function checkPreviewImageRetries(page: Page, preview: Locator, requests: string[]) {
  const status = preview.getByRole("status");
  const reading = preview.locator(".cm-markdown");
  const good = preview.getByRole("img", { name: "good", exact: true });
  const local = preview.getByRole("img", { name: "local", exact: true });
  await expect(preview.getByRole("button", { name: "本次允许加载" })).toHaveCount(0);
  for (const image of [good, local])
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(32);
  await reading.evaluate((element) => (element.scrollTop = element.scrollHeight));
  await expect(status).toHaveText("4 个外部图片加载失败");
  await expect(preview.locator("details")).not.toHaveAttribute("open", "");
  await expect(preview.locator("details")).toContainText("图片未能显示");
  await expect(preview.locator("details")).not.toContainText("HTTP");
  await reading.evaluate((element) => (element.scrollTop = 1200));
  const originalReading = await reading.elementHandle();
  const originalGood = await good.elementHandle();
  const originalLocal = await local.elementHandle();
  expect(requests.slice().sort()).toEqual(["good", ...failures].map(networkUrl).sort());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await preview.getByRole("button", { name: "重试失败图片" }).click();
  for (const name of failures) {
    const image = preview.getByRole("img", { name, exact: true });
    await expect(image).toHaveAttribute("src", imageUrl(name));
    await expect(image).toHaveAttribute("loading", "eager");
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(32);
    expect(requests.filter((url) => url === networkUrl(name))).toHaveLength(2);
  }
  await expect(status).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "本次允许加载" })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "重试失败图片" })).toHaveCount(0);
  expect(await reading.evaluate((element, saved) => element === saved, originalReading)).toBe(true);
  expect(await good.evaluate((element, saved) => element === saved, originalGood)).toBe(true);
  expect(await local.evaluate((element, saved) => element === saved, originalLocal)).toBe(true);
  await expect.poll(() => reading.evaluate((element) => element.scrollTop)).toBe(1200);
  expect(requests.filter((url) => url === networkUrl("good"))).toHaveLength(1);
  expect(requests).toHaveLength(9);
}
