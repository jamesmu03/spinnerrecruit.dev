#!/usr/bin/env node
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { loadConfig, saveConfig } from "./config";
import { ask, runConsentPrompt } from "./consent";
import {
  hasTmux,
  describeInstallCommand,
  installTmux,
  newSession,
  listPaneIds,
  splitWindow,
  selectPane,
  pinPaneHeight,
  attach,
  sessionExists,
  killSession,
  setRemainOnExit,
  enableHyperlinks,
  enableMouse,
  enableFocusEvents,
  hideStatusBar,
} from "./tmux";
import { runAdPane } from "./adPane";
import { installShim, uninstallShim, findRealTarget } from "./shim";
import { AD_LOG_FILE, readAdLog } from "./adLog";
import { noticeUpdateIfNeeded } from "./updateNotice";

const AD_PANE_LINES = 2;

function runPairCommand(developerId: string | undefined): void {
  if (!developerId) {
    console.error("Usage: spinner-recruit pair <developerId>");
    process.exitCode = 1;
    return;
  }
  saveConfig({ ...loadConfig(), developerId });
  console.log("Paired. Future ad impressions will be credited to your account.");
}

function runOptOutCommand(): void {
  saveConfig({ ...loadConfig(), consented: false });
  console.log("Opted out. No further network calls will be made until you opt in again.");
}

// Every ad actually shown gets one line here (see adLog.ts) — this just
// surfaces that file: a paper trail for cross-checking impression-pay
// disputes against the platform's own ledger, and for finding a listing
// again later without digging through serve history.
function runLogCommand(): void {
  const entries = readAdLog();
  console.log(`spinner-recruit: ${entries.length} ad impression(s) logged at ${AD_LOG_FILE}`);
  for (const entry of entries) {
    const status = entry.billed ? "billed" : "unbilled";
    console.log(`${entry.shownAt}  [${status}]  ${entry.company} — ${entry.title} (${entry.location})  ${entry.url}`);
  }
}

function spawnPlain(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// Claude runs directly in tmux's main pane — not through any process of
// ours — so it gets a real, fully-isolated pane with its own real dimensions.
// The ad renders in a second, separate pane that only ever writes to itself.
// tmux enforces that boundary, which a same-stream PTY trick cannot.
async function runWithTmux(command: string, args: string[]): Promise<void> {
  const sessionName = `sr-${randomUUID().slice(0, 8)}`;
  const socket = sessionName; // dedicated server per run — see tmux.ts
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  newSession(socket, sessionName, cols, rows, command, args);
  setRemainOnExit(socket, sessionName);
  enableHyperlinks(socket);
  // Re-enabled after finding the real cause of the "two green lines"/broken
  // rendering report: the command-resolution bug fixed alongside this meant
  // that first test was *also* nested (a second whole wrapped session, each
  // independently turning mouse mode on and starting its own click listener,
  // landing on the same physical screen). Retesting in isolation now that
  // nesting can't happen — see [[spinner-recruit-status]], 2026-06-23.
  enableMouse(socket, sessionName);
  enableFocusEvents(socket);
  hideStatusBar(socket, sessionName);
  const [mainPaneId] = listPaneIds(socket, sessionName);
  splitWindow(socket, sessionName, AD_PANE_LINES, process.execPath, [
    __filename,
    "__adpane",
    socket,
    mainPaneId ?? "",
  ]);
  if (mainPaneId) selectPane(socket, mainPaneId);
  const adPaneId = listPaneIds(socket, sessionName).find((id) => id !== mainPaneId);
  if (adPaneId) pinPaneHeight(socket, adPaneId, AD_PANE_LINES);

  // Without these, a signal that targets this process directly (terminal
  // close sending SIGHUP, `kill <pid>` sending SIGTERM) would terminate it
  // immediately via Node's default disposition — before the cleanup below
  // ever runs — leaking the tmux session and its ad-pane process forever.
  // Registering a handler suppresses that default, so the only paths left
  // are: attach()'s child exits on its own (handled below as always), or one
  // of these fires and we tear down explicitly.
  let cleaningUp = false;
  const onSignal = (): void => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (sessionExists(socket, sessionName)) killSession(socket, sessionName);
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  const exitCode = await attach(socket, sessionName);
  if (!cleaningUp && sessionExists(socket, sessionName)) killSession(socket, sessionName);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // __adpane is how this process re-invokes itself as the ad-pane child via
  // tmux split-window — it must be recognized unconditionally. The tmux
  // server inherits the shim's exported SPINNER_RECRUIT_TARGET, so without
  // this check running first, the ad-pane child would see that env var set
  // and (per the shimTarget branch below) try to run the *wrapped tool*
  // with args ["__adpane", socket, paneId] instead of rendering ads — and
  // since that goes through runWithTmux too, it recurses into another
  // tmux-wrapped session indefinitely.
  if (args[0] === "__adpane") {
    await runAdPane(args[1] ?? "", args[2] ?? "");
    return;
  }

  noticeUpdateIfNeeded();

  // Set by the PATH shim `install` writes: when present, this process *is*
  // standing in for the wrapped tool itself (claude, codex, ...), so every
  // arg belongs to it — none of the pair/optout/install subcommands apply.
  const shimTarget = process.env.SPINNER_RECRUIT_TARGET;

  if (!shimTarget) {
    if (args[0] === "pair") {
      runPairCommand(args[1]);
      return;
    }
    if (args[0] === "optout") {
      runOptOutCommand();
      return;
    }
    if (args[0] === "log") {
      runLogCommand();
      return;
    }
    if (args[0] === "install") {
      const tool = args[1] && !args[1].startsWith("--") ? args[1] : "claude";
      installShim(tool, args.includes("--dry-run"));
      return;
    }
    if (args[0] === "uninstall") {
      const tool = args[1] && !args[1].startsWith("--") ? args[1] : "claude";
      uninstallShim(tool, args.includes("--dry-run"));
      return;
    }
  }

  // Resolved to a real, absolute path (not just the bare tool name) so the
  // tmux pane execs it directly with no further PATH lookup — if a shim is
  // installed for this tool, a bare name handed to tmux would otherwise
  // resolve right back through the shim directory on $PATH (which is what
  // `install` puts first on PATH) and nest a second wrapped session inside
  // this one. Falls back to the bare name only if it's nowhere on PATH at
  // all, so the original "let it fail naturally" behavior is unchanged for
  // a genuinely missing binary.
  const requestedTool = args[0] ?? "claude";
  const command = shimTarget ?? findRealTarget(requestedTool) ?? requestedTool;
  const commandArgs = shimTarget ? args : args.slice(1);

  let config = loadConfig();
  if (!config.consented) {
    if (!process.stdin.isTTY) {
      // Can't prompt without a TTY — run the wrapped command untouched.
      spawnPlain(command, commandArgs);
      return;
    }
    config = await runConsentPrompt(config);
    saveConfig(config);
  }

  if (!config.consented || !process.stdout.isTTY || !process.stdin.isTTY) {
    spawnPlain(command, commandArgs);
    return;
  }

  if (!hasTmux()) {
    const installCommand = describeInstallCommand();
    if (installCommand) {
      const answer = await ask(
        "spinner-recruit: tmux is required to show ads without risking the wrapped " +
          "command's own display (it isolates the ad in its own pane), but it's not " +
          `installed. Install it now with \`${installCommand}\`? [y/N] `,
      );
      if (/^y/i.test(answer.trim()) && installTmux()) {
        await runWithTmux(command, commandArgs);
        return;
      }
      console.error("spinner-recruit: running without ads for now.\n");
    } else {
      console.error(
        "spinner-recruit: tmux is required to show ads without risking the wrapped " +
          "command's own display (it isolates the ad in its own pane). Install it — " +
          "e.g. `brew install tmux` — and try again. Running without ads for now.\n",
      );
    }
    spawnPlain(command, commandArgs);
    return;
  }

  await runWithTmux(command, commandArgs);
}

main();
