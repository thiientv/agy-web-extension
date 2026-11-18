import type { McpToolCallResult, SessionScope } from "../protocol/messages.js";
import { isPageZoomShortcut } from "../shared/cdp-input.js";
import { rankFindCandidates } from "../shared/find-matcher.js";
import { normalizeNavigationUrl } from "../shared/url-redact.js";
import type { CdpController } from "./cdp-controller.js";
import {
  armTabBackgroundClickGuard,
  drainTabBackgroundClickGuard,
  executeDropFileAtPoint,
  executeFileUploadOnRef,
  executeGetPageText,
  executeReadPageTree,
  executeSetFormInput,
  resolveElementViewportCenter,
  type UploadFilePayload
} from "./page-scripts.js";
import type { TabGroupManager } from "./tab-group-manager.js";

interface GifRecordedFrame {
  base64: string;
  format: "png";
  viewportWidth: number;
  viewportHeight: number;
  delay: number;
  action?: {
    type: string;
    description: string;
    coordinate?: [number, number];
    start_coordinate?: [number, number];
  };
}

interface GifSessionState {
  recording: boolean;
  frames: GifRecordedFrame[];
}

function textResult(text: string, isError = false): McpToolCallResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text }]
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asNumber(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === "string" && val.trim() !== "") {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function asCoordinatePair(val: unknown): [number, number] | undefined {
  if (
    Array.isArray(val) &&
    val.length === 2 &&
    typeof val[0] === "number" &&
    typeof val[1] === "number"
  ) {
    return [val[0], val[1]];
  }
  return undefined;
}

function asRegionQuad(val: unknown): [number, number, number, number] | undefined {
  if (
    Array.isArray(val) &&
    val.length === 4 &&
    typeof val[0] === "number" &&
    typeof val[1] === "number" &&
    typeof val[2] === "number" &&
    typeof val[3] === "number"
  ) {
    return [val[0], val[1], val[2], val[3]];
  }
  return undefined;
}

function isRestrictedBrowserUrl(url: string): boolean {
  return /^(chrome|chrome-extension|devtools|edge|about|view-source):/i.test(url);
}

async function waitForTabNavigationComplete(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        return;
      }
    } catch {
      return;
    }
    await sleepMs(120);
  }
}

async function ensureOffscreenDocumentReady(): Promise<void> {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: "Keep MV3 service worker responsive and encode GIF automation recordings."
  });
}

export class ToolExecutor {
  private readonly tabGroups: TabGroupManager;
  private readonly cdp: CdpController;
  private readonly gifByGroup = new Map<number, GifSessionState>();

  constructor(tabGroups: TabGroupManager, cdp: CdpController) {
    this.tabGroups = tabGroups;
    this.cdp = cdp;
  }

  private async maybeRecordGifFrame(
    tabId: number,
    groupId: number,
    actionMeta: GifRecordedFrame["action"]
  ): Promise<void> {
    const state = this.gifByGroup.get(groupId);
    if (!state?.recording || state.frames.length >= 120) {
      return;
    }
    try {
      await this.tabGroups.hideIndicatorForScreenshot(tabId);
      const shot = await this.cdp.captureScreenshot(tabId);
      await this.tabGroups.restoreIndicatorAfterScreenshot(tabId);
      state.frames.push({
        base64: shot.base64,
        format: "png",
        viewportWidth: shot.frame.viewportWidth,
        viewportHeight: shot.frame.viewportHeight,
        delay: 800,
        action: actionMeta
      });
    } catch {
      // Ignore frame capture errors on transitional navigations.
    }
  }

  private async resolveActionTargetPoint(
    tabId: number,
    args: Record<string, unknown>
  ): Promise<{ x: number; y: number } | { error: string }> {
    const ref = typeof args.ref === "string" ? args.ref.trim() : "";
    if (ref) {
      const box = await resolveElementViewportCenter(tabId, ref, true);
      if (!box.ok || box.x === undefined || box.y === undefined) {
        return { error: box.error ?? `Could not locate element "${ref}".` };
      }
      return { x: box.x, y: box.y };
    }
    const coord = asCoordinatePair(args.coordinate);
    if (!coord) {
      return {
        error: "Either `coordinate` ([x, y]) or `ref` (e.g. \"ref_1\") is required for this action."
      };
    }
    return this.cdp.toViewportPoint(tabId, coord);
  }

  private async handleTabsContext(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const createIfEmpty = Boolean(args.createIfEmpty);
    const ctx = await this.tabGroups.getOrCreateSessionContext(scope, createIfEmpty);
    if (!ctx) {
      return textResult(
        "No MCP tab group exists for this session yet. Call tabs_context_mcp with createIfEmpty: true to create an isolated background tab group."
      );
    }
    const lines = ctx.availableTabs.map(
      (t) => `- tabId=${t.id} | title=${JSON.stringify(t.title || "Untitled")} | url=${t.url}`
    );
    return textResult(
      `MCP Tab Group ID: ${ctx.tabGroupId}\nCurrent Tab ID: ${ctx.currentTabId}\nAvailable Tabs (${ctx.availableTabs.length}):\n${lines.join("\n")}`
    );
  }

  private async handleTabsCreate(scope: SessionScope): Promise<McpToolCallResult> {
    const created = await this.tabGroups.createTabInSessionGroup(scope);
    const lines = created.availableTabs.map(
      (t) => `- tabId=${t.id} | title=${JSON.stringify(t.title || "New Tab")} | url=${t.url}`
    );
    return textResult(
      `Created new background tab ${created.newTabId} (active: false) in MCP tab group ${created.tabGroupId}.\nAvailable Tabs (${created.availableTabs.length}):\n${lines.join("\n")}`
    );
  }

  private async handleTabsClose(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    if (tabId === undefined) {
      return textResult("Parameter `tabId` is required.", true);
    }
    await this.cdp.disposeTab(tabId).catch(() => undefined);
    const remaining = await this.tabGroups.closeTabInSession(tabId, scope);
    return textResult(
      `Closed tab ${tabId}. Remaining tabs in session group: ${
        remaining.length === 0
          ? "none"
          : remaining.map((t) => `${t.id} (${t.url})`).join(", ")
      }`
    );
  }

  private async handleNavigate(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    const force = Boolean(args.force);
    if (tabId === undefined || !rawUrl) {
      return textResult("Parameters `tabId` and `url` are required.", true);
    }

    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    const performNavigation = async (): Promise<McpToolCallResult> => {
      const normalized = normalizeNavigationUrl(rawUrl);
      if (normalized === "back") {
        await chrome.tabs.goBack(tabId);
      } else if (normalized === "forward") {
        await chrome.tabs.goForward(tabId);
      } else {
        await chrome.tabs.update(tabId, { url: normalized });
      }
      await sleepMs(150);
      const dlg = this.cdp.getOpenDialog(tabId);
      if (dlg?.type === "beforeunload" && !force) {
        await this.cdp
          .sendCommand(tabId, "Page.handleJavaScriptDialog", { accept: false })
          .catch(() => undefined);
        return textResult(
          "Navigation blocked by a 'Leave site?' beforeunload prompt. Pass `force: true` to discard unsaved changes and navigate anyway.",
          true
        );
      }

      await waitForTabNavigationComplete(tabId, 15000);
      const updatedTab = await chrome.tabs.get(tabId);
      const finalUrl = updatedTab.url ?? updatedTab.pendingUrl ?? normalized;
      if (!isRestrictedBrowserUrl(finalUrl)) {
        await this.tabGroups.showActiveVisualIndicator(tabId, {
          label: "Navigated",
          rest: true
        });
        await this.maybeRecordGifFrame(tabId, tab.groupId, {
          type: "navigate",
          description: `Navigate to ${finalUrl}`
        });
      }
      return textResult(
        `Navigated tab ${tabId} to ${finalUrl} (title: ${JSON.stringify(updatedTab.title ?? "")})`
      );
    };

    if (force && !isRestrictedBrowserUrl(tab.url)) {
      return this.cdp.withAttachedTab(tabId, async () => {
        await this.cdp.setAutoAcceptBeforeUnload(tabId, true);
        try {
          return await performNavigation();
        } finally {
          await this.cdp.setAutoAcceptBeforeUnload(tabId, false);
        }
      });
    }

    return performNavigation();
  }

  private async handleReadPage(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    if (tabId === undefined) {
      return textResult("Parameter `tabId` is required.", true);
    }
    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    if (isRestrictedBrowserUrl(tab.url)) {
      return textResult(
        `Cannot read accessibility tree on restricted browser URL (${tab.url}). Navigate to an http:// or https:// page first.`,
        true
      );
    }

    const filter = typeof args.filter === "string" ? args.filter : "all";
    const depth = asNumber(args.depth) ?? 15;
    const maxChars = asNumber(args.max_chars) ?? 50000;
    const refId = typeof args.ref_id === "string" ? args.ref_id : null;

    const tree = await executeReadPageTree(tabId, {
      filter,
      depth,
      maxChars,
      refId,
      findData: false
    });
    if (tree.error) {
      return textResult(tree.error, true);
    }

    return textResult(
      `URL: ${tab.url}\nTitle: ${tab.title}\nViewport: ${tree.viewport.width}x${tree.viewport.height}\n\n${
        tree.pageContent || "[empty page]"
      }`
    );
  }

  private async handleFind(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (tabId === undefined || !query) {
      return textResult("Parameters `tabId` and `query` are required.", true);
    }
    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    if (isRestrictedBrowserUrl(tab.url)) {
      return textResult(
        `Cannot search elements on restricted browser URL (${tab.url}). Navigate to an http:// or https:// page first.`,
        true
      );
    }

    const tree = await executeReadPageTree(tabId, {
      filter: "all",
      depth: null,
      maxChars: null,
      refId: null,
      findData: true
    });
    if (tree.error) {
      return textResult(tree.error, true);
    }

    const ranked = rankFindCandidates(tree.findNodes ?? [], query, {
      truncated: tree.findTruncated,
      metaPartial: tree.findMetaPartial
    });
    return textResult(ranked.output ?? ranked.noMatch ?? "No matching elements found.");
  }

  private async handleFormInput(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const ref = typeof args.ref === "string" ? args.ref.trim() : "";
    const rawValue = args.value;
    if (
      tabId === undefined ||
      !ref ||
      (typeof rawValue !== "string" &&
        typeof rawValue !== "number" &&
        typeof rawValue !== "boolean")
    ) {
      return textResult(
        "Parameters `tabId`, `ref`, and `value` (string | number | boolean) are required.",
        true
      );
    }

    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    const center = await resolveElementViewportCenter(tabId, ref, true);
    if (center.ok && center.x !== undefined && center.y !== undefined) {
      await this.tabGroups.showActiveVisualIndicator(tabId);
      await this.tabGroups.movePhantomCursor(tabId, center.x, center.y, true, "Filling field");
    }

    const res = await executeSetFormInput(tabId, ref, rawValue);
    if (!res.ok) {
      return textResult(res.message, true);
    }
    await this.maybeRecordGifFrame(tabId, tab.groupId, {
      type: "type",
      description: `Fill ${ref}`,
      ...(center.x !== undefined && center.y !== undefined
        ? { coordinate: [center.x, center.y] }
        : {})
    });
    return textResult(res.message);
  }

  private async handleComputer(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const action = typeof args.action === "string" ? args.action : "";
    if (tabId === undefined || !action) {
      return textResult("Parameters `tabId` and `action` are required.", true);
    }

    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    if (action === "wait") {
      const durationSec = Math.max(0, Math.min(10, asNumber(args.duration) ?? 1));
      await sleepMs(Math.round(durationSec * 1000));
      return textResult(`Waited ${durationSec} second(s).`);
    }

    if (isRestrictedBrowserUrl(tab.url)) {
      return textResult(
        `Cannot run computer action "${action}" on restricted browser URL (${tab.url}). Navigate to an http:// or https:// page first.`,
        true
      );
    }

    if (action === "scroll_to") {
      const ref = typeof args.ref === "string" ? args.ref.trim() : "";
      if (!ref) {
        return textResult("Parameter `ref` is required for `scroll_to`.", true);
      }
      await this.tabGroups.showActiveVisualIndicator(tabId);
      const box = await resolveElementViewportCenter(tabId, ref, true);
      if (!box.ok) {
        return textResult(box.error ?? `Failed to scroll to "${ref}".`, true);
      }
      return textResult(`Scrolled element [${ref}] into view at (${box.x}, ${box.y}).`);
    }

    const supportedCdpActions = new Set([
      "screenshot",
      "zoom",
      "left_click",
      "right_click",
      "double_click",
      "triple_click",
      "hover",
      "left_click_drag",
      "scroll",
      "type",
      "key"
    ]);
    if (!supportedCdpActions.has(action)) {
      return textResult(`Unsupported computer action: "${action}".`, true);
    }

    return this.cdp.withAttachedTab(tabId, async () => {
      if (action === "screenshot" || action === "zoom") {
        const scale = asNumber(args.scale);
        const region = action === "zoom" ? asRegionQuad(args.region) : undefined;
        if (action === "zoom" && !region) {
          return textResult(
            "Parameter `region` ([x0, y0, x1, y1]) is required for `zoom`.",
            true
          );
        }

        await this.tabGroups.hideIndicatorForScreenshot(tabId);
        await sleepMs(35);
        let shot;
        try {
          shot = await this.cdp.captureScreenshot(tabId, { region, scale });
        } finally {
          await this.tabGroups.restoreIndicatorAfterScreenshot(tabId);
        }

        return {
          content: [
            {
              type: "text",
              text: `Captured ${action} (imageId: ${shot.imageId}, coordinate_frame: ${shot.frame.screenshotWidth}x${shot.frame.screenshotHeight}, viewport: ${shot.frame.viewportWidth}x${shot.frame.viewportHeight}).`
            },
            {
              type: "image",
              data: shot.base64,
              mimeType: shot.mimeType
            }
          ]
        };
      }

      await this.tabGroups.showActiveVisualIndicator(tabId);

      if (
        action === "left_click" ||
        action === "right_click" ||
        action === "double_click" ||
        action === "triple_click"
      ) {
        const target = await this.resolveActionTargetPoint(tabId, args);
        if ("error" in target) {
          return textResult(target.error, true);
        }

        const button = action === "right_click" ? "right" : "left";
        const clickCount =
          action === "triple_click" ? 3 : action === "double_click" ? 2 : 1;
        const modifiers = typeof args.modifiers === "string" ? args.modifiers : undefined;

        await this.tabGroups.movePhantomCursor(tabId, target.x, target.y, true, "Clicking");
        await armTabBackgroundClickGuard(tabId);
        await this.cdp.dispatchClick(tabId, target.x, target.y, {
          button,
          clickCount,
          modifiers
        });
        await sleepMs(80);
        const interceptedPopupUrls = await drainTabBackgroundClickGuard(tabId);
        let popupNotice = "";
        if (interceptedPopupUrls.length > 0) {
          const openedTabIds = await this.tabGroups.createBackgroundPopupTabs(
            tabId,
            interceptedPopupUrls
          );
          if (openedTabIds.length > 0) {
            popupNotice = ` Opened background tab(s) [${openedTabIds.join(", ")}] in MCP tab group without stealing focus.`;
          }
        }

        await this.maybeRecordGifFrame(tabId, tab.groupId, {
          type: action,
          description: `Click (${target.x}, ${target.y})`,
          coordinate: [target.x, target.y]
        });

        return textResult(
          `Performed ${action} at viewport (${target.x}, ${target.y}).${popupNotice}`
        );
      }

      if (action === "hover") {
        const target = await this.resolveActionTargetPoint(tabId, args);
        if ("error" in target) {
          return textResult(target.error, true);
        }
        await this.tabGroups.movePhantomCursor(tabId, target.x, target.y, false, "Hovering");
        await this.cdp.dispatchHover(tabId, target.x, target.y);
        return textResult(`Moved cursor to viewport (${target.x}, ${target.y}).`);
      }

      if (action === "left_click_drag") {
        const rawStart = asCoordinatePair(args.start_coordinate);
        const rawEnd = asCoordinatePair(args.coordinate);
        if (!rawStart || !rawEnd) {
          return textResult(
            "Parameters `start_coordinate` and `coordinate` are required for `left_click_drag`.",
            true
          );
        }
        const startPt = this.cdp.toViewportPoint(tabId, rawStart);
        const endPt = this.cdp.toViewportPoint(tabId, rawEnd);
        const modifiers = typeof args.modifiers === "string" ? args.modifiers : undefined;
        await this.tabGroups.movePhantomCursor(tabId, startPt.x, startPt.y, true, "Dragging");
        await this.cdp.dispatchDrag(tabId, startPt.x, startPt.y, endPt.x, endPt.y, modifiers);
        await this.tabGroups.movePhantomCursor(tabId, endPt.x, endPt.y, false, "Dragged");
        await this.maybeRecordGifFrame(tabId, tab.groupId, {
          type: "left_click_drag",
          description: "Drag",
          start_coordinate: [startPt.x, startPt.y],
          coordinate: [endPt.x, endPt.y]
        });
        return textResult(
          `Dragged from (${startPt.x}, ${startPt.y}) to (${endPt.x}, ${endPt.y}).`
        );
      }

      if (action === "scroll") {
        const direction = args.scroll_direction;
        if (
          direction !== "up" &&
          direction !== "down" &&
          direction !== "left" &&
          direction !== "right"
        ) {
          return textResult(
            'Parameter `scroll_direction` ("up" | "down" | "left" | "right") is required for `scroll`.',
            true
          );
        }
        const rawCoord = asCoordinatePair(args.coordinate) ?? [640, 360];
        const pt = this.cdp.toViewportPoint(tabId, rawCoord);
        const ticks = asNumber(args.scroll_amount) ?? 3;
        await this.tabGroups.movePhantomCursor(tabId, pt.x, pt.y, false, `Scrolling ${direction}`);
        await this.cdp.dispatchScroll(tabId, pt.x, pt.y, direction, ticks);
        await this.maybeRecordGifFrame(tabId, tab.groupId, {
          type: "scroll",
          description: `Scroll ${direction}`,
          coordinate: [pt.x, pt.y]
        });
        return textResult(`Scrolled ${direction} (${ticks} ticks) at (${pt.x}, ${pt.y}).`);
      }

      if (action === "type") {
        const text = typeof args.text === "string" ? args.text : "";
        if (!text) {
          return textResult("Parameter `text` is required for `type`.", true);
        }
        await this.cdp.dispatchTypeText(tabId, text);
        await this.maybeRecordGifFrame(tabId, tab.groupId, {
          type: "type",
          description: `Type "${text.slice(0, 24)}"`
        });
        return textResult(`Typed ${text.length} character(s).`);
      }

      const keyText = typeof args.text === "string" ? args.text.trim() : "";
      if (!keyText) {
        return textResult("Parameter `text` is required for `key`.", true);
      }
      if (isPageZoomShortcut(keyText)) {
        return textResult(
          `Page zoom shortcut "${keyText}" is not supported. Use the \`zoom\` action on \`computer\` instead.`,
          true
        );
      }
      const repeat = asNumber(args.repeat) ?? 1;
      await this.cdp.dispatchKeySequence(tabId, keyText, repeat);
      await this.maybeRecordGifFrame(tabId, tab.groupId, {
        type: "key",
        description: `Press ${keyText}`
      });
      return textResult(`Pressed key sequence "${keyText}" (repeat=${repeat}).`);
    });
  }

  private async handleJavaScriptTool(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const action = typeof args.action === "string" ? args.action : "";
    const code = typeof args.text === "string" ? args.text : "";
    if (tabId === undefined || action !== "javascript_exec" || !code) {
      return textResult(
        "Parameters `tabId`, `action: 'javascript_exec'`, and `text` are required.",
        true
      );
    }

    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    if (isRestrictedBrowserUrl(tab.url)) {
      return textResult(
        `JavaScript execution is not allowed on restricted URL (${tab.url}). Navigate to an http:// or https:// page first.`,
        true
      );
    }

    const evaluated = await this.cdp.evaluatePageJavaScript(tabId, code);
    if (evaluated.errorText) {
      return textResult(`JavaScript error: ${evaluated.errorText}`, true);
    }
    const formatted =
      evaluated.value === undefined
        ? "undefined"
        : typeof evaluated.value === "string"
          ? evaluated.value
          : JSON.stringify(evaluated.value, null, 2);
    return textResult(formatted);
  }

  private async handleGetPageText(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    if (tabId === undefined) {
      return textResult("Parameter `tabId` is required.", true);
    }
    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    if (isRestrictedBrowserUrl(tab.url)) {
      return textResult(
        `Cannot extract page text on restricted URL (${tab.url}). Navigate to an http:// or https:// page first.`,
        true
      );
    }
    const maxChars = asNumber(args.max_chars) ?? 50000;
    const res = await executeGetPageText(tabId, maxChars);
    if (res.error) {
      return textResult(res.error, true);
    }
    return textResult(`Title: ${res.title}\nURL: ${res.url}\nSource: <${res.source}>\n\n${res.text}`);
  }

  private async handleReadConsoleMessages(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    if (tabId === undefined) {
      return textResult("Parameter `tabId` is required.", true);
    }
    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    const logs = this.cdp.readConsoleMessages(tabId, {
      onlyErrors: Boolean(args.onlyErrors),
      pattern: typeof args.pattern === "string" ? args.pattern : undefined,
      clear: Boolean(args.clear),
      limit: asNumber(args.limit) ?? 100
    });

    if (logs.length === 0) {
      if (!isRestrictedBrowserUrl(tab.url)) {
        await this.cdp.ensureAttached(tabId).catch(() => undefined);
      }
      return textResult("No matching console messages recorded for this tab.");
    }
    const formatted = logs
      .map((entry) => `[${entry.type.toUpperCase()}] ${entry.text}`)
      .join("\n");
    return textResult(formatted);
  }

  private async handleReadNetworkRequests(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    if (tabId === undefined) {
      return textResult("Parameter `tabId` is required.", true);
    }
    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    const reqs = this.cdp.readNetworkRequests(tabId, {
      urlPattern: typeof args.urlPattern === "string" ? args.urlPattern : undefined,
      clear: Boolean(args.clear),
      limit: asNumber(args.limit) ?? 100
    });

    if (reqs.length === 0) {
      if (!isRestrictedBrowserUrl(tab.url)) {
        await this.cdp.ensureAttached(tabId).catch(() => undefined);
      }
      return textResult("No matching network requests recorded for this tab.");
    }
    const formatted = reqs
      .map((r) => {
        const statusPart = r.failed
          ? `FAILED (${r.errorText ?? "error"})`
          : r.status !== undefined
            ? `${r.status} ${r.statusText ?? ""}`.trim()
            : "PENDING";
        return `${r.method} [${r.resourceType}] ${statusPart} — ${r.url}`;
      })
      .join("\n");
    return textResult(formatted);
  }

  private async handleResizeWindow(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const width = asNumber(args.width);
    const height = asNumber(args.height);
    if (tabId === undefined || width === undefined || height === undefined) {
      return textResult("Parameters `tabId`, `width`, and `height` are required.", true);
    }
    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    await chrome.windows.update(tab.windowId, {
      width: Math.round(width),
      height: Math.round(height)
    });
    return textResult(`Resized browser window ${tab.windowId} to ${Math.round(width)}x${Math.round(height)}.`);
  }

  private async handleUploadImage(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const imageId = typeof args.imageId === "string" ? args.imageId.trim() : "";
    if (tabId === undefined || !imageId) {
      return textResult("Parameters `tabId` and `imageId` are required.", true);
    }
    await this.tabGroups.assertTabInSession(tabId, scope);
    const cached = this.cdp.getCachedScreenshot(imageId);
    if (!cached) {
      return textResult(
        `Screenshot with imageId "${imageId}" was not found in cache. Capture a screenshot first.`,
        true
      );
    }

    const filename =
      typeof args.filename === "string" && args.filename.trim()
        ? args.filename.trim()
        : "image.png";
    const payload: UploadFilePayload = {
      name: filename,
      data: cached.base64,
      mimeType: cached.mimeType
    };

    const ref = typeof args.ref === "string" ? args.ref.trim() : "";
    if (ref) {
      const uploaded = await executeFileUploadOnRef(tabId, ref, [payload]);
      return textResult(uploaded.message, !uploaded.ok);
    }

    const coord = asCoordinatePair(args.coordinate);
    if (coord) {
      const pt = this.cdp.toViewportPoint(tabId, coord);
      const dropped = await executeDropFileAtPoint(tabId, pt.x, pt.y, payload);
      return textResult(dropped.message, !dropped.ok);
    }

    return textResult("Provide either `ref` or `coordinate` for `upload_image`.", true);
  }

  private async handleFileUpload(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const ref = typeof args.ref === "string" ? args.ref.trim() : "";
    if (tabId === undefined || !ref) {
      return textResult("Parameters `tabId` and `ref` are required.", true);
    }
    await this.tabGroups.assertTabInSession(tabId, scope);

    const rawFiles = Array.isArray(args.files) ? args.files : [];
    const payloads: UploadFilePayload[] = [];
    for (const item of rawFiles) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        if (typeof rec.data === "string" && typeof rec.name === "string") {
          payloads.push({
            data: rec.data,
            name: rec.name,
            mimeType:
              typeof rec.mimeType === "string" ? rec.mimeType : "application/octet-stream"
          });
        }
      }
    }

    if (payloads.length === 0) {
      return textResult("Provide at least one file in `files` or `paths`.", true);
    }

    const uploaded = await executeFileUploadOnRef(tabId, ref, payloads);
    return textResult(uploaded.message, !uploaded.ok);
  }

  private async handleGifCreator(
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const tabId = asNumber(args.tabId);
    const action = typeof args.action === "string" ? args.action : "";
    if (tabId === undefined || !action) {
      return textResult("Parameters `tabId` and `action` are required.", true);
    }

    const tab = await this.tabGroups.assertTabInSession(tabId, scope);
    const groupId = tab.groupId;
    let state = this.gifByGroup.get(groupId);
    if (!state) {
      state = { recording: false, frames: [] };
      this.gifByGroup.set(groupId, state);
    }

    if (action === "start_recording") {
      state.recording = true;
      state.frames = [];
      await this.maybeRecordGifFrame(tabId, groupId, {
        type: "start",
        description: "Start"
      });
      return textResult(`Started GIF recording for tab group ${groupId}.`);
    }

    if (action === "stop_recording") {
      state.recording = false;
      return textResult(
        `Stopped GIF recording for tab group ${groupId} (${state.frames.length} frame(s) captured).`
      );
    }

    if (action === "clear") {
      state.recording = false;
      state.frames = [];
      return textResult(`Cleared recorded GIF frames for tab group ${groupId}.`);
    }

    if (action === "export") {
      if (state.frames.length === 0) {
        return textResult(
          "No recorded frames available to export. Call gif_creator with action='start_recording' before performing browser actions.",
          true
        );
      }

      await ensureOffscreenDocumentReady();
      const response = (await chrome.runtime.sendMessage({
        type: "GENERATE_GIF",
        frames: state.frames,
        options:
          args.options && typeof args.options === "object"
            ? (args.options as Record<string, unknown>)
            : {}
      })) as
        | {
            success: boolean;
            error?: string;
            result?: { base64: string; blobUrl: string; size: number; width: number; height: number };
          }
        | undefined;

      if (!response?.success || !response.result) {
        return textResult(
          `GIF encoding failed: ${response?.error ?? "Unknown offscreen error"}`,
          true
        );
      }

      const filename =
        typeof args.filename === "string" && args.filename.trim()
          ? args.filename.trim()
          : `recording-${Date.now()}.gif`;

      if (args.download === true) {
        const dataUrl = `data:image/gif;base64,${response.result.base64}`;
        await chrome.downloads.download({
          url: dataUrl,
          filename,
          saveAs: false
        });
        return textResult(
          `Exported and downloaded GIF "${filename}" (${response.result.width}x${response.result.height}, ${response.result.size} bytes).`
        );
      }

      const coord = asCoordinatePair(args.coordinate);
      if (coord) {
        const pt = this.cdp.toViewportPoint(tabId, coord);
        const dropped = await executeDropFileAtPoint(tabId, pt.x, pt.y, {
          name: filename,
          data: response.result.base64,
          mimeType: "image/gif"
        });
        return textResult(dropped.message, !dropped.ok);
      }

      return textResult(
        `Generated GIF "${filename}" (${response.result.width}x${response.result.height}, ${response.result.size} bytes). Pass download: true or coordinate: [x, y] to save/drop it.`
      );
    }

    return textResult(`Unsupported gif_creator action: "${action}".`, true);
  }

  public async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    scope: SessionScope
  ): Promise<McpToolCallResult> {
    const normalizedName =
      toolName === "tabs_context"
        ? "tabs_context_mcp"
        : toolName === "tabs_create"
          ? "tabs_create_mcp"
          : toolName === "tabs_close"
            ? "tabs_close_mcp"
            : toolName;

    if (normalizedName === "tabs_context_mcp") {
      this.tabGroups.clearSessionStop(scope.sessionId);
    } else if (this.tabGroups.isSessionStopped(scope.sessionId)) {
      this.tabGroups.clearSessionStop(scope.sessionId);
      return textResult(
        "Agent execution was stopped by the user via the in-page Stop button.",
        true
      );
    }

    await this.tabGroups.setGroupWorkingState(scope.sessionId, true);
    try {
      switch (normalizedName) {
        case "tabs_context_mcp":
          return await this.handleTabsContext(args, scope);
        case "tabs_create_mcp":
          return await this.handleTabsCreate(scope);
        case "tabs_close_mcp":
          return await this.handleTabsClose(args, scope);
        case "navigate":
          return await this.handleNavigate(args, scope);
        case "read_page":
          return await this.handleReadPage(args, scope);
        case "find":
          return await this.handleFind(args, scope);
        case "form_input":
          return await this.handleFormInput(args, scope);
        case "computer":
          return await this.handleComputer(args, scope);
        case "javascript_tool":
          return await this.handleJavaScriptTool(args, scope);
        case "get_page_text":
          return await this.handleGetPageText(args, scope);
        case "read_console_messages":
          return await this.handleReadConsoleMessages(args, scope);
        case "read_network_requests":
          return await this.handleReadNetworkRequests(args, scope);
        case "resize_window":
          return await this.handleResizeWindow(args, scope);
        case "upload_image":
          return await this.handleUploadImage(args, scope);
        case "file_upload":
          return await this.handleFileUpload(args, scope);
        case "gif_creator":
          return await this.handleGifCreator(args, scope);
        default:
          return textResult(`Unknown browser tool: "${toolName}".`, true);
      }
    } catch (err) {
      return textResult(
        `Tool "${toolName}" failed: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      await this.tabGroups.setGroupWorkingState(scope.sessionId, false);
    }
  }
}
