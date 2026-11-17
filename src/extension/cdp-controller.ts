import {
  mapScreenshotToViewport,
  parseKeyChordSequence,
  parseModifierBitmask,
  type CoordinateFrame
} from "../shared/cdp-input.js";
import { redactSensitiveUrl } from "../shared/url-redact.js";

export interface TabAudioFocusState {
  id: number;
  active: boolean;
  windowFocused: boolean;
  windowState: string;
  audible: boolean;
  muted: boolean;
  mutedByExtension: boolean;
  url: string;
}

export interface CdpTransport {
  attach: (tabId: number) => Promise<void>;
  detach: (tabId: number) => Promise<void>;
  sendCommand: (
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  getTabState: (tabId: number) => Promise<TabAudioFocusState>;
  setTabMuted: (tabId: number, muted: boolean) => Promise<void>;
  onEvent: (
    listener: (tabId: number, method: string, params: Record<string, unknown>) => void
  ) => void;
  onDetach: (listener: (tabId: number) => void) => void;
}

export interface ConsoleLogEntry {
  type: string;
  text: string;
  timestamp: number;
}

export interface NetworkRequestEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  failed?: boolean;
  errorText?: string;
}

export interface CapturedScreenshot {
  imageId: string;
  base64: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  frame: CoordinateFrame;
}

const MAX_CONSOLE_LOGS_PER_TAB = 10000;
const MAX_NETWORK_REQS_PER_TAB = 1000;
const MAX_CACHED_SCREENSHOTS = 32;

function createBrowserCdpTransport(): CdpTransport {
  return {
    attach: (tabId) =>
      new Promise<void>((resolve, reject) => {
        chrome.debugger.attach({ tabId }, "1.3", () => {
          const err = chrome.runtime.lastError;
          if (err && !/already attached/i.test(err.message ?? "")) {
            reject(new Error(err.message));
            return;
          }
          resolve();
        });
      }),
    detach: (tabId) =>
      new Promise<void>((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      }),
    sendCommand: (tabId, method, params) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve((result as Record<string, unknown> | undefined) ?? {});
        });
      }),
    getTabState: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId).catch(() => null);
      const mutedInfo = tab.mutedInfo;
      return {
        id: tabId,
        active: Boolean(tab.active),
        windowFocused: Boolean(win?.focused),
        windowState: win?.state ?? "normal",
        audible: Boolean(tab.audible),
        muted: Boolean(mutedInfo?.muted),
        mutedByExtension:
          Boolean(mutedInfo?.muted) &&
          mutedInfo?.reason === "extension" &&
          mutedInfo.extensionId === chrome.runtime.id,
        url: tab.url ?? tab.pendingUrl ?? ""
      };
    },
    setTabMuted: async (tabId, muted) => {
      await chrome.tabs.update(tabId, { muted });
    },
    onEvent: (listener) => {
      chrome.debugger.onEvent.addListener((source, method, params) => {
        if (source.tabId !== undefined) {
          listener(source.tabId, method, (params as Record<string, unknown> | undefined) ?? {});
        }
      });
    },
    onDetach: (listener) => {
      chrome.debugger.onDetach.addListener((source) => {
        if (source.tabId !== undefined) {
          listener(source.tabId);
        }
      });
    }
  };
}

function stringifyConsoleArgs(rawArgs: unknown): string {
  if (!Array.isArray(rawArgs)) {
    return "";
  }
  return rawArgs
    .map((item) => {
      if (!item || typeof item !== "object") {
        return String(item);
      }
      const obj = item as Record<string, unknown>;
      if ("value" in obj && obj.value !== undefined) {
        return typeof obj.value === "string" ? obj.value : JSON.stringify(obj.value);
      }
      if (typeof obj.description === "string") {
        return obj.description;
      }
      return JSON.stringify(obj);
    })
    .join(" ");
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buf;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function readPngDimensions(base64: string): { width: number; height: number } | null {
  try {
    const header = atob(base64.slice(0, 48));
    if (header.length < 24) {
      return null;
    }
    const view = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i += 1) {
      view.setUint8(i, header.charCodeAt(16 + i));
    }
    return {
      width: view.getUint32(0, false),
      height: view.getUint32(4, false)
    };
  } catch {
    return null;
  }
}

export class CdpController {
  private readonly transport: CdpTransport;
  private readonly attachedTabs = new Set<number>();
  private readonly attachInFlight = new Map<number, Promise<void>>();
  private readonly mutedByUs = new Set<number>();
  private readonly consoleByTab = new Map<number, ConsoleLogEntry[]>();
  private readonly networkByTab = new Map<number, Map<string, NetworkRequestEntry>>();
  private readonly framesByTab = new Map<number, CoordinateFrame>();
  private readonly screenshotCache = new Map<
    string,
    { base64: string; mimeType: string; width: number; height: number }
  >();
  private readonly autoAcceptDialogTabs = new Set<number>();
  private readonly openDialogs = new Map<number, { type: string; message: string }>();

  constructor(transport?: CdpTransport) {
    this.transport = transport ?? createBrowserCdpTransport();
    this.transport.onEvent((tabId, method, params) => {
      this.handleDebuggerEvent(tabId, method, params);
    });
    this.transport.onDetach((tabId) => {
      this.attachedTabs.delete(tabId);
      this.openDialogs.delete(tabId);
      if (this.mutedByUs.delete(tabId)) {
        void this.transport.setTabMuted(tabId, false).catch(() => undefined);
      }
    });
  }

  private handleDebuggerEvent(
    tabId: number,
    method: string,
    params: Record<string, unknown>
  ): void {
    if (method === "Runtime.consoleAPICalled") {
      const type = typeof params.type === "string" ? params.type : "log";
      const text = stringifyConsoleArgs(params.args);
      const timestamp = typeof params.timestamp === "number" ? params.timestamp : Date.now();
      const list = this.consoleByTab.get(tabId) ?? [];
      list.push({ type, text, timestamp });
      if (list.length > MAX_CONSOLE_LOGS_PER_TAB) {
        list.shift();
      }
      this.consoleByTab.set(tabId, list);
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as Record<string, unknown> | undefined;
      const exception = details?.exception as Record<string, unknown> | undefined;
      const text =
        (typeof exception?.description === "string" && exception.description) ||
        (typeof details?.text === "string" && details.text) ||
        "Uncaught exception";
      const list = this.consoleByTab.get(tabId) ?? [];
      list.push({ type: "exception", text, timestamp: Date.now() });
      if (list.length > MAX_CONSOLE_LOGS_PER_TAB) {
        list.shift();
      }
      this.consoleByTab.set(tabId, list);
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const requestId = typeof params.requestId === "string" ? params.requestId : "";
      const reqObj = params.request as Record<string, unknown> | undefined;
      const rawUrl = typeof reqObj?.url === "string" ? reqObj.url : "";
      if (!requestId || !rawUrl || rawUrl.startsWith("data:")) {
        return;
      }
      const methodName = typeof reqObj?.method === "string" ? reqObj.method : "GET";
      const resourceType = typeof params.type === "string" ? params.type : "Other";
      let map = this.networkByTab.get(tabId);
      if (!map) {
        map = new Map<string, NetworkRequestEntry>();
        this.networkByTab.set(tabId, map);
      }
      if (map.size >= MAX_NETWORK_REQS_PER_TAB && !map.has(requestId)) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) {
          map.delete(oldestKey);
        }
      }
      map.set(requestId, {
        requestId,
        url: redactSensitiveUrl(rawUrl),
        method: methodName,
        resourceType
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = typeof params.requestId === "string" ? params.requestId : "";
      const map = this.networkByTab.get(tabId);
      const existing = map?.get(requestId);
      if (!existing) {
        return;
      }
      const resp = params.response as Record<string, unknown> | undefined;
      if (typeof resp?.status === "number") {
        existing.status = resp.status;
      }
      if (typeof resp?.statusText === "string") {
        existing.statusText = resp.statusText;
      }
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = typeof params.requestId === "string" ? params.requestId : "";
      const map = this.networkByTab.get(tabId);
      const existing = map?.get(requestId);
      if (!existing) {
        return;
      }
      existing.failed = true;
      if (typeof params.errorText === "string") {
        existing.errorText = params.errorText;
      }
      return;
    }

    if (method === "Page.javascriptDialogOpening") {
      const dlgType = typeof params.type === "string" ? params.type : "alert";
      const message = typeof params.message === "string" ? params.message : "";
      if (this.autoAcceptDialogTabs.has(tabId)) {
        void this.transport
          .sendCommand(tabId, "Page.handleJavaScriptDialog", { accept: true })
          .catch(() => undefined);
      } else {
        this.openDialogs.set(tabId, { type: dlgType, message });
      }
      return;
    }

    if (method === "Page.javascriptDialogClosed") {
      this.openDialogs.delete(tabId);
    }
  }

  private async maybeMuteBackgroundTab(tabId: number): Promise<void> {
    try {
      const state = await this.transport.getTabState(tabId);
      const isForeground =
        state.active && state.windowFocused && state.windowState !== "minimized";
      if (!isForeground && !state.audible && !state.muted) {
        await this.transport.setTabMuted(tabId, true);
        this.mutedByUs.add(tabId);
      }
    } catch {
      // Ignore mute error if tab closed concurrently.
    }
  }

  private cacheScreenshot(
    imageId: string,
    entry: { base64: string; mimeType: string; width: number; height: number }
  ): void {
    if (this.screenshotCache.size >= MAX_CACHED_SCREENSHOTS) {
      const oldest = this.screenshotCache.keys().next().value;
      if (oldest !== undefined) {
        this.screenshotCache.delete(oldest);
      }
    }
    this.screenshotCache.set(imageId, entry);
  }

  public async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) {
      return;
    }
    const inFlight = this.attachInFlight.get(tabId);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async (): Promise<void> => {
      try {
        await this.transport.attach(tabId);
        this.attachedTabs.add(tabId);
        await this.transport.sendCommand(tabId, "Page.enable");
        await this.transport.sendCommand(tabId, "Runtime.enable");
        await this.transport.sendCommand(tabId, "Network.enable");
        await this.maybeMuteBackgroundTab(tabId);
        await this.transport.sendCommand(tabId, "Emulation.setFocusEmulationEnabled", {
          enabled: true
        });
      } finally {
        this.attachInFlight.delete(tabId);
      }
    })();

    this.attachInFlight.set(tabId, promise);
    return promise;
  }

  public async sendCommand(
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await this.ensureAttached(tabId);
    try {
      return await this.transport.sendCommand(tabId, method, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/debugger is not attached|detached while handling/i.test(msg)) {
        this.attachedTabs.delete(tabId);
        await this.ensureAttached(tabId);
        return this.transport.sendCommand(tabId, method, params);
      }
      throw err;
    }
  }

  public async detachTab(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) {
      return;
    }
    this.attachedTabs.delete(tabId);
    try {
      await this.transport.sendCommand(tabId, "Emulation.setFocusEmulationEnabled", {
        enabled: false
      });
    } catch {
      // Ignore detach cleanup error.
    }
    if (this.mutedByUs.delete(tabId)) {
      await this.transport.setTabMuted(tabId, false).catch(() => undefined);
    }
    await this.transport.detach(tabId);
  }

  public getOpenDialog(tabId: number): { type: string; message: string } | undefined {
    return this.openDialogs.get(tabId);
  }

  public async setAutoAcceptBeforeUnload(tabId: number, enabled: boolean): Promise<void> {
    if (enabled) {
      this.autoAcceptDialogTabs.add(tabId);
      if (this.openDialogs.get(tabId)?.type === "beforeunload") {
        this.openDialogs.delete(tabId);
        await this.sendCommand(tabId, "Page.handleJavaScriptDialog", { accept: true }).catch(
          () => undefined
        );
      }
    } else {
      this.autoAcceptDialogTabs.delete(tabId);
    }
  }

  public getCoordinateFrame(tabId: number): CoordinateFrame | undefined {
    return this.framesByTab.get(tabId);
  }

  public getCachedScreenshot(
    imageId: string
  ): { base64: string; mimeType: string; width: number; height: number } | undefined {
    return this.screenshotCache.get(imageId);
  }

  public toViewportPoint(
    tabId: number,
    coordinate: readonly [number, number]
  ): { x: number; y: number } {
    return mapScreenshotToViewport(coordinate, this.framesByTab.get(tabId));
  }

  public async captureScreenshot(
    tabId: number,
    options?: {
      region?: readonly [number, number, number, number];
      scale?: number;
    }
  ): Promise<CapturedScreenshot> {
    const metrics = await this.sendCommand(tabId, "Page.getLayoutMetrics");
    const cssViewport = metrics.cssLayoutViewport as Record<string, unknown> | undefined;
    const layoutViewport = metrics.layoutViewport as Record<string, unknown> | undefined;
    const viewportWidth =
      (typeof cssViewport?.clientWidth === "number" ? cssViewport.clientWidth : undefined) ??
      (typeof layoutViewport?.clientWidth === "number" ? layoutViewport.clientWidth : 1280);
    const viewportHeight =
      (typeof cssViewport?.clientHeight === "number" ? cssViewport.clientHeight : undefined) ??
      (typeof layoutViewport?.clientHeight === "number" ? layoutViewport.clientHeight : 720);

    const captureParams: Record<string, unknown> = {
      format: "png",
      fromSurface: true
    };

    if (options?.region) {
      const [x0, y0, x1, y1] = options.region;
      const p0 = this.toViewportPoint(tabId, [x0, y0]);
      const p1 = this.toViewportPoint(tabId, [x1, y1]);
      const left = Math.max(0, Math.min(p0.x, p1.x));
      const top = Math.max(0, Math.min(p0.y, p1.y));
      const width = Math.max(1, Math.abs(p1.x - p0.x));
      const height = Math.max(1, Math.abs(p1.y - p0.y));
      captureParams.clip = {
        x: left,
        y: top,
        width,
        height,
        scale: 1
      };
    }

    const res = await this.sendCommand(tabId, "Page.captureScreenshot", captureParams);
    let base64 = typeof res.data === "string" ? res.data : "";
    if (!base64) {
      throw new Error("CDP Page.captureScreenshot returned empty image data.");
    }

    const pngDims = readPngDimensions(base64);
    const fullWidth = pngDims?.width ?? viewportWidth;
    const fullHeight = pngDims?.height ?? viewportHeight;

    const frame: CoordinateFrame = options?.region
      ? (this.framesByTab.get(tabId) ?? {
          viewportWidth,
          viewportHeight,
          screenshotWidth: viewportWidth,
          screenshotHeight: viewportHeight
        })
      : {
          viewportWidth,
          viewportHeight,
          screenshotWidth: fullWidth,
          screenshotHeight: fullHeight
        };

    if (!options?.region) {
      this.framesByTab.set(tabId, frame);
    }

    let outWidth = fullWidth;
    let outHeight = fullHeight;
    const scale = options?.scale;
    if (
      typeof scale === "number" &&
      scale > 0 &&
      scale < 1 &&
      typeof OffscreenCanvas !== "undefined" &&
      typeof createImageBitmap === "function"
    ) {
      const buf = base64ToArrayBuffer(base64);
      const blob = new Blob([buf], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      outWidth = Math.max(1, Math.round(bitmap.width * scale));
      outHeight = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(outWidth, outHeight);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, outWidth, outHeight);
        const scaledBlob = await canvas.convertToBlob({ type: "image/png" });
        const arrayBuf = await scaledBlob.arrayBuffer();
        base64 = uint8ArrayToBase64(new Uint8Array(arrayBuf));
      }
      bitmap.close();
    }

    const imageId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.cacheScreenshot(imageId, {
      base64,
      mimeType: "image/png",
      width: outWidth,
      height: outHeight
    });

    return {
      imageId,
      base64,
      mimeType: "image/png",
      width: outWidth,
      height: outHeight,
      frame
    };
  }

  public async dispatchClick(
    tabId: number,
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      modifiers?: string;
    }
  ): Promise<void> {
    const button = options?.button ?? "left";
    const clickCount = options?.clickCount ?? 1;
    const modifiers = parseModifierBitmask(options?.modifiers);
    const buttonsMask = button === "left" ? 1 : button === "right" ? 2 : 4;

    await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      modifiers
    });

    for (let count = 1; count <= clickCount; count += 1) {
      await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        buttons: buttonsMask,
        clickCount: count,
        modifiers
      });
      await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: 0,
        clickCount: count,
        modifiers
      });
    }
  }

  public async dispatchHover(tabId: number, x: number, y: number): Promise<void> {
    await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0
    });
  }

  public async dispatchDrag(
    tabId: number,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    modifiers?: string
  ): Promise<void> {
    const modMask = parseModifierBitmask(modifiers);
    await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: startX,
      y: startY,
      button: "none",
      buttons: 0,
      modifiers: modMask
    });
    await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: startX,
      y: startY,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: modMask
    });
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(startX + (endX - startX) * ratio),
        y: Math.round(startY + (endY - startY) * ratio),
        button: "left",
        buttons: 1,
        modifiers: modMask
      });
    }
    await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: endX,
      y: endY,
      button: "left",
      buttons: 0,
      clickCount: 1,
      modifiers: modMask
    });
  }

  public async dispatchScroll(
    tabId: number,
    x: number,
    y: number,
    direction: "up" | "down" | "left" | "right",
    ticks: number
  ): Promise<void> {
    const pixelsPerTick = 120;
    const distance = Math.max(1, Math.min(10, ticks)) * pixelsPerTick;
    const deltaX = direction === "left" ? -distance : direction === "right" ? distance : 0;
    const deltaY = direction === "up" ? -distance : direction === "down" ? distance : 0;
    await this.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY
    });
  }

  public async dispatchTypeText(tabId: number, text: string): Promise<void> {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const segment = lines[i] ?? "";
      if (segment.length > 0) {
        await this.sendCommand(tabId, "Input.insertText", { text: segment });
      }
      if (i < lines.length - 1) {
        await this.dispatchKeySequence(tabId, "Enter", 1);
      }
    }
  }

  public async dispatchKeySequence(
    tabId: number,
    keyText: string,
    repeat: number
  ): Promise<void> {
    const descriptors = parseKeyChordSequence(keyText);
    const totalRepeats = Math.max(1, Math.min(100, Math.floor(repeat)));
    for (let r = 0; r < totalRepeats; r += 1) {
      for (const desc of descriptors) {
        await this.sendCommand(tabId, "Input.dispatchKeyEvent", {
          type: desc.text ? "keyDown" : "rawKeyDown",
          key: desc.key,
          code: desc.code,
          windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
          nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
          modifiers: desc.modifiers,
          ...(desc.text ? { text: desc.text, unmodifiedText: desc.text } : {})
        });
        await this.sendCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: desc.key,
          code: desc.code,
          windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
          nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
          modifiers: desc.modifiers
        });
      }
    }
  }

  public async evaluatePageJavaScript(
    tabId: number,
    code: string
  ): Promise<{ value: unknown; errorText?: string }> {
    const runEval = (expression: string, replMode: boolean) =>
      this.sendCommand(tabId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        replMode
      });

    let result = await runEval(`{\n${code}\n}`, true);
    const exc = result.exceptionDetails as Record<string, unknown> | undefined;
    const excObj = exc?.exception as Record<string, unknown> | undefined;
    const desc = typeof excObj?.description === "string" ? excObj.description : "";
    if (/Illegal return statement/i.test(desc)) {
      result = await runEval(`(async () => {\n${code}\n})()`, false);
    }

    const finalExc = result.exceptionDetails as Record<string, unknown> | undefined;
    if (finalExc) {
      const finalExcObj = finalExc.exception as Record<string, unknown> | undefined;
      const errText =
        (typeof finalExcObj?.description === "string" && finalExcObj.description) ||
        (typeof finalExc.text === "string" && finalExc.text) ||
        "JavaScript evaluation error";
      return { value: undefined, errorText: errText };
    }

    const remoteObj = result.result as Record<string, unknown> | undefined;
    if (!remoteObj) {
      return { value: undefined };
    }
    if ("value" in remoteObj) {
      return { value: remoteObj.value };
    }
    if (remoteObj.type === "undefined") {
      return { value: undefined };
    }
    return { value: remoteObj.description ?? `[${String(remoteObj.type)}]` };
  }

  public readConsoleMessages(
    tabId: number,
    options?: {
      onlyErrors?: boolean;
      pattern?: string;
      clear?: boolean;
      limit?: number;
    }
  ): ConsoleLogEntry[] {
    const entries = this.consoleByTab.get(tabId) ?? [];
    const regex = options?.pattern ? new RegExp(options.pattern, "i") : null;
    const filtered = entries.filter((entry) => {
      if (options?.onlyErrors && entry.type !== "error" && entry.type !== "exception") {
        return false;
      }
      if (regex && !regex.test(entry.text)) {
        return false;
      }
      return true;
    });
    if (options?.clear) {
      this.consoleByTab.set(tabId, []);
    }
    const limit = options?.limit ?? 100;
    return filtered.slice(-Math.max(1, limit));
  }

  public readNetworkRequests(
    tabId: number,
    options?: {
      urlPattern?: string;
      clear?: boolean;
      limit?: number;
    }
  ): NetworkRequestEntry[] {
    const map = this.networkByTab.get(tabId);
    const entries = map ? [...map.values()] : [];
    const needle = options?.urlPattern?.toLowerCase();
    const filtered = entries.filter((entry) => {
      if (needle && !entry.url.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
    if (options?.clear && map) {
      map.clear();
    }
    const limit = options?.limit ?? 100;
    return filtered.slice(-Math.max(1, limit));
  }
}
