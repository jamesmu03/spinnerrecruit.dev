import { readFileSync } from "fs";
import { join } from "path";
import { loadConfig, saveConfig } from "./config";

const CURRENT_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }
).version;

// shim.ts always execs `npx --yes spinner-recruit@latest`, so this process can
// already be running a newer version than the user last saw without ever
// choosing to update — surface that instead of leaving the upgrade silent.
export function noticeUpdateIfNeeded(): void {
  const config = loadConfig();
  if (config.lastSeenVersion && config.lastSeenVersion !== CURRENT_VERSION) {
    console.error(`spinner-recruit: updated ${config.lastSeenVersion} -> ${CURRENT_VERSION}.`);
  }
  if (config.lastSeenVersion !== CURRENT_VERSION) {
    saveConfig({ ...config, lastSeenVersion: CURRENT_VERSION });
  }
}
