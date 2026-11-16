import { describe, expect, test } from "bun:test";

import {
  stableVersionsFromGitHubReleases,
  validateReleaseMetadata,
  versionFromReleaseTag,
} from "./validate-release";

const sha = "1234567890abcdef1234567890abcdef12345678";

describe("official Desktop release source", () => {
  test("accepts an exact stable tag for a production snapshot", () => {
    expect(
      validateReleaseMetadata({
        repository: "renrencodex/desktop",
        refType: "tag",
        tag: "v0.2.13",
        githubSha: sha,
        headSha: sha,
        version: "0.2.13",
        snapshotChannel: "production",
        snapshotCommit: sha,
      }),
    ).toBe("0.2.13");
  });

  test("rejects malformed, prerelease, and mismatched tags", () => {
    for (const tag of ["0.2.13", "v0.2", "v01.2.3", "v0.2.13-beta.1"]) {
      expect(() => versionFromReleaseTag(tag)).toThrow("v<stable-semver>");
    }
    expect(() =>
      validateReleaseMetadata({
        repository: "renrencodex/desktop",
        refType: "tag",
        tag: "v0.2.14",
        githubSha: sha,
        headSha: sha,
        version: "0.2.13",
        snapshotChannel: "production",
        snapshotCommit: sha,
      }),
    ).toThrow("does not match");
  });

  test("rejects forks, branch refs, detached commits, and non-production snapshots", () => {
    const valid = {
      repository: "renrencodex/desktop",
      refType: "tag",
      tag: "v0.2.13",
      githubSha: sha,
      headSha: sha,
      version: "0.2.13",
      snapshotChannel: "production",
      snapshotCommit: sha,
    } as const;

    expect(() => validateReleaseMetadata({ ...valid, repository: "fork/desktop" })).toThrow(
      "only run",
    );
    expect(() => validateReleaseMetadata({ ...valid, refType: "branch" })).toThrow("tag ref");
    expect(() => validateReleaseMetadata({ ...valid, headSha: "f".repeat(40) })).toThrow(
      "does not match",
    );
    expect(() => validateReleaseMetadata({ ...valid, snapshotChannel: "main" })).toThrow(
      "production",
    );
    expect(() => validateReleaseMetadata({ ...valid, snapshotCommit: "short" })).toThrow(
      "full lowercase",
    );
  });

  test("uses only published stable Desktop tags for monotonic GitHub release checks", () => {
    expect(
      stableVersionsFromGitHubReleases([
        { tag_name: "v0.2.12", draft: false, prerelease: false },
        { tag_name: "v0.2.13", draft: true, prerelease: false },
        { tag_name: "v0.3.0-beta.1", draft: false, prerelease: true },
        { tag_name: "docs-v1", draft: false, prerelease: false },
      ]),
    ).toEqual(["0.2.12"]);
    expect(() => stableVersionsFromGitHubReleases({})).toThrow("not an array");
    expect(() => stableVersionsFromGitHubReleases([{}])).toThrow("no tag name");
  });
});
