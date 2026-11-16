import { expect, test } from "bun:test";

import { ApiError, isDefinitiveConnectionTicketRejection } from "./error";

test("classifies only definitive connection-ticket authorization failures", () => {
  for (const status of [401, 403, 404]) {
    expect(
      isDefinitiveConnectionTicketRejection(new ApiError(status, "AUTHORIZATION_FAILED", "no")),
    ).toBe(true);
  }
  expect(
    isDefinitiveConnectionTicketRejection(
      new ApiError(409, "MACHINE_ACCESS_SUSPENDED", "suspended"),
    ),
  ).toBe(true);

  expect(
    isDefinitiveConnectionTicketRejection(new ApiError(409, "MACHINE_NOT_READY", "stopped")),
  ).toBe(false);
  expect(
    isDefinitiveConnectionTicketRejection(
      new ApiError(503, "CONNECTION_TICKET_UNAVAILABLE", "retry"),
    ),
  ).toBe(false);
  expect(isDefinitiveConnectionTicketRejection(new Error("network"))).toBe(false);
});
