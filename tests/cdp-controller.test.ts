import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpController, type CdpTransport } from "../src/extension/cdp-controller.js";

describe("CdpController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createFakeTransport(): {
    transport: CdpTransport;
    attached: Set<number>;
    attachCount: (tabId: number) => number;
    detachCount: (tabId: number) => number;
    commands: Array<{ tabId: number; method: string; params?: Record<string, unknown> }>;
    muteCalls: Array<{ tabId: number; muted: boolean }>;
    emitEvent: (tabId: number, method: string, params: Record<string, unknown>) => void;
    emitDetach: (tabId: number) => void;
  } {
    const commands: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = [];
    const muteCalls: Array<{ tabId: number; muted: boolean }> = [];
    const attached = new Set<number>();
    const attachesByTab = new Map<number, number>();
    const detachesByTab = new Map<number, number>();
    let eventListener:
      | ((tabId: number, method: string, params: Record<string, unknown>) => void)
      | null = null;
    let detachListener: ((tabId: number) => void) | null = null;

    const transport: CdpTransport = {
      attach: vi.fn(async (tabId) => {
        attached.add(tabId);
        attachesByTab.set(tabId, (attachesByTab.get(tabId) ?? 0) + 1);
      }),
      detach: vi.fn(async (tabId) => {
        attached.delete(tabId);
        detachesByTab.set(tabId, (detachesByTab.get(tabId) ?? 0) + 1);
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
      onDetach: (cb) => {
        detachListener = cb;
      }
    };

    return {
      transport,
      attached,
      attachCount: (tabId) => attachesByTab.get(tabId) ?? 0,
      detachCount: (tabId) => detachesByTab.get(tabId) ?? 0,
      commands,
      muteCalls,
      emitEvent: (tabId, method, params) => {
        eventListener?.(tabId, method, params);
      },
      emitDetach: (tabId) => {
        attached.delete(tabId);
        detachListener?.(tabId);
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

  it("auto-detaches debugger after 5s of idle time and preserves recorded logs across re-attach", async () => {
    vi.useFakeTimers();
    const { transport, attached, attachCount, detachCount, muteCalls, emitEvent } =
      createFakeTransport();
    const cdp = new CdpController(transport);

    await cdp.sendCommand(303, "Input.insertText", { text: "hello" });
    expect(attached.has(303)).toBe(true);
    expect(attachCount(303)).toBe(1);

    emitEvent(303, "Runtime.consoleAPICalled", {
      type: "error",
      args: [{ value: "CapturedBeforeIdleDetach" }],
      timestamp: 2000
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(attached.has(303)).toBe(true);
    expect(detachCount(303)).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(attached.has(303)).toBe(false);
    expect(detachCount(303)).toBe(1);
    expect(muteCalls).toContainEqual({ tabId: 303, muted: false });

    const retainedLogs = cdp.readConsoleMessages(303, { onlyErrors: true });
    expect(retainedLogs).toHaveLength(1);
    expect(retainedLogs[0]?.text).toContain("CapturedBeforeIdleDetach");

    await cdp.sendCommand(303, "Input.insertText", { text: "again" });
    expect(attached.has(303)).toBe(true);
    expect(attachCount(303)).toBe(2);
  });

  it("resets the 5s idle timer when another CDP command runs before expiry", async () => {
    vi.useFakeTimers();
    const { transport, attached, detachCount } = createFakeTransport();
    const cdp = new CdpController(transport);

    await cdp.sendCommand(404, "Input.insertText", { text: "first" });
    await vi.advanceTimersByTimeAsync(3500);
    expect(attached.has(404)).toBe(true);

    await cdp.sendCommand(404, "Input.insertText", { text: "second" });
    await vi.advanceTimersByTimeAsync(3500);
    expect(attached.has(404)).toBe(true);
    expect(detachCount(404)).toBe(0);

    await vi.advanceTimersByTimeAsync(1500);
    expect(attached.has(404)).toBe(false);
    expect(detachCount(404)).toBe(1);
  });

  it("keeps debugger attached while withAttachedTab is in flight even past 5s, then detaches 5s after completion", async () => {
    vi.useFakeTimers();
    const { transport, attached, detachCount } = createFakeTransport();
    const cdp = new CdpController(transport);

    let finishOp: (() => void) | null = null;
    const opPromise = cdp.withAttachedTab(505, async () => {
      await new Promise<void>((resolve) => {
        finishOp = resolve;
      });
      return "done";
    });

    await vi.advanceTimersByTimeAsync(8000);
    expect(attached.has(505)).toBe(true);
    expect(detachCount(505)).toBe(0);

    finishOp!();
    await expect(opPromise).resolves.toBe("done");

    await vi.advanceTimersByTimeAsync(4999);
    expect(attached.has(505)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(attached.has(505)).toBe(false);
    expect(detachCount(505)).toBe(1);
  });

  it("clears pending idle timers and per-tab buffers on disposeTab", async () => {
    vi.useFakeTimers();
    const { transport, detachCount, emitEvent } = createFakeTransport();
    const cdp = new CdpController(transport);

    await cdp.ensureAttached(606);
    emitEvent(606, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "ephemeral" }],
      timestamp: 3000
    });

    await cdp.disposeTab(606);
    expect(detachCount(606)).toBe(1);
    expect(cdp.readConsoleMessages(606)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10000);
    expect(detachCount(606)).toBe(1);
  });
});
