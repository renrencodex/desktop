import { expect, test } from "bun:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarMachineUsage } from "./SidebarMachineMetrics";

test("Desktop 电脑条目显示网络收发速率并提供无障碍方向文本", () => {
  const markup = renderToStaticMarkup(
    h(SidebarMachineUsage, {
      usage: {
        cpu: 0.25,
        memory: 0.5,
        networkReceiveBytesPerSecond: 1_572_864,
        networkTransmitBytesPerSecond: 262_144,
      },
    }),
  );

  expect(markup).toContain('data-network-rate="receive"');
  expect(markup).toContain('data-network-rate="transmit"');
  expect(markup).toContain('<span class="sr-only">接收 1.5 MiB/s</span>');
  expect(markup).toContain('<span class="sr-only">发送 256 KiB/s</span>');
  expect(markup).toContain('aria-hidden="true"><span class="text-emerald-400">↓</span>1.5 MiB/s');
  expect(markup).toContain('aria-hidden="true"><span class="text-sky-400">↑</span>256 KiB/s');
  expect(markup).toContain("grid h-3 grid-cols-[1.375rem_minmax(0,1fr)]");
  expect(markup).toContain("justify-start gap-1");
  expect(markup).not.toContain("justify-between");
  expect(markup).toContain("text-[8px]");
  expect(markup).not.toContain("grid-rows-2");
  expect(markup).not.toContain("text-emerald-400/80");
  expect(markup).not.toContain("text-sky-400/80");
});

test("Desktop 电脑条目在等待采样和不可用时保持稳定指标高度", () => {
  const pending = renderToStaticMarkup(h(SidebarMachineUsage, {}));
  const unavailable = renderToStaticMarkup(h(SidebarMachineUsage, { unavailable: "未运行" }));

  expect(pending).toContain('<span class="sr-only">接收 暂无数据</span>');
  expect(pending).toContain('<span class="sr-only">发送 暂无数据</span>');
  expect(unavailable).toContain('class="flex h-10');
  expect(unavailable).toContain("未运行");
  expect(unavailable).not.toContain("data-network-rate");
});
