export type DesktopCallbackDisposition = "ignore" | "invalid" | "exchange";

/**
 * Only the callback for the current in-memory authorization attempt may be consumed.
 * A well-formed callback with another state is an old or forged callback and stays silent.
 */
export function classifyDesktopAuthorizationCallback(
  pending: { state: string } | null,
  callback: { state: string } | null,
): DesktopCallbackDisposition {
  if (!pending) return "ignore";
  if (!callback) return "invalid";
  return callback.state === pending.state ? "exchange" : "ignore";
}
