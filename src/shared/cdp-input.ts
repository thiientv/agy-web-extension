export interface CoordinateFrame {
  viewportWidth: number;
  viewportHeight: number;
  screenshotWidth: number;
  screenshotHeight: number;
}

export interface CdpKeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
}

interface SpecialKeyInfo {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const SPECIAL_KEYS: Readonly<Record<string, SpecialKeyInfo>> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  f1: { key: "F1", code: "F1", keyCode: 112 },
  f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 },
  f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
  f6: { key: "F6", code: "F6", keyCode: 117 },
  f7: { key: "F7", code: "F7", keyCode: 118 },
  f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 },
  f10: { key: "F10", code: "F10", keyCode: 121 },
  f11: { key: "F11", code: "F11", keyCode: 122 },
  f12: { key: "F12", code: "F12", keyCode: 123 }
};

const MODIFIER_BITS: Readonly<Record<string, number>> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  windows: 4,
  super: 4,
  shift: 8
};

export function parseModifierBitmask(modifiers?: string): number {
  if (!modifiers) {
    return 0;
  }
  let mask = 0;
  for (const part of modifiers.split("+")) {
    const bit = MODIFIER_BITS[part.trim().toLowerCase()];
    if (bit !== undefined) {
      mask |= bit;
    }
  }
  return mask;
}

export function isPageZoomShortcut(keyText: string): boolean {
  const tokens = keyText.trim().split(/\s+/);
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (/^(cmd|command|meta|ctrl|control)(\+shift)?\+(0|=|\+|-|_|numpadadd|numpadsubtract)$/.test(lower)) {
      return true;
    }
  }
  return false;
}

function singleCharDescriptor(ch: string, modifiers: number): CdpKeyDescriptor {
  const upper = ch.toUpperCase();
  const isAlpha = /^[A-Z]$/.test(upper);
  const isDigit = /^[0-9]$/.test(ch);
  const code = isAlpha ? `Key${upper}` : isDigit ? `Digit${ch}` : "";
  const keyCode = isAlpha || isDigit ? upper.charCodeAt(0) : ch.charCodeAt(0);
  const hasCommandOrCtrl = (modifiers & (2 | 4)) !== 0;
  return {
    key: ch,
    code,
    windowsVirtualKeyCode: keyCode,
    modifiers,
    ...(hasCommandOrCtrl ? {} : { text: ch })
  };
}

function parseSingleChord(chord: string): CdpKeyDescriptor {
  const parts = chord.split("+").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { key: "", code: "", windowsVirtualKeyCode: 0, modifiers: 0 };
  }

  let modifiers = 0;
  const keyToken = parts[parts.length - 1] ?? "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    const modName = (parts[i] ?? "").toLowerCase();
    const bit = MODIFIER_BITS[modName];
    if (bit !== undefined) {
      modifiers |= bit;
    }
  }

  const special = SPECIAL_KEYS[keyToken.toLowerCase()];
  if (special) {
    return {
      key: special.key,
      code: special.code,
      windowsVirtualKeyCode: special.keyCode,
      modifiers,
      ...(special.text && (modifiers & (2 | 4)) === 0 ? { text: special.text } : {})
    };
  }

  const standaloneModifier = MODIFIER_BITS[keyToken.toLowerCase()];
  if (standaloneModifier !== undefined && parts.length === 1) {
    const modKeyMap: Record<number, { key: string; code: string; keyCode: number }> = {
      1: { key: "Alt", code: "AltLeft", keyCode: 18 },
      2: { key: "Control", code: "ControlLeft", keyCode: 17 },
      4: { key: "Meta", code: "MetaLeft", keyCode: 91 },
      8: { key: "Shift", code: "ShiftLeft", keyCode: 16 }
    };
    const info = modKeyMap[standaloneModifier] ?? { key: keyToken, code: "", keyCode: 0 };
    return {
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      modifiers: standaloneModifier
    };
  }

  if (keyToken.length === 1) {
    return singleCharDescriptor(keyToken, modifiers);
  }

  return {
    key: keyToken,
    code: keyToken,
    windowsVirtualKeyCode: 0,
    modifiers
  };
}

export function parseKeyChordSequence(text: string): CdpKeyDescriptor[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/\s+/)
    .map(parseSingleChord)
    .filter((desc) => desc.key.length > 0);
}

export function mapScreenshotToViewport(
  coordinate: readonly [number, number],
  frame?: CoordinateFrame
): { x: number; y: number } {
  const [rawX, rawY] = coordinate;
  if (
    !frame ||
    frame.screenshotWidth <= 0 ||
    frame.screenshotHeight <= 0 ||
    frame.viewportWidth <= 0 ||
    frame.viewportHeight <= 0
  ) {
    return { x: Math.round(rawX), y: Math.round(rawY) };
  }
  const scaleX = frame.viewportWidth / frame.screenshotWidth;
  const scaleY = frame.viewportHeight / frame.screenshotHeight;
  return {
    x: Math.round(rawX * scaleX),
    y: Math.round(rawY * scaleY)
  };
}
