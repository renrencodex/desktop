/** API 统一错误：code 来自服务端错误体，status 为 HTTP 状态码。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Ticket requests that prove the caller must not retain or retry a previous machine view. */
export function isDefinitiveConnectionTicketRejection(error: unknown): boolean {
  return (
    isApiError(error) &&
    ([401, 403, 404].includes(error.status) || error.code === "MACHINE_ACCESS_SUSPENDED")
  );
}
