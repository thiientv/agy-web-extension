import type { SessionScope } from "../protocol/messages.js";

export interface TabSummary {
  id: number;
  windowId: number;
  url: string;
  title: string;
  groupId: number;
  active?: boolean;
}

export interface SessionTabContext {
  tabGroupId: number;
  currentTabId: number;
  availableTabs: Array<{ id: number; title: string; url: string }>;
}

type ChromeTabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export interface ChromeTabsEnvironment {
  tabGroupIdNone: number;
  getLastFocusedWindow: () => Promise<{ id: number; focused: boolean; state: string } | null>;
  createWindow: (opts: { url: string }) => Promise<{ id: number; tabId: number }>;
  createTab: (opts: {
    windowId: number;
    url: string;
    active: boolean;
    openerTabId?: number;
    index?: number;
  }) => Promise<TabSummary>;
  getTab: (tabId: number) => Promise<TabSummary>;
  queryTabsByGroup: (groupId: number) => Promise<TabSummary[]>;
  removeTab: (tabId: number) => Promise<void>;
  groupTab: (tabId: number, groupId?: number, windowId?: number) => Promise<number>;
  getTabGroup: (
    groupId: number
  ) => Promise<{ id: number; windowId: number; title: string; color: string }>;
  updateTabGroup: (
    groupId: number,
    props: { title?: string; color?: ChromeTabGroupColor }
  ) => Promise<void>;
  sendMessageToTab: (tabId: number, payload: Record<string, unknown>) => Promise<unknown>;
}

const SESSION_GROUP_COLORS: ReadonlyArray<ChromeTabGroupColor> = [
  "orange",
  "blue",
  "purple",
  "cyan",
  "green",
  "pink",
  "yellow",
  "red",
  "grey"
];

interface ManagedSessionGroup {
  sessionId: string;
  displayName: string;
  chromeGroupId: number;
  color: ChromeTabGroupColor;
  lastTabId: number;
}

function createBrowserChromeTabsEnv(): ChromeTabsEnvironment {
  return {
    tabGroupIdNone: chrome.tabGroups.TAB_GROUP_ID_NONE,
    getLastFocusedWindow: async () => {
      try {
        const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
        if (win.id === undefined) {
          return null;
        }
        return {
          id: win.id,
          focused: Boolean(win.focused),
          state: win.state ?? "normal"
        };
      } catch {
        return null;
      }
    },
    createWindow: async ({ url }) => {
      const created = await chrome.windows.create({
        url,
        type: "normal",
        focused: false
      });
      const winId = created?.id;
      const firstTabId = created?.tabs?.[0]?.id;
      if (winId === undefined || firstTabId === undefined) {
        throw new Error("Failed to create Chrome window for MCP tab group.");
      }
      return { id: winId, tabId: firstTabId };
    },
    createTab: async (opts) => {
      const tab = await chrome.tabs.create({
        windowId: opts.windowId,
        url: opts.url,
        active: opts.active,
        ...(opts.openerTabId !== undefined ? { openerTabId: opts.openerTabId } : {}),
        ...(opts.index !== undefined ? { index: opts.index } : {})
      });
      if (tab.id === undefined) {
        throw new Error("Failed to create tab: Chrome returned no tab ID.");
      }
      return {
        id: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? tab.pendingUrl ?? opts.url,
        title: tab.title ?? "",
        groupId: tab.groupId,
        active: tab.active
      };
    },
    getTab: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      if (tab.id === undefined) {
        throw new Error(`Tab ${tabId} has no ID.`);
      }
      return {
        id: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? tab.pendingUrl ?? "",
        title: tab.title ?? "",
        groupId: tab.groupId,
        active: tab.active
      };
    },
    queryTabsByGroup: async (groupId) => {
      const tabs = await chrome.tabs.query({ groupId });
      return tabs
        .filter((t): t is chrome.tabs.Tab & { id: number } => t.id !== undefined)
        .map((t) => ({
          id: t.id,
          windowId: t.windowId,
          url: t.url ?? t.pendingUrl ?? "",
          title: t.title ?? "",
          groupId: t.groupId,
          active: t.active
        }));
    },
    removeTab: async (tabId) => {
      await chrome.tabs.remove(tabId);
    },
    groupTab: async (tabId, groupId, windowId) => {
      if (groupId !== undefined) {
        return chrome.tabs.group({ tabIds: [tabId], groupId });
      }
      return chrome.tabs.group({
        tabIds: [tabId],
        ...(windowId !== undefined ? { createProperties: { windowId } } : {})
      });
    },
    getTabGroup: async (groupId) => {
      const g = await chrome.tabGroups.get(groupId);
      return {
        id: g.id,
        windowId: g.windowId,
        title: g.title ?? "",
        color: g.color
      };
    },
    updateTabGroup: async (groupId, props) => {
      await chrome.tabGroups.update(groupId, props);
    },
    sendMessageToTab: async (tabId, payload) => {
      try {
        return await chrome.tabs.sendMessage(tabId, payload);
      } catch {
        return undefined;
      }
    }
  };
}

export class TabGroupManager {
  private readonly env: ChromeTabsEnvironment;
  private readonly sessions = new Map<string, ManagedSessionGroup>();
  private readonly stoppedSessions = new Set<string>();
  private colorCursor = 0;

  constructor(env?: ChromeTabsEnvironment) {
    this.env = env ?? createBrowserChromeTabsEnv();
  }

  private pickNextColor(): ChromeTabGroupColor {
    const color = SESSION_GROUP_COLORS[this.colorCursor % SESSION_GROUP_COLORS.length] ?? "orange";
    this.colorCursor += 1;
    return color;
  }

  private async verifyLiveGroup(managed: ManagedSessionGroup): Promise<TabSummary[] | null> {
    try {
      await this.env.getTabGroup(managed.chromeGroupId);
      const tabs = await this.env.queryTabsByGroup(managed.chromeGroupId);
      if (tabs.length === 0) {
        this.sessions.delete(managed.sessionId);
        return null;
      }
      return tabs;
    } catch {
      this.sessions.delete(managed.sessionId);
      return null;
    }
  }

  public isSessionStopped(sessionId: string): boolean {
    return this.stoppedSessions.has(sessionId);
  }

  public clearSessionStop(sessionId: string): void {
    this.stoppedSessions.delete(sessionId);
  }

  public async setGroupWorkingState(sessionId: string, working: boolean): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return;
    }
    const prefix = working ? "⌛" : "";
    try {
      await this.env.updateTabGroup(existing.chromeGroupId, {
        title: `${prefix}${existing.displayName}`
      });
    } catch {
      // Group may have been removed manually.
    }
  }

  public async markStopFromTab(tabId: number): Promise<string[]> {
    const matchedSessionIds: string[] = [];
    for (const [sessionId, group] of this.sessions.entries()) {
      const tabs = await this.verifyLiveGroup(group);
      if (tabs?.some((t) => t.id === tabId)) {
        this.stoppedSessions.add(sessionId);
        matchedSessionIds.push(sessionId);
        await this.setGroupWorkingState(sessionId, false);
        for (const t of tabs) {
          await this.env.sendMessageToTab(t.id, { type: "HIDE_AGENT_INDICATORS" });
        }
      }
    }
    return matchedSessionIds;
  }

  public async getOrCreateSessionContext(
    scope: SessionScope,
    createIfEmpty: boolean
  ): Promise<SessionTabContext | null> {
    const existing = this.sessions.get(scope.sessionId);
    if (existing) {
      const liveTabs = await this.verifyLiveGroup(existing);
      if (liveTabs && liveTabs.length > 0) {
        const currentTabId = liveTabs.some((t) => t.id === existing.lastTabId)
          ? existing.lastTabId
          : (liveTabs[0]?.id ?? existing.lastTabId);
        existing.lastTabId = currentTabId;
        return {
          tabGroupId: existing.chromeGroupId,
          currentTabId,
          availableTabs: liveTabs.map((t) => ({
            id: t.id,
            title: t.title,
            url: t.url
          }))
        };
      }
    }

    if (!createIfEmpty) {
      return null;
    }

    let windowId: number;
    let initialTabId: number;
    const focusedWin = await this.env.getLastFocusedWindow();
    if (focusedWin) {
      windowId = focusedWin.id;
      const createdTab = await this.env.createTab({
        windowId,
        url: "chrome://newtab/",
        active: false
      });
      initialTabId = createdTab.id;
    } else {
      const createdWin = await this.env.createWindow({ url: "chrome://newtab/" });
      windowId = createdWin.id;
      initialTabId = createdWin.tabId;
    }

    const chromeGroupId = await this.env.groupTab(initialTabId, undefined, windowId);
    const color = this.pickNextColor();
    const title = scope.displayName.trim() || "Antigravity";
    await this.env.updateTabGroup(chromeGroupId, { title, color });

    const managed: ManagedSessionGroup = {
      sessionId: scope.sessionId,
      displayName: title,
      chromeGroupId,
      color,
      lastTabId: initialTabId
    };
    this.sessions.set(scope.sessionId, managed);

    return {
      tabGroupId: chromeGroupId,
      currentTabId: initialTabId,
      availableTabs: [
        {
          id: initialTabId,
          title: "New Tab",
          url: "chrome://newtab/"
        }
      ]
    };
  }

  public async createTabInSessionGroup(scope: SessionScope): Promise<{
    newTabId: number;
    tabGroupId: number;
    availableTabs: Array<{ id: number; title: string; url: string }>;
  }> {
    const existing = this.sessions.get(scope.sessionId);
    if (!existing) {
      throw new Error(
        "No MCP tab group exists for this session. Call tabs_context_mcp with createIfEmpty: true first."
      );
    }

    const groupInfo = await this.env.getTabGroup(existing.chromeGroupId).catch(() => null);
    if (!groupInfo) {
      this.sessions.delete(scope.sessionId);
      throw new Error(
        "This session's MCP tab group no longer exists. Call tabs_context_mcp with createIfEmpty: true to create a new group."
      );
    }

    const created = await this.env.createTab({
      windowId: groupInfo.windowId,
      url: "chrome://newtab/",
      active: false
    });
    await this.env.groupTab(created.id, existing.chromeGroupId, groupInfo.windowId);
    existing.lastTabId = created.id;

    const tabs = await this.env.queryTabsByGroup(existing.chromeGroupId);
    return {
      newTabId: created.id,
      tabGroupId: existing.chromeGroupId,
      availableTabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url }))
    };
  }

  public async createBackgroundPopupTabs(
    openerTabId: number,
    urls: ReadonlyArray<string>
  ): Promise<number[]> {
    const createdIds: number[] = [];
    try {
      const opener = await this.env.getTab(openerTabId);
      for (const rawUrl of urls.slice(0, 3)) {
        if (!/^https?:/i.test(rawUrl)) {
          continue;
        }
        const created = await this.env.createTab({
          windowId: opener.windowId,
          url: rawUrl,
          active: false,
          openerTabId
        });
        if (opener.groupId !== this.env.tabGroupIdNone) {
          await this.env.groupTab(created.id, opener.groupId, opener.windowId);
        }
        createdIds.push(created.id);
      }
    } catch {
      // Ignore if opener tab disappeared.
    }
    return createdIds;
  }

  public async assertTabInSession(tabId: number, scope: SessionScope): Promise<TabSummary> {
    const existing = this.sessions.get(scope.sessionId);
    if (!existing) {
      throw new Error(
        "No MCP tab group initialized for this session. Call tabs_context_mcp with createIfEmpty: true first."
      );
    }
    const tab = await this.env.getTab(tabId).catch(() => null);
    if (!tab) {
      throw new Error(
        `Tab ${tabId} was not found. Call tabs_context_mcp to inspect active tabs in this group.`
      );
    }
    if (tab.groupId !== existing.chromeGroupId) {
      throw new Error(
        `Tab ${tabId} is not in this session's MCP tab group (${existing.chromeGroupId}). Call tabs_context_mcp to see valid tab IDs.`
      );
    }
    existing.lastTabId = tabId;
    return tab;
  }

  public async closeTabInSession(
    tabId: number,
    scope: SessionScope
  ): Promise<Array<{ id: number; title: string; url: string }>> {
    const existing = this.sessions.get(scope.sessionId);
    if (!existing) {
      throw new Error("No MCP tab group exists for this session.");
    }
    await this.assertTabInSession(tabId, scope);
    await this.env.removeTab(tabId);
    const remaining = await this.env
      .queryTabsByGroup(existing.chromeGroupId)
      .catch(() => [] as TabSummary[]);
    if (remaining.length === 0) {
      this.sessions.delete(scope.sessionId);
    } else if (existing.lastTabId === tabId && remaining[0]) {
      existing.lastTabId = remaining[0].id;
    }
    return remaining.map((t) => ({ id: t.id, title: t.title, url: t.url }));
  }

  public async showActiveVisualIndicator(
    tabId: number,
    cursorStep?: { label?: string; at?: { x: number; y: number }; rest?: boolean }
  ): Promise<void> {
    await this.env.sendMessageToTab(tabId, {
      type: "SHOW_AGENT_INDICATORS",
      ownerTabId: tabId,
      tag: {
        at: "bottom",
        openChat: false
      },
      ...(cursorStep ? { cursorStep } : {})
    });
  }

  public async movePhantomCursor(
    tabId: number,
    x: number,
    y: number,
    pressed: boolean,
    label?: string
  ): Promise<void> {
    if (label) {
      await this.env.sendMessageToTab(tabId, {
        type: "UPDATE_PHANTOM_CURSOR_STEP",
        cursorStep: { label, at: { x: Number.isNaN(x) ? 0 : x, y: Number.isNaN(y) ? 0 : y } }
      });
    }
    await this.env.sendMessageToTab(tabId, {
      type: "UPDATE_PHANTOM_CURSOR",
      x,
      y,
      pressed
    });
  }

  public async hideIndicatorForScreenshot(tabId: number): Promise<void> {
    await this.env.sendMessageToTab(tabId, {
      type: "HIDE_FOR_TOOL_USE",
      stayUp: true
    });
  }

  public async restoreIndicatorAfterScreenshot(tabId: number): Promise<void> {
    await this.env.sendMessageToTab(tabId, {
      type: "SHOW_AFTER_TOOL_USE"
    });
  }

  public getChromeGroupIdForSession(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.chromeGroupId;
  }

  public async cleanupSession(sessionId: string): Promise<number[]> {
    const existing = this.sessions.get(sessionId);
    this.stoppedSessions.delete(sessionId);
    if (!existing) {
      return [];
    }
    await this.setGroupWorkingState(sessionId, false);
    const tabs = await this.env
      .queryTabsByGroup(existing.chromeGroupId)
      .catch(() => [] as TabSummary[]);
    for (const t of tabs) {
      await this.env.sendMessageToTab(t.id, { type: "HIDE_AGENT_INDICATORS" });
    }
    return tabs.map((t) => t.id);
  }
}
