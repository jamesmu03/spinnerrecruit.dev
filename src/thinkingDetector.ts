export function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\r\b]/g, "\n");
}

export function lastNonBlankLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return "";
}

// Two differently-scoped checks, fed the *whole* visible pane each time:
//
// 1. "esc to interrupt" — checked anywhere on screen. Verified (against both
//    Claude and Codex) that this hint is removed entirely the instant a turn
//    finishes, replaced by the actual response — it never lingers as stale
//    history, so a whole-screen match can't get wedged open the way (2) can.
//    This matters because tools lay their busy indicator out differently:
//    Claude puts it on the very last line; Codex renders a scrolling action
//    log (e.g. "Searching the web...") with the live "Working (Ns • esc to
//    interrupt)" line buried in the middle, below which it always keeps a
//    static model/cwd footer — so a last-line-only check never sees it.
// 2. Bare "Thinking" — checked only on the last non-blank line, for tools
//    that print a literal verb instead of "esc to interrupt". Deliberately
//    NOT whole-screen: settled response prose that happens to contain the
//    word "thinking" (e.g. "I was thinking about X") would otherwise match
//    forever once scrolled into view — this is a real bug that was already
//    hit and fixed once before.
//
// Either signal alone moves the ad to "active"; the marker is repainted
// continuously while busy, so a session stays active as long as it keeps
// reappearing within idleMs of the last sighting.
export class ThinkingDetector {
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;

  constructor(
    private readonly onStart: () => void,
    private readonly onEnd: () => void,
    private readonly idleMs = 2_500,
  ) {}

  feed(rawSnapshot: string): void {
    const clean = stripAnsi(rawSnapshot);
    const matched = /esc to interrupt/i.test(clean) || /\bThinking\b/i.test(lastNonBlankLine(clean));
    if (!matched) return;
    if (!this.active) {
      this.active = true;
      this.onStart();
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.active) return;
    this.active = false;
    this.onEnd();
  }
}
