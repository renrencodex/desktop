import { describe, expect, test } from "bun:test";

import {
  buildDesktopAuthorizeUrl,
  createDesktopAuthorizationAttempt,
  parseDesktopAuthorizationCallback,
} from "./desktop-auth";

describe("Desktop OAuth PKCE", () => {
  test("creates high-entropy URL-safe state and an S256 challenge", async () => {
    const first = await createDesktopAuthorizationAttempt();
    const second = await createDesktopAuthorizationAttempt();
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(first.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toEqual(first);

    const url = new URL(buildDesktopAuthorizeUrl("https://cloud.example/", first, "Linux"));
    expect(url.pathname).toBe("/desktop/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(first.codeChallenge);
    expect(url.searchParams.get("state")).toBe(first.state);
  });

  test("strictly accepts only the fixed callback shape", () => {
    const code = "A".repeat(43);
    const state = "B".repeat(43);
    expect(
      parseDesktopAuthorizationCallback(`renrencodex://oauth/callback?code=${code}&state=${state}`),
    ).toEqual({ authorizationCode: code, state });

    for (const value of [
      `https://oauth/callback?code=${code}&state=${state}`,
      `renrencodex://evil/callback?code=${code}&state=${state}`,
      `renrencodex://oauth/callback?code=${code}&state=${state}&next=x`,
      `renrencodex://oauth/callback?code=${code}&code=${code}&state=${state}`,
      `renrencodex://oauth/callback?code=${code}&state=${state}#fragment`,
      `renrencodex://oauth/callback?code=short&state=${state}`,
    ]) {
      expect(parseDesktopAuthorizationCallback(value)).toBeNull();
    }
  });
});
