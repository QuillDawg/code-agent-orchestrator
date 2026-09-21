/**
 * Every relative link the published documentation makes, opened.
 *
 * A renamed heading is the cheapest way to break a document: the link still looks right in the diff, the
 * file it points at still exists, and the anchor silently lands the reader at the top of the page. It has
 * happened twice — `capabilities.md#watching-a-run` outlived the heading it named by one commit — and it
 * is not something a reader reports, because a page that scrolls to the top reads as a page that was
 * always like that.
 *
 * Only the documents that ship are checked. `docs/research/` is internal notes nobody links into, and the
 * spec and decisions documents are read by their authors with the whole repository in front of them.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'packages/protocol/CHANGELOG.md',
  'docs/agent-cli-integration.md',
  'docs/architecture.md',
  'docs/capabilities.md',
  'docs/cao-v2-beta-decisions.md',
  'docs/cao-v2-beta-spec.md',
  'docs/configuration.md',
  'docs/desktop.md',
  'docs/models.md',
];

const read = (file: string): Promise<string> => fs.readFile(path.join(root, file), 'utf8');

/** The lines of a document that are prose: a fenced block is sample output, not markdown. */
const prose = (text: string): string[] => {
  const kept: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced) kept.push(line);
  }
  return kept;
};

/** GitHub's heading slug: lowercased, punctuation dropped, spaces hyphenated, collisions suffixed. */
const anchorsOf = (text: string): Set<string> => {
  const found = new Set<string>();
  for (const line of prose(text)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const base = heading[1]!.replace(/`/g, '').trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    let slug = base;
    for (let n = 1; found.has(slug); n += 1) slug = `${base}-${n}`;
    found.add(slug);
  }
  return found;
};

/** `[text](target)`, for every target that is not an absolute URL. */
const linksOf = (text: string): string[] =>
  prose(text)
    .flatMap((line) => [...line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]!))
    .filter((target) => !/^(https?:|mailto:)/.test(target));

/**
 * The other kind of reference a document makes: `§4.2.3` of the beta spec, cited by number.
 *
 * The numbers outlived the draft they were written against — the spec has no §4.5, §6.3.1 or §8.6 — and
 * `packages/protocol/CHANGELOG.md`, which is published to npm on its own, carried seven of them. A number
 * that names nothing is worse than no number: it reads as a promise that somewhere the detail exists.
 */
describe('the sections the documents cite', () => {
  /** Every heading number of the spec, and the parents each one implies: `2.7` also proves `2`. */
  const specSections = async (): Promise<Set<string>> => {
    const found = new Set<string>();
    for (const line of prose(await read('docs/cao-v2-beta-spec.md'))) {
      const heading = /^#{2,6}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line);
      if (!heading) continue;
      const parts = heading[1]!.split('.');
      while (parts.length > 0) {
        found.add(parts.join('.'));
        parts.pop();
      }
    }
    return found;
  };

  it('every § citation names a section the spec has', async () => {
    const sections = await specSections();
    expect(sections.has('2.7')).toBe(true);
    for (const file of DOCS) {
      for (const cited of [...(await read(file)).matchAll(/§(\d+(?:\.\d+)*)/g)].map((m) => m[1]!)) {
        expect([...sections].includes(cited), `${file} cites §${cited}`).toBe(true);
      }
    }
  });
});

describe('the links between the documents', () => {
  it('every relative link names a file that is there', async () => {
    let checked = 0;
    for (const file of DOCS) {
      for (const target of linksOf(await read(file))) {
        const [relative] = target.split('#');
        if (relative === '') continue;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), relative!));
        await expect(fs.access(path.join(root, resolved)), `${file} → ${target}`).resolves.toBeUndefined();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('every anchor names a heading of the document it points into', async () => {
    const anchors = new Map(await Promise.all(DOCS.map(async (f) => [f, anchorsOf(await read(f))] as const)));
    let checked = 0;
    for (const file of DOCS) {
      for (const target of linksOf(await read(file))) {
        const [relative, anchor] = target.split('#');
        if (anchor === undefined || anchor === '') continue;
        const into = relative === '' ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), relative!));
        const headings = anchors.get(into);
        if (!headings) continue; // a link into a document this list does not own
        expect([...headings].includes(anchor), `${file} → ${target}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
