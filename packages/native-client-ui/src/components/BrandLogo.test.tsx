import { expect, test } from "bun:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BrandLogo } from "./BrandLogo";

test("主界面品牌标识使用与 Web 一致的终端图形", () => {
  const markup = renderToStaticMarkup(h(BrandLogo, {}));

  expect(markup).toContain('<svg aria-hidden="true" viewBox="30 115 180 115"');
  expect(markup).toContain('fill="#7FA98F"');
  expect(markup).not.toContain("/brand/256x256.png");
  expect(markup).toContain("人人Codex");
});

test("授权页继续使用方形应用图标", () => {
  const markup = renderToStaticMarkup(h(BrandLogo, { mark: "app-icon" }));

  expect(markup).toContain('src="/brand/256x256.png"');
  expect(markup).not.toContain("<svg");
});
