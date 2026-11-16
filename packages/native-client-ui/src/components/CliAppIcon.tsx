import type { CliApp, CliAppId } from "@cloud-machine/client-contracts";

export function CliAppIcon({
  icon,
  size = 32,
}: {
  appId: CliAppId;
  icon?: CliApp["icon"];
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={icon?.viewBox ?? "0 0 24 24"}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={icon?.path ?? "M3 3h18v18H3zM6 6v12h12V6z"} />
    </svg>
  );
}
