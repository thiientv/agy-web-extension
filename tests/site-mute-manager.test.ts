import { describe, expect, it } from "vitest";
import {
  SiteMuteManager,
  normalizeSiteRule,
  urlMatchesSiteRule,
  type MutableTabSummary,
  type SiteMuteEnvironment
} from "../src/extension/site-mute-manager.js";

function createFakeEnv(initialTabs: MutableTabSummary[], initialSites: string[] = []): {
  env: SiteMuteEnvironment;
  tabs: Map<number, MutableTabSummary>;
  storedSites: string[];
  manualMutes: Array<{ tabId: number; muted: boolean }>;
} {
  const tabs = new Map<number, MutableTabSummary>();
  for (const t of initialTabs) {
    tabs.set(t.id, { ...t });
  }
  let storedSites = [...initialSites];
  const manualMutes: Array<{ tabId: number; muted: boolean }> = [];

  const env: SiteMuteEnvironment = {
    queryAllTabs: async () => [...tabs.values()].map((t) => ({ ...t })),
    getTab: async (tabId) => {
      const found = tabs.get(tabId);
      if (!found) {
        throw new Error(`Tab ${tabId} not found`);
      }
      return { ...found };
    },
    setTabMuted: async (tabId, muted) => {
      const found = tabs.get(tabId);
      if (found) {
        found.muted = muted;
      }
    },
    loadMutedSites: async () => [...storedSites],
    saveMutedSites: async (sites) => {
      storedSites = [...sites];
    },
    onManualTabMute: (tabId, muted) => {
      manualMutes.push({ tabId, muted });
    }
  };

  return {
    env,
    tabs,
    get storedSites() {
      return storedSites;
    },
    manualMutes
  };
}

describe("SiteMuteManager", () => {
  it("normalizes site rules and matches subdomains safely", () => {
    expect(normalizeSiteRule("https://www.youtube.com/watch?v=123")).toBe("www.youtube.com");
    expect(normalizeSiteRule("YOUTUBE.COM")).toBe("youtube.com");
    expect(normalizeSiteRule("   ")).toBeNull();

    expect(urlMatchesSiteRule("https://www.youtube.com/watch?v=1", "youtube.com")).toBe(true);
    expect(urlMatchesSiteRule("https://music.youtube.com/", "youtube.com")).toBe(true);
    expect(urlMatchesSiteRule("https://notyoutube.com/", "youtube.com")).toBe(false);
    expect(urlMatchesSiteRule("https://youtube.com/", "www.youtube.com")).toBe(false);
  });

  it("mutes and unmutes sites persistently and updates matching open tabs", async () => {
    const fake = createFakeEnv([
      { id: 1, url: "https://www.youtube.com/watch?v=abc", title: "YouTube", muted: false },
      { id: 2, url: "https://music.youtube.com/", title: "YT Music", muted: false },
      { id: 3, url: "https://example.com/", title: "Example", muted: false }
    ]);
    const manager = new SiteMuteManager(fake.env);

    const muteRes = await manager.muteSite("youtube.com");
    expect(muteRes.rule).toBe("youtube.com");
    expect(muteRes.updatedTabIds).toEqual([1, 2]);
    expect(fake.tabs.get(1)?.muted).toBe(true);
    expect(fake.tabs.get(2)?.muted).toBe(true);
    expect(fake.tabs.get(3)?.muted).toBe(false);
    expect(fake.storedSites).toEqual(["youtube.com"]);

    // New tab navigating to a muted site is automatically muted.
    fake.tabs.set(4, {
      id: 4,
      url: "https://m.youtube.com/feed",
      title: "Mobile YT",
      muted: false
    });
    const synced = await manager.syncTabMuteState(4, "https://m.youtube.com/feed");
    expect(synced).toBe(true);
    expect(fake.tabs.get(4)?.muted).toBe(true);

    // Unmuting site removes persistence and unmutes matching tabs.
    const unmuteRes = await manager.unmuteSite("https://youtube.com");
    expect(unmuteRes.removed).toBe(true);
    expect(unmuteRes.updatedTabIds).toEqual([1, 2, 4]);
    expect(fake.tabs.get(1)?.muted).toBe(false);
    expect(fake.tabs.get(2)?.muted).toBe(false);
    expect(fake.tabs.get(4)?.muted).toBe(false);
    expect(fake.storedSites).toEqual([]);
  });

  it("mutes/unmutes individual tabs and lists current state", async () => {
    const fake = createFakeEnv(
      [
        { id: 10, url: "https://example.com/audio", title: "Audio", muted: false },
        { id: 11, url: "https://www.youtube.com/", title: "YT", muted: false }
      ],
      ["youtube.com"]
    );
    const manager = new SiteMuteManager(fake.env);

    await manager.warmup();
    expect(fake.tabs.get(11)?.muted).toBe(true);
    expect(fake.tabs.get(10)?.muted).toBe(false);

    const mutedTab = await manager.setTabMuted(10, true);
    expect(mutedTab.muted).toBe(true);
    expect(fake.manualMutes).toContainEqual({ tabId: 10, muted: true });

    const listed = await manager.listState();
    expect(listed.mutedSites).toEqual(["youtube.com"]);
    expect(listed.mutedTabs.map((t) => t.id)).toEqual([10, 11]);
  });
});
