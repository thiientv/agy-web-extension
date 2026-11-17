import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage
} from "../protocol/messages.js";
import { CdpController } from "./cdp-controller.js";
import { TabGroupManager } from "./tab-group-manager.js";
import { ToolExecutor } from "./tool-executor.js";

const BRIDGE_KEEPALIVE_ALARM = "agy-bridge-keepalive";

const tabGroups = new TabGroupManager();
const cdp = new CdpController();
const executor = new ToolExecutor(tabGroups, cdp);

let bridgeSocket: WebSocket | null = null;
let connecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

async function getBridgeEndpointUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(["bridgeUrl"]);
    if (typeof stored.bridgeUrl === "string" && stored.bridgeUrl.startsWith("ws://")) {
      return stored.bridgeUrl;
    }
  } catch {
    // Fallback to default local bridge URL.
  }
  return `ws://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}/extension`;
}

function sendOutbound(msg: ExtensionOutboundMessage): void {
  if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
    bridgeSocket.send(JSON.stringify(msg));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }
  reconnectAttempt += 1;
  const delay = Math.min(500 * Math.pow(1.4, Math.min(reconnectAttempt, 8)), 5000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectBridge();
  }, Math.round(delay));
}

async function handleInboundMessage(msg: ExtensionInboundMessage): Promise<void> {
  if (msg.type === "ping") {
    sendOutbound({ type: "pong" });
    return;
  }
  if (msg.type === "pong" || msg.type === "peer_connected") {
    return;
  }
  if (msg.type === "peer_disconnected") {
    const tabIds = await tabGroups.cleanupSession(msg.sessionId);
    for (const tabId of tabIds) {
      await cdp.detachTab(tabId).catch(() => undefined);
    }
    return;
  }
  if (msg.type === "tool_call") {
    const result = await executor.executeTool(msg.toolName, msg.args, msg.sessionScope);
    sendOutbound({
      type: "tool_result",
      toolUseId: msg.toolUseId,
      result
    });
  }
}

async function connectBridge(): Promise<void> {
  if (
    connecting ||
    (bridgeSocket &&
      (bridgeSocket.readyState === WebSocket.OPEN ||
        bridgeSocket.readyState === WebSocket.CONNECTING))
  ) {
    return;
  }

  connecting = true;
  try {
    const url = await getBridgeEndpointUrl();
    const ws = new WebSocket(url);
    bridgeSocket = ws;

    ws.onopen = () => {
      connecting = false;
      reconnectAttempt = 0;
      sendOutbound({
        type: "extension_hello",
        extensionVersion: chrome.runtime.getManifest().version,
        browserName: navigator.userAgent
      });
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as ExtensionInboundMessage;
        void handleInboundMessage(parsed);
      } catch {
        // Ignore malformed payloads.
      }
    };

    ws.onclose = () => {
      if (bridgeSocket === ws) {
        bridgeSocket = null;
      }
      connecting = false;
      scheduleReconnect();
    };

    ws.onerror = () => {
      connecting = false;
    };
  } catch {
    connecting = false;
    scheduleReconnect();
  }
}

async function ensureKeepaliveOffscreen(): Promise<void> {
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: "Maintain WebSocket bridge connection for Antigravity MCP automation."
      });
    }
  } catch {
    // Offscreen may already be active.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  void ensureKeepaliveOffscreen();
  void connectBridge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  void ensureKeepaliveOffscreen();
  void connectBridge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_KEEPALIVE_ALARM) {
    if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      sendOutbound({ type: "ping" });
    } else {
      void connectBridge();
    }
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }
  const msg = message as Record<string, unknown>;

  if (msg.type === "SW_KEEPALIVE") {
    if (!bridgeSocket || bridgeSocket.readyState === WebSocket.CLOSED) {
      void connectBridge();
    }
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === "STATIC_INDICATOR_HEARTBEAT") {
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === "STOP_AGENT") {
    const targetTabId =
      typeof msg.targetTabId === "number" ? msg.targetTabId : sender.tab?.id;
    if (targetTabId !== undefined) {
      void tabGroups.markStopFromTab(targetTabId).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === "SET_BRIDGE_URL" && typeof msg.bridgeUrl === "string") {
    void chrome.storage.local.set({ bridgeUrl: msg.bridgeUrl }).then(() => {
      if (bridgeSocket) {
        bridgeSocket.close(1000, "reconfigure");
        bridgeSocket = null;
      }
      void connectBridge();
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});

void ensureKeepaliveOffscreen();
void connectBridge();
