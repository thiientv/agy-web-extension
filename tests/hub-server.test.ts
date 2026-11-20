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

  it("keeps multiple Chrome profiles connected simultaneously without evicting each other and routes sessions to their selected profile", async () => {
    const hub = new BridgeHubServer({ host: "127.0.0.1", port: 0, extensionWaitMs: 300 });
    const port = await hub.start();
    cleanups.push(() => hub.stop());

    const connectMockProfile = async (opts: {
      profileId: string;
      profileName: string;
      profileEmail?: string;
      lastFocusedAt: number;
    }): Promise<{
      socket: WebSocket;
      received: ExtensionInboundMessage[];
      closed: { value: boolean };
    }> => {
      const received: ExtensionInboundMessage[] = [];
      const closed = { value: false };
      const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => {
          socket.send(
            JSON.stringify({
              type: "extension_hello",
              extensionVersion: "1.0.0",
              browserName: "Chromium",
              profileId: opts.profileId,
              profileName: opts.profileName,
              ...(opts.profileEmail ? { profileEmail: opts.profileEmail } : {}),
              lastFocusedAt: opts.lastFocusedAt
            })
          );
          resolve();
        });
        socket.once("error", reject);
      });
      socket.on("close", () => {
        closed.value = true;
      });
      socket.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as ExtensionInboundMessage;
        received.push(msg);
        if (msg.type === "tool_call") {
          socket.send(
            JSON.stringify({
              type: "tool_result",
              toolUseId: msg.toolUseId,
              result: {
                content: [
                  {
                    type: "text",
                    text: `${opts.profileId}:${msg.sessionScope.sessionId}:${msg.toolName}:active=${msg.sessionScope.activeProfile?.profileName}:count=${msg.sessionScope.connectedProfiles?.length ?? 0}`
                  }
                ]
              }
            })
          );
        }
      });
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            socket.once("close", () => resolve());
            socket.close();
            setTimeout(resolve, 100);
          })
      );
      return { socket, received, closed };
    };

    const work = await connectMockProfile({
      profileId: "prof_work",
      profileName: "work",
      profileEmail: "dev@company.com",
      lastFocusedAt: 1000
    });
    const personal = await connectMockProfile({
      profileId: "prof_personal",
      profileName: "personal",
      profileEmail: "me@gmail.com",
      lastFocusedAt: 2000
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(work.closed.value).toBe(false);
    expect(personal.closed.value).toBe(false);

    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    const healthJson = (await healthRes.json()) as {
      ok: boolean;
      extensionConnected: boolean;
      connectedProfiles: Array<{ profileId: string; profileName: string }>;
    };
    expect(healthJson.ok).toBe(true);
    expect(healthJson.extensionConnected).toBe(true);
    expect(healthJson.connectedProfiles.map((p) => p.profileId)).toEqual([
      "prof_personal",
      "prof_work"
    ]);

    const clientWork = new McpBridgeClient({
      host: "127.0.0.1",
      port,
      sessionId: "sess_work",
      autoSpawnDaemon: false
    });
    const clientPersonal = new McpBridgeClient({
      host: "127.0.0.1",
      port,
      sessionId: "sess_personal",
      autoSpawnDaemon: false
    });
    const clientDefault = new McpBridgeClient({
      host: "127.0.0.1",
      port,
      sessionId: "sess_default",
      autoSpawnDaemon: false
    });
    const clientPreferred = new McpBridgeClient({
      host: "127.0.0.1",
      port,
      sessionId: "sess_pref",
      preferredProfile: "dev@company.com",
      autoSpawnDaemon: false
    });
    cleanups.push(
      () => clientWork.close(),
      () => clientPersonal.close(),
      () => clientDefault.close(),
      () => clientPreferred.close()
    );

    const [resWorkCtx, resPersonalCtx, resDefaultCtx, resPrefCtx] = await Promise.all([
      clientWork.callTool("tabs_context_mcp", { profile: "work", createIfEmpty: true }),
      clientPersonal.callTool("tabs_context_mcp", { profile: "personal", createIfEmpty: true }),
      clientDefault.callTool("tabs_context_mcp", { createIfEmpty: true }),
      clientPreferred.callTool("tabs_context_mcp", { createIfEmpty: true })
    ]);

    expect(resWorkCtx.content[0]).toEqual({
      type: "text",
      text: "prof_work:sess_work:tabs_context_mcp:active=work:count=2"
    });
    expect(resPersonalCtx.content[0]).toEqual({
      type: "text",
      text: "prof_personal:sess_personal:tabs_context_mcp:active=personal:count=2"
    });
    expect(resDefaultCtx.content[0]).toEqual({
      type: "text",
      text: "prof_personal:sess_default:tabs_context_mcp:active=personal:count=2"
    });
    expect(resPrefCtx.content[0]).toEqual({
      type: "text",
      text: "prof_work:sess_pref:tabs_context_mcp:active=work:count=2"
    });

    // Subsequent calls without `profile` stay pinned to each session's bound profile.
    const [navWork, navPersonal] = await Promise.all([
      clientWork.callTool("navigate", { tabId: 1, url: "https://work.example" }),
      clientPersonal.callTool("navigate", { tabId: 2, url: "https://personal.example" })
    ]);
    expect(navWork.content[0]).toEqual({
      type: "text",
      text: "prof_work:sess_work:navigate:active=work:count=2"
    });
    expect(navPersonal.content[0]).toEqual({
      type: "text",
      text: "prof_personal:sess_personal:navigate:active=personal:count=2"
    });

    // Switching profile notifies the old profile via peer_disconnected and binds to the new one.
    const switched = await clientWork.callTool("tabs_context_mcp", { profile: "personal" });
    expect(switched.content[0]).toEqual({
      type: "text",
      text: "prof_personal:sess_work:tabs_context_mcp:active=personal:count=2"
    });
    expect(
      work.received.some((m) => m.type === "peer_disconnected" && m.sessionId === "sess_work")
    ).toBe(true);

    // Unknown profile returns an informative error listing connected profiles.
    const unknownRes = await clientWork.callTool("tabs_context_mcp", { profile: "nonexistent" });
    expect(unknownRes.isError).toBe(true);
    const errBlock = unknownRes.content[0];
    if (errBlock && errBlock.type === "text") {
      expect(errBlock.text).toContain("nonexistent");
      expect(errBlock.text).toContain("work");
      expect(errBlock.text).toContain("personal");
    }

    // Reconnecting with the same profileId replaces only that profile's socket, not the other profile.
    const workReconnect = await connectMockProfile({
      profileId: "prof_work",
      profileName: "work",
      profileEmail: "dev@company.com",
      lastFocusedAt: 3000
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(work.closed.value).toBe(true);
    expect(workReconnect.closed.value).toBe(false);
    expect(personal.closed.value).toBe(false);
  });
});
