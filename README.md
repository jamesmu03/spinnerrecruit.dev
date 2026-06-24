# spinner-recruit (CLI)

Run `claude`, `codex`, or any terminal coding agent through this wrapper
instead of calling it directly:

```bash
npx spinner-recruit@latest claude
npx spinner-recruit@latest codex
```

While it's thinking, a purple, clickable one-line job ad appears in its own
small pane below the agent's — the agent runs in a full, completely isolated
tmux pane and is never touched. **Requires `tmux`** — if it's missing, the
wrapper detects your package manager (Homebrew on macOS; apt/dnf/yum/pacman/
apk/zypper on Linux) and offers to install it for you on first run. If none
is found, or you decline, it just runs your command untouched with no ads,
rather than risk corrupting its display.

## Usage

```bash
spinner-recruit pair <developerId>   # one-time: link impressions to your account
spinner-recruit claude                # run Claude as usual — everything is forwarded
spinner-recruit codex                 # same, for Codex
spinner-recruit <any other command>   # works with anything that prints a "Thinking"/"esc to interrupt" marker
spinner-recruit optout                 # disable ads — no further network calls
spinner-recruit log                    # print every ad you've been shown (pay-dispute record / job links)
spinner-recruit install [tool]         # make bare `claude` (or [tool], e.g. `codex`) always run through this wrapper
spinner-recruit uninstall [tool]       # undo install for that tool
```

The first run shows a one-time opt-in prompt. Until you accept, the wrapper
makes zero network calls and the wrapped command runs completely untouched.

### `install` — make a bare command always go through the wrapper

By default you have to type `npx spinner-recruit@latest claude` every time. Running
`spinner-recruit install` (or `spinner-recruit install codex`) sets up a
small shim so that typing the plain command in any terminal — including VS
Code's integrated terminal — does the same thing automatically:

1. It finds the real binary (`claude` by default, or whatever you pass) on
   `$PATH`.
2. It writes a same-named script to `~/.spinner-recruit/bin/`, which sets
   `SPINNER_RECRUIT_TARGET` to that real path and forwards everything else
   to `npx spinner-recruit@latest`. You can install shims for multiple tools at
   once (e.g. both `claude` and `codex`) — they share the same directory.
3. It appends a marked, clearly-delimited block to your shell's startup file
   (`~/.zshrc` on zsh, `~/.bash_profile` on bash) putting that shim directory
   first on `$PATH`. Re-running `install` is idempotent — it won't duplicate
   the block. `spinner-recruit uninstall [tool]` removes that tool's shim
   file; it only removes the PATH block once no shims are left.

Add `--dry-run` to either command to see what would change without writing
anything.

**This cannot reach a VS Code sidebar/chat panel** for Claude Code, Codex, or
any other assistant with one — that UI never invokes a terminal command, so
there's no process to intercept. `install` only affects real terminal usage
(your terminal app, and VS Code's integrated terminal panel, which is just a
shell).

## How it works

1. `spinner-recruit claude` creates a tmux session and runs `claude` directly
   as the session's only pane — a real, fully-isolated pane tmux owns, never
   touched by this tool.
2. A second small pane is split off below it, running this CLI's own ad
   renderer, which never writes anywhere except its own pane.
3. The ad renderer polls Claude's pane every second via a read-only
   `tmux capture-pane` snapshot and checks the last non-blank line for a
   "Thinking" marker.
4. The ad text is an OSC 8 terminal hyperlink, so a modifier-click (e.g.
   Cmd-click) always works as a fallback. A plain click also works: tmux
   mouse mode is on for the session, and the ad pane requests its own mouse
   tracking, so tmux forwards a plain click on that pane straight to us —
   we open the link ourselves the same way the hyperlink would have. Either
   path hits `GET /api/go/[serveId]` on the API, which bills the click and
   redirects to the real job URL.
5. We attach to the tmux session in the foreground; the session tears down
   when you detach or Claude's pane exits.
6. Every ad actually shown gets one line appended to
   `~/.spinner-recruit/ad-log.jsonl` (company, title, url, location, the
   serve ID, and whether it met the dwell threshold to be billed) — run
   `spinner-recruit log` to view it. It's a local paper trail: a cross-check
   against the platform's own impression ledger if a payout is ever
   disputed, and a way to find a listing again later.

## Config

Stored at `~/.spinner-recruit/config.json`:

```json
{ "consented": true, "developerId": "<uuid>" }
```

Override the API base URL with `SPINNER_RECRUIT_API_URL` (defaults to the
production API).

## Build from source

```bash
npm install
npm run build       # compiles src/ -> dist/, chmod +x dist/index.js
node dist/index.js claude
```

## Releasing

Pushing a tag matching `v*.*.*` on the public mirror triggers
`.github/workflows/publish.yml`, which builds and runs
`npm publish --provenance` from GitHub Actions — the published package gets
a verified
[provenance](https://docs.npmjs.com/generating-provenance-statements)
attestation linking it back to this exact commit and workflow run, instead
of an untraceable publish from someone's laptop.

One-time setup required before this works: on the
[npmjs.com package settings page](https://www.npmjs.com/package/spinner-recruit/access),
add this repo + the `publish.yml` workflow as a **Trusted Publisher**. No
`NPM_TOKEN` secret is needed — npm exchanges the workflow's OIDC token for a
short-lived publish credential automatically.
