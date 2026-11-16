interface ComputeResourcesIconProps {
  className?: string;
  size?: number;
}

/** 计算资源统一使用的双显示器图标。 */
export function ComputeResourcesIcon({ className, size = 13 }: ComputeResourcesIconProps) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M8 5V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2m0 0v4h3" />
      <rect x={2} y={8} width={13} height={10} rx={2} />
      <path d="M8.5 18v4M5 22h7" />
    </svg>
  );
}
