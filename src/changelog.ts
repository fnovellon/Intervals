/** A release as written in CHANGELOG.md (Keep a Changelog layout). */
export interface Release {
  version: string;
  /** ISO date, when the heading has one. */
  date?: string;
  sections: Array<{ title: string; items: string[] }>;
}

const RELEASE = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const SECTION = /^###\s+(.+?)\s*$/;
const ITEM = /^[-*]\s+(.*)$/;

/** Parse CHANGELOG.md into releases, newest first as written. Anything outside a release is ignored. */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let release: Release | undefined;
  let section: Release["sections"][number] | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const r = RELEASE.exec(line);
    if (r) {
      release = { version: r[1], ...(r[2] ? { date: r[2] } : {}), sections: [] };
      releases.push(release);
      section = undefined;
      continue;
    }
    if (!release) continue;
    const s = SECTION.exec(line);
    if (s) {
      section = { title: s[1], items: [] };
      release.sections.push(section);
      continue;
    }
    const item = ITEM.exec(line);
    if (item && section) section.items.push(item[1]);
    else if (section && /^\s{2,}\S/.test(line) && section.items.length) section.items[section.items.length - 1] += ` ${line.trim()}`;
  }
  return releases;
}
