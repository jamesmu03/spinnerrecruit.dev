import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Ad } from "./adClient";

const DIR = join(homedir(), ".spinner-recruit");
export const AD_LOG_FILE = join(DIR, "ad-log.jsonl");

export interface AdLogEntry {
  shownAt: string;
  serveId: string;
  billed: boolean;
  company: string;
  title: string;
  url: string;
  location: string;
  compLabel: string | null;
  seeded: boolean;
}

// Append-only paper trail of every ad actually shown to this developer: a
// local cross-check against the platform's own impression ledger in case of
// a pay dispute, and a way to find a listing again later without digging
// through serve history. `billed` mirrors whether the dwell threshold was
// met and an impression was actually reported (see adPane.ts's
// settleCurrent), not just whether the ad rendered.
export function logAdSeen(shownAt: number, serveId: string, billed: boolean, ad: Ad): void {
  try {
    mkdirSync(DIR, { recursive: true });
    const entry: AdLogEntry = {
      shownAt: new Date(shownAt).toISOString(),
      serveId,
      billed,
      company: ad.company,
      title: ad.title,
      url: ad.url,
      location: ad.location,
      compLabel: ad.compLabel,
      seeded: ad.seeded,
    };
    appendFileSync(AD_LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // logging must never break the ad pane or the wrapped session
  }
}

export function readAdLog(): AdLogEntry[] {
  try {
    return readFileSync(AD_LOG_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AdLogEntry);
  } catch {
    return [];
  }
}
