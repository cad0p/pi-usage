# Verification — CI gates, independent review, offline gates, live proof

This is the verification checklist every change to `@cad0p/pi-usage` follows: what CI proves on every PR, how independent review works, the offline gates, and what must be proven live for each change type. It composes the repo's authoritative sources (`.github/workflows/*`, [ARCHITECTURE.md](ARCHITECTURE.md), the README) into one file. If a needed signal is missing here, that is a docs gap: add it in the same PR that needed it.

## 1. How to use this file

1. Find your change type in §5 and note its live-proof row.
2. Run the offline gates (§4) in your worktree.
3. Push and confirm CI is green (§2) on the exact head SHA.
4. Get independent review (§3) on that SHA.
5. Prove live (§5) with real output, never a substitute.
6. Close out (§6).

## 2. CI gates

PR checks, all required by the `main` ruleset:

| Check | What it proves |
|---|---|
| `test (ubuntu-latest)`, `test (macos-latest)` | `.github/workflows/ci.yml`: `npm test` (the full offline suite, including `tests/docs.test.mjs`: markdown tables, fences, links, anchors and the README test counter) on Node 24, then `npm pack --dry-run` asserts the tarball ships `bin/piquota.js`, `extensions/quota-panel.ts`, `README.md`, `LICENSE`. Add any new shipped entry point (e.g. the Omarchy plugin) to that list in the same PR. |
| `validate-package-version` | Feature PRs must not bump `package.json` version; release PRs (`release/from-v*`) own it. |
| `validate-release-pr` | Release-PR shape only; passes or skips on ordinary PRs. |

```bash
gh -R cad0p/pi-usage pr checks <pr>          # pass / fail / pending / skipping
gh -R cad0p/pi-usage pr checks <pr> --watch
gh run view <run-id> --log
```

Anything other than a pass (or a legitimate skip) is a blocker. Release PRs opened by the bot start as `action_required`: approve their runs with `gh api -X POST repos/cad0p/pi-usage/actions/runs/<id>/approve`.

## 3. Independent review protocol

Every non-trivial change gets a verdict from an agent that did **not** author it:

1. **Functional** — does it do what the issue says; are the tests real; failure paths and boundaries.
2. **Adversarial** — break it: malformed provider payloads, 401/403/429/timeouts, an `auth.json` with unknown, blank or sibling-slot entries, corrupt cache/history files, midnight and month rollovers, very large session files, mutated test expectations (a pinned string or number that drifts must fail a test).
3. **Credential-safety lens** — for anything touching auth, HTTP, caches, records or logs: `auth.json` is opened read-only and never written; Claude/Codex tokens are never refreshed; no token, key, cookie or e-mail reaches stdout, stderr, caches, history files or Omarchy records.

Rules: findings are reproduced before reporting (failing command, mutated test, quoted line). Verdicts are recorded against a SHA; any later push needs a fresh pass by the lenses it touches. An agent's summary is intent, not outcome: the orchestrator reads the diff.

## 4. Offline gates

```bash
npm test                     # node --test tests/*.test.mjs — offline, fake tokens, temp dirs only
npm pack --dry-run           # what the tarball will ship
```

- Tests never touch the network, the real home directory, the real `~/.pi`, the real Omarchy usage directory or the user's desktop session.
- Update the README test counter (`# N tests` under "Tests") when adding tests; `tests/docs.test.mjs` enforces it.
- Feature PRs do not edit `CHANGELOG.md` or the `package.json` version.

## 5. Live proof per change type

Live proof runs the real code against the real surface and captures the authoritative signal; green CI is not live proof. Record the commands and (redacted) output in the PR.

**Always, for every live run:**

```bash
H=$(sha256sum ~/.pi/agent/auth.json)
# … live commands …
[ "$H" = "$(sha256sum ~/.pi/agent/auth.json)" ] && echo auth-unchanged
<live command> | grep -cE 'sk-|ya29\.|1//|eyJ[A-Za-z0-9_-]{20,}|sessionKey'   # must print 0
```

**Never disrupt the owner's desktop.** No live run reloads the running Omarchy shell, writes into `~/.config/omarchy/plugins` or `shell.json`, opens popups on real outputs, sends input, or screenshots real outputs, unless the owner has said yes for that run. Run worktree code, never the installed copy, except in the post-release check.

| Change type | Live proof |
|---|---|
| **Provider / auth (`src/providers/*`, `src/auth/*`, `src/engine.js`)** | `node bin/piquota.js --json --force <family>` from the worktree: the family is `ok` with the expected windows, or degrades with the intended typed error. For multi-account families, every slot appears (OpenCode Go: `opencode-go`, `opencode-go-2` … in `auth.json` order) and per-account errors stay per account. Always the auth-unchanged and no-secret checks above. |
| **Omarchy records (`src/omarchy/*`)** | `PI_QUOTA_OMARCHY_DIR=$(mktemp -d) node bin/piquota.js omarchy`, then `jq` each `pi-*.json`: contract fields present, `percent` in 0..1 (records and `accounts[].limits`), no account identifiers beyond `#<slot>`. Never write into the live `~/.local/state/omarchy/agents/usage` from a worktree: the systemd timer owns it.  |
| **Omarchy bar plugin (`omarchy/`)** | Offscreen harness only: render the panel from fixture records (copies of real records are fine) to PNG for collapsed, expanded, scrolled and multi-account states, review the images, and require zero QML warnings on the harness's stderr. `tests/omarchy-harness/render.sh $T/png --records $T/records --scenarios default,all-collapsed,all-expanded,scroll-middle,scroll-bottom,cursor,keys > $T/dark.log 2>&1`, the same with `--light`, then `grep -E 'WARN\|ERROR\|TypeError\|ReferenceError' $T/*.log \| grep -vc 'window masks'` must print 0 (that one line is the offscreen platform, not QML). `$T/records` = the records built above plus `node tests/omarchy-harness/fixtures.mjs $T/fx`'s `claude.json` for the token sections; `--scenarios builtin,builtin-2` renders the built-in Agents panel from the same records for a side-by-side look. `--scenarios adversarial` renders the malformed `recentDays: [null]` record, which `render.sh` copies only for that scenario (a run against real records would otherwise grow a second section for an id they already claim); it needs its own run, with `--light` too. The script itself exits non-zero on a QML warning, a failed `qs` or a missing PNG, so a green run needs no extra grep. `omarchy plugin validate omarchy/cad0p.pi-usage` must exit 0. The harness runs its own Quickshell on `QT_QPA_PLATFORM=offscreen` with a throwaway `HOME`, so nothing reaches the running shell; check `pgrep -af 'qs -p /tmp/pi-usage-harness'` is empty afterwards. If the Omarchy components cannot load offscreen, use a temporary headless Hyprland output with a separate Quickshell instance pinned to it, capture with `grim -o <that output>`, then remove the output and stop the instance. Installing into the live shell (one shell reload) is the owner's call and happens after release. |
| **Pi extension `/usage` (`extensions/quota-panel.ts`)** | Interactive tmux session running the worktree code: `PI_QUOTA_BIN=<worktree>/bin/piquota.js pi --no-extensions -e <worktree>/extensions/quota-panel.ts`. Capture with `tmux capture-pane -p -J`: bare `/usage` shows the panel and it closes on the next prompt or a second `/usage`; `/usage panel` pins it; `/usage hide` hides it; no persistent footer, box or status line by default; every account line fits the pane width; no "(widget truncated)". |
| **Local token stats (`src/local/*`)** | From the worktree, against the real sessions but a scratch agent dir, so nothing is written under `~/.pi` (`ln -s ~/.pi/agent/sessions "$SCRATCH/agent/sessions"`): a cold run (`PI_CODING_AGENT_DIR=$SCRATCH/agent XDG_CACHE_HOME=$SCRATCH/cache PI_QUOTA_LOCAL_STATS_BUDGET_MS=600000 node bin/piquota.js --json --no-cache`) and two warm runs; `sha256sum "$SCRATCH/agent/pi-usage/totals.json"` unchanged across the warm runs; `du -b` on the history files; `node bin/piquota.js stats` and `node bin/piquota.js stats --rebuild-totals`, with the totals hash unchanged by the rebuild. Check the history files hold only counts and model names, no session content. For a change that touches the freeze/lock/copy rules, also run two concurrent scans of one tree (`race.mjs`-style: two children, one late append) and confirm the frozen day moved by the delta once, plus a copied session file leaving the totals unchanged. Cold ≈ 3 s on 1.56 GB / 608 files (45 frozen days), warm ≈ 60 ms, history ≈ 28 KB. |
| **CLI flags / output** | Run each changed command and flag from the worktree and quote the output. |
| **Docs only** | CI green; every command and path the change mentions exists. State in the PR that no live run applies. |

**Post-release check (every release).** After npm has processed the version (the install metadata can lag a few minutes; `pi update` fails with a 404 until then): `pi update --extension npm:@cad0p/pi-usage`, `piquota --version`, `systemctl --user start piquota-omarchy.service` and inspect the live `pi-*.json` records, then `/usage` in a tmux pi session, with the auth-unchanged and no-secret checks.

## 6. Closeout

- [ ] CI green on the exact head SHA (§2).
- [ ] Offline gates green locally on that commit (§4).
- [ ] Independent verdicts recorded on that SHA (§3); fixes re-verified.
- [ ] Live proof captured for the change type (§5), or an explicit statement why none applies.
- [ ] Scope: `git diff --name-only origin/main...HEAD` matches the plan; no `CHANGELOG.md` or version edits; no stray artifacts.
- [ ] PR title and body carry `closes #N`; the body comes from the vault file and lists the evidence.
- [ ] After release: post-release check (§5) done.
