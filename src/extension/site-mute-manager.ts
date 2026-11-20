export interface MutableTabSummary {
  id: number;
  url: string;
  title: string;
  muted: boolean;
}

export interface SiteMuteEnvironment {
  queryAllTabs: () => Promise<MutableTabSummary[]>;
  getTab: (tabId: number) => Promise<MutableTabSummary>;
  setTabMuted: (tabId: number, muted: boolean) => Promise<void>;
  loadMutedSites: () => Promise<string[]>;
  saveMutedSites: (sites: string[]) => Promise<void>;
  onManualTabMute?: (tabId: number, muted: boolean) => void;
}

const MUTED_SITES_STORAGE_KEY = "mutedSites";

function createBrowserSiteMuteEnv(
  onManualTabMute?: (tabId: number, muted: boolean) => void
): SiteMuteEnvironment {
  return {
    queryAllTabs: async () => {
      const tabs = await chrome.tabs.query({});
      const out: MutableTabSummary[] = [];
      for (const tab of tabs) {
        if (tab.id === undefined) {
          continue;
        }
        out.push({
          id: tab.id,
          url: tab.url ?? tab.pendingUrl ?? "",
          title: tab.title ?? "",
          muted: Boolean(tab.mutedInfo?.muted)
        });
      }
      return out;
    },
    getTab: async (tabId: number) => {
      const tab = await chrome.tabs.get(tabId);
      if (tab.id === undefined) {
        throw new Error(`Tab ${tabId} not found.`);
      }
      return {
        id: tab.id,
        url: tab.url ?? tab.pendingUrl ?? "",
        title: tab.title ?? "",
        muted: Boolean(tab.mutedInfo?.muted)
      };
    },
    setTabMuted: async (tabId: number, muted: boolean) => {
      await chrome.tabs.update(tabId, { muted });
    },
    loadMutedSites: async () => {
      try {
        const stored = await chrome.storage.local.get([MUTED_SITES_STORAGE_KEY]);
        const raw = stored[MUTED_SITES_STORAGE_KEY];
        if (!Array.isArray(raw)) {
          return [];
        }
        return raw.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      } catch {
        return [];
      }
    },
    saveMutedSites: async (sites: string[]) => {
      try {
        await chrome.storage.local.set({ [MUTED_SITES_STORAGE_KEY]: sites });
      } catch {
        // Ignore storage write errors.
      }
    },
    ...(onManualTabMute ? { onManualTabMute } : {})
  };
}

export function normalizeSiteRule(rawSite: string): string | null {
  const trimmed = rawSite.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
    return host || null;
  } catch {
    return null;
  }
}

export function urlMatchesSiteRule(url: string, normalizedRule: string): boolean {
  if (!url || !normalizedRule) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === normalizedRule || host.endsWith(`.${normalizedRule}`);
  } catch {
    return false;
  }
}

export class SiteMuteManager {
  private readonly env: SiteMuteEnvironment;
  private mutedSitesCache: string[] | null = null;
  private loadPromise: Promise<string[]> | null = null;

  constructor(env?: SiteMuteEnvironment, onManualTabMute?: (tabId: number, muted: boolean) => void) {
    this.env = env ?? createBrowserSiteMuteEnv(onManualTabMute);
  }

  private async ensureLoaded(): Promise<string[]> {
    if (this.mutedSitesCache !== null) {
      return this.mutedSitesCache;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.env.loadMutedSites().then((rawSites) => {
        const normalized = new Set<string>();
        for (const site of rawSites) {
          const rule = normalizeSiteRule(site);
          if (rule) {
            normalized.add(rule);
          }
        }
        this.mutedSitesCache = [...normalized];
        this.loadPromise = null;
        return this.mutedSitesCache;
      });
    }
    return this.loadPromise;
  }

  private async updateMatchingTabs(rule: string, muted: boolean): Promise<number[]> {
    const tabs = await this.env.queryAllTabs();
    const updatedTabIds: number[] = [];
    for (const tab of tabs) {
      if (!urlMatchesSiteRule(tab.url, rule)) {
        continue;
      }
      this.env.onManualTabMute?.(tab.id, muted);
      if (tab.muted !== muted) {
        await this.env.setTabMuted(tab.id, muted).catch(() => undefined);
      }
      updatedTabIds.push(tab.id);
    }
    return updatedTabIds;
  }

  public async warmup(): Promise<void> {
    const sites = await this.ensureLoaded();
    if (sites.length === 0) {
      return;
    }
    const tabs = await this.env.queryAllTabs();
    for (const tab of tabs) {
      if (sites.some((rule) => urlMatchesSiteRule(tab.url, rule))) {
        this.env.onManualTabMute?.(tab.id, true);
        if (!tab.muted) {
          await this.env.setTabMuted(tab.id, true).catch(() => undefined);
        }
      }
    }
  }

  public async isUrlMuted(url: string): Promise<boolean> {
    const sites = await this.ensureLoaded();
    return sites.some((rule) => urlMatchesSiteRule(url, rule));
  }

  public async syncTabMuteState(tabId: number, url: string): Promise<boolean> {
    if (!url) {
      return false;
    }
    const sites = await this.ensureLoaded();
    if (!sites.some((rule) => urlMatchesSiteRule(url, rule))) {
      return false;
    }
    this.env.onManualTabMute?.(tabId, true);
    await this.env.setTabMuted(tabId, true).catch(() => undefined);
    return true;
  }

  public async setTabMuted(tabId: number, muted: boolean): Promise<MutableTabSummary> {
    this.env.onManualTabMute?.(tabId, muted);
    await this.env.setTabMuted(tabId, muted);
    return this.env.getTab(tabId);
  }

  public async muteSite(rawSite: string): Promise<{ rule: string; updatedTabIds: number[] }> {
    const rule = normalizeSiteRule(rawSite);
    if (!rule) {
      throw new Error(`Invalid site or domain: "${rawSite}".`);
    }
    const sites = await this.ensureLoaded();
    if (!sites.includes(rule)) {
      sites.push(rule);
      await this.env.saveMutedSites([...sites]);
    }
    const updatedTabIds = await this.updateMatchingTabs(rule, true);
    return { rule, updatedTabIds };
  }

  public async unmuteSite(rawSite: string): Promise<{ rule: string; removed: boolean; updatedTabIds: number[] }> {
    const rule = normalizeSiteRule(rawSite);
    if (!rule) {
      throw new Error(`Invalid site or domain: "${rawSite}".`);
    }
    const sites = await this.ensureLoaded();
    const idx = sites.indexOf(rule);
    const removed = idx !== -1;
    if (removed) {
      sites.splice(idx, 1);
      await this.env.saveMutedSites([...sites]);
    }
    const updatedTabIds = await this.updateMatchingTabs(rule, false);
    return { rule, removed, updatedTabIds };
  }

  public async listState(): Promise<{ mutedSites: string[]; mutedTabs: MutableTabSummary[] }> {
    const [sites, tabs] = await Promise.all([this.ensureLoaded(), this.env.queryAllTabs()]);
    return {
      mutedSites: [...sites],
      mutedTabs: tabs.filter((tab) => tab.muted)
    };
  }
}
