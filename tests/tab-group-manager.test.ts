import { describe, expect, it, vi } from "vitest";
import { TabGroupManager, type ChromeTabsEnvironment } from "../src/extension/tab-group-manager.js";

describe("TabGroupManager", () => {
  function createFakeChromeEnv(): {
    env: ChromeTabsEnvironment;
    createdTabs: Array<{ id: number; windowId: number; url: string; active: boolean; groupId: number }>;
    updatedGroups: Array<{ groupId: number; title?: string; color?: string }>;
    tabActiveUpdates: number;
  } {
    let nextTabId = 100;
    let nextGroupId = 500;
    const createdTabs: Array<{
      id: number;
      windowId: number;
      url: string;
      active: boolean;
      groupId: number;
    }> = [
      {
        id: 1,
        windowId: 10,
        url: "https://user-work-tab.example.com",
        active: true,
        groupId: -1
      }
    ];
    const groups = new Map<number, { id: number; windowId: number; title: string; color: string }>();
    const updatedGroups: Array<{ groupId: number; title?: string; color?: string }> = [];
    let tabActiveUpdates = 0;

    const env: ChromeTabsEnvironment = {
      tabGroupIdNone: -1,
      getLastFocusedWindow: vi.fn(async () => ({ id: 10, focused: true, state: "normal" })),
      createWindow: vi.fn(async (opts) => {
        const id = ++nextTabId;
        createdTabs.push({
          id,
          windowId: 20,
          url: opts.url,
          active: false,
          groupId: -1
        });
        return { id: 20, tabId: id };
      }),
      createTab: vi.fn(async (opts) => {
        const id = ++nextTabId;
        const rec = {
          id,
          windowId: opts.windowId,
          url: opts.url,
          active: opts.active,
          groupId: -1
        };
        createdTabs.push(rec);
        return { id, windowId: opts.windowId, url: opts.url, title: "New Tab", groupId: -1 };
      }),
      getTab: vi.fn(async (tabId) => {
        const found = createdTabs.find((t) => t.id === tabId);
        if (!found) {
          throw new Error(`No tab ${tabId}`);
        }
        return {
          id: found.id,
          windowId: found.windowId,
          url: found.url,
          title: "Tab",
          groupId: found.groupId,
          active: found.active
        };
      }),
      queryTabsByGroup: vi.fn(async (groupId) =>
        createdTabs
          .filter((t) => t.groupId === groupId)
          .map((t) => ({
            id: t.id,
            windowId: t.windowId,
            url: t.url,
            title: "Tab",
            groupId: t.groupId,
            active: t.active
          }))
      ),
      removeTab: vi.fn(async (tabId) => {
        const idx = createdTabs.findIndex((t) => t.id === tabId);
        if (idx !== -1) {
          createdTabs.splice(idx, 1);
        }
      }),
      groupTab: vi.fn(async (tabId, groupId, windowId) => {
        const gid = groupId ?? ++nextGroupId;
        const found = createdTabs.find((t) => t.id === tabId);
        if (found) {
          found.groupId = gid;
        }
        if (!groups.has(gid)) {
          groups.set(gid, { id: gid, windowId: windowId ?? 10, title: "", color: "orange" });
        }
        return gid;
      }),
      getTabGroup: vi.fn(async (groupId) => {
        const g = groups.get(groupId);
        if (!g) {
          throw new Error(`No group ${groupId}`);
        }
        return g;
      }),
      updateTabGroup: vi.fn(async (groupId, props) => {
        const g = groups.get(groupId);
        if (!g) {
          throw new Error(`No group ${groupId}`);
        }
        if (props.title !== undefined) {
          g.title = props.title;
        }
        if (props.color !== undefined) {
          g.color = props.color;
        }
        updatedGroups.push({ groupId, ...props });
      }),
      sendMessageToTab: vi.fn(async () => ({ success: true }))
    };

    void tabActiveUpdates;
    return { env, createdTabs, updatedGroups, tabActiveUpdates };
  }

  it("creates session tab group with active:false without touching user's foreground tab", async () => {
    const { env, createdTabs, updatedGroups } = createFakeChromeEnv();
    const mgr = new TabGroupManager(env);

    const ctx = await mgr.getOrCreateSessionContext(
      { sessionId: "session_1", displayName: "Antigravity" },
      true
    );

    expect(ctx).not.toBeNull();
    expect(ctx?.availableTabs).toHaveLength(1);
    const agentTab = createdTabs.find((t) => t.id === ctx?.currentTabId);
    expect(agentTab?.active).toBe(false);
    expect(createdTabs[0]?.active).toBe(true);
    expect(updatedGroups.some((u) => u.title === "Antigravity")).toBe(true);
  });

  it("isolates tab groups across concurrent sessions and blocks cross-group tab access", async () => {
    const { env } = createFakeChromeEnv();
    const mgr = new TabGroupManager(env);

    const ctxA = await mgr.getOrCreateSessionContext(
      { sessionId: "sA", displayName: "Antigravity" },
      true
    );
    const ctxB = await mgr.getOrCreateSessionContext(
      { sessionId: "sB", displayName: "Antigravity" },
      true
    );

    expect(ctxA?.tabGroupId).not.toBe(ctxB?.tabGroupId);
    await expect(
      mgr.assertTabInSession(ctxB!.currentTabId, {
        sessionId: "sA",
        displayName: "Antigravity"
      })
    ).rejects.toThrow(/not in this session's MCP tab group/i);
  });
});
