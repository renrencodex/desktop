import type { HostNavigation } from "@cloud-machine/workspace-ui";

/** 切换已挂载的工作区时仍由宿主提交路由，不能只改浏览器地址。 */
export function navigateRetainedWorkspace(
  navigation: HostNavigation,
  href: string,
  replace: boolean,
): void {
  if (replace) navigation.replace(href);
  else navigation.push(href);
}
