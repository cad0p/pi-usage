# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 🐛 Bug Fixes

- *(extension)* /usage glance closes on the next prompt; every window per account (closes #9)
- *(auth)* Read Antigravity from Pi's google-antigravity login (closes #12)


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


