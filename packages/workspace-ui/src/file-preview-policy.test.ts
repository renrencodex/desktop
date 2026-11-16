import { expect, test } from "bun:test";
import { classifyPreviewImageReference as classify } from "./file-preview-policy";

const origin = "https://console.example.com";
const credentialBearingUrl = ["https://user", "password@images.example.com/a.png"].join(":");

test("HTTPS 徽章无需扩展名，保留查询参数，规范化同一资源", () => {
  for (const url of [
    "https://goreportcard.com/badge/github.com/p4gefau1t/trojan-go",
    "https://img.shields.io/github/downloads/p4gefau1t/trojan-go/total?label=downloads&logo=github&style=flat",
    "https://starchart.cc/p4gefau1t/trojan-go.svg",
  ])
    expect(classify(url, origin)).toEqual({ kind: "external", url, requestKey: url });
  expect(classify(" HTTPS://Images.Example.Com.:443/badge?style=flat#view ", origin)).toEqual({
    kind: "external",
    url: "https://images.example.com/badge?style=flat#view",
    requestKey: "https://images.example.com/badge?style=flat",
  });
});

test("SVG 视图片段保留在显示地址中，仅请求数量去重忽略片段", () => {
  const requestKey = "https://images.example.com/sprite.svg?theme=dark%23light";
  for (const fragment of ["left", "right", "svgView(viewBox(100,0,100,100))"])
    expect(classify(`${requestKey}#${fragment}`, origin)).toEqual({
      kind: "external",
      url: `${requestKey}#${fragment}`,
      requestKey,
    });
});

test.each([
  "",
  "//images.example.com/a.png",
  "http://images.example.com/a.png",
  "https:images.example.com/a.png",
  "https:///localhost/a.png",
  credentialBearingUrl,
  "https://user@images.example.com/a.png",
  "https://images.example.com\\@console.example.com/a.png",
  "https://images.example.com/\na.png",
  "\thttps://images.example.com/a.png",
  "https://images.example.com/\u007fa.png",
  "https://localhost/a.png",
  "https://a.localhost./a.png",
  "https://computer.local/a.png",
  "https://computer/a.png",
  "https://127.0.0.1/a.png",
  "https://10.0.0.1/a.png",
  "https://8.8.8.8/a.png",
  "https://2130706433/a.png",
  "https://0x7f000001/a.png",
  "https://[::1]/a.png",
  "https://[::ffff:127.0.0.1]/a.png",
  "https://console.example.com/a.png",
  "https://console.example.com.:443/a.png",
  "javascript:alert(1)",
  "file:///etc/a.png",
  "blob:https://images.example.com/a",
  "https://%00.example.com/a.png",
])("拒绝非授权地址：%s", (url) => {
  expect(classify(url, origin).kind).toBe("invalid");
});

test("相对路径和 data 仍交给原有本地读取器做边界/类型检查", () => {
  for (const value of [
    "a.png",
    "../a.png",
    "/a.png",
    "a%20b.png",
    "data:image/png;base64,YQ==",
    "data:text/html,bad",
    "%2f%2fevil/x",
  ])
    expect(classify(value, origin)).toEqual({ kind: "local" });
});
