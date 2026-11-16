export const PUBLIC_PRODUCT_CATEGORY = "智能体专属电脑";

const titleLead = "给智能体一台";
const titleEmphasis = "专属电脑";

export const LANDING_HERO_COPY = {
  eyebrowLead: PUBLIC_PRODUCT_CATEGORY,
  eyebrowTail: "独立 Linux · 多端接续",
  titleLead,
  titleEmphasis,
  title: `${titleLead}${titleEmphasis}`,
  benefitLine: "让 AI 全天候为你工作",
  description:
    "为智能体准备一台独立的 Linux 电脑。在应用商店一键安装codex、gemini、grok、kimi等智能体应用后，即使关掉浏览器，任务也不会中断。电脑、平板或手机都能随时回来查看和操作。",
} as const;

export const PUBLIC_POSITIONING_COPY = {
  footer: `人人Codex · ${PUBLIC_PRODUCT_CATEGORY}`,
  authTagline: `${PUBLIC_PRODUCT_CATEGORY} · 独立 Linux，全天候运行`,
  seoTitle: `人人Codex｜${LANDING_HERO_COPY.title}`,
  seoDescription:
    "人人Codex 为智能体提供独立、全天候运行的 Linux 电脑。任务断线不中断，终端、文件和端口预览可在 Web、Windows 与移动端随时接续；编程智能体是其中一种用法。",
  defaultDescription: "智能体专属电脑：独立 Linux 环境，全天候持续运行",
  registerDescription: "注册人人Codex，为智能体创建一台全天候运行的专属 Linux 电脑。",
} as const;
