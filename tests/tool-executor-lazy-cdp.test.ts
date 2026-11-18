import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CdpController, type CdpTransport } from "../src/extension/cdp-controller.js";
import {
  TabGroupManager,
  type ChromeTabsEnvironment
} from "../src/extension/tab-group-manager.js";
import { ToolExecutor } from "../src/extension/tool-executor.js";

interface FakeChromeGlobal {
  tabs: {
    update: (tabId: number, props: { url?: string; muted?: boolean }) => Promise<chrome.tabs.Tab>;
    get: (tabId: number) => Promise<chrome.tabs.Tab>;
    goBack: (tabId: number) => Promise<void>;
    goForward: (tabId: number) => Promise<void>;
  };
  scripting: {
    executeScript: (injection: {
      target: { tabId: number };
      files?: string[];
      args?: unknown[];
      func?: (...args: never[]) => unknown;
    }) => Promise<Array<{ result: unknown }>>;
  };
}

function createHarness(): {
  executor: ToolExecutor;
  cdp: CdpController;
  attachCalls: () => number;
  emitEvent: (tabId: number, method: string, params: Record<string, unknown>) => void;
  tabIdPromise: Promise<number>;
} {
  let tabUrl = "chrome://newtab/";
  const tabTitle = "Test Page";
  let attachCount = 0;
  let eventListener:
    | ((tabId: number, method: string, params: Record<string, unknown>) => void)
    | null = null;

  const env: ChromeTabsEnvironment = {
    tabGroupIdNone: -1,
    getLastFocusedWindow: vi.fn(async () => ({ id: 10, focused: true, state: "normal" })),
    createWindow: vi.fn(async () => ({ id: 10, tabId: 101 })),
    createTab: vi.fn(async (opts) => {
      tabUrl = opts.url;
      return {
        id: 101,
        windowId: opts.windowId,
        url: tabUrl,
        title: tabTitle,
        groupId: -1,
        active: false
      };
    }),
    getTab: vi.fn(async (id) => ({
      id,
      windowId: 10,
      url: tabUrl,
      title: tabTitle,
      groupId: 501,
      active: false
    })),
    queryTabsByGroup: vi.fn(async () => [
      {
        id: 101,
        windowId: 10,
        url: tabUrl,
        title: tabTitle,
        groupId: 501,
        active: false
      }
    ]),
    removeTab: vi.fn(async () => undefined),
    groupTab: vi.fn(async () => 501),
    getTabGroup: vi.fn(async (gid) => ({
      id: gid,
      windowId: 10,
      title: "Antigravity",
      color: "orange"
    })),
    updateTabGroup: vi.fn(async () => undefined),
    sendMessageToTab: vi.fn(async () => ({ success: true }))
  };

  const transport: CdpTransport = {
    attach: vi.fn(async () => {
      attachCount += 1;
    }),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => ({})),
    getTabState: vi.fn(async (id) => ({
      id,
      active: false,
      windowFocused: true,
      windowState: "normal",
      audible: false,
      muted: false,
      mutedByExtension: false,
      url: tabUrl
    })),
    setTabMuted: vi.fn(async () => undefined),
    onEvent: (cb) => {
      eventListener = cb;
    },
    onDetach: () => undefined
  };

  const buildChromeTab = (id: number): chrome.tabs.Tab => ({
    id,
    windowId: 10,
    url: tabUrl,
    title: tabTitle,
    status: "complete",
    groupId: 501,
    index: 1,
    pinned: false,
    highlighted: false,
    active: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false
  });

  const fakeChrome: FakeChromeGlobal = {
    tabs: {
      update: vi.fn(
        async (
          id: number,
          props: { url?: string; muted?: boolean }
        ): Promise<chrome.tabs.Tab> => {
          if (props.url) {
            tabUrl = props.url;
          }
          return buildChromeTab(id);
        }
      ),
      get: vi.fn(async (id: number): Promise<chrome.tabs.Tab> => buildChromeTab(id)),
      goBack: vi.fn(async () => undefined),
      goForward: vi.fn(async () => undefined)
    },
    scripting: {
      executeScript: vi.fn(
        async (injection: {
          target: { tabId: number };
          files?: string[];
          args?: unknown[];
          func?: (...args: never[]) => unknown;
        }): Promise<Array<{ result: unknown }>> => {
          if (!injection.args || injection.args.length === 0) {
            return [{ result: true }];
          }
          if (typeof injection.args[1] === "boolean") {
            return [{ result: { ok: true, x: 240, y: 180, tagName: "input" } }];
          }
          return [{ result: { ok: true, message: "Updated input [ref_1] value." } }];
        }
      )
    }
  };

  vi.stubGlobal("chrome", fakeChrome);

  const tabGroups = new TabGroupManager(env);
  const cdp = new CdpController(transport);
  const executor = new ToolExecutor(tabGroups, cdp);
  const scope = { sessionId: "session_lazy", displayName: "Antigravity" };

  const tabIdPromise = tabGroups
    .getOrCreateSessionContext(scope, true)
    .then((ctx) => ctx!.currentTabId);

  return {
    executor,
    cdp,
    attachCalls: () => attachCount,
    emitEvent: (tabId, method, params) => {
      eventListener?.(tabId, method, params);
    },
    tabIdPromise
  };
}

describe("ToolExecutor lazy CDP attachment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not attach chrome.debugger for standard navigate, form_input, or computer(scroll_to)", async () => {
    const { executor, attachCalls, tabIdPromise } = createHarness();
    const tabId = await tabIdPromise;
    const scope = { sessionId: "session_lazy", displayName: "Antigravity" };

    const navRes = await executor.executeTool(
      "navigate",
      { tabId, url: "https://example.com/dashboard" },
      scope
    );
    expect(navRes.isError).toBeUndefined();
    expect(attachCalls()).toBe(0);

    const formRes = await executor.executeTool(
      "form_input",
      { tabId, ref: "ref_1", value: "hello" },
      scope
    );
    expect(formRes.isError).toBeUndefined();
    expect(attachCalls()).toBe(0);

    const scrollRes = await executor.executeTool(
      "computer",
      { tabId, action: "scroll_to", ref: "ref_1" },
      scope
    );
    expect(scrollRes.isError).toBeUndefined();
    expect(attachCalls()).toBe(0);
  });

  it("attaches chrome.debugger when navigate is called with force: true on an active http(s) page", async () => {
    const { executor, attachCalls, tabIdPromise } = createHarness();
    const tabId = await tabIdPromise;
    const scope = { sessionId: "session_lazy", displayName: "Antigravity" };

    await executor.executeTool("navigate", { tabId, url: "https://example.com/editor" }, scope);
    expect(attachCalls()).toBe(0);

    const navRes = await executor.executeTool(
      "navigate",
      { tabId, url: "https://example.com/unsaved", force: true },
      scope
    );
    expect(navRes.isError).toBeUndefined();
    expect(attachCalls()).toBe(1);
  });

  it("reads buffered console and network entries after detach without re-attaching chrome.debugger", async () => {
    const { executor, cdp, attachCalls, emitEvent, tabIdPromise } = createHarness();
    const tabId = await tabIdPromise;
    const scope = { sessionId: "session_lazy", displayName: "Antigravity" };

    await executor.executeTool("navigate", { tabId, url: "https://example.com" }, scope);
    expect(attachCalls()).toBe(0);

    await cdp.ensureAttached(tabId);
    expect(attachCalls()).toBe(1);

    emitEvent(tabId, "Runtime.consoleAPICalled", {
      type: "error",
      args: [{ value: "WidgetBoom" }],
      timestamp: 100
    });
    emitEvent(tabId, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/api/ping", method: "GET" },
      type: "Fetch"
    });
    emitEvent(tabId, "Network.responseReceived", {
      requestId: "r1",
      response: { status: 200, statusText: "OK" }
    });

    await cdp.detachTab(tabId);

    const consoleRes = await executor.executeTool(
      "read_console_messages",
      { tabId, onlyErrors: true },
      scope
    );
    expect(consoleRes.isError).toBeUndefined();
    expect(attachCalls()).toBe(1);

    const netRes = await executor.executeTool(
      "read_network_requests",
      { tabId, urlPattern: "/api/ping" },
      scope
    );
    expect(netRes.isError).toBeUndefined();
    expect(attachCalls()).toBe(1);
  });
});
