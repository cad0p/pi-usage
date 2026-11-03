/**
 * Raw key decoding for the /usage overlay.
 *
 * Terminals speak two encodings for the keys the overlay answers. Legacy
 * terminals send the familiar escape sequences (`\x1b[A` for Up, `\x1b[5~` for
 * PgUp), and terminals that negotiate the kitty keyboard protocol — Ghostty
 * among them, because Pi asks for flags 1|2|4 — send CSI sequences carrying a
 * 1-based modifier mask and an event type (`\x1b[1;1:1A` for a press,
 * `\x1b[1;1:2A` for a repeat, `\x1b[1;1:3A` for a release), and may report a
 * printable key as its codepoint (`\x1b[106u` for `j`).
 *
 * This mirrors the subset of pi-tui's `matchesKey`, `isKeyRelease`,
 * `isKeyRepeat` and `decodeKittyPrintable` the overlay needs. It is local on
 * purpose. Pi maps `@earendil-works/pi-tui` for an extension at load time
 * through jiti's virtual modules, so a static import would work inside Pi — but
 * the test suite loads the extension with Node's type stripping, where a bare
 * specifier resolves only from a `node_modules` this package does not have and
 * never installs: it ships zero runtime and dev dependencies, and CI runs
 * `npm test` with no install step. Declaring pi-tui a peer/dev dependency would
 * only move that install into CI and every contributor's checkout, and injecting
 * the matcher would still need a real implementation for the tests. One local
 * decoder is a single code path that the unit table, the overlay tests and the
 * live tmux proof all exercise.
 *
 * A release is never a press: the overlay drops it before acting. A repeat is a
 * press. A held arrow must keep moving, and in a legacy terminal the OS repeat
 * is byte-identical to the first press, so ignoring kitty repeats would make a
 * held key behave differently in Ghostty than in tmux.
 */

const LOCK_MASK = 64 + 128; // Caps Lock and Num Lock ride along in the modifier field
const MODIFIER_SHIFT = 1;

/** Kitty reserves this Private Use Area range for functional keys. */
const KITTY_FUNCTIONAL_START = 57344;
const KITTY_FUNCTIONAL_END = 63743;

/** Internal codepoints: negative so a reported codepoint can never collide. */
const ARROW = { up: -1, down: -2, right: -3, left: -4 };
const FUNCTIONAL = { delete: -10, insert: -11, pageUp: -12, pageDown: -13, home: -14, end: -15 };

/** The final letter of a `CSI A/B/C/D` arrow sequence. */
const ARROW_BY_LETTER = { A: ARROW.up, B: ARROW.down, C: ARROW.right, D: ARROW.left };

/** Codepoints of the keys the overlay names. */
const KEY_CODEPOINTS = {
  escape: 27,
  enter: 13,
  tab: 9,
  space: 32,
  ...ARROW,
  ...FUNCTIONAL,
};

/**
 * Kitty's Private Use Area spellings of the same keys, including the keypad
 * aliases (57417 left … 57424 end, 57414 keypad enter).
 *
 * @type {Map<number, number>}
 */
const KITTY_EQUIVALENTS = new Map([
  [57350, ARROW.left],
  [57351, ARROW.right],
  [57352, ARROW.up],
  [57353, ARROW.down],
  [57354, FUNCTIONAL.pageUp],
  [57355, FUNCTIONAL.pageDown],
  [57356, FUNCTIONAL.home],
  [57357, FUNCTIONAL.end],
  [57414, KEY_CODEPOINTS.enter],
  [57417, ARROW.left],
  [57418, ARROW.right],
  [57419, ARROW.up],
  [57420, ARROW.down],
  [57421, FUNCTIONAL.pageUp],
  [57422, FUNCTIONAL.pageDown],
  [57423, FUNCTIONAL.home],
  [57424, FUNCTIONAL.end],
]);

/** What a legacy terminal (or tmux, in either cursor mode) sends for each key. */
const LEGACY = {
  escape: ["\u001b"],
  enter: ["\r", "\n"],
  tab: ["\t"],
  space: [" "],
  up: ["\u001b[A", "\u001bOA"],
  down: ["\u001b[B", "\u001bOB"],
  left: ["\u001b[D", "\u001bOD"],
  right: ["\u001b[C", "\u001bOC"],
  pageUp: ["\u001b[5~", "\u001b[[5~"],
  pageDown: ["\u001b[6~", "\u001b[[6~"],
  home: ["\u001b[H", "\u001bOH", "\u001b[1~", "\u001b[7~"],
  end: ["\u001b[F", "\u001bOF", "\u001b[4~", "\u001b[8~"],
};

/** The number in a `CSI <n> ~` functional sequence. */
const FUNCTIONAL_BY_NUMBER = { 1: FUNCTIONAL.home, 2: FUNCTIONAL.insert, 3: FUNCTIONAL.delete, 4: FUNCTIONAL.end, 5: FUNCTIONAL.pageUp, 6: FUNCTIONAL.pageDown, 7: FUNCTIONAL.home, 8: FUNCTIONAL.end };

const CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const CSI_ARROW = /^\x1b\[(?:1)?(?:;(\d+))?(?::(\d+))?([ABCD])$/;
const CSI_HOME_END = /^\x1b\[(?:1)?(?:;(\d+))?(?::(\d+))?([HF])$/;
const CSI_FUNCTIONAL = /^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/;
const CSI_MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;

/**
 * Event type from the trailing field: 1 press, 2 repeat, 3 release.
 *
 * @param {string | undefined} value
 * @returns {"press" | "repeat" | "release"}
 */
function eventType(value) {
  if (value === "2") return "repeat";
  if (value === "3") return "release";
  return "press";
}

/**
 * Normalize a kitty functional codepoint to the internal one.
 *
 * @param {number} codepoint
 * @returns {number}
 */
function normalize(codepoint) {
  return KITTY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

/**
 * One parsed key event, or null when the bytes are neither a key the overlay
 * knows nor a sequence it can read.
 *
 * @param {string} data
 * @returns {{ codepoint: number, shifted?: number, modifier: number, event: "press" | "repeat" | "release" } | null}
 */
function parseKey(data) {
  let match = data.match(CSI_MODIFY_OTHER_KEYS);
  if (match) return { codepoint: Number(match[2]), modifier: Number(match[1]) - 1, event: "press" };

  match = data.match(CSI_U);
  if (match) {
    return {
      codepoint: Number(match[1]),
      shifted: match[2] ? Number(match[2]) : undefined,
      modifier: match[4] ? Number(match[4]) - 1 : 0,
      event: eventType(match[5]),
    };
  }

  match = data.match(CSI_ARROW);
  if (match) return { codepoint: ARROW_BY_LETTER[match[3]], modifier: match[1] ? Number(match[1]) - 1 : 0, event: eventType(match[2]) };

  match = data.match(CSI_HOME_END);
  if (match) {
    return {
      codepoint: match[3] === "H" ? FUNCTIONAL.home : FUNCTIONAL.end,
      modifier: match[1] ? Number(match[1]) - 1 : 0,
      event: eventType(match[2]),
    };
  }

  match = data.match(CSI_FUNCTIONAL);
  if (match) {
    const codepoint = FUNCTIONAL_BY_NUMBER[Number(match[1])];
    if (codepoint !== undefined) return { codepoint, modifier: match[2] ? Number(match[2]) - 1 : 0, event: eventType(match[3]) };
  }
  return null;
}

/**
 * Whether raw input is a kitty key release. Only a kitty-protocol terminal
 * reports releases, so legacy input is always a press.
 *
 * @param {string} data
 * @returns {boolean}
 */
export function isKeyRelease(data) {
  return parseKey(data)?.event === "release";
}

/**
 * Whether raw input is a kitty key repeat (the terminal auto-repeating a held
 * key). The overlay treats it as a press; see the module comment.
 *
 * @param {string} data
 * @returns {boolean}
 */
export function isKeyRepeat(data) {
  return parseKey(data)?.event === "repeat";
}

/**
 * Whether raw input is the named key, unmodified.
 *
 * Shift is allowed on enter, space and escape, whose shifted form is the same
 * key in a legacy terminal; Shift+Tab is backtab (`\x1b[Z`), a different key, so
 * it is not tab in either encoding, and any other modifier is a different key
 * (shift+up, ctrl+page-up, …).
 *
 * @param {string} data raw bytes from the terminal
 * @param {"escape" | "enter" | "tab" | "space" | "up" | "down" | "left" | "right" | "pageUp" | "pageDown" | "home" | "end"} name
 * @returns {boolean}
 */
export function matchesKey(data, name) {
  if ((LEGACY[name] ?? []).includes(data)) return true;
  const expected = KEY_CODEPOINTS[name];
  if (expected === undefined) return false;
  const parsed = parseKey(data);
  if (!parsed) return false;
  const modifier = parsed.modifier & ~LOCK_MASK;
  const allowed = name === "enter" || name === "space" || name === "escape" ? MODIFIER_SHIFT : 0;
  if ((modifier & ~allowed) !== 0) return false;
  return normalize(parsed.codepoint) === expected;
}

/**
 * The printable character a kitty CSI-u or xterm modifyOtherKeys sequence
 * carries, if it is one. Plain and Shift-modified text only: ctrl/alt/super
 * combinations are key bindings, not text.
 *
 * @param {string} data
 * @returns {string | undefined}
 */
function decodePrintable(data) {
  const parsed = parseKey(data);
  if (!parsed) return undefined;
  const modifier = parsed.modifier & ~LOCK_MASK;
  if ((modifier & ~MODIFIER_SHIFT) !== 0) return undefined;
  let codepoint = parsed.codepoint;
  if (modifier & MODIFIER_SHIFT) {
    if (parsed.shifted !== undefined) codepoint = parsed.shifted;
    else if (codepoint >= 97 && codepoint <= 122) codepoint -= 32;
  }
  codepoint = normalize(codepoint);
  if (!Number.isFinite(codepoint) || codepoint < 32) return undefined;
  if (codepoint >= KITTY_FUNCTIONAL_START && codepoint <= KITTY_FUNCTIONAL_END) return undefined;
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return undefined;
  }
}

/**
 * Whether raw input is the printable character, in any encoding: the byte
 * itself (legacy), or a codepoint sequence with no modifier or Shift.
 *
 * @param {string} data raw bytes from the terminal
 * @param {string} char one printable character
 * @returns {boolean}
 */
export function matchesPrintable(data, char) {
  if (data === char) return true;
  return decodePrintable(data) === char;
}
