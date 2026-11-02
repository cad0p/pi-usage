# AI Usage (`cad0p.pi-usage`)

One Omarchy bar icon and one scrolling panel for every AI subscription that has
a usage record in `${XDG_STATE_HOME:-~/.local/state}/omarchy/agents/usage/`:
pi-usage's `pi-*.json` and Omarchy's own `claude`, `codex` and `fireworks`
records alike. Every provider is a collapsible section instead of a tab; a
multi-account provider shows every window of every account.

Part of [`@cad0p/pi-usage`](../../README.md#the-ai-usage-bar-plugin), which
documents installation, keys, settings and IPC. Install with
`./install.sh --omarchy-plugin`, then `omarchy plugin enable cad0p.pi-usage`.

| File | Role |
|---|---|
| `Panel.qml` | Bar button, popup, keyboard and IPC (`omarchy-shell cad0p.pi-usage …`) |
| `UsageContent.qml` | The scrolling list of provider sections and their rows |
| `Main.qml` | Record discovery and watching, expansion state, refresh |
| `Agent.qml` | Per-record file watcher |
| `UsageLogic.js` | Pure logic (headline, ordering, formatting), tested with `node --test` |
| `assets/` | Provider marks, `<family>.svg` with a `-light` twin where needed |

Derived from Omarchy's built-in Agents plugin (`shell/plugins/agents`, MIT,
by Omarchy): its record contract, rows, meters, type scale and the Claude,
Codex and Fireworks marks. MIT, like the package.
