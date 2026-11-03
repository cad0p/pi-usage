/**
 * Pi quota line — read-only quota for the providers Pi already owns.
 *
 * Surface: nothing at session start. Bare /usage opens a fullscreen overlay that
 * takes the keyboard, scrolls, folds a section per provider and closes on Esc or
 * q; nothing stays on screen behind it. /usage box, /usage line or /usage panel
 * pins a surface above the editor, /usage status enables the footer, and
 * /usage hide removes it. No timer or post-turn refresh runs until a surface is on.
 *
 * Design rules:
 *   - the numbers are **used**, not remaining, so the line answers "how much have
 *     I burned" and the bar fills up as you spend;
 *   - each provider name is painted with its own brand colour, which Pi's theme
 *     does not expose, so it is emitted as truecolor ANSI. Widget string arrays
 *     are wrapped in Text components, which are ANSI-aware, so the codes are
 *     measured correctly. `NO_COLOR` / `TERM=dumb` disables them;
 *   - the semaphore is both colour and shape (empty circle = plenty left, filled
 *     circle = nearly spent), so it survives a colourblind or mono terminal;
 *   - the footer status is off by default: gentle-pi already owns that line and
 *     truncates it from the end.
 *
 * Command: /usage, with /usage refresh | line | panel | hide | status | nostatus |
 * json. No surface is pinned at session start: the command is on demand.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `mergeLastGood` is intentionally NOT imported here: it lives in src/sticky.js
// and the CLI (`bin/piquota.js`) already applies it on every `--json` run, so the
// extension sees a report whose transiently-failed families already carry the last
// good snapshot in `provider.note`. The classifier below mirrors src/providers/error-kind.js
// so the extension can render category-specific glyphs without depending on the repo.

const STATUS_KEY = "00-quota";
const WIDGET_KEY = "quota-line";
const RAIL_KEY = "quota";
// Symbol shared with gentle-pi's runtime sidebar state registry.
const SIDEBAR_STATE_KEY = Symbol.for("gentle-pi.experimental-sidebar.state");
const REFRESH_MS = Number(process.env.PI_QUOTA_REFRESH_MS) || 300_000;
const AGENT_END_DEBOUNCE_MS = 1_500;
const EXEC_TIMEOUT_MS = 30_000;

type QuotaWindow = {
  id: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  resetsInSec: number | null;
  windowSeconds?: number | null;
  note: string | null;
};

type QuotaProvider = {
  family: string;
  label: string;
  primaryWindowId?: string | null;
  account: string;
  plan: string | null;
  windows: QuotaWindow[];
  error: string | null;
  note?: string | null;
  ok: boolean;
  notConfigured?: boolean;
  sourceKind?: "pi" | "claude-code";
  updatedAt: string;
  expiresInMin: number | null;
};

type LocalModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

type LocalAccountStats = {
  todayTokens?: number;
  weekTokens?: number;
  todayPrompts?: number;
  totalPrompts?: number;
  totalTokens?: number;
};

/**
 * Pi's own token counts for one family, computed by the CLI from the session
 * files. It only ever holds aggregate counts: no prompt text, no identities.
 */
type LocalFamilyStats = {
  hasLocalStats?: boolean;
  todayPrompts?: number;
  todaySessions?: number;
  todayTotalTokens?: number;
  todayTokensByModel?: Record<string, number>;
  weekTokensByModel?: Record<string, number>;
  recentDays?: Array<{ date: string; messageCount: number }>;
  totalPrompts?: number;
  totalSessions?: number;
  activeDays?: number;
  activeDates?: string[];
  modelUsage?: Record<string, LocalModelUsage>;
  byAccount?: Record<string, LocalAccountStats>;
};

type QuotaReport = {
  providers: QuotaProvider[];
  generatedAt: string;
  sources: string[];
  warnings: string[];
  byFamily: Record<string, QuotaProvider[]>;
  localStats?: Record<string, LocalFamilyStats>;
  localStatsMeta?: { partial?: boolean } | null;
};

type Theme = {
  fg: (key: string, text: string) => string;
  bold: (text: string) => string;
  bg?: (key: string, text: string) => string;
};

/** Only the UI surface this extension uses. */
type UiContext = {
  hasUI: boolean;
  /** Pi's run mode; `custom` components only exist in the TUI. */
  mode?: string;
  ui: {
    theme: Theme;
    setStatus: (key: string, value: string | undefined) => void;
    setWidget: (key: string, value: any, options?: { placement?: string }) => void;
    notify: (message: string, type?: string) => void;
    custom?: (
      factory: (tui: any, theme: Theme, keybindings: any, done: (result?: unknown) => void) => any,
      options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
    ) => Promise<unknown>;
  };
};

/** Brand accents. Anthropic clay, OpenAI teal, Google blue, OpenCode accent. */
const BRAND: Record<string, string> = {
  claude: "#D97757",
  codex: "#10A37F",
  antigravity: "#4285F4",
  "opencode-go": "#007AFF",
  "github-actions": "#2088FF",
};

/** Short display names that stay legible in one row. */
const SHORT_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Agy",
  "opencode-go": "OP-Go",
  "github-actions": "GH",
};

/** Semaphore bands, expressed in *used* percent. */
const BANDS = [
  { max: 25, color: "#3FB950", glyph: "○" },
  { max: 50, color: "#3FB950", glyph: "◔" },
  { max: 80, color: "#D29922", glyph: "◕" },
  { max: Infinity, color: "#F85149", glyph: "●" },
];

function colorEnabled(): boolean {
  return process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

/** 24-bit foreground colour; a no-op when colours are disabled. */
function paint(hex: string, text: string): string {
  if (!colorEnabled() || !/^#[0-9a-fA-F]{6}$/.test(hex)) return text;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
}

function bandFor(usedPercent: number) {
  return BANDS.find((band) => usedPercent < band.max) ?? BANDS[BANDS.length - 1];
}

function usedOf(window: QuotaWindow | null): number | null {
  if (!window) return null;
  if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) return window.usedPercent;
  if (typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)) {
    return 100 - window.remainingPercent;
  }
  return null;
}

function resolveCliPath(): string | null {
  const override = process.env.PI_QUOTA_BIN;
  if (override && existsSync(override)) return override;
  try {
    const sibling = fileURLToPath(new URL("../bin/piquota.js", import.meta.url));
    if (existsSync(sibling)) return sibling;
  } catch {}
  for (const candidate of [
    join(homedir(), ".local", "share", "pi-quota", "bin", "piquota.js"),
    join(homedir(), ".local", "bin", "piquota"),
    join(homedir(), ".pi", "agent", "npm", "node_modules", "@cad0p", "pi-usage", "bin", "piquota.js"),
    join(homedir(), ".pi", "agent", "npm", "node_modules", "@j3pf", "piquota", "bin", "piquota.js"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Rank by how soon a window constrains you: 5h/session first, then daily,
 * weekly, monthly. Kept in sync with windowRank() in src/model.js.
 */
function windowRank(window: QuotaWindow): number {
  const seconds = window.windowSeconds;
  if (typeof seconds === "number" && seconds > 0) {
    if (seconds <= 6 * 3600) return 0;
    if (seconds <= 36 * 3600) return 1;
    if (seconds <= 8 * 86400) return 2;
    if (seconds <= 31 * 86400) return 3;
  }
  const id = (window.id ?? "").toLowerCase();
  if (/5h|session|hour|rolling/.test(id)) return 0;
  if (/daily|day/.test(id)) return 1;
  if (/weekly|week|7d/.test(id)) return 2;
  if (/monthly|month|30d/.test(id)) return 3;
  return 4;
}

/**
 * The window that represents a provider: the shortest one, so the row answers
 * "can I keep working right now". Prefers the window the CLI already chose.
 */
function headline(provider: QuotaProvider): QuotaWindow | null {
  const chosen = provider.windows.find((window) => window.id === provider.primaryWindowId);
  if (chosen) return chosen;

  const scored = provider.windows.filter((window) => usedOf(window) !== null);
  if (scored.length === 0) return provider.windows[0] ?? null;
  return scored.reduce((best, window) => {
    const bestRank = windowRank(best);
    const rank = windowRank(window);
    if (rank !== bestRank) return rank < bestRank ? window : best;
    return (usedOf(window) as number) > (usedOf(best) as number) ? window : best;
  });
}

/**
 * Compact surfaces show the first account per family, because a fourteenth
 * OpenCode Go account must not push Claude out of the footer. The full panel is
 * the one place that lists every account.
 */
function firstPerFamily(providers: QuotaProvider[]): QuotaProvider[] {
  const seen = new Set<string>();
  const out: QuotaProvider[] = [];
  for (const provider of providers) {
    if (seen.has(provider.family)) continue;
    seen.add(provider.family);
    out.push(provider);
  }
  return out;
}

function bar(usedPercent: number | null, width = 10): string {
  if (usedPercent === null) return "·".repeat(width);
  const filled = Math.round((Math.max(0, Math.min(100, usedPercent)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function humanDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "unknown";
  if (seconds <= 0) return "now";
  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

type ErrorKind = "transient" | "throttle" | "expired" | "auth" | "missing" | "unknown";

/**
 * Classify a provider error so the renderer can paint a distinct glyph and
 * caption per cause. Mirrors src/providers/error-kind.js so the extension is
 * self-contained: the file lives in ~/.pi/agent/extensions and has no access
 * to the repo's `src/` tree.
 */
function errorKind(error: string | null | undefined): ErrorKind {
  if (!error || typeof error !== "string") return "unknown";
  if (
    /no [a-z-]+ credential|has no (anthropic|openai-codex|antigravity|opencode-go) (access )?token|no key stored|no "auth" cookie|no opencode\.ai session/i.test(
      error,
    )
  ) {
    return "missing";
  }
  if (
    /token expired|token EXPIRED|token -?\d+m|expires in -\d+|sign-in expired|re-authenticate|expired or rejected|rejected by .* zen|rejected; run \/login|reconnect OpenCode in Pi/i.test(
      error,
    )
  ) {
    return "expired";
  }
  if (/HTTP 401|HTTP 403|401|403|unauthorized|forbidden|invalid_grant|token rejected/i.test(error)) {
    return "auth";
  }
  if (/HTTP 429|rate limited|backing off|throttle/i.test(error)) {
    return "throttle";
  }
  if (/HTTP 5\d\d|timed out|timeout|ECONNRESET|socket|network|fetch failed|ENOTFOUND|ETIMEDOUT|EPIPE|ECONNREFUSED|aborted|hang up/i.test(error)) {
    return "transient";
  }
  return "unknown";
}

function isRecoverableError(error: string | null | undefined): boolean {
  const kind = errorKind(error);
  return kind === "transient" || kind === "throttle";
}

function errorGlyph(error: string | null | undefined): string {
  switch (errorKind(error)) {
    case "transient":
      return "~";
    case "throttle":
      return "…";
    case "expired":
    case "auth":
      return "!";
    case "missing":
      return "·";
    default:
      return "?";
  }
}

function errorCaption(error: string | null | undefined): string {
  switch (errorKind(error)) {
    case "throttle":
      return "rate-limited upstream";
    case "transient":
      return "upstream temporarily unavailable";
    case "expired":
      return "token expired";
    case "auth":
      return "credential rejected";
    case "missing":
      return "not configured";
    default:
      return "unavailable";
  }
}

/**
 * The one-row line: brand-coloured name plus a semaphore and the used percent.
 *
 *   Claude:○ 0%   Codex:○ 8%   Agy:○ 4%   Agy C/G:○ 4%   OP-Go:○ 3%
 */
function renderLine(report: QuotaReport, theme: Theme): string {
  // Only display providers that are configured in Pi.
  // A provider that is simply not configured does not belong in the editor line.
  const active = firstPerFamily(report.providers.filter((provider) => provider.notConfigured !== true));
  if (active.length === 0) return theme.fg("dim", "quota: no providers configured in Pi");

  const renderToken = (provider: QuotaProvider, label: string, window: QuotaWindow | null, color = BRAND[provider.family] ?? "#8B949E"): string => {
    const name = paint(color, `${label}:`);
    if (!provider.ok) {
      const kind = errorKind(provider.error);
      const glyph = errorGlyph(provider.error);
      const tone = kind === "transient" || kind === "throttle" ? "warning" : kind === "expired" || kind === "auth" ? "error" : "dim";
      return `${name}${theme.fg(tone, glyph)}`;
    }

    const used = usedOf(window);
    if (used === null) return `${name}${theme.fg("dim", "?")}`;

    const band = bandFor(used);
    return `${name}${paint(band.color, band.glyph)} ${paint(band.color, `${Math.round(used)}%`)}`;
  };
  const tokens = active.flatMap((provider) => {
    if (provider.family !== "antigravity") {
      return [renderToken(provider, SHORT_NAME[provider.family] ?? provider.family, headline(provider))];
    }
    return [
      renderToken(provider, "Agy", provider.windows.find((window) => window.id === "gemini-5h" || (/gemini/i.test(window.id) && isFiveHour(window)))),
      renderToken(provider, "Agy C/G", provider.windows.find((window) => window.id === "claude-gpt-5h" || (/(claude|gpt|3p)/i.test(window.id) && isFiveHour(window))), "#7AA2F7"),
    ];
  });
  return tokens.join("  ");
}

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/**
 * Clip themed text to a visible width without cutting an ANSI sequence in half.
 * gentle-pi drops the entire rail when one card line overflows its column, so a
 * long error caption must shorten the line instead of widening it.
 */
function clipVisible(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  const tokens = text.match(/\u001b\[[0-9;]*m|[\s\S]/g) ?? [];
  let out = "";
  let used = 0;
  for (const token of tokens) {
    if (token.startsWith("\u001b")) {
      out += token;
      continue;
    }
    if (used >= width - 1) break;
    out += token;
    used += 1;
  }
  return `${out}\u2026\u001b[0m`;
}

function isFiveHour(window: QuotaWindow): boolean {
  return (
    window.id === "5h" ||
    /5h|session|hour/i.test(`${window.id} ${window.label}`) ||
    (typeof window.windowSeconds === "number" && window.windowSeconds <= 6 * 3600)
  );
}

/** Compact five-row quota widget aligned to the right edge of the editor. */
export function renderBox(report: QuotaReport, theme: Theme, totalWidth?: number): string[] {
  const providerFor = (family: string): QuotaProvider | undefined => report.providers.find((provider) => provider.family === family);
  const windowFor = (family: string, matches: (window: QuotaWindow) => boolean) => {
    const provider = providerFor(family);
    return { provider, window: provider?.windows.find(matches) ?? null };
  };
  const rows = [
    { label: "Claude: ", color: "#D97757", ...windowFor("claude", isFiveHour) },
    { label: "Codex:  ", color: "#10A37F", ...windowFor("codex", isFiveHour) },
    { label: "Agy:    ", color: "#4285F4", ...windowFor("antigravity", (window) => window.id === "gemini-5h" || (/gemini/i.test(window.id) && isFiveHour(window))) },
    { label: "Agy C/G:", color: "#7AA2F7", ...windowFor("antigravity", (window) => window.id === "claude-gpt-5h" || (/(claude|gpt|3p)/i.test(window.id) && isFiveHour(window))) },
    { label: "OP-Go:  ", color: "#007AFF", ...windowFor("opencode-go", isFiveHour) },
  ];
  if (providerFor("github-actions")) {
    rows.push({ label: "GH Actions:", color: "#2088FF", ...windowFor("github-actions", (window) => window.id === "monthly") });
  }
  const content = rows.map(({ label, color, provider, window }) => {
    const name = paint(color, label);
    if (!provider || !provider.ok) {
      return { left: `${name} ${theme.fg("error", `! ${provider ? errorCaption(provider.error) : "not configured"}`)}`, right: "" };
    }
    const used = usedOf(window);
    let mid = theme.fg("dim", "? n/a");
    if (used !== null) {
      const band = bandFor(used);
      mid = paint(band.color, `${band.glyph} ${`${Math.round(used)}%`.padStart(4)}`);
    }
    return {
      left: `${name} ${mid}`,
      right: `${theme.fg("dim", "R:")}${paint("#E0AF68", humanDuration(window?.resetsInSec ?? null))}`,
    };
  });
  const innerWidth = Math.max(25, ...content.map(({ left, right }) => visibleLength(left) + (right ? 2 + visibleLength(right) : 0)));
  const box = [
    `╭─ Quota ${"─".repeat(Math.max(0, innerWidth - 6))}╮`,
    ...content.map(({ left, right }) => {
      const padding = right
        ? " ".repeat(Math.max(1, innerWidth - visibleLength(left) - visibleLength(right)))
        : " ".repeat(Math.max(0, innerWidth - visibleLength(left)));
      return `│ ${left}${padding}${right} │`;
    }),
    `╰${"─".repeat(innerWidth + 2)}╯`,
  ];
  const width = totalWidth ?? (process.stdout.columns || 80);
  return box.map((line) => `${" ".repeat(Math.max(0, width - visibleLength(line)))}${line}`);
}

function renderSidebarCard(report: QuotaReport | null, theme: Theme, width: number): string[] {
  const cardWidth = Math.max(4, width);
  const innerWidth = cardWidth - 4;
  const providerFor = (family: string): QuotaProvider | undefined => report?.providers.find((provider) => provider.family === family);
  const windowFor = (family: string, matches: (window: QuotaWindow) => boolean) => {
    const provider = providerFor(family);
    return { provider, window: provider?.windows.find(matches) ?? null };
  };
  const rows = report
    ? [
        { label: "Claude: ", color: "#D97757", ...windowFor("claude", isFiveHour) },
        { label: "Codex:  ", color: "#10A37F", ...windowFor("codex", isFiveHour) },
        { label: "Agy:    ", color: "#4285F4", ...windowFor("antigravity", (window) => window.id === "gemini-5h" || (/gemini/i.test(window.id) && isFiveHour(window))) },
        { label: "Agy C/G:", color: "#7AA2F7", ...windowFor("antigravity", (window) => window.id === "claude-gpt-5h" || (/(claude|gpt|3p)/i.test(window.id) && isFiveHour(window))) },
        { label: "OP-Go:  ", color: "#007AFF", ...windowFor("opencode-go", isFiveHour) },
        ...(providerFor("github-actions")
          ? [{ label: "GH Actions:", color: "#2088FF", ...windowFor("github-actions", (window) => window.id === "monthly") }]
          : []),
      ]
    : [];
  const content = rows.length > 0
    ? rows.map(({ label, color, provider, window }) => {
        const name = paint(color, label);
        const showingLastKnownValues = Boolean(provider?.note && /last known values/i.test(provider.note));
        if (!provider || (!provider.ok && !showingLastKnownValues)) {
          return { left: `${name} ! ${provider ? errorCaption(provider.error) : "not configured"}`, right: "" };
        }
        const used = usedOf(window);
        if (used === null) return { left: `${name} ? n/a`, right: "" };
        const band = bandFor(used);
        const indicator = showingLastKnownValues ? `${theme.fg("warning", "~")} ` : "";
        return {
          left: `${name} ${indicator}${paint(band.color, `${band.glyph} ${`${Math.round(used)}%`.padStart(4)}`)}`,
          right: `${theme.fg("dim", "R:")}${paint("#E0AF68", humanDuration(window?.resetsInSec ?? null))}`,
        };
      })
    : [{ left: theme.fg("dim", "loading quota …"), right: "" }];
  return [
    `╭─ Quota ${"─".repeat(Math.max(0, cardWidth - 10))}╮`,
    ...content.map(({ left, right }) => {
      // The right column is dropped before the left one is clipped: a reset countdown
      // matters less than the provider name and its percentage.
      const fits = right !== "" && 2 + visibleLength(left) + 2 + visibleLength(right) + 2 <= cardWidth;
      const rightText = fits ? right : "";
      const leftRoom = innerWidth - (rightText === "" ? 0 : visibleLength(rightText) + 1);
      const leftText = clipVisible(left, Math.max(1, leftRoom));
      const padding = " ".repeat(Math.max(0, innerWidth - visibleLength(leftText) - visibleLength(rightText)));
      return `│ ${leftText}${padding}${rightText} │`;
    }),
    `╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`,
  ];
}

/** The detailed panel: every account and every window, with a used-fraction bar. */
/**
 * Clip one line to `width` visible columns, keeping SGR sequences intact. Every
 * glyph this extension paints is one column wide, so code points are columns.
 */
function clipToWidth(line: string, width: number): string {
  let visible = 0;
  let out = "";
  let styled = false;
  for (let index = 0; index < line.length; ) {
    const sgr = /^\u001b\[[0-9;]*m/.exec(line.slice(index));
    if (sgr) {
      out += sgr[0];
      styled = true;
      index += sgr[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index) as number);
    // Close any open style so a cut line cannot bleed colour into the next one.
    if (visible + 1 > width) return styled ? `${out}\u001b[0m` : out;
    out += char;
    visible += 1;
    index += char.length;
  }
  return out;
}

/** One visible character with the SGR runs in front of it and the style it inherits. */
type StyledChar = { raw: string; char: string; style: string };

/**
 * Split a themed line into visible characters, folding each SGR run into the
 * character that follows it and remembering the style open at that point.
 * Wrapping needs both: a continuation row must re-open the style it inherits,
 * and every produced row must close whatever it left open.
 */
function styledChars(line: string): { chars: StyledChar[]; trailing: string } {
  const chars: StyledChar[] = [];
  let pending = "";
  let style = "";
  for (let index = 0; index < line.length; ) {
    const sgr = /^\u001b\[[0-9;]*m/.exec(line.slice(index));
    if (sgr) {
      pending += sgr[0];
      style = sgr[0] === "\u001b[0m" ? "" : `${style}${sgr[0]}`;
      index += sgr[0].length;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index) as number);
    chars.push({ raw: `${pending}${char}`, char, style });
    pending = "";
    index += char.length;
  }
  return { chars, trailing: pending };
}

/**
 * Wrap one themed line to `width` columns, breaking at its " · " separators.
 *
 * A hard clip used to cut a row mid-token at 64 columns, which loses the datum
 * that matters most: "(18d)" is when the month resets, and "token exp" is the
 * state of the credential. So a row that does not fit wraps instead — the first
 * row keeps the line's own indent, every continuation is indented by the line's
 * leading spaces (or `hanging`), and no cell is ever dropped. A cell with no
 * separator in it wraps between words; a single word wider than the terminal is
 * the only case left to cut.
 */
function wrapLine(line: string, width: number, hanging?: string): string[] {
  const limit = Math.max(1, Math.floor(width));
  if (visibleLength(line) <= limit) return [line];
  const { chars, trailing } = styledChars(line);
  if (chars.length === 0) return [line];
  const visible = chars.map((item) => item.char).join("");
  // A break sits on the space in front of " · ", so neither row starts with a
  // dangling middle dot; a word boundary is the fallback for a long sentence.
  const breaks: number[] = [];
  const spaces: number[] = [];
  for (let index = 0; index + 2 < visible.length; index += 1) {
    if (visible[index] === " " && visible[index + 1] === "·" && visible[index + 2] === " ") breaks.push(index);
  }
  for (let index = 0; index < visible.length; index += 1) if (visible[index] === " ") spaces.push(index);
  const indent = hanging ?? /^ */.exec(visible)?.[0] ?? "";
  const row = (from: number, to: number, prefix: string, extra = ""): string => {
    // A wrapped row must not end in the padding the break was taken on.
    const text = `${prefix}${chars.slice(from, to).map((item) => item.raw).join("")}${extra}`.replace(/ +(?=(\u001b\[[0-9;]*m)*$)/, "");
    return /\u001b\[/.test(text) ? `${text}\u001b[0m` : text;
  };

  const lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const prefix = start === 0 ? "" : chars[start].style === "" ? indent : `${indent}${chars[start].style}`;
    const fits = start + Math.max(1, limit - visibleLength(prefix));
    if (fits >= chars.length) {
      lines.push(row(start, chars.length, prefix, trailing));
      break;
    }
    const breakAt = breaks.filter((index) => index > start && index <= fits).pop();
    const spaceAt = breakAt === undefined ? spaces.filter((index) => index > start && index <= fits).pop() : undefined;
    const cut = breakAt ?? spaceAt ?? fits;
    lines.push(row(start, cut, prefix));
    start = breakAt === undefined ? (spaceAt === undefined ? cut : cut + 1) : cut + 3;
  }
  return lines.length > 0 ? lines : [line];
}

/**
 * The panel as a component rather than a string array: Pi caps string-array
 * widgets at ten lines, and a multi-account family alone can exceed that.
 *
 * A line that does not fit wraps at its separators instead of being cut: at 64
 * columns a hard clip used to lose the half of a row that says when the month
 * resets, which is exactly the datum the row exists for.
 */
function panelComponent(lines: string[]) {
  return () => ({
    render: (width: number) => lines.flatMap((line) => wrapLine(line, Math.max(0, width - 1))).map((line) => ` ${line}`),
    invalidate() {},
  });
}

/** Window names for the one-line account rows (same words as the Omarchy panel). */
const WINDOW_TAG: Record<string, string> = { "5h": "session", weekly: "week", monthly: "month" };

/** A reset countdown in its largest unit, so a row of three stays narrow. */
function shortDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  if (seconds <= 0) return "now";
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

/** Token counts stay readable in a widget: 812, 4.1k, 1.2M. */
function formatTokens(value: number): string {
  const tokens = Math.max(0, Math.round(Number(value) || 0));
  if (tokens < 1_000) return String(tokens);
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens < 1_000_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${(tokens / 1_000_000_000).toFixed(1)}B`;
}

/** Model ids are long and provider-prefixed; the panel only needs the tail. */
function shortModelName(name: string): string {
  const text = String(name ?? "");
  const tail = text.split("/").pop() || text;
  return tail.length <= 22 ? tail : `${tail.slice(0, 21)}…`;
}

/**
 * The heaviest models of the last seven days, plus how many were left out.
 * The all-time buckets are the fallback for a report from a CLI that predates
 * the weekly breakdown, and for a week with no usage at all.
 */
function topModels(usage: Record<string, LocalModelUsage> | undefined, weekUsage: Record<string, number> | undefined, limit: number) {
  const byName = (a: { name: string; total: number }, b: { name: string; total: number }) =>
    b.total - a.total || a.name.localeCompare(b.name);
  const weekRows = Object.entries(weekUsage ?? {})
    .map(([name, total]) => ({ name, total: Number(total) || 0 }))
    .filter((row) => row.total > 0)
    .sort(byName);
  const rows = weekRows.length > 0
    ? weekRows
    : Object.entries(usage ?? {})
        .map(([name, bucket]) => ({
          name,
          total:
            (Number(bucket?.inputTokens) || 0) +
            (Number(bucket?.outputTokens) || 0) +
            (Number(bucket?.cacheReadInputTokens) || 0) +
            (Number(bucket?.cacheCreationInputTokens) || 0),
        }))
        .sort(byName);
  return { rows: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/**
 * The token section of one provider: today and the last seven days, then the
 * models that account for that usage. Two lines at most, aligned with the
 * window rows above it.
 */
function renderTokenRows(stats: LocalFamilyStats | undefined, labelWidth: number, theme: Theme, partial = false): string[] {
  if (!stats || stats.hasLocalStats === false) return [];
  const week = (stats.recentDays ?? []).reduce((sum, day) => sum + (Number(day?.messageCount) || 0), 0);
  const today = Number(stats.todayTotalTokens) || 0;
  const prompts = Number(stats.todayPrompts) || 0;
  const parts = [
    `${theme.fg("dim", "today")} ${formatTokens(today)}`,
    `${theme.fg("dim", "7d")} ${formatTokens(week)}`,
  ];
  if (prompts > 0) parts.push(theme.fg("dim", `${prompts} prompt${prompts === 1 ? "" : "s"}`));
  if (partial) parts.push(theme.fg("warning", "scan partial"));
  const lines = [`  ${theme.fg("dim", "tokens".padEnd(labelWidth))}  ${parts.join(theme.fg("dim", " · "))}`];

  const { rows, more } = topModels(stats.modelUsage, stats.weekTokensByModel, 3);
  if (rows.length > 0) {
    const cells = rows.map((row) => `${shortModelName(row.name)} ${formatTokens(row.total)}`);
    if (more > 0) cells.push(theme.fg("dim", `+${more} more`));
    lines.push(`  ${" ".repeat(labelWidth)}  ${cells.join(theme.fg("dim", " · "))}`);
  }
  return lines;
}

/** The account's fullest window: the one that stops its next prompt. */
function bindingWindow(provider: QuotaProvider): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const window of provider.windows) {
    const used = usedOf(window);
    if (used === null) continue;
    if (best === null || used > (usedOf(best) as number)) best = window;
  }
  return best;
}

/** Short per-account failure reason; mirrors src/omarchy/record.js. */
function accountReason(error: string | null | undefined): string {
  const text = String(error ?? "");
  if (/key rejected|key was rejected/i.test(text)) return "key rejected";
  if (/Go plan not active|Workspace access denied/i.test(text)) return "no Go plan";
  return errorCaption(error);
}

/**
 * The slot label of an account: "" for the base auth.json entry (it has no
 * number, so no surface may invent one) and "#<slot>" for a real sibling. A
 * report cached before the fix still says "#1" for the base entry.
 */
function accountLabel(account: string | null | undefined): string {
  const text = String(account ?? "");
  if (text === "#1") return "";
  return /^#\d+$/.test(text) ? text : text;
}

/** The per-account token row, tolerating the old "#1" key in a cached scan. */
function accountStats(stats: LocalFamilyStats | undefined, label: string): LocalAccountStats | undefined {
  if (!stats?.byAccount) return undefined;
  return stats.byAccount[label] ?? (label === "" ? stats.byAccount["#1"] : undefined);
}

/**
 * A family Pi holds several credentials for: one section and one line per
 * account, whatever the account labels look like.
 */
function isMultiAccount(providers: QuotaProvider[], provider: QuotaProvider): boolean {
  return providers.filter((other) => other.family === provider.family).length > 1;
}

/**
 * One family, many accounts: a header plus one line per account with only its
 * binding window, so fourteen keys stay fourteen lines instead of fifty-six.
 * Each line carries the account's own tokens for today, because on a
 * fourteen-key provider "which key burned today's quota" is the question.
 */
function renderAccountRows(accounts: QuotaProvider[], theme: Theme, stats?: LocalFamilyStats): string[] {
  const family = accounts[0].family;
  const healthy = accounts.filter((account) => account.ok).length;
  const header = `${paint(BRAND[family] ?? "#8B949E", SHORT_NAME[family] ?? accounts[0].label)} ${theme.fg("dim", `· ${healthy} of ${accounts.length} accounts ok`)}`;
  const lines = [header];
  // The base entry has no number: its label column is blank but padded to the
  // widest sibling, so the percentage columns still line up.
  const labels = accounts.map((account) => accountLabel(account.account));
  const width = Math.max(...labels.map((label) => label.length));
  accounts.forEach((account, index) => {
    const label = theme.fg("dim", labels[index].padEnd(width));
    if (!account.ok) {
      const kind = errorKind(account.error);
      const color = kind === "transient" || kind === "throttle" ? "warning" : kind === "expired" || kind === "auth" ? "error" : "dim";
      lines.push(`  ${label}  ${theme.fg(color, errorGlyph(account.error))} ${theme.fg("warning", accountReason(account.error))}`);
      return;
    }
    const window = bindingWindow(account);
    const used = usedOf(window);
    if (window === null || used === null) {
      lines.push(`  ${label}  ${theme.fg("dim", "no rate-limit windows reported")}`);
      return;
    }
    // Every window on one line, each in its own band colour; the leading glyph
    // is the fullest window's, so the column still sorts the accounts by eye.
    const band = bandFor(used);
    const cells = account.windows
      .filter((each) => usedOf(each) !== null)
      .map((each) => {
        const pct = usedOf(each) as number;
        const reset = each.resetsInSec === null ? "" : ` ${theme.fg("dim", `(${shortDuration(each.resetsInSec)})`.padEnd(5))}`;
        return `${theme.fg("dim", WINDOW_TAG[each.id] ?? each.id)} ${paint(bandFor(pct).color, `${Math.round(pct)}%`.padStart(4))}${reset}`;
      });
    const today = Number(accountStats(stats, labels[index])?.todayTokens) || 0;
    const tokens = today > 0 ? ` · ${formatTokens(today)} today` : "";
    lines.push(`  ${label}  ${paint(band.color, band.glyph)} ${cells.join(theme.fg("dim", " · "))}${theme.fg("dim", tokens)}`);
  });
  return lines;
}

/**
 * One provider block of the panel: the header painted with the provider name
 * and every window, account and token row that belongs to it. The overlay
 * folds on these blocks; the pinned widget renders them flat, unchanged.
 */
type PanelSection = { key: string; header: string; body: string[] };

/** The provider block of a single-account provider: its header plus its detail. */
function renderProviderLines(provider: QuotaProvider, theme: Theme, localStats: LocalFamilyStats | undefined, partialScan: boolean): string[] {
  const lines: string[] = [];
  const labelWidth = Math.max(6, ...provider.windows.map((window) => String(window.label ?? "").length));
  const name = paint(BRAND[provider.family] ?? "#8B949E", provider.label);
  const account = accountLabel(provider.account);
  const meta: string[] = account === "" ? [] : [account];
  if (provider.plan) meta.push(`plan ${provider.plan}`);
  // Two stores can back Claude, and this is the one place that says which.
  if (provider.sourceKind === "claude-code") meta.push("Claude Code CLI");
  if (provider.expiresInMin !== null && provider.expiresInMin <= 120) {
    meta.push(
      provider.expiresInMin < 0
        ? theme.fg("error", "token expired")
        : theme.fg("dim", `token ${provider.expiresInMin}m`),
    );
  }
  lines.push(meta.length > 0 ? `${name} ${theme.fg("dim", `· ${meta.join(" · ")}`)}` : name);

  if (!provider.ok) {
    const kind = errorKind(provider.error);
    const glyph = errorGlyph(provider.error);
    const color = kind === "transient" || kind === "throttle" ? "warning" : kind === "expired" || kind === "auth" ? "error" : "dim";
    lines.push(`  ${theme.fg(color, glyph)} ${theme.fg("warning", provider.note ?? errorCaption(provider.error))}`);
    if (isRecoverableError(provider.error) && provider.note) lines.push(`  ${theme.fg("warning", provider.note)}`);
  } else if (provider.windows.length === 0) {
    if (provider.note) lines.push(`  ${theme.fg("warning", `~ ${provider.note}`)}`);
    lines.push(`  ${theme.fg("dim", "no rate-limit windows reported")}`);
  } else {
    if (provider.note) lines.push(`  ${theme.fg("warning", `~ ${provider.note}`)}`);
    for (const window of provider.windows) {
      const used = usedOf(window);
      const label = theme.fg("dim", window.label.padEnd(labelWidth));
      if (used === null) {
        lines.push(`  ${label}  ${theme.fg("dim", window.note ?? "no percentage reported")}`);
        continue;
      }
      const band = bandFor(used);
      const reset = window.resetsInSec === null ? "" : theme.fg("dim", ` · reset in ${humanDuration(window.resetsInSec)}`);
      lines.push(
        `  ${label}  ${paint(band.color, band.glyph)} ${paint(band.color, bar(used))} ` +
          `${paint(band.color, `${used.toFixed(used < 10 ? 1 : 0)}%`.padStart(5))} ` +
          `${theme.fg("dim", "used")}${reset}`,
      );
    }
  }

  // Local token stats survive a failed quota probe: the credential may be
  // rejected while the tokens already burned are still a fact on disk.
  lines.push(...renderTokenRows(localStats, labelWidth, theme, partialScan));
  return lines;
}

/**
 * Split the panel into its foldable provider sections and the lines below them
 * (byline, unconfigured providers, warnings). Bare `/usage` folds these; the
 * pinned `/usage panel` flattens them back into the same list as before.
 */
function renderPanelLayout(report: QuotaReport, theme: Theme): { sections: PanelSection[]; tail: string[] } {
  const sections: PanelSection[] = [];
  const active = report.providers.filter((provider) => provider.notConfigured !== true);
  const unconfigured = report.providers.filter((provider) => provider.notConfigured === true);
  const renderedFamilies = new Set<string>();
  const partialScan = report.localStatsMeta?.partial === true;

  for (const provider of active) {
    const localStats = report.localStats?.[provider.family];
    const labelWidth = Math.max(6, ...provider.windows.map((window) => String(window.label ?? "").length));
    if (isMultiAccount(active, provider)) {
      if (renderedFamilies.has(provider.family)) continue;
      renderedFamilies.add(provider.family);
      const rows = renderAccountRows(active.filter((other) => other.family === provider.family), theme, localStats);
      sections.push({
        key: `${provider.family}`,
        header: rows[0] ?? paint(BRAND[provider.family] ?? "#8B949E", provider.label),
        body: [...rows.slice(1), ...renderTokenRows(localStats, labelWidth, theme, partialScan)],
      });
      continue;
    }
    const lines = renderProviderLines(provider, theme, localStats, partialScan);
    sections.push({ key: `${provider.family}:${provider.account}`, header: lines[0] ?? "", body: lines.slice(1) });
  }

  const tail: string[] = [];
  // No timestamp here: the overlay header already says when the report landed
  // ("updated HH:MM"), and a second format for the same fact reads as a
  // different number to check. The pinned panel prints this line alone.
  tail.push(theme.fg("dim", "used % · read-only"));
  if (unconfigured.length > 0) {
    const names = unconfigured.map((p) => SHORT_NAME[p.family] ?? p.family).join(", ");
    tail.push(theme.fg("dim", `not configured in Pi: ${names}`));
  }
  for (const warning of report.warnings.slice(0, 3)) {
    tail.push(theme.fg("warning", `warn: ${warning}`));
  }
  return { sections, tail };
}

/** The flat panel: every section, then the footer, unconfigured names, warnings. */
function renderPanel(report: QuotaReport, theme: Theme): string[] {
  const { sections, tail } = renderPanelLayout(report, theme);
  return [...sections.flatMap((section) => [section.header, ...section.body]), ...tail];
}

/**
 * Raw input sequences for the keys the overlay turns into actions. The
 * extension ships as one file with no runtime dependencies, so this mirrors
 * the subset of pi-tui's matchesKey() the overlay needs: arrows, paging and
 * home/end in the encodings terminals and tmux actually send.
 */
const KEY_SEQUENCES: Record<string, string[]> = {
  up: ["\u001b[A", "\u001bOA"],
  down: ["\u001b[B", "\u001bOB"],
  left: ["\u001b[D", "\u001bOD"],
  right: ["\u001b[C", "\u001bOC"],
  pageUp: ["\u001b[5~", "\u001b[[5~"],
  pageDown: ["\u001b[6~", "\u001b[[6~"],
  home: ["\u001b[H", "\u001bOH", "\u001b[1~", "\u001b[7~"],
  end: ["\u001b[F", "\u001bOF", "\u001b[4~", "\u001b[8~"],
};

function isKey(data: string, name: string): boolean {
  return (KEY_SEQUENCES[name] ?? []).includes(data);
}

/** Pi reports the terminal height as a number; fall back to a usable frame. */
function terminalRows(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value as number)) : 24;
}

function clampScroll(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** One line with its label left and its status right, clipped to the width. */
function spreadLine(left: string, right: string, width: number): string {
  if (right === "") return clipToWidth(left, width);
  const rightText = clipToWidth(right, width);
  const leftText = clipToWidth(left, Math.max(0, width - visibleLength(rightText) - 1));
  const gap = Math.max(0, width - visibleLength(leftText) - visibleLength(rightText));
  return `${leftText}${" ".repeat(gap)}${rightText}`;
}

/** One content row of the overlay, with the section it belongs to. */
type OverlayRow = { text: string; section: number; header: boolean };

/**
 * What outlives one overlay instance. Every bare `/usage` builds a fresh view,
 * so the folds live in the extension — for the pi session only, never on disk.
 */
type OverlaySession = {
  expanded: Map<string, boolean>;
};

function newOverlaySession(): OverlaySession {
  return { expanded: new Map() };
}

type UsageOverlayOptions = {
  /** Close the overlay through the component's completion callback. */
  done: () => void;
  /** Ask the TUI for a frame after state changed. */
  requestRender: () => void;
  /** Current terminal height. */
  getRows: () => number;
  /** The newest report the extension holds, or null before the first one. */
  getReport: () => QuotaReport | null;
  /** The last refresh failure, shown as a line instead of thrown. */
  getError: () => string | null;
  isRefreshing: () => boolean;
  /** Run the same forced refresh `/usage` always ran, in the background. */
  refresh: () => void;
};

/**
 * The key legend. Every key the current view answers appears here, and pairs a
 * view does not answer (month navigation outside History) are added by that
 * view. The legend wraps instead of dropping pairs, so a 60-column terminal
 * still shows every key; the close key stays last.
 */
const NOW_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["↑↓/jk", "move"],
  ["enter/←→/hl", "fold"],
  ["pgup/pgdn", "page"],
  ["g/G", "top/end"],
  ["wheel", "scroll"],
  ["r", "refresh"],
  ["esc/q", "close"],
];

/** The report cache the CLI writes after every successful run. */
function reportCachePath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "pi-quota", "usage.json");
}

/**
 * The last report the CLI cached, read synchronously so the overlay can paint
 * on the same keystroke as /usage. Read-only, age is irrelevant for a first
 * frame, and a missing or malformed cache is simply "no cached report".
 */
function readCachedReport(): QuotaReport | null {
  try {
    const parsed = JSON.parse(readFileSync(reportCachePath(), "utf-8"));
    const report = parsed?.report;
    if (!report || !Array.isArray(report.providers)) return null;
    // The cache stores absolute reset instants; the surfaces paint countdowns.
    const now = Date.now();
    for (const provider of report.providers) {
      for (const window of provider.windows ?? []) {
        if (!window.resetsAt) continue;
        const resetsAtMs = Date.parse(window.resetsAt);
        if (!Number.isNaN(resetsAtMs)) window.resetsInSec = Math.max(0, Math.round((resetsAtMs - now) / 1000));
      }
    }
    return report as QuotaReport;
  } catch {
    return null;
  }
}

/** The update time shown once a refresh lands, as the clock time it happened. */
function updatedAtLabel(report: QuotaReport): string {
  const at = new Date(report.generatedAt);
  if (Number.isNaN(at.getTime())) return "updated";
  return `updated ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * Split `count` cells into the fewest rows that fit `width`, then even them out.
 *
 * Greedy filling is the row count; a second pass picks, among all splits into
 * that many rows, the one whose widest row is the narrowest. That is what turns
 * a 7+1 legend into 4+4 without ever adding a row or dropping a pair.
 *
 * @returns the number of cells on each row.
 */
function balanceRows(lengths: number[], width: number, separator: number): number[] {
  const count = lengths.length;
  if (count === 0) return [];
  const prefix: number[] = [0];
  for (const length of lengths) prefix.push(prefix[prefix.length - 1] + length);
  const cost = (from: number, to: number) => prefix[to] - prefix[from] + separator * (to - from - 1);

  let rows = 1;
  let used = lengths[0];
  for (let index = 1; index < count; index += 1) {
    if (used + separator + lengths[index] <= width) used += separator + lengths[index];
    else {
      rows += 1;
      used = lengths[index];
    }
  }
  if (rows <= 1) return [count];

  // best[i][r]: the narrowest possible widest row for cells[i..] in exactly r rows.
  const best: number[][] = Array.from({ length: count + 1 }, () => Array(rows + 1).fill(Number.POSITIVE_INFINITY));
  best[count][0] = 0;
  for (let remaining = 1; remaining <= rows; remaining += 1) {
    for (let from = count - 1; from >= 0; from -= 1) {
      for (let take = 1; take <= count - from - (remaining - 1); take += 1) {
        const rest = best[from + take][remaining - 1];
        if (rest === Number.POSITIVE_INFINITY) continue;
        const widest = Math.max(cost(from, from + take), rest);
        if (widest < best[from][remaining]) best[from][remaining] = widest;
      }
    }
  }

  const counts: number[] = [];
  let from = 0;
  for (let remaining = rows; remaining > 0; remaining -= 1) {
    let chosen = 1;
    for (let take = 1; take <= count - from - (remaining - 1); take += 1) {
      const rest = best[from + take][remaining - 1];
      if (rest === Number.POSITIVE_INFINITY) continue;
      if (Math.max(cost(from, from + take), rest) === best[from][remaining]) {
        chosen = take;
        break;
      }
    }
    counts.push(chosen);
    from += chosen;
  }
  return counts;
}

/**
 * The focused `/usage` view: the whole panel, one collapsible section per
 * provider, a header cursor, scrolling and a one-line key hint. It reads the
 * report and the error through callbacks, so a background refresh only has to
 * call redraw(); the view holds no timer and no disk state.
 */
export class UsageOverlay {
  private readonly theme: Theme;
  private readonly options: UsageOverlayOptions;
  /** Fold state, shared with the next view for this pi session. */
  private readonly session: OverlaySession;
  private cursor = 0;
  private scroll = 0;
  private disposed = false;
  /** Width of the last frame; rows are wrapped for it. */
  private measureWidth = 80;
  private cachedLayout: { sections: PanelSection[]; tail: string[] } | null | undefined;
  private cachedMetrics: { rows: OverlayRow[]; headerRows: number[]; sectionEnds: number[] } | undefined;
  private cachedMetricsWidth: number | undefined;
  private cachedWidth: number | undefined;
  private cachedRows: number | undefined;
  private cachedLines: string[] | undefined;
  /** Legend rows the last frame needed; the viewport height depends on it. */
  private legendRows = 1;

  constructor(theme: Theme, options: UsageOverlayOptions, session: OverlaySession = newOverlaySession()) {
    this.theme = theme;
    this.options = options;
    this.session = session;
  }

  /** The fold map shared with the next view, so a reopen keeps every fold. */
  private get expanded(): Map<string, boolean> {
    return this.session.expanded;
  }

  /** Drop cached rows and frames; the next render rebuilds from live state. */
  public invalidate(): void {
    this.cachedLayout = undefined;
    this.cachedMetrics = undefined;
    this.cachedMetricsWidth = undefined;
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  /** Re-render after the extension's background refresh landed. */
  public redraw(): void {
    if (this.disposed) return;
    this.invalidate();
    this.options.requestRender();
  }

  /** Stop drawing once the overlay closed, however it closed. */
  public dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  /** Handle one raw key: fold, move, refresh, scroll, close. */
  public handleInput(data: string): void {
    if (this.disposed) return;
    if (data === "\u001b" || data === "q") {
      this.dispose();
      this.options.done();
      return;
    }
    if (data === "r") {
      this.invalidate();
      this.options.refresh();
      return;
    }
    if (isKey(data, "up") || data === "k") this.moveCursor(-1);
    else if (isKey(data, "down") || data === "j") this.moveCursor(1);
    else if (data === "\r" || data === "\n" || data === " ") this.toggleSection();
    else if (isKey(data, "left") || data === "h") this.setExpanded(false);
    else if (isKey(data, "right") || data === "l") this.setExpanded(true);
    else if (isKey(data, "pageUp")) this.page(-1);
    else if (isKey(data, "pageDown")) this.page(1);
    else if (isKey(data, "home") || data === "g") this.jumpTo(0);
    else if (isKey(data, "end") || data === "G") this.jumpTo(-1);
    else return;
    // The TUI renders the component again after every key, so the cached frame
    // and the cached row map must be dropped here, not only on report changes.
    this.invalidate();
  }

  /**
   * Wheel notches scroll the body; every other mouse event stays with pi.
   *
   * pi's TUI routes fullscreen wheel events to the focused component but offers
   * no scrolling API for a custom screen: unhandled notches only move a
   * ScrollView, and this extension ships as one dependency-free file that
   * cannot import one. So the wheel is handled here, exactly as pi-context-view
   * does (one notch = wheelDelta lines, undefined for every other event).
   */
  public handleMouse(event: { type?: string; wheelDelta?: number }): { handled: true; render: boolean } | undefined {
    if (this.disposed || event?.type !== "wheel" || !event.wheelDelta) return undefined;
    const before = this.scroll;
    this.scroll = clampScroll(this.scroll + event.wheelDelta, this.maxScroll());
    if (this.scroll === before) return { handled: true, render: false };
    this.invalidate();
    this.syncCursor();
    return { handled: true, render: true };
  }

  /** Render one fullscreen frame for the given width and terminal height. */
  public render(width: number): string[] {
    const rows = terminalRows(this.options.getRows());
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;

    this.measureWidth = width;
    // The legend wraps, so its row count depends on the width: it is measured
    // before the viewport is cut, and the frame reserves exactly those rows.
    const legend = this.legendLines(width);
    this.legendRows = legend.length;
    const { rows: content } = this.metrics();
    const height = Math.max(1, rows - this.frameRows());
    this.scroll = clampScroll(this.scroll, Math.max(0, content.length - height));

    const viewport: string[] = [];
    for (const row of content.slice(this.scroll, this.scroll + height)) {
      const text = row.header ? `${row.section === this.cursor ? "❯" : " "} ${row.text}` : row.text;
      viewport.push(clipToWidth(text, width));
    }
    while (viewport.length < height) viewport.push("");

    const title = this.theme.fg("accent", this.theme.bold("Quota"));
    const frame = [spreadLine(title, this.statusText(content.length, height), width), "", ...viewport, "", ...legend];
    while (frame.length < rows) frame.push("");
    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = frame.slice(0, rows);
    return this.cachedLines;
  }

  /** Rows the frame spends around the scrolling content: title, two blanks, legend. */
  private frameRows(): number {
    return 3 + Math.max(1, this.legendRows);
  }

  /** Visible content height, excluding the fixed frame rows. */
  private viewportHeight(): number {
    return Math.max(1, terminalRows(this.options.getRows()) - this.frameRows());
  }

  private maxScroll(): number {
    return Math.max(0, this.metrics().rows.length - this.viewportHeight());
  }

  private isExpanded(key: string): boolean {
    return this.expanded.get(key) ?? true;
  }

  /** The report split into its foldable sections; null while the first load runs. */
  private layout(): { sections: PanelSection[]; tail: string[] } | null {
    if (this.cachedLayout === undefined) {
      const report = this.options.getReport();
      this.cachedLayout = report ? renderPanelLayout(report, this.theme) : null;
    }
    return this.cachedLayout;
  }

  /** Flattened rows, plus where every section's header starts and ends. */
  private metrics(): { rows: OverlayRow[]; headerRows: number[]; sectionEnds: number[] } {
    if (this.cachedMetrics && this.cachedMetricsWidth === this.measureWidth) return this.cachedMetrics;
    this.cachedMetricsWidth = this.measureWidth;
    const rows: OverlayRow[] = [];
    const headerRows: number[] = [];
    const sectionEnds: number[] = [];
    const error = this.options.getError();
    if (error) rows.push({ text: `  ${this.theme.fg("error", `! ${error}`)}`, section: -1, header: false });
    const layout = this.layout();
    if (!layout) {
      rows.push({ text: `  ${this.theme.fg("dim", "loading quota …")}`, section: -1, header: false });
    } else {
      layout.sections.forEach((section, index) => {
        const open = this.isExpanded(section.key);
        headerRows.push(rows.length);
        this.pushRow(rows, `${open ? "▾" : "▸"} ${section.header}`, index, true);
        if (open) for (const line of section.body) this.pushRow(rows, `    ${line}`, index, false);
        sectionEnds.push(rows.length - 1);
      });
      for (const line of layout.tail) this.pushRow(rows, `  ${line}`, -1, false);
    }
    this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, headerRows.length - 1)));
    this.cachedMetrics = { rows, headerRows, sectionEnds };
    return this.cachedMetrics;
  }

  /**
   * Append one content row, wrapped to the measured width. The cursor marker and
   * the body indent are two columns the wrap budget must leave room for, and a
   * wrapped header's continuation rows are body rows of the same section, so the
   * header indexes the cursor walks do not shift.
   */
  private pushRow(rows: OverlayRow[], text: string, section: number, header: boolean): void {
    const width = Math.max(8, this.measureWidth - (header ? 2 : 0));
    const parts = wrapLine(text, width);
    rows.push({ text: parts[0], section, header });
    for (const part of parts.slice(1)) rows.push({ text: header ? `  ${part}` : part, section, header: false });
  }

  /** Walk the headers; a section taller than the viewport scrolls first. */
  private moveCursor(delta: -1 | 1): void {
    const { headerRows, sectionEnds } = this.metrics();
    if (headerRows.length === 0) return;
    const height = this.viewportHeight();
    const section = this.layout()?.sections[this.cursor];
    const open = section !== undefined && this.isExpanded(section.key);
    const end = sectionEnds[this.cursor] ?? 0;
    if (delta > 0 && open && end > this.scroll + height - 1) {
      this.scroll = clampScroll(this.scroll + 1, this.maxScroll());
      return;
    }
    if (delta < 0 && open && headerRows[this.cursor] < this.scroll) {
      this.scroll = clampScroll(this.scroll - 1, this.maxScroll());
      return;
    }
    const next = this.cursor + delta;
    if (next < 0 || next >= headerRows.length) {
      this.scroll = clampScroll(this.scroll + delta, this.maxScroll());
      return;
    }
    this.cursor = next;
    this.reveal();
  }

  /** Scroll the cursor's header into view; a tall section starts at its header. */
  private reveal(): void {
    const { headerRows, sectionEnds } = this.metrics();
    const height = this.viewportHeight();
    const top = headerRows[this.cursor] ?? 0;
    const bottom = sectionEnds[this.cursor] ?? top;
    if (top < this.scroll || bottom > this.scroll + height - 1) this.scroll = top;
    this.scroll = clampScroll(this.scroll, this.maxScroll());
  }

  /**
   * Page the body. When nothing can scroll the keystroke does nothing: paging
   * used to re-snap the cursor to the last on-screen header, so PgUp on a short
   * page moved the selection *down*.
   */
  private page(delta: -1 | 1): void {
    const before = this.scroll;
    this.scroll = clampScroll(this.scroll + delta * this.viewportHeight(), this.maxScroll());
    this.invalidate();
    if (this.scroll !== before) this.syncCursor();
  }

  private jumpTo(index: 0 | -1): void {
    const { headerRows } = this.metrics();
    if (headerRows.length === 0) {
      this.scroll = index === 0 ? 0 : this.maxScroll();
      return;
    }
    this.cursor = index === 0 ? 0 : headerRows.length - 1;
    this.scroll = index === 0 ? 0 : this.maxScroll();
    const top = headerRows[this.cursor] ?? 0;
    if (top < this.scroll) this.scroll = top;
  }

  /**
   * Keep the cursor on the header nearest the one it was on that is still on
   * screen. The last visible header is the wrong pick: scrolling a little used
   * to throw the selection to the bottom of the page. When no header is on
   * screen the cursor stays put, so scrolling back returns to it.
   */
  private syncCursor(): void {
    const { headerRows } = this.metrics();
    if (headerRows.length === 0) return;
    const bottom = this.scroll + this.viewportHeight() - 1;
    let best: number | null = null;
    for (let index = 0; index < headerRows.length; index += 1) {
      const row = headerRows[index];
      if (row < this.scroll || row > bottom) continue;
      if (best === null || Math.abs(index - this.cursor) < Math.abs(best - this.cursor)) best = index;
    }
    if (best !== null) this.cursor = best;
  }

  private toggleSection(): void {
    const section = this.layout()?.sections[this.cursor];
    if (!section) return;
    this.setExpanded(!this.isExpanded(section.key));
  }

  private setExpanded(open: boolean): void {
    const section = this.layout()?.sections[this.cursor];
    if (!section || this.isExpanded(section.key) === open) return;
    this.expanded.set(section.key, open);
    this.invalidate();
    this.reveal();
  }

  /**
   * The header's right side: a visible refresh indicator while the CLI runs,
   * the update time it landed at afterwards, the view's position, and the
   * scroll range when the content is taller than the viewport.
   */
  private statusText(total: number, height: number): string {
    const parts: string[] = [];
    if (this.options.isRefreshing()) {
      parts.push(this.theme.fg("accent", "refreshing …"));
    } else {
      const report = this.options.getReport();
      if (report) parts.push(this.theme.fg("dim", updatedAtLabel(report)));
      if (this.options.getError()) parts.push(this.theme.fg("error", "refresh failed"));
    }
    if (total > height) {
      const last = Math.min(total, this.scroll + height);
      parts.push(this.theme.fg("dim", `${this.scroll + 1}-${last}/${total}`));
    }
    return parts.join(this.theme.fg("dim", " · "));
  }

  /** Hint pairs for the active view; History adds its month navigation. */
  private legendHints(): ReadonlyArray<readonly [string, string]> {
    return NOW_HINTS;
  }

  /**
   * Wrap the legend pairs across as many rows as the width needs, balanced:
   * greedy filling leaves the last pair alone on a row of its own ("esc/q
   * close" under seven pairs), which reads as a lost key. The row count is the
   * minimum greedy needs, so widening the pane never adds a row.
   */
  private legendLines(width: number): string[] {
    const separator = this.theme.fg("dim", " · ");
    const pairs = this.legendHints().map(([keys, label]) => `${this.theme.fg("dim", keys)} ${label}`);
    if (pairs.length === 0) return [""];
    const rows = balanceRows(pairs.map((pair) => visibleLength(pair)), width, 3);
    const lines: string[] = [];
    let index = 0;
    for (const count of rows) {
      lines.push(pairs.slice(index, index + count).join(separator));
      index += count;
    }
    return lines;
  }
}

export default function quotaPanelExtension(pi: ExtensionAPI): void {
  let report: QuotaReport | null = null;
  let refreshing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let agentEndTimer: ReturnType<typeof setTimeout> | null = null;
  let panelVisible = false;
  /**
   * The open fullscreen overlay, while there is one. Bare `/usage` opens it and
   * a background refresh redraws it; closing it leaves nothing behind.
   */
  let overlayView: UsageOverlay | null = null;
  /**
   * What a reopened overlay keeps: every bare `/usage` builds a fresh view, so
   * the folds live here, for the pi session and never on disk.
   */
  let overlaySession = newOverlaySession();
  /**
   * Nothing is pinned by default. A box or line above the editor is a persistent
   * surface, and a quota command should not claim a row until asked.
   */
  let lineVisible = false;
  let boxVisible = false;
  let explicitBox = false;
  /** gentle-pi owns the footer and truncates it from the end, so start off. */
  let statusVisible = false;
  let lastError: string | null = null;
  let disposed = false;
  /** True once the installed gentle-pi is known to paint a rail slot for this card. */
  let railMode = false;

  /**
   * Load the rail inspector from the installed CLI tree. A missing patcher disables
   * native-layout detection; the runtime chaining hook remains available.
   */
  async function loadRailPatcher(): Promise<{
    resolveGentlePiLayout: (options?: { dir?: string }) => { layoutPath: string; present: boolean };
    inspectRailPatch: (options: { layoutPath: string }) => { state: string };
  } | null> {
    const cli = resolveCliPath();
    if (!cli) return null;
    const modulePath = join(dirname(cli), "..", "src", "gentle-pi", "rail-patch.js");
    if (!existsSync(modulePath)) return null;
    try {
      return await import(pathToFileURL(modulePath).href);
    } catch {
      return null;
    }
  }

  /** Inspect the gentle-pi rail slot without changing package files. */
  async function syncRailPatch(): Promise<void> {
    railMode = false;
    const patcher = await loadRailPatcher();
    if (!patcher) return;
    const layout = patcher.resolveGentlePiLayout();
    if (!layout.present) return;
    const inspection = patcher.inspectRailPatch({ layoutPath: layout.layoutPath });
    railMode = inspection.state === "patched";
  }

  /**
   * Run the CLI. A report run owns `lastError`; the advisory `omarchy` publish
   * writes human text, not JSON, and must never surface as a quota failure.
   */
  async function runCli(args: string[], options: { reportErrors?: boolean } = {}): Promise<QuotaReport | null> {
    const reportErrors = options.reportErrors !== false;
    const cli = resolveCliPath();
    if (!cli) {
      if (reportErrors) lastError = "piquota not installed: run install.sh from the pi-quota repo";
      return null;
    }
    try {
      const runner = /node(\.exe)?$/i.test(process.execPath) ? process.execPath : "node";
      const result = await pi.exec(runner, [cli, ...args], { timeout: EXEC_TIMEOUT_MS });
      if (!result.stdout || result.stdout.trim() === "") {
        if (reportErrors) lastError = result.stderr?.trim() || "piquota produced no output";
        return null;
      }
      const parsed = JSON.parse(result.stdout) as QuotaReport;
      if (!parsed || !Array.isArray(parsed.providers)) {
        if (reportErrors) lastError = "piquota output was not a quota report";
        return null;
      }
      if (reportErrors) lastError = null;
      return parsed;
    } catch (error) {
      if (reportErrors) lastError = (error as { message?: string })?.message ?? String(error);
      return null;
    }
  }

  function paintUi(ctx: UiContext): void {
    if (disposed) return;
    const theme = ctx.ui.theme;

    if (statusVisible) {
      ctx.ui.setStatus(STATUS_KEY, report ? renderLine(report, theme) : theme.fg("dim", "quota …"));
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    if (panelVisible && report) {
      ctx.ui.setWidget(WIDGET_KEY, panelComponent(renderPanel(report, theme)), { placement: "aboveEditor" });
      return;
    }

    if (!boxVisible && !lineVisible) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui: any, widgetTheme: Theme) => {
        const rawState = tui?.terminal?.[SIDEBAR_STATE_KEY];
        const activeTheme = widgetTheme || theme;
        const digest = () =>
          report
            ? `${report.generatedAt}:${report.providers
                .map((provider) =>
                  provider.windows
                    .map((window) => [window.id, window.usedPercent, window.remainingPercent, window.resetsAt, window.resetsInSec].join(","))
                    .join(";"),
                )
                .join("|")}`
            : "loading";
        let nativeQuotaRendered = false;
        const rail = {
          digest,
          render: (w: number) => {
            nativeQuotaRendered = true;
            return renderSidebarCard(report, activeTheme, w);
          },
          invalidate() {},
        };

        let railActive = Boolean(rawState?.active && rawState?.ownsHost?.());

        if (rawState?.parts) {
          rawState.parts.set(RAIL_KEY, rail);

          // Runtime resilience: if gentle-pi's rail is active and has a footer part,
          // but railMode is false (e.g. unpatched gentle-pi, freshly updated package before
          // restart, or read-only filesystem), wrap the footer component so the quota card
          // is seamlessly rendered right under the footer in the rail.
          if (!railMode && rawState.parts.has("footer")) {
            const originalFooter = rawState.parts.get("footer");
            if (originalFooter && !(originalFooter as any).__piQuotaChained) {
              const chainedFooter = {
                ...originalFooter,
                __piQuotaChained: true,
                __piQuotaOriginal: originalFooter,
                digest() {
                  const fd = originalFooter.digest?.() ?? "";
                  return nativeQuotaRendered ? fd : `${fd}:quota:${digest()}`;
                },
                render(w: number) {
                  const fl = [...(originalFooter.render(w) ?? [])];
                  if (nativeQuotaRendered) return fl;
                  const ql = renderSidebarCard(report, activeTheme, w);
                  if (!ql || ql.length === 0) return fl;
                  return [...fl, "", ...ql];
                },
                handleMouse(event: any) {
                  return originalFooter.handleMouse?.(event);
                },
                invalidate() {
                  originalFooter.invalidate?.();
                },
              };
              rawState.parts.set("footer", chainedFooter);
              railActive = Boolean(rawState.active && rawState.ownsHost?.());
            } else if (originalFooter?.__piQuotaChained) {
              railActive = Boolean(rawState.active && rawState.ownsHost?.());
            }
          }
        }

        const state = (railMode || railActive) ? rawState : undefined;

        return {
          render: (w: number) => {
            const liveState = tui?.terminal?.[SIDEBAR_STATE_KEY] ?? rawState;
            const isFullscreen = (tui as any)?.mode === "fullscreen";
            const cols = tui?.terminal?.columns ?? process.stdout.columns ?? 0;
            const isRailActive = Boolean(liveState && (liveState.active || (cols >= 140 && isFullscreen)));
            if (isRailActive) return [];
            if (!report) return [activeTheme.fg("dim", "quota …")];
            // When gentle-pi is present and the sidebar is inactive or the terminal is narrow,
            // compact to one row only when the box has not been selected.
            if (((railMode && state !== undefined) || (state && !state.active)) && !explicitBox) {
              return [renderLine(report, activeTheme)];
            }
            if (w < 100 && !explicitBox) {
              return [renderLine(report, activeTheme)];
            }
            if (boxVisible) return renderBox(report, activeTheme, w);
            if (lineVisible) return [renderLine(report, activeTheme)];
            return [];
          },
          dispose: () => {
            if (rawState?.parts?.get(RAIL_KEY) === rail) rawState.parts.delete(RAIL_KEY);
            const currentFooter = rawState?.parts?.get("footer");
            if (currentFooter?.__piQuotaChained && currentFooter.__piQuotaOriginal) {
              rawState.parts.set("footer", currentFooter.__piQuotaOriginal);
            }
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  /** True when something is pinned above the editor or the footer is on. */
  function surfaceActive(): boolean {
    return lineVisible || boxVisible || panelVisible || statusVisible;
  }

  /**
   * Poll only once a surface has asked for live numbers. A bare /usage refresh is
   * a one-shot read; it must not leave a timer behind.
   */
  function ensurePolling(ui: UiContext): void {
    if (disposed || timer || !surfaceActive()) return;
    timer = setInterval(() => {
      if (!ui.hasUI || disposed) return;
      void refresh(ui, false);
    }, REFRESH_MS);
    // SAFETY: Node.js Timer provides unref to prevent hanging process exit.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function stopPolling(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  async function refresh(ctx: UiContext, force: boolean): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const next = await runCli(force ? ["--json", "--force"] : ["--json"]);
      if (disposed) return;
      if (next) {
        report = next;
        // A bare /usage overlay is not a pinned surface: only repaint the widget
        // and the footer when something is actually on screen.
        if (surfaceActive()) paintUi(ctx);
        void runCli(["omarchy"], { reportErrors: false });
      }
    } finally {
      refreshing = false;
      overlayView?.redraw();
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // SAFETY: Pi's session context implements UiContext when hasUI is true.
    const ui = ctx as unknown as UiContext;
    if (!ui.hasUI) return;
    disposed = false;
    // A new session starts with every section open.
    overlaySession = newOverlaySession();
    // Resolve the native rail mode before the first paint.
    await syncRailPatch();
    if (disposed) return;
    // Default: no persistent surface. Nothing is pinned above the editor, the
    // footer stays untouched and no timer polls until /usage turns a surface on.
    stopPolling();
    paintUi(ui);
  });

  pi.on("agent_start", () => {
    if (agentEndTimer) {
      clearTimeout(agentEndTimer);
      agentEndTimer = null;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    // SAFETY: Pi's agent_end context implements UiContext when hasUI is true.
    const ui = ctx as unknown as UiContext;
    if (!ui.hasUI || disposed) return;
    // A quota refresh after every turn is only useful when its result is visible.
    if (!surfaceActive()) return;
    if (agentEndTimer) clearTimeout(agentEndTimer);
    const debounceMs = Number(process.env.PI_QUOTA_EVENT_DEBOUNCE_MS) || AGENT_END_DEBOUNCE_MS;
    agentEndTimer = setTimeout(() => {
      agentEndTimer = null;
      if (!ui.hasUI || disposed) return;
      void refresh(ui, false);
    }, debounceMs);
    // SAFETY: Node.js Timer provides unref to prevent hanging process exit.
    (agentEndTimer as unknown as { unref?: () => void }).unref?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // SAFETY: Pi's session_shutdown context implements UiContext when hasUI is true.
    const ui = ctx as unknown as UiContext;
    disposed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (agentEndTimer) {
      clearTimeout(agentEndTimer);
      agentEndTimer = null;
    }
    if (ui.hasUI) {
      ui.ui.setStatus(STATUS_KEY, undefined);
      ui.ui.setWidget(WIDGET_KEY, undefined);
    }
  });

  /**
   * Bare /usage: a fullscreen overlay that owns the keyboard and closes on Esc,
   * so no panel is left above the editor. It opens with the cached report and
   * refreshes in the background; a failure becomes a line in the view.
   */
  async function showOverlay(ctx: UiContext): Promise<void> {
    // Paint on the same keystroke: the report already in memory, otherwise the
    // CLI's on-disk cache. The forced refresh runs behind the overlay and never
    // delays the first frame.
    if (!report) report = readCachedReport();
    const custom = ctx.ui.custom;
    if (typeof custom !== "function" || (ctx.mode !== undefined && ctx.mode !== "tui")) {
      // A host without custom components still gets the panel that /usage panel pins.
      panelVisible = true;
      lineVisible = false;
      boxVisible = false;
      explicitBox = false;
      if (!report) await refresh(ctx, false);
      ensurePolling(ctx);
      paintUi(ctx);
      ctx.ui.notify("This host has no fullscreen overlay; the quota panel is pinned above the editor", "info");
      return;
    }
    await custom(
      (tui, theme, _keybindings, done) => {
        const view = new UsageOverlay(theme, {
          done: () => done(undefined),
          requestRender: () => tui?.requestRender?.(),
          getRows: () => tui?.terminal?.rows ?? process.stdout.rows ?? 24,
          getReport: () => report,
          getError: () => lastError,
          isRefreshing: () => refreshing,
          refresh: () => {
            void refresh(ctx, true);
          },
        }, overlaySession);
        overlayView = view;
        return {
          render: (width: number) => view.render(width),
          invalidate: () => view.invalidate(),
          dispose: () => {
            if (overlayView === view) overlayView = null;
            view.dispose();
          },
          handleInput: (data: string) => {
            view.handleInput(data);
            tui?.requestRender?.();
          },
          handleMouse: (event: any) => view.handleMouse(event),
        };
      },
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } },
    );
  }

  const handler = async (args: string, ctx: UiContext): Promise<void> => {
    if (!ctx.hasUI) return;
    const action = args.trim().toLowerCase();

    switch (action) {
      case "refresh":
        await refresh(ctx, true);
        ctx.ui.notify(
          report
            ? `Quota refreshed (${report.providers.filter((provider) => provider.ok).length}/${report.providers.length} providers)`
            : `Quota refresh failed: ${lastError}`,
          report ? "info" : "error",
        );
        return;
      case "line":
      case "widget":
        lineVisible = true;
        boxVisible = false;
        explicitBox = false;
        panelVisible = false;
        if (!report) await refresh(ctx, false);
        ensurePolling(ctx);
        paintUi(ctx);
        ctx.ui.notify("Quota line pinned above the editor", "info");
        return;
      case "panel":
        panelVisible = true;
        lineVisible = false;
        boxVisible = false;
        explicitBox = false;
        if (!report) await refresh(ctx, false);
        ensurePolling(ctx);
        paintUi(ctx);
        ctx.ui.notify("Quota panel shown above the editor", "info");
        return;
      case "box":
        lineVisible = true;
        boxVisible = true;
        explicitBox = true;
        panelVisible = false;
        if (!report) await refresh(ctx, false);
        ensurePolling(ctx);
        paintUi(ctx);
        ctx.ui.notify("Quota box pinned above the editor", "info");
        return;
      case "hide":
      case "off":
        panelVisible = false;
        lineVisible = false;
        boxVisible = false;
        explicitBox = false;
        if (!surfaceActive()) stopPolling();
        paintUi(ctx);
        ctx.ui.notify("Quota hidden", "info");
        return;
      case "status":
        statusVisible = true;
        ensurePolling(ctx);
        paintUi(ctx);
        ctx.ui.notify("Also showing quota in the footer (may be truncated when the bar is full)", "info");
        return;
      case "nostatus":
        statusVisible = false;
        if (!surfaceActive()) stopPolling();
        paintUi(ctx);
        return;
      case "json":
        ctx.ui.notify(`${resolveCliPath() ?? "piquota"} --json   (cached at ~/.cache/pi-quota/usage.json)`, "info");
        return;
      default:
        break;
    }

    // Bare /usage (or an unknown argument): open the overlay with whatever the
    // extension already has, and refresh in the background behind it.
    const opening = showOverlay(ctx);
    void refresh(ctx, true);
    await opening;
  };

  pi.registerCommand("usage", {
    description: "Open the read-only quota overlay (used %, one foldable section per provider)",
    getArgumentCompletions: (prefix: string) => {
      const options = ["refresh", "line", "box", "panel", "hide", "status", "nostatus", "json"];
      const matches = options.filter((option) => option.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler,
  });
}
