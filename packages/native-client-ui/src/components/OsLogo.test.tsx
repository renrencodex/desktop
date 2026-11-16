import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OsLogo } from "./OsLogo";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("openEuler 与 openSUSE 的图形资源会被打包到 Desktop", async () => {
  const markup = renderToStaticMarkup(
    h(
      "div",
      null,
      h(OsLogo, { osId: "openEuler", label: "openEuler", size: 18 }),
      h(OsLogo, { osId: "opensuse", label: "openSUSE Leap", size: 18 }),
    ),
  );
  const sources = ["/os-logos/openeuler.png", "/os-logos/opensuse.png"];

  for (const source of sources) {
    expect(markup).toContain(`src="${source}"`);
    const asset = await readFile(resolve(import.meta.dir, "../../public", source.slice(1)));
    expect(asset.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
  }
  expect(markup).toContain('width="18" height="18"');
  expect(markup).toContain('width="36" height="18"');
});

test("已知 SVG 系统和未知系统继续使用原有渲染方式", () => {
  const known = renderToStaticMarkup(h(OsLogo, { osId: "ubuntu", size: 16 }));
  const unknown = renderToStaticMarkup(
    h(OsLogo, { osId: "example", label: "Example Linux", size: 16 }),
  );

  expect(known.startsWith("<svg")).toBe(true);
  expect(unknown).toContain(">E</span>");
});
