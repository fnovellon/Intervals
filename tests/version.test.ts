import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/changelog";
import { APP_VERSION } from "../src/version";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const changelog = parseChangelog(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
const SEMVER = /^\d+\.\d+\.\d+$/;

describe("version and changelog", () => {
  it("package.json holds a semantic version and the app reports the same one", () => {
    expect(pkg.version).toMatch(SEMVER);
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("the newest changelog entry is the current version", () => {
    expect(changelog.length).toBeGreaterThan(0);
    expect(changelog[0].version).toBe(pkg.version);
  });

  it("every release has a unique, descending version, a date and some content", () => {
    const seen = new Set<string>();
    let previous: number[] | undefined;
    for (const r of changelog) {
      expect(r.version, "semantic version").toMatch(SEMVER);
      expect(seen.has(r.version), `duplicate ${r.version}`).toBe(false);
      seen.add(r.version);
      expect(r.date, `date of ${r.version}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.sections.length, `content of ${r.version}`).toBeGreaterThan(0);
      r.sections.forEach((s) => {
        expect(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]).toContain(s.title);
        expect(s.items.length).toBeGreaterThan(0);
      });
      const parts = r.version.split(".").map(Number);
      if (previous) {
        const newer = previous[0] - parts[0] || previous[1] - parts[1] || previous[2] - parts[2];
        expect(newer, `${r.version} must be older than the entry above`).toBeGreaterThan(0);
      }
      previous = parts;
    }
  });

  it("parses headings, sections and wrapped list items", () => {
    const parsed = parseChangelog("# T\n\nintro\n\n## [1.2.3] - 2026-01-02\n\n### Fixed\n- one\n  continued\n- two\n\n## [1.0.0]\n### Added\n- x\n");
    expect(parsed).toEqual([
      { version: "1.2.3", date: "2026-01-02", sections: [{ title: "Fixed", items: ["one continued", "two"] }] },
      { version: "1.0.0", sections: [{ title: "Added", items: ["x"] }] },
    ]);
  });
});
