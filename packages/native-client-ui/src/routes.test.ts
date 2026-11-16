import { describe, expect, test } from "bun:test";

import { parseClientRoute } from "./routes";

describe("parseClientRoute", () => {
  test("maps the desktop root and legacy directory route to canonical locations", () => {
    expect(parseClientRoute("/")).toEqual({ kind: "redirect", to: "/machines" });
    expect(
      parseClientRoute(
        "/machines/machine-a/workspaces/workspace-old/directories/workspace-current",
      ),
    ).toEqual({
      kind: "redirect",
      to: "/machines/machine-a/workspaces/workspace-current",
    });
  });

  test("recognizes all authenticated management routes", () => {
    expect(parseClientRoute("/machines")).toEqual({ kind: "machines" });
    expect(parseClientRoute("/machines/new")).toEqual({ kind: "new-machine" });
    expect(parseClientRoute("/machines/machine%20a")).toEqual({
      kind: "machine",
      machineId: "machine a",
    });
    expect(parseClientRoute("/machines/machine-a/provisioning")).toEqual({
      kind: "provisioning",
      machineId: "machine-a",
    });
    expect(parseClientRoute("/settings/wallet")).toEqual({
      kind: "settings",
      section: "wallet",
    });
    expect(parseClientRoute("/settings/about")).toEqual({
      kind: "settings",
      section: "about",
    });
    expect(parseClientRoute("/settings/referrals")).toEqual({
      kind: "settings",
      section: "referrals",
    });
    expect(parseClientRoute("/referrals/accept")).toEqual({ kind: "not-found" });
    expect(parseClientRoute("/settings/models")).toEqual({ kind: "redirect", to: "/settings" });
  });

  test("keeps workspace rendering in the retained shell and rejects unknown routes", () => {
    expect(parseClientRoute("/machines/machine-a/workspaces/workspace-a")).toEqual({
      kind: "workspace",
    });
    expect(parseClientRoute("/unknown")).toEqual({ kind: "not-found" });
    expect(parseClientRoute("/machines/%E0%A4%A")).toEqual({ kind: "not-found" });
  });
});
