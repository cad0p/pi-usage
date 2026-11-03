# AI Usage (`cad0p.pi-usage`)

One Omarchy bar icon and one scrolling panel for every AI subscription that has
a usage record in `${XDG_STATE_HOME:-~/.local/state}/omarchy/agents/usage/`:
pi-usage's `pi-*.json` and Omarchy's own `claude`, `codex` and `fireworks`
records alike. Every provider is a collapsible section instead of a tab; a
multi-account provider shows every window of every account.

The plugin does **not** support the built-in Agents widget's synced cross-device
aggregation (`syncMode`, `syncDir`, `syncFileName`, `syncDeviceId`). Users who
rely on synced aggregation should keep the built-in widget; this plugin is not a
full replacement for it.

Omarchy's own collectors follow the `omarchyCollectors` setting: `Off` never
runs them, `Auto` only while the built-in Agents widget is off the bar — the
`retryAdvised` retry included.

Part of [`@cad0p/pi-usage`](../../README.md#the-ai-usage-bar-plugin), which
documents installation, keys, settings and IPC. Install with
`./install.sh --omarchy-plugin`, then `omarchy plugin enable cad0p.pi-usage`.

The installer links the plugin directory; Omarchy loads that symlink, but
`omarchy plugin validate` rejects symlinked plugin folders. Validate the real
package path instead, for example
`omarchy plugin validate ~/.pi/agent/npm/node_modules/@cad0p/pi-usage/omarchy/cad0p.pi-usage`,
or validate the directory in a source checkout—not the
`~/.config/omarchy/plugins/cad0p.pi-usage` link.

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
