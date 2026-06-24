import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DIR = join(homedir(), ".spinner-recruit");
const FILE = join(DIR, "config.json");

export interface Config {
  consented: boolean;
  developerId?: string;
  lastSeenVersion?: string;
}

export function loadConfig(): Config {
  try {
    return { consented: false, ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {
    return { consented: false };
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(config, null, 2));
}
