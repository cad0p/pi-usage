# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

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


