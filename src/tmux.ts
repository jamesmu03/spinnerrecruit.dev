import { spawn, spawnSync } from "child_process";

// All terminal multiplexing is delegated to tmux rather than reimplemented:
// tmux enforces pane boundaries at the multiplexer layer, so whatever Claude's
// own TUI does inside its pane (full-screen redraws, scroll regions, clears)
// can never bleed into the ad's pane, and vice versa. That guarantee is the
// whole reason this exists instead of writing into the same PTY Claude owns.
//
// Every call below takes a `socket` name and passes `-L <socket>` so each run
// gets its own private tmux *server*, never the shared default one. Without
// this, a tmux server already running (from an earlier run, or anything else
// on the machine) gets reused for `new-session`, and reused servers keep the
// environment they were originally started with — a fresh shell's env (e.g.
// SPINNER_RECRUIT_DEBUG, or anything else) silently never reaches the new
// session. A dedicated socket per run sidesteps that whole class of bug and
// also means we never share session-namespace with any tmux the user runs
// for their own unrelated purposes.
function run(socket: string, args: string[], opts?: { stdio?: "inherit"; encoding?: "utf8" }): ReturnType<typeof spawnSync> {
  return spawnSync("tmux", ["-L", socket, ...args], opts as never);
}

export function hasTmux(): boolean {
  return spawnSync("tmux", ["-V"]).status === 0;
}

function hasBinary(bin: string): boolean {
  return spawnSync("which", [bin]).status === 0;
}

// Picks the install command for whichever package manager is actually on
// this machine, in order of preference. Returns null on an unfamiliar Linux
// distro or on Windows (tmux isn't a thing there outside WSL, which would
// hit the linux branch below anyway) — callers fall back to telling the
// user to install it themselves.
function findInstallCommand(): string[] | null {
  if (process.platform === "darwin") {
    return hasBinary("brew") ? ["brew", "install", "tmux"] : null;
  }
  if (process.platform === "linux") {
    if (hasBinary("apt-get")) return ["sudo", "apt-get", "install", "-y", "tmux"];
    if (hasBinary("dnf")) return ["sudo", "dnf", "install", "-y", "tmux"];
    if (hasBinary("yum")) return ["sudo", "yum", "install", "-y", "tmux"];
    if (hasBinary("pacman")) return ["sudo", "pacman", "-S", "--noconfirm", "tmux"];
    if (hasBinary("apk")) return ["sudo", "apk", "add", "tmux"];
    if (hasBinary("zypper")) return ["sudo", "zypper", "install", "-y", "tmux"];
  }
  return null;
}

// Human-readable form of findInstallCommand(), for showing the user what's
// about to run before asking them to confirm it.
export function describeInstallCommand(): string | null {
  return findInstallCommand()?.join(" ") ?? null;
}

// Runs the detected install command with inherited stdio, so the user sees
// normal package-manager output and any sudo password prompt. Checks hasTmux()
// afterward rather than trusting the exit code, since that's what we actually
// care about (and covers the no-op case where a package manager exits 0
// because tmux was already installed).
export function installTmux(): boolean {
  const installCommand = findInstallCommand();
  if (!installCommand) return false;
  const [bin, ...args] = installCommand;
  spawnSync(bin, args, { stdio: "inherit" });
  return hasTmux();
}

export function newSession(
  socket: string,
  sessionName: string,
  cols: number,
  rows: number,
  command: string,
  args: string[],
): void {
  run(socket, ["new-session", "-d", "-s", sessionName, "-x", String(cols), "-y", String(rows), command, ...args]);
}

export function listPaneIds(socket: string, sessionName: string): string[] {
  const result = run(socket, ["list-panes", "-t", sessionName, "-F", "#{pane_id}"], { encoding: "utf8" });
  return ((result.stdout as string) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function splitWindow(socket: string, sessionName: string, lines: number, command: string, args: string[]): void {
  run(socket, ["split-window", "-t", sessionName, "-v", "-l", String(lines), command, ...args]);
}

// tmux only applies an absolute split size (-l) at split time. Every
// subsequent window resize rescales all panes proportionally along with it,
// so without this the ad pane silently grows/shrinks off its intended line
// count instead of staying pinned. This hook re-asserts the height on every
// resize of the attached client. `-g` is global, but our server is private
// to this one run (see the per-run socket above), so it only ever affects
// this session.
export function pinPaneHeight(socket: string, paneId: string, lines: number): void {
  run(socket, ["set-hook", "-g", "client-resized", `resize-pane -t ${paneId} -y ${lines}`]);
}

// split-window makes the newly-created pane active by default — left alone,
// the user's keystrokes would go to the ad pane (which doesn't read input)
// instead of the wrapped command. Call this right after splitWindow to hand
// focus back.
export function selectPane(socket: string, paneId: string): void {
  run(socket, ["select-pane", "-t", paneId]);
}

export function setOption(socket: string, sessionName: string, option: string, value: string): void {
  run(socket, ["set-option", "-t", sessionName, option, value]);
}

// tmux's own status line (session name, window list, clock — the "green
// bar") is unrelated to anything we render and just adds clutter/confusion
// next to the ad pane, so hide it for sessions we create.
export function hideStatusBar(socket: string, sessionName: string): void {
  run(socket, ["set", "-t", sessionName, "status", "off"]);
}

// tmux doesn't forward OSC 8 hyperlink escapes to the real terminal unless
// the terminal type is known to support them, and none are flagged as
// hyperlink-capable by default — without this, the ad's link renders as
// plain text with no click target. This is a server-wide option but our
// server is private to this one run, so it only ever needs setting once.
export function enableHyperlinks(socket: string): void {
  run(socket, ["set", "-s", "terminal-features", ",*:hyperlinks"]);
}

// With mouse mode off (tmux's default), every click is handled solely by the
// outer terminal, and OSC 8 hyperlinks only ever follow on that terminal's
// own modifier-click convention (cmd-click, ctrl-click, ...) — there's no
// way for a plain click to reach us. Turning mouse on makes tmux forward raw
// clicks straight to whichever pane's program has itself requested mouse
// tracking (the ad pane does this on its own stdout — see adPane.ts), while
// every other pane keeps tmux's normal click/select/copy behavior. That's
// what lets a plain click open the ad. set-clipboard keeps the main pane's
// existing click-drag-to-select workflow feeling native: tmux still does the
// selecting, but the result is pushed to the system clipboard via OSC 52
// instead of only living in tmux's own paste buffer.
export function enableMouse(socket: string, sessionName: string): void {
  run(socket, ["set", "-t", sessionName, "mouse", "on"]);
  run(socket, ["set", "-t", sessionName, "set-clipboard", "on"]);
}

// Claude Code (running as the session's main pane) asks the terminal for
// focus in/out events for its own UI, and shows a hint — "tmux focus-events
// off · add 'set -g focus-events on' to ~/.tmux.conf and reattach..." — every
// time it doesn't see them. tmux only forwards focus events to a pane's
// program when this is on, and it defaults off; every session we create is a
// brand-new private server, so without this Claude would show that hint on
// literally every run, which reads like a tmux/wrapper problem even though
// it's really just Claude asking for something we hadn't turned on.
export function enableFocusEvents(socket: string): void {
  run(socket, ["set", "-g", "focus-events", "on"]);
}

// tmux's default behavior is to silently close a pane the instant its command
// exits, which makes a crashing ad-pane process indistinguishable from one
// that never split at all. remain-on-exit keeps the pane (and whatever it
// last printed, including a stack trace) visible until the window closes.
export function setRemainOnExit(socket: string, sessionName: string): void {
  run(socket, ["set-window-option", "-t", sessionName, "remain-on-exit", "on"]);
}

// Resolves once the user detaches or the session's last pane exits. Async
// (not spawnSync) specifically so the event loop keeps running while
// attached — a synchronous wait would block Node from ever running a signal
// handler, so a SIGTERM/SIGHUP/SIGINT delivered straight to this process
// (terminal close, `kill <pid>`, etc.) would kill it before it got a chance
// to tear down the tmux session, leaking the session and its ad-pane process.
export function attach(socket: string, sessionName: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("tmux", ["-L", socket, "attach-session", "-t", sessionName], {
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

export function sessionExists(socket: string, sessionName: string): boolean {
  return run(socket, ["has-session", "-t", sessionName]).status === 0;
}

export function killSession(socket: string, sessionName: string): void {
  run(socket, ["kill-session", "-t", sessionName]);
}

// Captures the main pane's currently visible viewport (not scrollback) — a
// cheap, side-effect-free snapshot used to detect the busy/"Thinking" marker
// without ever touching the wrapped command's pane.
export function capturePane(socket: string, paneId: string): string {
  const result = run(socket, ["capture-pane", "-t", paneId, "-p"], { encoding: "utf8" });
  return (result.stdout as string) ?? "";
}
