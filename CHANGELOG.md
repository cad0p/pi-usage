# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Mistral quota from the billing API (closes #36)
- Devin quota from pi-devin's snapshot (closes #37)

### 🐛 Bug Fixes

- Base account is #1, label column fits, API-key sibling is not down (closes #38, closes #39, closes #40)
- *(cli)* Cut coloured rows by visible width; colour follows the terminal (closes #46)


## [0.11.6] - 2026-11-03

<!-- USER-EDITABLE SECTION START -->
`/usage` refreshes inside pi with no CLI child, each provider on its own, and every key works under the kitty keyboard protocol.

- **In-process refresh:** `/usage` runs the engine inside pi instead of spawning `piquota`, so it paints in about 0.35 s and `r` finishes in under a second. Each provider updates on its own, so a slow one never holds the others back. The token-stats scan runs in a worker thread and never blocks the TUI. The systemd timer still uses the read-only CLI.
- **Logins stay valid:** inside pi, Claude and Codex tokens come from pi's own `getProviderAuth`, which renews them under pi's lock exactly as when you use the model. Antigravity, which pi 1.5 no longer resolves, keeps its renewed token in memory for its lifetime; nothing is written back.
- **Kitty keyboard protocol (Ghostty, kitty, foot):** arrows, Esc, Enter, Tab, Space and every legend key work in their CSI-u form on both tabs. Key releases never act, repeats do. A drift test compares the decoder with the installed pi-tui matcher.
- **History all-time counts today once**, and an all-time figure that lags behind the month files is shown dimmed with a note instead of disappearing.
- **Antigravity header:** no repeated project, and no false "token expired" while the account works.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- In-process /usage refresh, each provider on its own (closes #26)

### 🐛 Bug Fixes

- History all-time counts today once; Antigravity header without the false expiry (closes #29)
- *(extension)* /usage keys work under the kitty keyboard protocol (closes #33)


## [0.11.5] - 2026-11-03

<!-- USER-EDITABLE SECTION START -->
A fullscreen `/usage` with browsable history, and a refresh about three times faster.

- **Fullscreen `/usage`:** bare `/usage` opens a view like `/context`. It paints at once from the last report (`refreshing …` until the new one lands, then `updated HH:MM`), keeps an always-visible key legend, folds provider sections, and scrolls with the arrows, `j`/`k`, PgUp/PgDn, `g`/`G` and the mouse wheel. Rows wrap instead of being clipped, so resets stay visible at 64 columns. Folds, page and month persist for the pi session; `esc`/`q` leaves a clean editor.
- **History:** `tab` (or `1`/`2`) switches to month history: days, models and per-account tokens, `←`/`→` and `[`/`]` walk the months, and today merges from the live report exactly once. Backed by the new read-only `piquota stats --json [--month YYYY-MM]`.
- **No invented `#1`:** the unnumbered base account carries no suffix on any surface.
- **Faster refresh:** a provider's accounts are queried in parallel (default 8, `PI_QUOTA_ACCOUNT_CONCURRENCY` 1–32): a forced refresh went from ~2.9 s to ~1.0 s, OpenCode Go's 14 keys from ~3.8 s to ~0.9 s.
- **User-Agent:** every request sends `pi-usage/<version> (+https://github.com/cad0p/pi-usage)` instead of Node's generic `node` (Antigravity keeps its CLI agent).
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Fullscreen /usage with month history; no invented "#1" (closes #21, closes #22)

### ⚡ Performance

- Query a provider's accounts in parallel; send the package User-Agent (closes #23)


## [0.11.4] - 2026-11-03

<!-- USER-EDITABLE SECTION START -->
Token history, a scrolling bar panel, and Antigravity from Pi's own login.

- **Token stats from Pi's sessions:** tokens by day and by model per provider and account, read from `~/.pi/agent/sessions` with no extra credential. Incremental (a warm run reads only appended bytes) and durable: finished days are frozen into `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-usage/` (`totals.json` + `tokens-YYYY-MM.json`) and survive session deletion and cache loss. Shown in `/usage` and in the Omarchy records; `piquota stats` inspects the history.
- **AI Usage bar plugin (`cad0p.pi-usage`):** looks like Omarchy's Agents panel, but every provider is a collapsible section of one scrolling panel, multi-account providers list every window of every account, and tokens by day and by model are drawn as in the built-in. `install.sh --omarchy-plugin` links it from the pi package, so `pi update` updates it.
- **No more writes into other Omarchy plugins:** `piquota omarchy` stopped copying provider marks into every `~/.config/omarchy/plugins/*/assets`.
- **`/usage` glance:** bare `/usage` closes on the next prompt or a second `/usage` (`/usage panel` still pins), and each account line shows session, week and month.
- **Antigravity:** read from Pi's `google-antigravity` login (the legacy `antigravity` key still works).
- `docs/verification.md`: the checklist every change follows.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- *(local)* Token stats by day and by model from Pi's session files (closes #16)
- *(omarchy)* AI Usage bar plugin, every provider a collapsible section (closes #18)

### 🐛 Bug Fixes

- *(extension)* /usage glance closes on the next prompt; every window per account (closes #9)
- *(auth)* Read Antigravity from Pi's google-antigravity login (closes #12)

### 📚 Documentation

- Add the verification checklist every change follows (closes #14)


## [0.11.3] - 2026-11-02

<!-- USER-EDITABLE SECTION START -->
First fix release of the fork. With Claude Code uninstalled, Claude now reads Pi's own login instead of a dead Claude Code store, and `/usage` shows every OpenCode Go account.

- **Claude source:** `auto` passes over an expired Claude Code token when Pi's `anthropic` login is fresh, and adds a warning naming the switch. `PI_QUOTA_CLAUDE_SOURCE=claude-code` still pins the CLI store. The report cache is keyed by the Claude source setting, so a switch refetches.
- **Multi-account panel:** a provider with several accounts is one header plus one line per account (its fullest window, or `key rejected` / `no Go plan`), rendered as a component so Pi's ten-line widget cap no longer truncates it.
- **Summary:** `OP-Go: 7/14 ok · lowest 24% (#7)` instead of account #1's number.
- `piquota --version` reads `package.json`.
<!-- USER-EDITABLE SECTION END -->

### 🐛 Bug Fixes

- /usage live bugs — dead Claude store, truncated panel, account-#1 summary (closes #5)


