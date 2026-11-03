/**
 * Drift guard: the local key decoder against pi-tui's own matcher.
 *
 * src/overlay-keys.js mirrors pi-tui's matchesKey / decodePrintableKey for the
 * keys the /usage overlay answers. A copy drifts: pi-tui gains a sequence, a
 * regex or a modifier rule, and the overlay silently stops agreeing with the
 * host that routes its keys. This test loads pi-tui — from this package's own
 * resolution, the newest Pi release install, or ~/.pi/agent/npm — and compares
 * both decoders over a generated encoding table for every legend key, with the
 * kitty protocol flag on and off.
 *
 * pi-tui is not a dependency of this package and CI installs nothing, so the
 * test skips cleanly when the host is absent. Every disagreement must be an
 * entry in ALLOWED with a one-line reason, and every entry must still be
 * observed: a stale allowlist fails instead of hiding a new difference.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { matchesKey as localMatchesKey, matchesPrintable } from "../src/overlay-keys.js";

const ESC = "\u001b";

/** Every named key the overlay answers, with pi-tui's key id for it. */
const NAMED = [
  { name: "escape", piKey: "escape" },
  { name: "enter", piKey: "enter" },
  { name: "tab", piKey: "tab" },
  { name: "space", piKey: "space" },
  { name: "up", piKey: "up" },
  { name: "down", piKey: "down" },
  { name: "left", piKey: "left" },
  { name: "right", piKey: "right" },
  { name: "pageUp", piKey: "pageUp" },
  { name: "pageDown", piKey: "pageDown" },
  { name: "home", piKey: "home" },
  { name: "end", piKey: "end" },
];

/** Every printable key the overlay answers, as the codepoint kitty reports. */
const PRINTABLES = [
  { char: "j", codepoint: 106 },
  { char: "k", codepoint: 107 },
  { char: "h", codepoint: 104 },
  { char: "l", codepoint: 108 },
  { char: "g", codepoint: 103 },
  { char: "G", codepoint: 71 },
  { char: "r", codepoint: 114 },
  { char: "q", codepoint: 113 },
  { char: "1", codepoint: 49 },
  { char: "2", codepoint: 50 },
  { char: "[", codepoint: 91 },
  { char: "]", codepoint: 93 },
];

/** The modifier masks a terminal reports, including Caps Lock and Num Lock. */
const MASKS = [1, 2, 3, 5, 9, 65, 129];

/** The event types: press, release, repeat. */
const EVENTS = [1, 2, 3];

/**
 * Disagreements the local decoder intends. Each entry matches the records it
 * covers and states, in one line, why the difference is deliberate. Every entry
 * must still be observed, so a fixed or newly drifted case cannot hide here.
 */
const ALLOWED = [
  {
    reason: "the kitty spec spells arrows, paging, home/end and keypad Enter as these Private Use Area codepoints; pi-tui's table starts at the keypad range (57399+), so it does not recognize them",
    test: (record) => record.kind === "named" && record.local === true && /^\u001b\[(5735[0-7]|57344|57414|5741[7-9]|5742[0-4])(?:;|u)/.test(record.sequence),
  },
  {
    reason: "shift+Escape is byte-identical to Escape in a legacy terminal, so the overlay accepts its kitty form; pi-tui matches only the unmodified key",
    test: (record) => record.kind === "named" && record.key === "escape" && record.sequence.startsWith("\u001b[27;2"),
  },
  {
    reason: "shift+Enter is \\r in a legacy terminal (and Ghostty binds it to \\n), so the overlay accepts its kitty form whether or not the protocol is active; pi-tui only accepts it while the protocol is",
    test: (record) => record.kind === "named" && record.key === "enter" && (record.sequence.startsWith("\u001b[13;2") || record.sequence.startsWith("\u001b[57414;2")),
  },
  {
    reason: "a bare newline is Enter in a legacy terminal and Ghostty's shift+Enter binding; the overlay keeps accepting it while the kitty protocol is active, pi-tui does not",
    test: (record) => record.kind === "named" && record.key === "enter" && record.sequence === "\n",
  },
  {
    reason: "shift+Space is the plain space byte in a legacy terminal, so the overlay accepts its kitty form; pi-tui matches it only as shift+space",
    test: (record) => record.kind === "named" && record.key === "space" && record.sequence.startsWith("\u001b[32;2"),
  },
  {
    reason: "xterm modifyOtherKeys with a 1 modifier field means no modifiers, which is unambiguous; pi-tui's modifyOtherKeys matcher takes only the modified forms",
    test: (record) => record.kind === "named" && (record.sequence === "\u001b[27;1;13~" || record.sequence === "\u001b[27;1;9~"),
  },
  {
    reason: "without flag 4 the terminal reports the unshifted codepoint plus Shift; the overlay infers the capital (shift+j produces J, as in a legacy terminal), while pi-tui's decoder returns the letter as reported",
    test: (record) => record.kind === "print" && record.local === false && record.pi === true && new RegExp(`^\\u001b\\[${record.key.toLowerCase().charCodeAt(0)};2(?:[:;]|u)`).test(record.sequence),
  },
  {
    reason: "a shifted-key field of \"g\" says the key produces g, not G; pi-tui matches its shift+g key id, the overlay decodes the character that is produced",
    test: (record) => record.kind === "print" && record.key === "G" && record.sequence.startsWith("\u001b[71:103;2"),
  },
];

/**
 * Generated encodings for one named key: legacy, kitty CSI with every modifier
 * and event-type field, xterm modifyOtherKeys, and the kitty functional PUA
 * codepoints (57350–57357 arrows/page/home/end, 57417–57424 keypad aliases).
 *
 * @param {string} name
 * @returns {string[]}
 */
function namedEncodings(name) {
  const out = [];
  const kitty = (codepoint, extra = "") => {
    out.push(`${ESC}[${codepoint}u`);
    for (const mask of MASKS) {
      for (const event of EVENTS) out.push(`${ESC}[${codepoint};${mask}:${event}u`);
      out.push(`${ESC}[${codepoint};${mask}u`);
    }
    out.push(extra);
  };
  if (name === "escape") {
    out.push(ESC);
    kitty(27);
    out.push(`${ESC}[27;5;27~`);
    return out;
  }
  if (name === "enter") {
    out.push("\r", "\n", `${ESC}OM`, `${ESC}\r`);
    kitty(13);
    kitty(57414);
    out.push(`${ESC}[27;1;13~`);
    return out;
  }
  if (name === "tab") {
    out.push("\t", `${ESC}[Z`);
    kitty(9);
    out.push(`${ESC}[27;1;9~`);
    return out;
  }
  if (name === "space") {
    out.push(" ", `${ESC} `);
    kitty(32);
    return out;
  }
  if (name === "pageUp" || name === "pageDown") {
    const number = name === "pageUp" ? 5 : 6;
    out.push(`${ESC}[${number}~`, `${ESC}[[${number}~`);
    for (const mask of MASKS) {
      for (const event of EVENTS) out.push(`${ESC}[${number};${mask}:${event}~`);
      out.push(`${ESC}[${number};${mask}~`);
    }
    for (const codepoint of name === "pageUp" ? [57354, 57421] : [57355, 57422]) kitty(codepoint);
    return out;
  }
  if (name === "home" || name === "end") {
    const letter = name === "home" ? "H" : "F";
    for (const number of [1, 4, 7, 8]) out.push(`${ESC}[${number}~`);
    out.push(`${ESC}[${letter}`, `${ESC}O${letter}`, `${ESC}[1${letter}`);
    for (const mask of MASKS) {
      for (const event of EVENTS) out.push(`${ESC}[1;${mask}:${event}${letter}`);
      out.push(`${ESC}[1;${mask}${letter}`);
    }
    for (const codepoint of name === "home" ? [57356, 57423] : [57357, 57424]) kitty(codepoint);
    return out;
  }
  const letter = { up: "A", down: "B", right: "C", left: "D" }[name];
  out.push(`${ESC}[${letter}`, `${ESC}O${letter}`, `${ESC}[1${letter}`);
  for (const mask of MASKS) {
    for (const event of EVENTS) out.push(`${ESC}[1;${mask}:${event}${letter}`);
    out.push(`${ESC}[1;${mask}${letter}`);
  }
  for (const codepoint of { up: [57352, 57419], down: [57353, 57420], left: [57350, 57417], right: [57351, 57418] }[name]) kitty(codepoint);
  return out;
}

/**
 * Generated encodings for one printable key.
 *
 * @param {number} codepoint
 * @returns {string[]}
 */
function printableEncodings(codepoint) {
  const out = [String.fromCodePoint(codepoint), `${ESC}[${codepoint}u`];
  for (const mask of MASKS) {
    for (const event of EVENTS) out.push(`${ESC}[${codepoint};${mask}:${event}u`);
    out.push(`${ESC}[${codepoint};${mask}u`);
  }
  return out;
}

/** The extra alternatives a terminal reports for a shifted letter or symbol. */
function shiftedAlternatives(char, codepoint) {
  const lower = char.toLowerCase();
  if (char !== lower) {
    const lowerCodepoint = lower.charCodeAt(0);
    return [
      `${ESC}[${lowerCodepoint}:${codepoint};2u`,
      `${ESC}[${codepoint}:${lowerCodepoint};2u`,
      `${ESC}[${lowerCodepoint};${codepoint}::2u`,
    ];
  }
  return [];
}

/**
 * Load pi-tui from wherever this machine has it: the package resolution, the
 * newest Pi release install, or the managed npm tree. Returns null when the
 * host is not installed, which is the CI case.
 *
 * @returns {Promise<{ matchesKey: Function, decodePrintableKey: Function, setKittyProtocolActive: Function, from: string } | null>}
 */
async function loadPiTui() {
  const candidates = [];
  const override = process.env.PI_TUI_KEYS;
  if (override) candidates.push(override);
  const releases = join(homedir(), ".pi/agent/install/releases");
  if (existsSync(releases)) {
    const versions = readdirSync(releases).sort((a, b) => {
      const [aMajor = 0, aMinor = 0, aPatch = 0] = a.split(".").map(Number);
      const [bMajor = 0, bMinor = 0, bPatch = 0] = b.split(".").map(Number);
      return bMajor - aMajor || bMinor - aMinor || bPatch - aPatch;
    });
    for (const version of versions) candidates.push(join(releases, version, "node_modules/@earendil-works/pi-tui/dist/keys.js"));
  }
  candidates.push(join(homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-tui/dist/keys.js"));
  try {
    const module = await import("@earendil-works/pi-tui");
    if (typeof module.matchesKey === "function" && typeof module.setKittyProtocolActive === "function") {
      return { matchesKey: module.matchesKey, decodePrintableKey: module.decodePrintableKey, setKittyProtocolActive: module.setKittyProtocolActive, from: "@earendil-works/pi-tui" };
    }
  } catch {
    // Not resolvable from here; try the paths the host actually installs to.
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const module = await import(pathToFileURL(path).href);
      if (typeof module.matchesKey === "function" && typeof module.setKittyProtocolActive === "function") {
        return { matchesKey: module.matchesKey, decodePrintableKey: module.decodePrintableKey, setKittyProtocolActive: module.setKittyProtocolActive, from: path };
      }
    } catch {
      // A half-installed release is not a drift signal.
    }
  }
  return null;
}

/**
 * pi-tui's verdict for a printable character: its key id for the character, or
 * the character its CSI-u decoder extracts.
 *
 * @param {{ matchesKey: Function, decodePrintableKey: Function }} piTui
 * @param {string} data
 * @param {string} char
 * @returns {boolean}
 */
function piTuiPrintable(piTui, data, char) {
  const lower = char.toLowerCase();
  const keyId = char === lower ? lower : `shift+${lower}`;
  return piTui.matchesKey(data, keyId) || piTui.decodePrintableKey(data) === char;
}

/**
 * Compare both decoders over the generated table and return every
 * disagreement as a record.
 *
 * @param {{ matchesKey: Function, decodePrintableKey: Function, setKittyProtocolActive: Function }} piTui
 * @param {boolean} kittyActive
 * @returns {Array<{ kind: string, key: string, sequence: string, local: boolean, pi: boolean }>}
 */
function disagreements(piTui, kittyActive) {
  piTui.setKittyProtocolActive(kittyActive);
  const found = [];
  for (const { name, piKey } of NAMED) {
    for (const data of namedEncodings(name)) {
      const local = localMatchesKey(data, name);
      const pi = piTui.matchesKey(data, piKey);
      if (local !== pi) found.push({ kind: "named", key: name, sequence: data, local, pi });
    }
  }
  for (const { char, codepoint } of PRINTABLES) {
    const encodings = [...printableEncodings(codepoint), ...shiftedAlternatives(char, codepoint)];
    for (const data of encodings) {
      const local = matchesPrintable(data, char);
      const pi = piTuiPrintable(piTui, data, char);
      if (local !== pi) found.push({ kind: "print", key: char, sequence: data, local, pi });
    }
  }
  return found;
}

/** One line describing a disagreement, for the failure message. */
const describe = (record) => `${record.kind}|${record.key}|${JSON.stringify(record.sequence)}|local=${record.local}|pi=${record.pi}`;

test("the local decoder agrees with pi-tui's matcher, except for documented differences", async (t) => {
  const piTui = await loadPiTui();
  if (!piTui) {
    t.skip("pi-tui is not installed here; it is a host package, never a dependency of this package");
    return;
  }
  const found = [...disagreements(piTui, false), ...disagreements(piTui, true)];
  const unexpected = found.filter((record) => !ALLOWED.some((entry) => entry.test(record)));
  const stale = ALLOWED.filter((entry) => !found.some((record) => entry.test(record)));
  assert.deepEqual(
    unexpected.map(describe),
    [],
    `the local decoder disagrees with pi-tui (${piTui.from}) in ways no allowlist entry explains:\n${unexpected.map(describe).join("\n")}`,
  );
  assert.deepEqual(stale.map((entry) => entry.reason), [], "allowlist entries no longer observed (remove them, or the drift is real)");
});
