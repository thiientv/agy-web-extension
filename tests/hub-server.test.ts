import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { BridgeHubServer } from "../src/bridge/hub-server.js";
import { McpBridgeClient } from "../src/mcp/bridge-client.js";
import type { ExtensionInboundMessage } from "../src/protocol/messages.js";

describe("BridgeHubServer and McpBridgeClient", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) {
        await fn();
      }
    }
  });

  it("multiplexes tool calls from multiple concurrent agy MCP sessions to the Chrome extension and notifies on session disconnect", async () => {
    const hub = new BridgeHubServer({ host: "127.0.0.1", port: 0 });
    const port = await hub.start();
    cleanups.push(() => hub.stop());

    const extReceived: ExtensionInboundMessage[] = [];
    const extSocket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await new Promise<void>((resolve, reject) => {
      extSocket.once("open", () => {
        extSocket.send(
          JSON.stringify({
            type: "extension_hello",
            extensionVersion: "1.0.0",
            browserName: "Chromium"
          })
        );
        resolve();
      });
      extSocket.once("error", reject);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          extSocket.once("close", () => resolve());
          extSocket.close();
          setTimeout(resolve, 100);
        })
    );

    extSocket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as ExtensionInboundMessage;
      extReceived.push(msg);
      if (msg.type === "tool_call") {
        extSocket.send(
          JSON.stringify({
            type: "tool_result",
            toolUseId: msg.toolUseId,
            result: {
              content: [
                {
                  type: "text",
                  text: `ok:${msg.sessionScope.sessionId}:${msg.toolName}`
                }
              ]
            }
          })
        );
      }
    });

    const clientA = new McpBridgeClient({
      host: "127.0.0.1",
      port,
      sessionId: "session_A",
      displayName: "Antigravity A",
      autoSpawnDaemon: false
    });
    const clientB = new McpBridgeClient({
      host: "127.0.0.1",
      port,
      sessionId: "session_B",
      displayName: "Antigravity B",
      autoSpawnDaemon: false
    });
    cleanups.push(() => clientB.close());

    const [resA, resB] = await Promise.all([
      clientA.callTool("tabs_context_mcp", { createIfEmpty: true }),
      clientB.callTool("navigate", { tabId: 42, url: "https://example.com" })
    ]);

    expect(resA.content[0]).toEqual({
      type: "text",
      text: "ok:session_A:tabs_context_mcp"
    });
    expect(resB.content[0]).toEqual({
      type: "text",
      text: "ok:session_B:navigate"
    });

    await clientA.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const disconnectNotice = extReceived.find(
      (m) => m.type === "peer_disconnected" && m.sessionId === "session_A"
    );
    expect(disconnectNotice).toBeDefined();
  });

  it("returns a clear error result when no Chrome extension is connected", async () => {
    const hub = new BridgeHubServer({ host: "127.0.0.1", port: 0, extensionWaitMs: 150 });
    const port = await hub.start();
    cleanups.push(() => hub.stop());

    const client = new McpBridgeClient({
      host: "127.0.0.1",
      port,
      sessionId: "session_no_ext",
      displayName: "Antigravity",
      autoSpawnDaemon: false
    });
    cleanups.push(() => client.close());

    const res = await client.callTool("tabs_context_mcp", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({
      type: "text"
    });
    const first = res.content[0];
    if (first && first.type === "text") {
      expect(first.text).toContain("extension is not connected");
    }
  });
});
