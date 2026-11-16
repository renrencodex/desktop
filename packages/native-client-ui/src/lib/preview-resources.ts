import { parse, serialize, defaultTreeAdapter, type DefaultTreeAdapterTypes as Html } from "parse5";
import { parse as parseCss, generate, walk, type CssNode } from "css-tree";
import {
  PreviewResourceError,
  previewResourceIssue,
  type PreviewResourceIssue,
} from "@cloud-machine/workspace-ui/file-preview-policy";
import { baseName } from "./fs-utils";
import { hasPreviewControl, previewFormat, resolvePreviewPath } from "./file-preview";

export const PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; media-src blob: data:; font-src blob: data:; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_TOTAL = 25 * 1024 * 1024;
const MAX_ASSETS = 64;
const MAX_DEPTH = 4;
const fonts: Record<string, string> = {
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};
function assetMime(path: string): string | null {
  const ext = baseName(path).split(".").at(-1)!.toLowerCase();
  if (ext === "css") return "text/css";
  if (fonts[ext]) return fonts[ext]!;
  const format = previewFormat(path);
  return format && ["image", "svg", "audio", "video"].includes(format.kind) ? format.mime : null;
}
type Asset = { path: string; mime: string; bytes: Uint8Array };

/** 所有资源先读取为字节，再发布由本会话持有的 Blob URL。没有 fetch 或浏览器 DOM 解析。 */
export class PreviewResources {
  readonly issues = new Map<string, PreviewResourceIssue>();
  private readonly assets = new Map<string, Promise<Asset>>();
  private readonly urls = new Map<string, string>();
  private readonly urlFactory: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  private total = 0;
  private readQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  constructor(
    private readonly options: {
      rootPath: string;
      signal: AbortSignal;
      read: (path: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
      urls?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
    },
  ) {
    this.urlFactory = options.urls ?? URL;
  }

  dispose() {
    this.disposed = true;
    for (const url of this.urls.values()) this.urlFactory.revokeObjectURL(url);
    this.urls.clear();
    this.assets.clear();
  }
  private check() {
    this.options.signal.throwIfAborted();
    if (this.disposed) throw new DOMException("预览已关闭", "AbortError");
  }
  private report(reference: string, error: unknown) {
    this.issues.set(reference, previewResourceIssue(reference, error));
  }
  private async asset(documentPath: string, reference: string): Promise<Asset> {
    this.check();
    const path = resolvePreviewPath(documentPath, reference, this.options.rootPath);
    if (!path) {
      if (/^(?:https?:|\/\/)/i.test(reference.trim()))
        throw new PreviewResourceError("external-blocked", "此类预览不允许外部资源");
      throw new PreviewResourceError("invalid-reference", "地址不允许或超出文件预览范围");
    }
    const mime = assetMime(path);
    if (!mime) throw new Error("不支持的依赖资源");
    let pending = this.assets.get(path);
    if (!pending) {
      if (this.assets.size >= MAX_ASSETS) throw new Error("依赖资源超过 64 个");
      // Markdown 图片可同时挂载；排队后再计算剩余预算，避免并发读取
      // 各自使用旧预算，瞬间读入远超 25 MiB 的依赖数据。
      pending = this.readQueue.then(async () => {
        this.check();
        const budget = Math.min(MAX_ASSET_BYTES, MAX_ASSET_TOTAL - this.total);
        if (budget <= 0) throw new Error("依赖资源超过大小上限");
        const bytes = await this.options.read(path, budget, this.options.signal);
        this.check();
        if (bytes.length > MAX_ASSET_BYTES || this.total + bytes.length > MAX_ASSET_TOTAL)
          throw new Error("依赖资源超过大小上限");
        this.total += bytes.length;
        return { path, mime, bytes };
      });
      this.readQueue = pending.then(
        () => {},
        () => {},
      );
      this.assets.set(path, pending);
    }
    return pending;
  }
  async image(documentPath: string, reference: string): Promise<string | null> {
    return this.url(documentPath, reference, "image");
  }
  private async url(
    documentPath: string,
    reference: string,
    category: "image" | "media" | "css",
  ): Promise<string | null> {
    try {
      // 限制内嵌资源类型；任意 data:text/html 或用户提供的 blob: 永不放行。
      if (
        category === "image" &&
        /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=]+$/i.test(reference)
      ) {
        if (reference.length > MAX_ASSET_BYTES) throw new Error("内嵌图片超过上限");
        return reference;
      }
      const asset = await this.asset(documentPath, reference);
      if (category === "image" && !asset.mime.startsWith("image/")) throw new Error("引用不是图片");
      if (category === "media" && !/^(audio|video)\//.test(asset.mime))
        throw new Error("引用不是音视频");
      this.check();
      let url = this.urls.get(asset.path);
      if (!url) {
        url = this.urlFactory.createObjectURL(
          new Blob([asset.bytes as BlobPart], { type: asset.mime }),
        );
        this.urls.set(asset.path, url);
      }
      return url;
    } catch (error) {
      this.check();
      this.report(reference, error);
      return null;
    }
  }
  async css(content: string, path: string, ancestors: string[] = []): Promise<string> {
    if (ancestors.length >= MAX_DEPTH || ancestors.includes(path)) {
      this.report(path, new Error("CSS 引用循环或超过深度 4"));
      return "";
    }
    const chain = [...ancestors, path];
    let ast: CssNode;
    try {
      ast = parseCss(content, { parseCustomProperty: true });
    } catch {
      this.report(path, new Error("CSS 无法解析"));
      return "";
    }
    const imports: Array<{ node: CssNode; reference: string }> = [];
    const urls: Array<Extract<CssNode, { type: "Url" }>> = [];
    // 未识别的 Raw 不允许透传，避免藏在解析失败片段中的外网请求。
    walk(ast, function (node, item, list) {
      if (node.type === "Raw" && item && list) list.remove(item);
      if (node.type === "Url" && this.atrule?.name.toLowerCase() !== "import") urls.push(node);
      if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
        let reference = "";
        if (node.prelude)
          walk(node.prelude, (child) => {
            if (child.type === "Url" || child.type === "String") reference ||= child.value;
          });
        imports.push({ node, reference });
        if (item && list) list.remove(item);
      }
    });
    const imported: string[] = [];
    for (const entry of imports) {
      try {
        const asset = await this.asset(path, entry.reference);
        if (asset.mime !== "text/css") throw new Error("CSS 引用类型错误");
        const css = await this.css(new TextDecoder().decode(asset.bytes), asset.path, chain);
        const prelude =
          entry.node.type === "Atrule" && entry.node.prelude ? generate(entry.node.prelude) : "";
        // 只保留无媒体条件的 import；条件复杂时提示而不是错误地无条件应用。
        if (prelude.replace(/^(?:url\([^)]*\)|"[^"]*"|'[^']*')\s*/, ""))
          this.report(entry.reference, new Error("带条件的 CSS import 未加载"));
        else imported.push(css);
      } catch (error) {
        this.check();
        this.report(entry.reference, error);
      }
    }
    for (const node of urls) {
      if (node.value.startsWith("#")) continue;
      node.value = (await this.url(path, node.value, "css")) ?? "data:,";
    }
    this.check();
    // style 是 HTML raw-text 元素，CSS 字符串中的 </style> 也会提前结束它。
    // CSS 转义保持样式含义，同时避免导入样式绕过前面的 HTML 清理。
    return (imported.join("\n") + "\n" + generate(ast)).replace(/</g, "\\3c ");
  }
  async html(content: string, path: string): Promise<string> {
    const document = parse(content, { scriptingEnabled: false });
    const blocked = new Set([
      "script",
      "iframe",
      "object",
      "embed",
      "base",
      "meta",
      "template",
      "noscript",
    ]);
    const visit = async (parent: Html.ParentNode) => {
      for (const node of [...parent.childNodes]) {
        if (!("tagName" in node)) continue;
        if (blocked.has(node.tagName)) {
          parent.childNodes = parent.childNodes.filter((child) => child !== node);
          continue;
        }
        const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
        if (node.tagName === "link") {
          if (attrs.get("rel")?.toLowerCase() === "stylesheet" && attrs.get("href")) {
            try {
              const asset = await this.asset(path, attrs.get("href")!);
              if (asset.mime !== "text/css") throw new Error("样式引用类型错误");
              node.tagName = node.nodeName = "style";
              node.attrs = [];
              node.childNodes = [
                {
                  nodeName: "#text",
                  value: await this.css(new TextDecoder().decode(asset.bytes), asset.path),
                  parentNode: node,
                },
              ];
            } catch (error) {
              this.check();
              this.report(attrs.get("href")!, error);
              parent.childNodes = parent.childNodes.filter((child) => child !== node);
            }
          } else parent.childNodes = parent.childNodes.filter((child) => child !== node);
          continue;
        }
        node.attrs = [];
        for (const attr of attrs) {
          const [name, value] = attr;
          if (
            /^on/i.test(name) ||
            [
              "srcdoc",
              "srcset",
              "ping",
              "action",
              "formaction",
              "form",
              "target",
              "background",
              "autoplay",
              "is",
            ].includes(name)
          )
            continue;
          if (name === "style") {
            const safe = await this.css(`x{${value}}`, path);
            const start = safe.indexOf("{");
            node.attrs.push({
              name,
              value: start >= 0 ? safe.slice(start + 1, safe.lastIndexOf("}")) : "",
            });
          } else if (name === "src" || name === "poster") {
            const url = await this.url(
              path,
              value,
              ["audio", "video", "source"].includes(node.tagName) && name === "src"
                ? "media"
                : "image",
            );
            if (url) node.attrs.push({ name, value: url });
          } else if (name === "href" || name === "xlink:href") {
            if (/^#[a-z\d_.:-]*$/i.test(value)) node.attrs.push({ name, value });
          } else if (!hasPreviewControl(value)) node.attrs.push({ name, value });
        }
        if (node.tagName === "style") {
          const css = node.childNodes
            .filter((child): child is Html.TextNode => child.nodeName === "#text")
            .map((child) => child.value)
            .join("");
          node.childNodes = [
            { nodeName: "#text", value: await this.css(css, path), parentNode: node },
          ];
        } else await visit(node);
      }
    };
    await visit(document);
    this.check();
    // parse5 会补齐 html/head；直接操作节点，带属性的 head 也必须生效。
    const html = document.childNodes.find(
      (node): node is Html.Element => "tagName" in node && node.tagName === "html",
    );
    const head = html?.childNodes.find(
      (node): node is Html.Element => "tagName" in node && node.tagName === "head",
    );
    if (!head) throw new Error("HTML 安全策略无法设置");
    const policy = defaultTreeAdapter.createElement("meta", head.namespaceURI, [
      { name: "http-equiv", value: "Content-Security-Policy" },
      { name: "content", value: PREVIEW_CSP },
    ]);
    const referrer = defaultTreeAdapter.createElement("meta", head.namespaceURI, [
      { name: "name", value: "referrer" },
      { name: "content", value: "no-referrer" },
    ]);
    policy.parentNode = referrer.parentNode = head;
    head.childNodes.unshift(policy, referrer);
    return serialize(document);
  }
}
