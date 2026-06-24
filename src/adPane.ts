import { randomUUID } from "crypto";
import { appendFileSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { Ad, fetchNextAd, goUrl, reportImpression } from "./adClient";
import { logAdSeen } from "./adLog";
import { loadConfig } from "./config";
import { capturePane } from "./tmux";
import { ThinkingDetector } from "./thinkingDetector";

// tmux's capture-pane *succeeds* and returns this literal placeholder text
// once the target pane's command has exited (with remain-on-exit keeping the
// pane itself visible) — it isn't an error we can catch, so without this
// check the poll loop runs forever even after the wrapped command is long
// gone, leaking a background process per session.
const PANE_DEAD_MARKER = "Pane is dead";

// Set SPINNER_RECRUIT_DEBUG=1 to log every captured status line to
// ~/.spinner-recruit/debug.log — useful for tuning ThinkingDetector's
// pattern against a new tool's actual terminal output.
const DEBUG_LOG = join(homedir(), ".spinner-recruit", "debug.log");
function debugLog(line: string): void {
  if (!process.env.SPINNER_RECRUIT_DEBUG) return;
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${JSON.stringify(line)}\n`);
  } catch {
    // best-effort only
  }
}

const POLL_MS = 1_000;
const ROTATION_MS = 60_000;
const MIN_IMPRESSION_DWELL_MS = 5_000;

const PURPLE = "\x1b[38;2;168;85;247m";
const RESET = "\x1b[0m";
const CLEAR_AND_HOME = "\x1b[H\x1b[2J";

function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// Opens a URL with whatever the OS considers "the" handler for it (the
// default browser), the same outcome a terminal's native modifier-click on
// the OSC 8 hyperlink above produces — just triggered by our own click
// detection (see listenForClicks) instead of relying on that convention.
function openUrl(url: string): void {
  const plat = platform();
  const [cmd, args] =
    plat === "darwin" ? ["open", [url]] : plat === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // spawn() failures (e.g. ENOENT if the opener isn't on PATH) surface as an
    // async 'error' event, not a thrown exception — the try/catch above never
    // sees them. With no listener, Node treats an unhandled 'error' event as
    // an uncaught exception and kills this whole process, silently dropping
    // the click. Found by tracing a real click that matched and fired
    // onClick() correctly but never actually opened anything.
    child.on("error", () => {});
    child.unref();
  } catch {
    // a failed open should never crash the ad pane
  }
}

// Mode 1000 (button-event tracking: reports press/release, no motion) +
// 1006 (SGR extended coordinates, decimal text instead of byte-offset
// encoding). X10 (DECSET 9) was tried first as the simplest dialect, but
// real-world testing found it inert in VS Code's xterm.js-based terminal —
// no corruption, just never delivered. SGR is the modern, broadly-supported
// protocol (xterm, iTerm2, Windows Terminal, kitty, and VS Code's terminal
// all implement it) and is what tmux itself reports with by default, so
// this is also the path most likely to already be exercised/working.
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";

// SGR press report: ESC [ < Cb ; Cx ; Cy M (lowercase 'm' is release, which
// we don't care about). Cb is the raw button number, not byte-offset like
// X10 — 0 is the left button with no modifier held; shift/meta/ctrl each add
// a bit (4/8/16), and the scroll wheel uses 64+, so checking Cb===0
// specifically excludes modifier-clicks (which should keep going through the
// terminal's own native hyperlink-follow path, not ours) and wheel events.
const SGR_CLICK_RE = /\x1b\[<(\d+);\d+;\d+M/g;

// tmux only forwards raw mouse bytes to a pane whose own program has
// requested mouse tracking on its own stdout (see enableMouse in tmux.ts).
function listenForClicks(onClick: () => void): () => void {
  if (!process.stdin.isTTY) return () => {};
  process.stdout.write(MOUSE_ENABLE);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  const onData = (chunk: Buffer): void => {
    for (const match of chunk.toString("latin1").matchAll(SGR_CLICK_RE)) {
      if (Number(match[1]) === 0) onClick();
    }
  };
  process.stdin.on("data", onData);
  return () => {
    process.stdin.off("data", onData);
    process.stdin.setRawMode?.(false);
    process.stdout.write(MOUSE_DISABLE);
  };
}

// Pane is exactly 1 row tall (see splitWindow's `-l 1` in index.ts). A line
// longer than the pane's column width auto-wraps in the terminal, but there's
// no second row for the wrapped remainder to land on — the visible result is
// just the tail of the text (often the location, since that's last). Truncate
// to the pane's actual width instead of ever letting it wrap.
let lastRendered: { text: string; url?: string } | null = null;

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return "";
  if (text.length <= maxWidth) return text;
  return `${text.slice(0, maxWidth - 1)}…`;
}

function render(text: string, url?: string): void {
  lastRendered = { text, url };
  const visible = truncate(text, process.stdout.columns || 80);
  const body = url ? hyperlink(visible, url) : visible;
  process.stdout.write(CLEAR_AND_HOME + PURPLE + body + RESET);
}

function clear(): void {
  lastRendered = null;
  process.stdout.write(CLEAR_AND_HOME);
}

// A write to a pty that's gone away (e.g. tmux tearing down/recreating this
// pane during a fast resize) raises EPIPE as an 'error' event, not a thrown
// exception from .write() itself — with no listener, Node treats that as an
// uncaught exception and kills this whole process. remain-on-exit then
// leaves tmux's own "Pane is dead" text sitting in the ad pane, which could
// easily read as some kind of crash/disconnect rather than what it is: a
// transient write racing a resize. Safe to ignore — the next render() (or
// the resize handler below) just writes again.
process.stdout.on("error", () => {});

// The pane resizes live with the terminal window (tmux keeps it 1 row tall,
// just narrower/wider), and Node reflects that via this event — re-render the
// current ad at the new width instead of leaving stale, wrongly-truncated text.
process.stdout.on("resize", () => {
  if (lastRendered) render(lastRendered.text, lastRendered.url);
});

// Runs entirely inside its own tmux pane — this process owns that pane
// exclusively, so it can clear/rewrite freely with zero risk of corrupting
// the wrapped tool's pane. It never writes anywhere outside its own stdout;
// it only *reads* the main pane via capture-pane snapshots to know when to
// show ads.
export async function runAdPane(socket: string, mainPaneId: string): Promise<void> {
  const config = loadConfig();
  const sessionId = randomUUID();
  debugLog(`runAdPane start: HOME=${process.env.HOME} developerId=${config.developerId} consented=${config.consented}`);

  let rotationTimer: ReturnType<typeof setInterval> | undefined;
  let current: { serveId: string; shownAt: number; billed: boolean; ad: Ad } | null = null;
  let sessionActive = false;

  async function settleCurrent(): Promise<void> {
    if (!current || current.billed) return;
    current.billed = true;
    const billed = Date.now() - current.shownAt >= MIN_IMPRESSION_DWELL_MS;
    if (billed) await reportImpression(current.serveId);
    logAdSeen(current.shownAt, current.serveId, billed, current.ad);
  }

  // Re-enabled alongside tmux's `mouse on` (see index.ts) — the previous
  // "broke VS Code's terminal" report turned out to also be hitting the
  // command-resolution nesting bug fixed in the same commit that disabled
  // this, so it was never tested in isolation. Retesting now that nesting
  // can't happen.
  const stopListeningForClicks = listenForClicks(() => {
    if (lastRendered?.url) openUrl(lastRendered.url);
  });

  async function rotate(): Promise<void> {
    await settleCurrent();
    debugLog(`rotate(): fetching, sessionActive=${sessionActive}`);
    const served = await fetchNextAd(undefined, sessionId, config.developerId);
    debugLog(`rotate(): fetch returned ${served ? `ad=${served.ad.text}` : "null"}, sessionActive=${sessionActive}`);
    if (!sessionActive) return;
    if (!served) {
      current = null;
      clear();
      return;
    }
    current = { serveId: served.serveId, shownAt: Date.now(), billed: false, ad: served.ad };
    debugLog(`rotate(): rendering "[ad] ${served.ad.text}"`);
    render(`[ad] ${served.ad.text}`, goUrl(served.serveId));
  }

  function startSession(): void {
    debugLog("startSession() called");
    if (sessionActive) return;
    sessionActive = true;
    void rotate();
    rotationTimer = setInterval(() => void rotate(), ROTATION_MS);
  }

  async function endSession(): Promise<void> {
    debugLog(`endSession() called, sessionActive=${sessionActive}`);
    if (!sessionActive) return;
    sessionActive = false;
    if (rotationTimer) clearInterval(rotationTimer);
    clear();
    await settleCurrent();
  }

  const detector = new ThinkingDetector(startSession, endSession);

  const pollTimer = setInterval(() => {
    const snapshot = capturePane(socket, mainPaneId);
    if (!snapshot) return;
    if (process.env.SPINNER_RECRUIT_DEBUG) debugLog(`full=${JSON.stringify(snapshot)}`);
    if (snapshot.includes(PANE_DEAD_MARKER)) {
      void cleanup().then(() => process.exit(0));
      return;
    }
    detector.feed(snapshot);
  }, POLL_MS);

  // Async so every caller can await the in-flight settleCurrent() (which
  // itself awaits the billing report and writes the local ad-seen log)
  // before exiting — a bare process.exit() right after a fire-and-forget
  // settle used to win the race against that pending network call, silently
  // dropping both the server-side impression and the log entry for whichever
  // ad was on screen when the session ended.
  //
  // endSession() runs (and is awaited) *before* detector.stop(): calling
  // detector.stop() first would itself fire onEnd()/endSession() — but only
  // as the detector's own fire-and-forget side effect, not something this
  // function can await — and by the time control returned here sessionActive
  // would already be false, so our own await endSession() would short-circuit
  // immediately instead of waiting on that real, still-pending settle.
  // Calling it ourselves first means this is the one call that actually does
  // the work; detector.stop() afterward is purely to clear its idle timer and
  // flip its own `active` flag — the onEnd() it triggers at that point is a
  // guaranteed instant no-op since sessionActive is already false.
  async function cleanup(): Promise<void> {
    clearInterval(pollTimer);
    await endSession();
    detector.stop();
    stopListeningForClicks();
  }

  process.on("SIGTERM", () => {
    void cleanup().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void cleanup().then(() => process.exit(0));
  });
}
