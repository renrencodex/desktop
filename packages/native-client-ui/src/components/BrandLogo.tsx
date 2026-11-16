export function BrandLogo({
  className,
  mark = "terminal",
}: {
  className?: string;
  mark?: "terminal" | "app-icon";
}) {
  return (
    <span
      className={["inline-flex items-center gap-0.5 font-semibold tracking-tight", className]
        .filter(Boolean)
        .join(" ")}
    >
      {mark === "app-icon" ? (
        <img
          aria-hidden="true"
          src="/brand/256x256.png"
          className="brand-logo-image h-[1.25em] w-[1.25em] shrink-0"
          alt=""
        />
      ) : (
        <svg aria-hidden="true" viewBox="30 115 180 115" className="h-[0.9em] w-auto shrink-0">
          <path
            d="M76 56V171L366 305Q386 314 405.5 320Q425 326 436 329Q425 331 405 337Q385 343 366 351L76 486V603L524 392V267Z"
            transform="translate(27.02 227.4) scale(0.17 -0.17)"
            fill="#7FA98F"
          />
          <path
            d="M60 -138V-25H540V-138Z"
            transform="translate(106.24 194.28) scale(0.17 -0.17)"
            fill="#7FA98F"
          />
        </svg>
      )}
      <span className="brand-logo-wordmark">人人Codex</span>
    </span>
  );
}
