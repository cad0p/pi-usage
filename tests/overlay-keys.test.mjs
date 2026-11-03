/**
 * Key decoding for the /usage overlay.
 *
 * The overlay answers the same keys in a legacy terminal (`\x1b[A`) and in one
 * that negotiates the kitty keyboard protocol (Ghostty: `\x1b[1;1:1A`), never
 * counts the release half of a kitty press, and keeps a repeat a press.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isKeyRelease, isKeyRepeat, matchesKey, matchesPrintable } from "../src/overlay-keys.js";

const ESC = "\u001b";

/**
 * Every named key the overlay turns into an action, in every encoding it can
 * arrive in. A release and a repeat are the same sequence with the event-type
 * field set to 3 and 2.
 */
const NAMED_KEYS = [
  {
    name: "escape",
    legacy: [ESC],
    press: [`${ESC}[27u`, `${ESC}[27;1u`, `${ESC}[27;1:1u`],
    release: [`${ESC}[27;1:3u`],
    repeat: [`${ESC}[27;1:2u`],
  },
  {
    name: "enter",
    legacy: ["\r", "\n"],
    press: [`${ESC}[13u`, `${ESC}[13;1u`, `${ESC}[57414u`],
    release: [`${ESC}[13;1:3u`],
    repeat: [`${ESC}[13;1:2u`],
  },
  {
    name: "tab",
    legacy: ["\t"],
    press: [`${ESC}[9u`, `${ESC}[9;1u`],
    release: [`${ESC}[9;1:3u`],
    repeat: [`${ESC}[9;1:2u`],
  },
  {
    name: "space",
    legacy: [" "],
    press: [`${ESC}[32u`, `${ESC}[32;1u`],
    release: [`${ESC}[32;1:3u`],
    repeat: [`${ESC}[32;1:2u`],
  },
  {
    name: "up",
    legacy: [`${ESC}[A`, `${ESC}OA`],
    press: [`${ESC}[1;1A`, `${ESC}[1;1:1A`, `${ESC}[57352u`, `${ESC}[57419u`],
    release: [`${ESC}[1;1:3A`, `${ESC}[57352;1:3u`],
    repeat: [`${ESC}[1;1:2A`, `${ESC}[57352;1:2u`],
  },
  {
    name: "down",
    legacy: [`${ESC}[B`, `${ESC}OB`],
    press: [`${ESC}[1;1B`, `${ESC}[1;1:1B`, `${ESC}[57353u`, `${ESC}[57420u`],
    release: [`${ESC}[1;1:3B`, `${ESC}[57353;1:3u`],
    repeat: [`${ESC}[1;1:2B`, `${ESC}[57353;1:2u`],
  },
  {
    name: "left",
    legacy: [`${ESC}[D`, `${ESC}OD`],
    press: [`${ESC}[1;1D`, `${ESC}[1;1:1D`, `${ESC}[57350u`, `${ESC}[57417u`],
    release: [`${ESC}[1;1:3D`, `${ESC}[57350;1:3u`],
    repeat: [`${ESC}[1;1:2D`, `${ESC}[57350;1:2u`],
  },
  {
    name: "right",
    legacy: [`${ESC}[C`, `${ESC}OC`],
    press: [`${ESC}[1;1C`, `${ESC}[1;1:1C`, `${ESC}[57351u`, `${ESC}[57418u`],
    release: [`${ESC}[1;1:3C`, `${ESC}[57351;1:3u`],
    repeat: [`${ESC}[1;1:2C`, `${ESC}[57351;1:2u`],
  },
  {
    name: "pageUp",
    legacy: [`${ESC}[5~`, `${ESC}[[5~`],
    press: [`${ESC}[5;1~`, `${ESC}[5;1:1~`, `${ESC}[57354u`, `${ESC}[57421u`],
    release: [`${ESC}[5;1:3~`, `${ESC}[57354;1:3u`],
    repeat: [`${ESC}[5;1:2~`, `${ESC}[57354;1:2u`],
  },
  {
    name: "pageDown",
    legacy: [`${ESC}[6~`, `${ESC}[[6~`],
    press: [`${ESC}[6;1~`, `${ESC}[6;1:1~`, `${ESC}[57355u`, `${ESC}[57422u`],
    release: [`${ESC}[6;1:3~`, `${ESC}[57355;1:3u`],
    repeat: [`${ESC}[6;1:2~`, `${ESC}[57355;1:2u`],
  },
  {
    name: "home",
    legacy: [`${ESC}[H`, `${ESC}OH`, `${ESC}[1~`, `${ESC}[7~`],
    press: [`${ESC}[1;1H`, `${ESC}[1;1:1H`, `${ESC}[7;1~`, `${ESC}[57356u`, `${ESC}[57423u`],
    release: [`${ESC}[1;1:3H`, `${ESC}[57356;1:3u`],
    repeat: [`${ESC}[1;1:2H`, `${ESC}[57356;1:2u`],
  },
  {
    name: "end",
    legacy: [`${ESC}[F`, `${ESC}OF`, `${ESC}[4~`, `${ESC}[8~`],
    press: [`${ESC}[1;1F`, `${ESC}[1;1:1F`, `${ESC}[8;1~`, `${ESC}[57357u`, `${ESC}[57424u`],
    release: [`${ESC}[1;1:3F`, `${ESC}[57357;1:3u`],
    repeat: [`${ESC}[1;1:2F`, `${ESC}[57357;1:2u`],
  },
];

/**
 * The printable keys in the legend, with the codepoint a kitty terminal reports
 * for each. `G` is Shift+g, so it can arrive with the shifted keycode.
 */
const PRINTABLE_KEYS = [
  { char: "j", codepoint: 106 },
  { char: "k", codepoint: 107 },
  { char: "h", codepoint: 104 },
  { char: "l", codepoint: 108 },
  { char: "g", codepoint: 103 },
  { char: "G", codepoint: 71, shifted: [`${ESC}[103:71;2u`, `${ESC}[103:71:103;2u`, `${ESC}[103;2u`, `${ESC}[71;2u`] },
  { char: "r", codepoint: 114 },
  { char: "q", codepoint: 113 },
  { char: "1", codepoint: 49 },
  { char: "2", codepoint: 50 },
  { char: "[", codepoint: 91 },
  { char: "]", codepoint: 93 },
];

test("legacy sequences answer every named key and nothing else", () => {
  assert.deepEqual(
    NAMED_KEYS.map((entry) => entry.name),
    ["escape", "enter", "tab", "space", "up", "down", "left", "right", "pageUp", "pageDown", "home", "end"],
    "every key the overlay names has a row",
  );
  for (const entry of NAMED_KEYS) {
    for (const sequence of entry.legacy) {
      assert.equal(matchesKey(sequence, entry.name), true, `${JSON.stringify(sequence)} is ${entry.name}`);
      assert.equal(isKeyRelease(sequence), false, "a legacy terminal sends no releases");
      for (const other of NAMED_KEYS) {
        if (other.name === entry.name) continue;
        assert.equal(matchesKey(sequence, other.name), false, `${JSON.stringify(sequence)} is not ${other.name}`);
      }
    }
  }
});

test("kitty press sequences answer every named key, with and without the modifier field", () => {
  for (const entry of NAMED_KEYS) {
    for (const sequence of entry.press) {
      assert.equal(matchesKey(sequence, entry.name), true, `${JSON.stringify(sequence)} is ${entry.name}`);
      assert.equal(isKeyRelease(sequence), false);
      assert.equal(isKeyRepeat(sequence), false);
    }
  }
});

test("kitty release sequences are releases, and the overlay's guard drops them", () => {
  for (const entry of NAMED_KEYS) {
    for (const sequence of entry.release) {
      assert.equal(isKeyRelease(sequence), true, `${JSON.stringify(sequence)} is a release of ${entry.name}`);
      assert.equal(isKeyRepeat(sequence), false);
    }
  }
});

test("kitty repeats stay presses, so a held key keeps moving", () => {
  for (const entry of NAMED_KEYS) {
    for (const sequence of entry.repeat) {
      assert.equal(isKeyRepeat(sequence), true, `${JSON.stringify(sequence)} repeats ${entry.name}`);
      assert.equal(isKeyRelease(sequence), false);
      assert.equal(matchesKey(sequence, entry.name), true, "a repeat is the same key, pressed again");
    }
  }
});

test("kitty-encoded printables match their character, including shifted letters", () => {
  for (const entry of PRINTABLE_KEYS) {
    const sequences = [
      entry.char,
      `${ESC}[${entry.codepoint}u`,
      `${ESC}[${entry.codepoint};1u`,
      `${ESC}[${entry.codepoint};1:1u`,
      ...(entry.shifted ?? []),
    ];
    for (const sequence of sequences) {
      assert.equal(matchesPrintable(sequence, entry.char), true, `${JSON.stringify(sequence)} is "${entry.char}"`);
      for (const other of PRINTABLE_KEYS) {
        if (other.char === entry.char) continue;
        assert.equal(matchesPrintable(sequence, other.char), false, `${JSON.stringify(sequence)} is not "${other.char}"`);
      }
    }
  }
});

test("shifted symbols and modified keys are not the plain key", () => {
  // Kitty reports Shift+[ as "{" and Shift+1 as "!", never as the unshifted key.
  assert.equal(matchesPrintable(`${ESC}[91:123;2u`, "["), false);
  assert.equal(matchesPrintable(`${ESC}[49:33;2u`, "1"), false);
  // Ctrl/Alt/Super combinations are key bindings, not legend keys.
  for (const sequence of [`${ESC}[106;5u`, `${ESC}[106;3u`, `${ESC}[106;9u`]) {
    assert.equal(matchesPrintable(sequence, "j"), false, `${JSON.stringify(sequence)} is not a plain j`);
  }
  // A modifier makes the special keys a different key too, except Shift on the
  // four whose shifted form is itself (legacy terminals send those identically).
  assert.equal(matchesKey(`${ESC}[13;5u`, "enter"), false);
  assert.equal(matchesKey(`${ESC}[32;5u`, "space"), false);
  assert.equal(matchesKey(`${ESC}[32;2u`, "space"), true);
  assert.equal(matchesKey(`${ESC}[13;2u`, "enter"), true);
  // Shift+Tab is backtab, not tab, in either encoding; legacy terminals send
  // it as \u001b[Z and kitty terminals as a shifted Tab codepoint.
  assert.equal(matchesKey(`${ESC}[Z`, "tab"), false);
  assert.equal(matchesKey(`${ESC}[9;2u`, "tab"), false);
  assert.equal(matchesKey(`${ESC}[9u`, "tab"), true);
  // Shift/Ctrl/Alt + arrow are not the plain arrow.
  assert.equal(matchesKey(`${ESC}[1;2A`, "up"), false);
  assert.equal(matchesKey(`${ESC}[1;3A`, "up"), false);
  assert.equal(matchesKey(`${ESC}[1;5A`, "up"), false);
  // Caps Lock and Num Lock are reported in the modifier field and must not
  // break the arrows; the overlay still gets the plain key.
  assert.equal(matchesKey(`${ESC}[1;65B`, "down"), true);
  assert.equal(matchesKey(`${ESC}[1;129C`, "right"), true);
});

test("other keys, bare modifiers and pasted text are never legend keys", () => {
  const unrelated = [
    `${ESC}[3~`,
    `${ESC}[2~`,
    `${ESC}[15~`,
    `${ESC}[200~j k q 1 2 ${ESC}[201~`,
    "\u0003",
    "",
    "x",
    // Backspace and Delete are not legend keys, in either encoding.
    "\u007f",
    `${ESC}[127u`,
    `${ESC}[127;1:1u`,
  ];
  for (const sequence of unrelated) {
    assert.equal(isKeyRelease(sequence), false);
    assert.equal(isKeyRepeat(sequence), false);
    for (const entry of NAMED_KEYS) {
      assert.equal(matchesKey(sequence, entry.name), false, `${JSON.stringify(sequence)} is not ${entry.name}`);
    }
    for (const entry of PRINTABLE_KEYS) {
      assert.equal(matchesPrintable(sequence, entry.char), false, `${JSON.stringify(sequence)} is not "${entry.char}"`);
    }
  }
});
