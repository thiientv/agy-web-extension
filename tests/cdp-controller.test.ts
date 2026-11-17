import { describe, expect, it, vi } from "vitest";
import { CdpController, type CdpTransport } from "../src/extension/cdp-controller.js";

describe("CdpController", () => {
  function createFakeTransport(): {
    transport: CdpTransport;
    commands: Array<{ tabId: number; method: string; params?: Record<string, unknown> }>;
    muteCalls: Array<{ tabId: number; muted: boolean }>;
    emitEvent: (tabId: number, method: string, params: Record<string, unknown>) => void;
  } {
    const commands: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = [];
    const muteCalls: Array<{ tabId: number; muted: boolean }> = [];
    const attached = new Set<number>();
    let eventListener:
      | ((tabId: number, method: string, params: Record<string, unknown>) => void)
      | null = null;

    const transport: CdpTransport = {
      attach: vi.fn(async (tabId) => {
        attached.add(tabId);
      }),
      detach: vi.fn(async (tabId) => {
        attached.delete(tabId);
      }),
      sendCommand: vi.fn(async (tabId, method, params) => {
        commands.push({ tabId, method, params });
        return {};
      }),
      getTabState: vi.fn(async (tabId) => ({
        id: tabId,
        active: false,
        windowFocused: true,
        windowState: "normal",
        audible: false,
        muted: false,
        mutedByExtension: false,
        url: "https://example.com/app"
      })),
      setTabMuted: vi.fn(async (tabId, muted) => {
        muteCalls.push({ tabId, muted });
      }),
      onEvent: (cb) => {
        eventListener = cb;
      },
      onDetach: () => {
        // noop in unit mock
      }
    };

    return {
      transport,
      commands,
      muteCalls,
      emitEvent: (tabId, method, params) => {
        eventListener?.(tabId, method, params);
      }
    };
  }

  it("enables focus emulation and mutes background tab on attach, and restores both on detach", async () => {
    const { transport, commands, muteCalls } = createFakeTransport();
    const cdp = new CdpController(transport);

    await cdp.ensureAttached(101);
    expect(commands).toContainEqual({
      tabId: 101,
      method: "Emulation.setFocusEmulationEnabled",
      params: { enabled: true }
    });
    expect(muteCalls).toContainEqual({ tabId: 101, muted: true });

    await cdp.detachTab(101);
    expect(commands).toContainEqual({
      tabId: 101,
      method: "Emulation.setFocusEmulationEnabled",
      params: { enabled: false }
    });
    expect(muteCalls).toContainEqual({ tabId: 101, muted: false });
  });

  it("records console messages and redacted network requests per tab", async () => {
    const { transport, emitEvent } = createFakeTransport();
    const cdp = new CdpController(transport);
    await cdp.ensureAttached(202);

    emitEvent(202, "Runtime.consoleAPICalled", {
      type: "error",
      args: [{ value: "Failed to load widget" }],
      timestamp: 1000
    });
    emitEvent(202, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "Debug heartbeat" }],
      timestamp: 1001
    });

    emitEvent(202, "Network.requestWillBeSent", {
      requestId: "req_1",
      request: {
        url: "https://api.example.com/v1/profile?access_token=topsecret&id=7",
        method: "GET"
      },
      type: "Fetch"
    });
    emitEvent(202, "Network.responseReceived", {
      requestId: "req_1",
      response: {
        status: 200,
        statusText: "OK"
      }
    });

    const errorsOnly = cdp.readConsoleMessages(202, { onlyErrors: true });
    expect(errorsOnly).toHaveLength(1);
    expect(errorsOnly[0]?.text).toContain("Failed to load widget");

    const net = cdp.readNetworkRequests(202, { urlPattern: "/v1/profile" });
    expect(net).toHaveLength(1);
    expect(net[0]?.url).toContain("access_token=REDACTED");
    expect(net[0]?.url).not.toContain("topsecret");
    expect(net[0]?.status).toBe(200);
  });
});
