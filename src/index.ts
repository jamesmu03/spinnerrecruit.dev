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

// SpinnerRecruit was retired in November 2026: the ad API, dashboards and
// payouts are shut down. With this on, the CLI never starts tmux and never
// touches the network — it just runs the wrapped command directly. The
// original implementation below is kept, unreachable, as a record of how the
// product worked.
const SUNSET = true;
const SUNSET_URL = "https://jamesmu03.github.io/spinnerrecruit.dev";

const SUNSET_HELP_TEXT = `spinner-recruit has been retired — no ads are served and no network calls are made.

  spinner-recruit <command> [args]      runs <command> directly, untouched
  spinner-recruit uninstall [tool]      remove the \`claude\` (or [tool]) shim that \`install\` set up
  spinner-recruit log                   print the ads you were shown while it was live

Archived site: ${SUNSET_URL}
`;

const HELP_TEXT = `Usage: spinner-recruit <command> [args]

  spinner-recruit claude                run Claude through the wrapper (ads in a separate tmux pane)
  spinner-recruit codex                 same, for Codex
  spinner-recruit <any other command>   works with anything that prints a "Thinking"/"esc to interrupt" marker
  spinner-recruit pair <developerId>    one-time: link impressions to your account
  spinner-recruit optout                disable ads — no further network calls
  spinner-recruit log                   print every ad you've been shown
  spinner-recruit install [tool]        make bare \`claude\` (or [tool], e.g. \`codex\`) always run through this wrapper — defaults to claude
  spinner-recruit uninstall [tool]      undo install for that tool — defaults to claude

Requires tmux (the wrapper offers to install it on first run) and the tool
you're wrapping — e.g. Claude Code itself — already on your PATH.
`;

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
  // Without this, a missing/misspelled command (e.g. `--help`, falling
  // through as a "requested tool") surfaces as an unhandled ENOENT that
  // crashes the whole process instead of a normal error message.
  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error(`spinner-recruit: \`${command}\` not found on your PATH.`);
    } else {
      console.error(`spinner-recruit: failed to run \`${command}\`: ${err.message}`);
    }
    process.exit(1);
  });
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

// Retired-mode entry point: no tmux, no consent prompt, no network. Shimmed
// users (bare `claude` routed here via `install`) are told how to remove the
// shim every run, since until they do every launch still pays npx's startup
// cost for nothing; everyone else sees the note once.
function runSunset(args: string[]): void {
  const shimTarget = process.env.SPINNER_RECRUIT_TARGET;

  if (!shimTarget) {
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
      console.log(SUNSET_HELP_TEXT);
      return;
    }
    if (args[0] === "pair" || args[0] === "install" || args[0] === "optout") {
      console.log(
        `spinner-recruit has been retired — \`${args[0]}\` no longer does anything. ` +
          `No ads are served and no network calls are made. ${SUNSET_URL}`,
      );
      return;
    }
    if (args[0] === "log") {
      runLogCommand();
      return;
    }
    if (args[0] === "uninstall") {
      const explicitTool = args[1] && !args[1].startsWith("--");
      uninstallShim(explicitTool ? args[1] : "claude", args.includes("--dry-run"));
      return;
    }
  }

  const requestedTool = args[0] ?? "claude";
  const command = shimTarget ?? findRealTarget(requestedTool) ?? requestedTool;
  const commandArgs = shimTarget ? args : args.slice(1);

  if (shimTarget) {
    console.error(
      "spinner-recruit has been retired — running your command directly. " +
        "Run `npx spinner-recruit uninstall` to remove this shim.",
    );
  } else {
    const config = loadConfig();
    if (!config.sunsetNoticeShown) {
      console.error(
        `spinner-recruit has been retired — running \`${requestedTool}\` directly, no ads. ${SUNSET_URL}`,
      );
      try {
        saveConfig({ ...config, sunsetNoticeShown: true });
      } catch {
        // A read-only home directory must not stop the wrapped command.
      }
    }
  }

  spawnPlain(command, commandArgs);
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
    if (SUNSET) return;
    await runAdPane(args[1] ?? "", args[2] ?? "");
    return;
  }

  if (SUNSET) {
    runSunset(args);
    return;
  }

  noticeUpdateIfNeeded();

  // Set by the PATH shim `install` writes: when present, this process *is*
  // standing in for the wrapped tool itself (claude, codex, ...), so every
  // arg belongs to it — none of the pair/optout/install subcommands apply.
  const shimTarget = process.env.SPINNER_RECRUIT_TARGET;

  if (!shimTarget) {
    if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
      console.log(HELP_TEXT);
      return;
    }
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
      const explicitTool = args[1] && !args[1].startsWith("--");
      if (!explicitTool) {
        console.log(
          "No tool given — defaulting to claude. Run `spinner-recruit install codex` " +
            "(or any other tool name) to target something else.",
        );
      }
      installShim(explicitTool ? args[1] : "claude", args.includes("--dry-run"));
      return;
    }
    if (args[0] === "uninstall") {
      const explicitUninstallTool = args[1] && !args[1].startsWith("--");
      if (!explicitUninstallTool) {
        console.log(
          "No tool given — defaulting to claude. Run `spinner-recruit uninstall codex` " +
            "(or any other tool name) to target something else.",
        );
      }
      uninstallShim(explicitUninstallTool ? args[1] : "claude", args.includes("--dry-run"));
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
