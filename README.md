# pi-usage

One source of truth for quota: **the credentials Pi already owns**.

> [!NOTE]
> `@cad0p/pi-usage` is a fork of [J3pf/piQuota](https://github.com/J3pf/piQuota) (`@j3pf/piquota`). It adds:
>
> * **OpenCode Go from the API key**: `GET https://opencode.ai/zen/go/v1/usage` returns the rolling (5h), weekly and monthly windows for the key Pi already stores, so no browser session is needed.
> * **Numbered accounts**: `auth.json` entries such as `opencode-go-2` … `opencode-go-14` (the [pi-fallback-provider](https://github.com/cad0p/pi-fallback-provider) sibling convention) are read as extra accounts of their base provider.
> * **One Omarchy tab per provider**: a multi-account provider shows each account's binding window (`#2 · Monthly`) in a single tab, and summarises failed accounts.
> * **Tokens by day and by model**: the tokens Pi's own session files recorded are folded per provider and shown in `/usage`, in `--json` (`localStats`) and in the Omarchy records, at a bounded scan cost.
> * **`/usage` on demand**: the Pi command is `/usage` only, and nothing is pinned above the editor or in the footer unless you ask for it. A multi-account provider gets one line per account in the panel.
> * **No dead Claude store**: `auto` passes over an expired Claude Code token when Pi's own `anthropic` login is fresh, and says so in the warnings.
>
> Everything below still applies; the CLI is still called `piquota`.

`pi-quota` is a standalone project. It does not import, invoke or modify
shuvquota, and it never writes to a credential file.

> [!TIP]
> **Working with AI Agents?** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for architectural boundaries, test runner commands, and hard invariants for AI coding agents, and [docs/verification.md](docs/verification.md) for the verification checklist every change follows.

| Surface | Command |
| --- | --- |
| Terminal | `piquota` · `piquota --json` · `piquota --status` · `piquota --compact` |
| Pi TUI | `/usage` |
| External / `rp-host` / automation | `piquota --json` (structured JSON feed with `primaryWindowId` and countdowns) |
| Omarchy Bar Panel | `piquota omarchy` (or systemd user timer via `--omarchy-timer`) |

> [!NOTE]
> **Moshi Integration Removed in v0.11.0**: Previous versions included an integration with the Moshi mobile app and `moshi-hook`. Starting with v0.11.0, Moshi-specific commands and approval mirroring are removed in favor of direct local integrations such as `piquota --json` for `rp-host` / Rp-app and `piquota omarchy` for Omarchy.

## Hard guarantees

* `~/.pi/agent/auth.json` is opened with `flag: "r"`. Never written, synced or
  refreshed. Verified with a checksum before and after every run.
* No token, refresh token, API key, session cookie or `sessionKey` is printed,
  logged, cached, or sent anywhere. E-mail identities are redacted in every
  artifact.
* Antigravity's access token **may** be refreshed, but only in memory. Google
  does not rotate that refresh token, so Pi's stored copy stays valid. Claude and
  Codex are never refreshed, because they **do** rotate and persisting a rotated
  token would break Pi.
* The Claude Code store (`~/.claude/.credentials.json`) is opened read-only too, and
  its refresh token is never even read into memory, so nothing here can rotate a
  token the installed `claude` owns. `~/.claude.json` is read only for the account
  e-mail and display name; its project history is never touched.
* Browser cookie databases are copied to a private temp dir and opened
  read-only. This is only used for the OpenCode Go fallback, when the key usage
  endpoint is gone and no session cookie is configured.
* `/usage` never injects quota into the LLM context: the extension only calls
  `ui.setStatus`, `ui.setWidget` and `ui.notify`.
* Pi's session files (`~/.pi/agent/sessions/**/*.jsonl`) are opened read-only, to
  count tokens per day and per model. The scan cache keys each file by its path,
  size and byte offset and stores open days; the durable history under
  `~/.pi/agent/pi-usage/` stores frozen days. Both hold only aggregate counts and
  model names — no prompt text or tool output reaches a cache, a record or the
  report.
* Nothing is written outside these paths:

  | Path | What |
  | --- | --- |
  | `~/.cache/pi-quota/usage.json` | the report cache |
  | `~/.cache/pi-quota/local-sessions.json` | per-session-file offsets and open token days |
  | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-usage/totals.json`, `tokens-YYYY-MM.json` | frozen token history, plus `.corrupt-<ts>` backups for corrupt files |
  | `~/.cache/pi-quota/refresh-state.json` | each family's own refresh clock |
  | `~/.cache/pi-quota/last-published.json`, `last-good.json`, `backoff.json` | sticky snapshots and throttle state |
  | `~/.config/pi-quota/opencode-cookie` | only after `piquota auth opencode`, mode `600` |
  | `~/.pi/agent/extensions/*.ts` | only by `install.sh` |

## Status, verified against the live APIs

| Provider | Source | Endpoint | Result |
| --- | --- | --- | --- |
| Claude | Claude Code CLI store, else `anthropic.access` | `GET api.anthropic.com/api/oauth/usage` | ✅ 5h + weekly + plan |
| Codex | `openai-codex.access` + `accountId` | `GET chatgpt.com/backend-api/wham/usage` | ✅ 5h + weekly + plan |
| Antigravity | `google-antigravity.access` (or legacy `antigravity`) + `projectId` | `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` | ✅ Gemini + Claude/GPT buckets, **with in-memory refresh** |
| OpenCode Go | `opencode-go.key`, numbered siblings included | `GET opencode.ai/zen/go/v1/usage` | ✅ 5h + weekly + monthly per account; the session cookie and SSR dashboard are a base-account fallback |
| GitHub Actions (opt-in) | Authenticated `gh` CLI | `gh api /organizations/<org>/settings/billing/usage/summary?product=Actions` | ✅ org-wide monthly Linux minutes, plan-derived allowance |

Four findings worth recording, each of which cost a wrong hypothesis:

1. **Antigravity needs the CLI `User-Agent`.** Without
   `User-Agent: antigravity/cli/...` the backend answers
   `403 You do not have a valid license of this product` for a healthy token.
2. **Pi's `opencode-go` entry is an OpenCode Zen API key, and that key reads its
   own Go usage.** `GET /zen/go/v1/usage` answers with the rolling (5h), weekly
   and monthly windows for the key's workspace; `401` means the key was revoked
   and `403 Workspace access denied` means the key is valid but its workspace has
   no Go plan. Only a `404` (endpoint gone) or an entry without a key falls back
   to the session cookie and the authenticated SSR dashboard, and only for the
   base account, because one browser session belongs to one workspace.
3. **`primaryWindowId` identifies the most urgent window.** The CLI computes the
   shortest, most pressing window (e.g. 5h session before weekly) so downstream UI
   consumers like `rp-host` and the Pi TUI render priority pills without reimplementing
   window precedence.
4. **Both Claude OAuth stores answer the same endpoint.** Pi's own `anthropic`
   entry and the Claude Code CLI store return identical windows, which is what
   makes the second source a drop-in replacement rather than a separate feature.

### Claude has two sources

There are two ways to be signed in to Claude, and a user may have either or both:

| Source | Store | Why it exists |
| --- | --- | --- |
| Claude Code CLI | `~/.claude/.credentials.json` (honours `CLAUDE_CONFIG_DIR`); on macOS, when that file is absent, the `Claude Code-credentials` login Keychain item (read-only, via `security find-generic-password`; macOS may ask once to allow access) | What `npm:pi-claude-code-provider` drives. A subscription with usage credits disabled answers `400` on Pi's own entry for every request, and this is the source that still works. |
| Pi's own entry | `~/.pi/agent/auth.json` → `anthropic` | `/login anthropic` in Pi, without the plugin installed. |

**The Claude Code CLI wins when both are present and its token is still valid.** The
choice is a *preference, not a fallback*: only the selected source is tried, so a
broken preferred source is reported rather than silently masked by the other one.
The one exception is an expired Claude Code token next to a fresh Pi login: a store
left behind by an uninstalled CLI never refreshes again, so `auto` reads Pi's login
instead and adds a warning naming the switch. Override it with
`PI_QUOTA_CLAUDE_SOURCE=pi` or `=claude-code`; `--explain` prints which one was used
and why.

The Claude Code store is opened read-only, and its refresh token is deliberately
**never carried into memory**: Anthropic rotates refresh tokens, and a rotation
performed behind the CLI's back would sign the installed `claude` out. Refresh, if
any, stays the CLI's business.

### GitHub Actions credential source

GitHub Actions does not use a Pi-store credential. Quota requests are delegated to
GitHub CLI, which owns authentication; piQuota never reads the token value.

| Source | Credential | Why it exists |
|---|---|---|
| GitHub CLI | Its authenticated session, or `GH_TOKEN` / `GITHUB_TOKEN` passed to `gh` | Reads organization billing usage without putting the token in piQuota's report or cache. |

Enable the family with `PI_QUOTA_GITHUB_ACTIONS=1` or select it explicitly with
`piquota github-actions` (`piquota gh` and `piquota actions` are aliases). Use
`gh auth login` if the CLI is not authenticated; organization billing access and
the `read:org`, `repo`, and `workflow` scopes may be required.

| Variable | Default | Effect |
|---|---|---|
| `PI_QUOTA_GITHUB_ACTIONS` | off | Enables the family for default runs; truthy values are `1`, `true`, `yes`, and `on`. |
| `PI_QUOTA_GITHUB_ORG` | `KoralisSoft` | Organization queried for its plan and usage. |
| `PI_QUOTA_GITHUB_ACTIONS_MINUTES` | plan-derived | Positive integer monthly allowance override; unsupported plans require this setting. |
| `PI_QUOTA_GITHUB_ACTIONS_REPOS` | empty | Optional comma-separated repo names used only to filter attribution; quota remains org-wide. |

## Prerequisites & Installation

* **Node.js >= 22.19.0** (native `node:sqlite` and global `fetch` support; zero npm dependencies).
* **[Pi Coding Agent](https://github.com/earendil-works/pi)** (`pi`).
* **[Gentle AI](https://github.com/Gentleman-Programming/gentle-pi)** (`gentle-pi`).
* Platform support: Linux, WSL2, macOS. See [docs/OS-COMPATIBILITY.md](docs/OS-COMPATIBILITY.md) for OS-specific details.

### 1-Line Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/cad0p/pi-usage/main/install.sh | bash
```

### Install the Pi extension from npm

```bash
pi install npm:@cad0p/pi-usage
```

Loads both Pi extensions straight from the package. The quota panel resolves
the CLI from inside the package, so nothing else is required to see quotas in
the TUI.
When you also run `install.sh` for the terminal CLI, pass
`--no-extension` so the two copies cannot drift apart.

| Capability | `pi install npm:` | `install.sh` |
| --- | --- | --- |
| TUI panel, sidebar and `/usage` | yes | yes |
| Omarchy bar records | yes, written on every refresh | yes |
| `piquota` on your `PATH` for terminal use | no | yes, symlinked |
| Omarchy sync while Pi is closed | no | yes, with `--omarchy-timer` |

If you live inside Pi and use Omarchy, the npm route covers it: the extension
runs `piquota omarchy` on every quota refresh, so the bar fills without any
setup. Choose `install.sh` when you want the CLI in a terminal, or background
sync while Pi is not running.

### Manual Install / Development

```bash
git clone https://github.com/cad0p/pi-usage.git
cd pi-usage
./install.sh                 # --link for development, --uninstall to remove
./install.sh --no-extension  # CLI only; keep the Pi extension installed as a package
./install.sh --omarchy-plugin  # also link the AI Usage bar plugin (see Omarchy integration)
```

No sudo. It validates Node, Pi and Gentle AI, reports which Claude source it found,
copies the project to `~/.local/share/pi-quota`, symlinks `~/.local/bin/piquota`,
installs the Pi TUI extension (and its gentle-pi rail slot) unless `--no-extension`
is given,
and removes the previous generation's `shuvquota` shim so upstream `/usr/bin/shuvquota`
is reachable again.

## Commands

```bash
piquota                 # boxed panel: ring, bar, % left, "reset in 3h 12m"
piquota claude codex    # only these families
piquota github-actions  # GitHub Actions minutes (explicit opt-in; aliases: gh, actions)
piquota --json          # normalized report (for rp-host, scripts, and automations)
piquota --compact       # one line per provider
piquota --status        # single line with rings, for status bars
piquota --explain       # which stores and fields are read (names only)
piquota --clear-cache   # delete the cache and exit
piquota --no-color      # plain output
piquota --ttl 300       # cache TTL in seconds (default 60)
piquota --timeout 5000  # per-request timeout in ms (default 15000)
piquota --no-cache      # ignore the cache entirely
piquota --force         # ignore a still-fresh cache entry
piquota --no-refresh    # never refresh Antigravity's token in memory
piquota --version       # the version this binary reports

piquota auth status             # every credential source, including opencode.ai
piquota auth opencode           # open the login in Firefox and capture the session
piquota auth opencode --paste   # read the cookie from stdin instead
piquota auth opencode --no-browser
piquota auth opencode --wait 300

piquota omarchy                 # write pi-*.json records for Omarchy's Agents panel
piquota stats                   # durable token history: last frozen day, families, totals
piquota stats --rebuild-totals  # recompute totals.json from the frozen month files
```

Colours: green above 50% remaining, yellow 20–50%, red below 20%.

**Which window the ring shows:** always the **shortest** one (5h/session first,
then daily, weekly, monthly), because that is the limit you hit first. A weekly
window at 31% left is more consumed, but a 5h window at 97% is what answers "can
I keep working right now". Ties inside the same rank go to the tightest window,
so Antigravity's two 5h groups resolve to whichever is more consumed. The rule
lives in `selectPrimaryWindow()` (`src/model.js`), the CLI stamps
`primaryWindowId` into the report, and the Pi extension reads that field, so the
terminal and the TUI cannot disagree. The full panel still lists every window,
so nothing is hidden.

Inside Pi:

| Command | Effect |
| --- | --- |
| `/usage` | one on-demand refresh, show the full panel until the next prompt (or a second `/usage`), notify a one-line summary |
| `/usage box` | pin the five-row box above the editor |
| `/usage line` | pin the compact line above the editor, in its own row |
| `/usage panel` | full panel above the editor, pinned across prompts |
| `/usage hide` | hide the panel/line and stop background refresh until a surface is on again |
| `/usage status` / `nostatus` | enable/disable the footer status |
| `/usage refresh` | refresh only |
| `/usage json` | where the cached report lives |

### The Pi surface

Nothing is pinned by default: `/usage` is a one-shot command, so it claims no row
above the editor and leaves the footer alone. Turn a surface on with `/usage box`,
`/usage line`, `/usage panel` or `/usage status`; only then does the extension keep
it fresh with a background refresh (and a gentle refresh after each agent turn).
`/usage hide` gives the row back.

A provider with several accounts is shown as one header (`OP-Go · 7 of 14 accounts
ok`) plus one line per account with every window and its reset, e.g.
`#2 ● session 2% (10m) · week 10% (6d) · month 90% (19d)`, or the reason it failed
(`key rejected`, `no Go plan`). The leading glyph is the fullest window's band. The panel is rendered as a component, so Pi's ten-line
cap on plain widgets never truncates it, and the summary names the account with the
most room: `OP-Go: 7/14 ok · lowest 24% (#7)`.

`/usage box` pins the **five-row box above the editor**:

```
              ╭─ Quota ──────────────────╮
              │ Claude:  ○   0%   R:3h 12m │
              │ Codex:   ○   8%   R:2h 40m │
              │ Agy:     ○   4%      R:41m │
              │ Agy C/G: ? n/a  R:unknown │
              │ OP-Go:   ○   4%   R:1h 05m │
              ╰───────────────────────────╯
```

When gentle-pi's fullscreen sidebar is active, the same card is painted in its
right rail instead, under Status and TODO, and the above-editor box stays quiet so
the numbers are not shown twice. See [the rail slot](#the-gentle-pi-rail-slot).

* each name is painted with its **own brand colour** — Claude `#D97757`, Codex
  `#10A37F`, Antigravity `#4285F4`, OpenCode `#007AFF`;
* the numbers are **used**, not remaining, and the semaphore is both colour and
  shape (`○` plenty left → `◔` → `◕` → `●` nearly spent), so it still reads on a
  colourblind or mono terminal;
* **only active providers are shown:** if you only have Claude and Codex configured
  in Pi, only Claude and Codex appear in the line and on Moshi (no empty warning
  icons for providers you don't use);
* `NO_COLOR` / `TERM=dumb` drops the colours and keeps the glyphs;
* the window shown is the **shortest** one (5h first), and `/usage` expands every
  window with a used-fraction bar and the reset countdown.

Pi's theme only exposes a fixed palette, so brand colours are emitted as
truecolor ANSI. Widget string arrays are wrapped in `Text` components by Pi,
which are ANSI-aware, so the codes are measured correctly and `theme.fg()` keeps
working in the same strings.

### Why the footer is off by default

gentle-pi replaces the footer with its own shell bar (`setFooter`) and that bar
drops segments **from the end** when the line overflows:

```js
while (segments.length > 1 && visibleWidth(left) > width) segments.pop();
```

Extension statuses render last, so a footer status is the first thing discarded —
which is why a long status line appears and then vanishes once the bar fills with
cost, branch and usage data. The quota line therefore lives in its own row, where
nothing competes for it. `/usage status` still enables the footer variant for
anyone who wants it.

### The gentle-pi rail slot

gentle-pi paints its right rail from a **hardcoded allowlist**, so a part that
another extension registers is silently never drawn:

```ts
const sections = ["footer", "agents", "todo"].map((key) => { /* ... */ });
```

piQuota registers its card under `quota`, which that list does not include. There is
no injection point, so the card cannot appear in the rail on its own. The fix is one
anchored edit that appends the part:

```ts
const sections = ["footer", "agents", "todo", "quota"].map((key) => { /* ... */ });
```

`piquota gentle-pi` owns that edit:

* `piquota gentle-pi status` — report whether the rail renders the quota part;
* `piquota gentle-pi apply` — append the part (idempotent);
* `piquota gentle-pi revert` — remove the part and restore the original bytes.

Because a gentle-pi update replaces the package, the patch would otherwise vanish.
The extension therefore **validates the slot on every session start** and re-applies
it when it is gone, reporting the repair instead of doing it silently. `install.sh`
applies it at install time and reverts it on `--uninstall`.

Safety properties, all covered by `tests/rail-patch.test.mjs`:

* exactly one array literal is rewritten; every other byte of the file is untouched;
* an unrecognized shape is **refused**, never guessed at, because a wrong rewrite of
  another extension's layout would break the whole rail;
* the write is atomic, the pre-patch revision is kept as a one-time
  `.pi-quota-backup` next to the file, and the result is re-read after writing with a
  restore from that backup when it does not read back as patched;
* `PI_QUOTA_GENTLE_PI_DIR` points the lookup elsewhere, which is what keeps the test
  suite away from a real installation.

If gentle-pi is absent, or the slot cannot be applied, nothing breaks: the card stays
in the box above the editor. The rail only exists in fullscreen at 140 columns or
wider, so the suppression of that box is conditional on gentle-pi reporting its rail
as active — in regular mode or a narrow terminal the box is the only surface.

## JSON feed & rp-host integration (`piquota --json`)

`piquota --json` provides a structured, machine-readable feed of all configured
provider quotas. It is designed for consumption by local status bars, dynamic
islands, background pollers, and client applications such as `rp-host` (from the
Rp suite) without external network daemons or closed-source intermediaries:

* **Predictable exit status**: exits `0` if at least one configured provider
  answered successfully, or `1` if all providers failed or are unconfigured.
* **`primaryWindowId`**: the CLI pre-calculates the most urgent quota window
  (e.g., short 5h session window over weekly or monthly allowances) so consumer
  pills or widgets do not have to implement provider-specific priority hierarchies.
* **Percentages and Countdown**: `usedPercent` and `remainingPercent` report
  percentages (0..100); `resetsInSec` provides the exact integer seconds until
  reset, immune to local clock skew.
* **`notConfigured` vs `ok`**: unconfigured providers report `notConfigured: true`,
  allowing consumers to cleanly omit them without displaying false-positive
  error indicators.
* **`localStats`**: the tokens Pi's own session files recorded, per family,
  shaped exactly like the fields Omarchy's Agents panel reads (today, the last
  seven local days, all-time per-model buckets) plus a `byAccount` breakdown for
  numbered siblings. `localStatsMeta` says how the scan went.

```json
{
  "engine": "pi-quota",
  "schemaVersion": 1,
  "readOnly": true,
  "generatedAt": "2026-10-15T05:35:21.210Z",
  "sources": ["/home/user/.pi/agent/auth.json"],
  "warnings": [],
  "providers": [
    {
      "family": "codex",
      "label": "Codex (Pi)",
      "account": "user@example.com",
      "plan": "plus",
      "source": "/home/user/.pi/agent/auth.json",
      "sourceKind": "pi",
      "expiresInMin": 12650,
      "ok": true,
      "notConfigured": false,
      "error": null,
      "updatedAt": "2026-10-15T05:35:21.210Z",
      "primaryWindowId": "5h",
      "windows": [
        {
          "id": "5h",
          "label": "5h window",
          "usedPercent": 14.5,
          "remainingPercent": 85.5,
          "resetsAt": "2026-10-15T10:35:24.000Z",
          "resetsInSec": 18003,
          "windowSeconds": 18000,
          "note": null
        }
      ]
    }
  ]
}
```

The token part of the same report is abridged here (`recentDays` always carries
seven entries, oldest first, today last):

```json
{
  "localStats": {
    "codex": {
      "hasLocalStats": true,
      "hasPromptStats": true,
      "todayTotalTokens": 14172,
      "todayPrompts": 3,
      "todaySessions": 1,
      "todayTokensByModel": { "gpt-5.1-codex": 14172 },
      "weekTokensByModel": { "gpt-5.1-codex": 118422 },
      "recentDays": [{ "date": "2026-10-27", "messageCount": 0 }],
      "totalPrompts": 1200,
      "totalSessions": 42,
      "activeDays": 11,
      "activeDates": ["2026-10-27"],
      "modelUsage": { "gpt-5.1-codex": { "inputTokens": 4, "outputTokens": 425, "cacheReadInputTokens": 6838, "cacheCreationInputTokens": 6905 } },
      "byAccount": { "#1": { "todayTokens": 14172, "weekTokens": 118422, "todayPrompts": 3, "totalPrompts": 1200, "totalTokens": 48812210 } }
    }
  },
  "localStatsMeta": { "files": 604, "scanned": 1, "reused": 603, "bytesRead": 3042, "durationMs": 9, "partial": false, "budgetMs": 12000, "frozenDays": 0, "locked": false }
}
```

### Each provider refreshes on its own clock

Anthropic's usage endpoint answers `429` when polled every minute; Codex,
Antigravity and OpenCode Go tolerate 60 s intervals. To prevent cards from looking
stale without triggering rate limits:

| Family | Clock |
| --- | --- |
| Claude | **300 s** (`--claude-ttl`) |
| Codex, Antigravity, OpenCode Go | **60 s** (`--fetch-ttl`) |

`src/refresh.js` keeps a timestamp per family, requests only what is past its own
clock, and merges the result back into the canonical report. `src/sticky.js`
keeps the last healthy snapshot during transient upstream 429 throttles so the
user never loses visibility. Permanent failures (expired sign-in, missing
credential) are never masked.

## Omarchy integration

Omarchy 4.0.4's **Agents** bar panel draws every `*.json` record in
`${XDG_STATE_HOME:-~/.local/state}/omarchy/agents/usage/`, whoever wrote it.
`piquota omarchy` (opt-in, one shot) writes one record per provider piQuota can
read, so Claude, Codex, Antigravity and OpenCode Go all get a tab:

```bash
piquota omarchy                  # write pi-claude.json, pi-codex.json, ... once
./install.sh --omarchy-timer     # also run it every 5 minutes (systemd user timer)
```

- Records are named `pi-<family>.json`, so they never overwrite Omarchy's own
  `claude.json` / `codex.json`. They hold plan names, used percentages, window
  labels, reset times, and — when the token scan has run — aggregate token counts
  per local day and per model (`hasLocalStats`, `recentDays`, `modelUsage`).
  No prompt text, session path, account or e-mail address is copied.
- A provider with a failing sign-in shows a status and a help line instead of
  limits. A provider that is not configured gets no record, and a stale
  `pi-*.json` is removed on the next run.
- A family with several accounts (numbered `<base>-<slot>` entries in
  `auth.json`) still gets **one** record: every healthy account contributes only
  the window that constrains it, titled `#<slot> · Session|Weekly|Monthly`, and
  failed accounts add no rows but are summarised by reason, e.g.
  `#8–#10 key rejected · #11–#14 no Go plan`. The same record also carries
  `accounts[{id, ok, status, limits}]` with every window of every account
  (`status` is a short reason such as `Key rejected` for a failed one), which
  Omarchy's built-in panel ignores and this package's own plugin draws.
- Omarchy's native collector already tracks Claude with richer local statistics, so
  `piquota omarchy` automatically skips `claude` and cleans up duplicate `pi-claude.json`
  files when `claude.json` exists in the usage directory (override with `PI_QUOTA_OMARCHY_SKIP`).
- `PI_QUOTA_OMARCHY_DIR` overrides the output directory. `./install.sh --uninstall`
  removes the timer and the `pi-*.json` records.

### The AI Usage bar plugin

The package also ships its own Omarchy bar widget, `cad0p.pi-usage` ("AI
Usage", in [`omarchy/cad0p.pi-usage/`](omarchy/cad0p.pi-usage/)). It is derived
from Omarchy's built-in Agents plugin (MIT, by Omarchy) and reuses the shell's
own panel components, so it looks the same, but it has no tabs: every provider
is a collapsible section of one scrolling panel.

- **Header row**: the provider's mark, name and plan, the headline percentage
  with its window and reset (`Weekly · 1d`), a chip when something is wrong
  (`Unavailable`, `7 down`), and the headline meter while folded. The headline is
  the fullest window; for a multi-account provider it is the healthy account
  with the most room left, the `lowest` figure `/usage` prints.
- **Expanded**: the status card, LIMITS with the built-in meters and countdowns,
  then for a multi-account record one row per account with every window
  (`#2  session 2% 10m · week 10% 6d · month 90% 19d`, failed accounts dimmed
  with their reason), then TOKENS BY DAY and TOKENS BY MODEL whenever the record
  carries local statistics, drawn exactly as the built-in draws them.
- **Which section is open**: on first use, only the provider closest to a limit
  (ties go to the earliest reset). Every expand or collapse you make sticks,
  across popup opens and shell restarts, in
  `~/.local/state/omarchy/settings/cad0p.pi-usage.json`.
- **Keys**: `j`/`k` or the arrows walk the section headers (a tall open section
  scrolls first), Enter or Space toggles, `l`/`h` expand/collapse, `r` refreshes,
  Tab moves to the neighbouring bar panel, Esc closes. The mouse wheel scrolls;
  a click on a header toggles it.
- **Records**: every `*.json` in the usage directory, Omarchy's own included.
  A provider is hidden by `providers.<id>.enabled = false` in the widget's
  settings, the same switch the built-in uses. The plugin does **not** support
  the built-in Agents widget's synced cross-device aggregation
  (`syncMode`, `syncDir`, `syncFileName`, `syncDeviceId`). Users who rely on
  synced aggregation should keep the built-in widget; this plugin is not a full
  replacement for it.
- **Refresh**: the systemd timer and the Pi extension already publish the
  `pi-*.json` records, so the plugin never schedules `piquota`. `r`, a middle
  click or `omarchy-shell cad0p.pi-usage refresh` starts
  `piquota-omarchy.service` (or runs the package's `piquota omarchy` when there is
  no unit). Omarchy's collectors (`omarchy-agent-usage-update`) run on the
  `refreshIntervalSec` timer and for a record's `retryAdvised` retry, and only
  while the built-in Agents widget is off the bar (`omarchyCollectors`: `Auto`,
  `On` or `Off`, where `Off` never runs them), so keeping both never doubles the
  work.

Install it by linking it into Omarchy's plugin directory; the link points into
the pi package when there is one, so `pi update` updates the plugin too:

```bash
./install.sh --omarchy-plugin                          # symlink ~/.config/omarchy/plugins/cad0p.pi-usage (idempotent)
omarchy plugin enable cad0p.pi-usage                   # put it on the bar (right section)
omarchy bar put cad0p.pi-usage --after omarchy.agents  # or: right next to the built-in Agents icon
omarchy plugin disable omarchy.agents                  # optional: drop the built-in widget
```

Without the installer, the link is
`ln -s ~/.pi/agent/npm/node_modules/@cad0p/pi-usage/omarchy/cad0p.pi-usage ~/.config/omarchy/plugins/cad0p.pi-usage`
followed by `omarchy-shell shell rescanPlugins`. To hide providers, pass the whole
object, as with the built-in:
`omarchy bar set cad0p.pi-usage providers '{"fireworks":{"enabled":false}}' --json`.
Remove it with `omarchy plugin disable cad0p.pi-usage` and
`rm ~/.config/omarchy/plugins/cad0p.pi-usage` (`./install.sh --uninstall` removes
the link too); `omarchy plugin enable omarchy.agents` brings the built-in back.

IPC: `omarchy-shell cad0p.pi-usage <open|close|toggle|refresh>`, plus
`expand <id>` / `collapse <id>` (e.g. `expand pi-opencode-go`).

`tests/omarchy-harness/render.sh [out-dir] [--light]` renders the panel offscreen
to PNGs against fixture records, with Omarchy's real components and the current
theme, next to the built-in panel for comparison. It never touches the running
shell.

## Token stats from Pi's own sessions

Pi writes every assistant message's `usage` block into
`~/.pi/agent/sessions/**.jsonl` (plus `~/.omp/agent/sessions` when the omp fork
is installed; `PI_CODING_AGENT_DIR` relocates the Pi agent directory). piQuota
folds those messages into tokens per local day and per model, per provider, and
shows them next to the quota:

| Where | What |
| --- | --- |
| `piquota --json` | `localStats.<family>` — the Omarchy-shaped counters plus `byAccount` |
| `/usage` panel | a `tokens` row per provider: today, 7 days, prompts, then the top 3 models of the week |
| `piquota omarchy` | the optional fields Omarchy's Agents panel draws as "Tokens by day" and "Tokens by model" |
| `piquota stats` | the durable history: last frozen day, families, prompts, session-days |

What counts: one assistant message with a non-zero token count is one prompt,
and its tokens are `input + output + cacheRead + cacheWrite` — the same sum the
Omarchy panel renders. Messages are bucketed by **local** date (the panel calls
the last row "Today"). Only providers piQuota can bill are counted:
`anthropic`, `openai-codex`, `antigravity`, `opencode-go` and their numbered
siblings, so `opencode-go-7` is account `#7`. Providers it does not manage
(`deepinfra`, `xai`, ...) are ignored, and so is the custom `claude-bridge`
provider: its tokens are not a Pi subscription.

**Two stores, two lifetimes.** Open days (normally just today) live in the
disposable scan cache. Once a local day is over it is frozen into a durable
history that no rescan, no cache wipe and no session deletion can rewrite. The
history is Pi data, so it lives next to Pi's agent directory:

| Path | What |
| --- | --- |
| `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-usage/totals.json` | all-time rollup per family and account (models, prompts, session-days, active dates) plus `lastFrozenDay` |
| `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-usage/tokens-YYYY-MM.json` | the frozen days of one local month, keyed day → family → slot → model |
| `~/.cache/pi-quota/local-sessions.json` | per-session-file size, mtime, byte offset and copy fingerprint, open days, and pending late deltas for unreadable months |

> `~/.pi` is often a git repository. Add `agent/pi-usage/` to that repo's
> `.gitignore` if you do not want your token counts committed.

Freezing: every run moves each day before today that is not frozen yet into its
month file and into `totals.json`, then drops it from the per-file cache. The
month file is written first and the totals second; the `lastFrozenDay` watermark
makes a restart re-freeze a half-written day idempotently (the month write is a
SET per day) instead of adding it twice. A late write to an already-frozen day —
a session that appends just past midnight — increments both stores directly; if
its month is temporarily unreadable, the delta stays in the cache until a later
run can write it. Such a held delta lives only in the disposable cache: if the
cache is lost before the month becomes writable, that delta is dropped, because
the bytes of a frozen day are never read again. A crash between the month and totals writes can double that
one small delta. A budget-truncated scan never freezes: history is only written
from complete runs.

Consequences, all covered by tests: history survives session deletion and cache
loss. A lost or corrupt `totals.json` is moved aside as
`totals.json.corrupt-<ts>` and **rebuilt from the month files**, which are the
authoritative record of frozen days — not from the session files, because a
session deleted since then would otherwise shrink history. Frozen days are never
recomputed, so a replaced session file cannot rewrite them either.

Damaged month files are handled without rebuilding frozen days from sessions. A
month that cannot be *read* (permissions, I/O) is left alone: the run warns, keeps
its open days in the cache, and does not freeze them until the month is readable.
Other history proceeds normally, and this alone does not force a full session
rescan. A rollup rebuild never writes `totals.json` from an incomplete month set.

A *corrupt* or foreign-version month is moved aside by the lock owner (never by a
read-only run) to `.corrupt-<ts>`. Its warning names the file and directs you to copy the
`.corrupt-<ts>` backup back to the original month path if recoverable, or to delete
the backup to abandon those counts. Until one of the two happens, freezing stops at
that month for *every* later day too (the frozen watermark only moves forward), so
later days stay open in the cache and each run repeats the warning; once the backup
is restored or deleted, the held days freeze on the next run. Frozen days are never rebuilt from sessions: their
daily rows are missing (shown as 0) in `recentDays`, while `totals.json` retains
the all-time counts, so the two views may disagree. `piquota stats --rebuild-totals`
refuses while a quarantined month has not been restored. A lost *month* file
loses that month's daily detail; normal runs keep the all-time totals, and a
rebuild can recover counts from every remaining month file even if sessions are
gone. Rebuild refuses when there is no month file at all while `totals.json`
still has data, because replacing that rollup with an empty one would turn a
missing directory into permanently lost history. A normal run reads only
`totals.json` plus the month files covering the last seven days (current month,
and the previous one early in a month), so years of history never slow a run: on
this machine 45 frozen days cost ~28 KB in total — `totals.json` 6.9 KB and two
month files of 5.4 KB and 16 KB. A day inside that window is read from its month
file once frozen, so late writes appear in "tokens by day" without waiting for
the week to roll over.

Cost: the first run streams each session file once — 1.56 GB across 608 files
in 3.0 s here; later runs read only the bytes appended since the previous scan
(59 ms of scanning for the whole store, ~20 KB read), and every byte is parsed
once in normal operation. The CLI's own wall time is dominated by the provider
calls either way.

What forces a file to be read from its first byte (a *rescan*, in which frozen
days are skipped and only open days are rebuilt): the cache missing or corrupt,
the file replaced or now shorter, a path the cache has never seen (a copy, a
move, a restored backup — its old days were already frozen under its previous
path), or the same size with a new mtime (an in-place rewrite of the same
length). An append only reads the new bytes. The one rewrite this cannot see is
one that restores both the size *and* the mtime, which no stat-based check can
detect. The cache is atomic and `0600`.

Two writers are routine here (the systemd timer and `/usage`), so a run takes an
exclusive lock — `local-sessions.json.lock`, with a 2-minute stale timeout —
before it reads the history. The file holds an owner token, and a live run
refreshes its mtime as it walks the store, so a slow scan is never mistaken for a
dead one. A run that cannot take the lock reports the numbers already on disk and
writes nothing; a run that is taken over mid-scan notices on its next refresh and
also writes nothing (it never deletes its successor's lock).

Duplicate *sessions* are handled two ways. A byte-identical copy of a session
file (a copy, a restored backup, a sync tool) is recognised by a (size, first
32 KB, last 32 KB) fingerprint and contributes nothing; anything appended to it
later is counted normally, and if the original is deleted the copy is adopted and
read on the next run. A fingerprint can collide — two same-size sessions that
differ only in the middle — so a candidate is verified by streaming both files
before it is called a copy; that full comparison runs only on the rare duplicate.
A *fork* that copies a prefix and then diverges has its own size and tail, so it
is counted as a session of its own, duplicated prefix included: on this machine
(611 files, 186,443 assistant messages) only 11 message ids appeared in more than
one file (0.006%), none of them on today, so message-id de-duplication would cost
megabytes to correct a handful of tokens and is not implemented.

The scan has a wall-clock budget (12 s, or `PI_QUOTA_LOCAL_STATS_BUDGET_MS`) so
the first run cannot push `/usage` past its 30 s exec timeout; when it runs out
the report carries `localStatsMeta.partial`, the panel marks the numbers
`scan partial`, and nothing is frozen that run. `PI_QUOTA_LOCAL_STATS=0` turns
the scan off.

Session counts are **session-days**, not distinct session files: a day is frozen
as aggregate rows, without the list of files that fed it, so a session that runs
past midnight counts once on each day it appears in. `todaySessions` is exact
(those files are still open); `totalSessions` is the sum of the per-day counts.

## Layout

```
src/auth/pi-auth.js            read-only auth.json reader, WSL + Linux, deduplicated
src/auth/claude-code-auth.js   read-only Claude Code store; never carries its refresh token
src/auth/jwt.js                Codex JWT payload reader (claim keys contain dots)
src/browser/cookies.js         read-only Firefox/Chromium cookie access via a temp copy
src/browser/history.js         workspace ids recovered from a copied places.sqlite
src/opencode/session.js        cookie + workspace resolution, dashboard fetch
src/opencode/dashboard.js      three-strategy parser for the Go plan page
src/providers/*.js             one file per provider; each degrades instead of throwing
src/providers/github-actions.js  plan-derived org Actions minutes via authenticated gh CLI
src/providers/antigravity-oauth.js  in-memory refresh with Google's public client
src/providers/backoff.js       per-family throttle state
src/sticky.js                  last published / last good snapshots and throttle recovery
src/engine.js                  collectQuota() -> one normalized report
src/local/pi-sessions.js       token counts from Pi's session files, incremental scan
src/local/history.js           frozen local-day history: month files + all-time rollup
src/model.js                   window normalization, percent and reset parsing
src/render/{theme,panel}.js    colors, thresholds, rings, bars, boxed panel
src/cache.js                   report cache at ~/.cache/pi-quota/usage.json
src/omarchy/record.js          pure mapping from the report to Omarchy usage records
src/omarchy/publish.js         atomic writer for pi-*.json, and stale-record cleanup
src/refresh.js                 per-family refresh clocks, and the merge back into one report
src/cli/args.js                argument parsing, and the flag/positional split
src/cli/commands/stats.js      `piquota stats` and `--rebuild-totals`
src/exec.js                    the one place that spawns gh CLI binary
src/http.js                    fetch wrapper: timeouts, JSON, redaction
contrib/systemd/               user service and timer behind `install.sh --omarchy-timer`
omarchy/cad0p.pi-usage/        the AI Usage Omarchy bar plugin (QML; UsageLogic.js is its pure logic)
tests/omarchy-harness/         offscreen renderer for the plugin, fixtures included
bin/piquota.js                 the only CLI
extensions/quota-panel.ts      Pi TUI line and /usage
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `no <family> credential in the Pi store` | Not logged in to Pi for that provider. `/login <provider>` in Pi. |
| `no claude credential in the Pi store or from the Claude Code CLI` | Neither Claude source is configured. `/login anthropic` in Pi, or install Claude Code and run `claude` once. |
| `Claude Code CLI has no readable credentials; looked for …` | The store is missing, empty or corrupt. `piquota --explain` prints every path that was tried. |
| `Claude Code token expired or rejected; run \`claude\` once` | Claude Code's own access token lapsed. Run any `claude` command; piQuota never refreshes it. |
| Claude reports `plan pro` but the window looks wrong | The store is chosen by preference, not by success. `PI_QUOTA_CLAUDE_SOURCE=pi piquota` forces the other source; the cache is keyed by that setting, so the switch refetches. |
| `rate limited (HTTP 429); retry in Ns` | The vendor throttled the usage endpoint. Wait, or raise `--ttl`. |
| `Antigravity token rejected` | Refresh failed; `/login antigravity` in Pi. `--no-refresh` disables the attempt. |
| `no "auth" cookie for opencode.ai in N readable store(s)` | Run `piquota auth opencode`, or paste the cookie. |
| `only encrypted Chromium stores found` | Log in with Firefox; Chrome on Windows uses DPAPI. |
| `unknown flag: --x` | The flag is a typo or was removed. `piquota --help` lists every flag. |
| `unknown argument` | `piquota --help` lists every flag. |

## Tests

```bash
node --test tests/*.test.mjs     # 354 tests, fake tokens only, no network
```

Modules covered: `auth.json` parsing and de-duplication, the Claude Code store
(including that the refresh token never leaves it and that reading leaves the file
byte-identical), Claude source precedence, the five providers (including GitHub
Actions plan resolution, opt-in gating and degradation, the two Antigravity
failures and the OpenCode degradation), the dashboard parser's three
strategies, the Firefox cookie reader against a synthetic SQLite database, the
Antigravity refresh (in-memory only), sticky and last-good snapshots resilience,
the Omarchy record mapping and atomic writer, the Omarchy plugin's logic,
manifest and marks, the local token scan (family and slot mapping, incremental
append, shrink, deletion, local-day bucketing, cache corruption), the durable
history (month partitioning, freezing at midnight, late appends to frozen days,
cache loss, a crash between the month and totals writes, corrupt-history
quarantine, rebuild-totals), the renderers, the Pi extension contract, the
per-family refresh clocks, argument parsing, and the structure of these
documents themselves (tables, fences, links, anchors).

## Acknowledgments & Prior Art

* **[shuvquota](https://github.com/shuv1337/shuvquota)** by [@shuv1337](https://github.com/shuv1337):
  Huge credit to `shuvquota` for pioneering multi-provider terminal quota monitoring across AI services. Its approach to rate-limit endpoints, dashboard parsing patterns for OpenCode Go, and terminal quota concepts served as inspiration for this project.

  `piQuota` was built as a standalone, strictly read-only implementation designed specifically around [Pi Coding Agent](https://github.com/earendil-works/pi) credentials (`~/.pi/agent/auth.json`), Gentle AI orchestration, and zero-dependency JSON and desktop integrations.
