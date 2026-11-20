import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  type ConnectedProfileSummary,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type McpPeerInboundMessage,
  type McpPeerOutboundMessage,
  type McpToolCallResult
} from "../protocol/messages.js";

export interface BridgeHubOptions {
  host?: string;
  port?: number;
  extensionWaitMs?: number;
  toolTimeoutMs?: number;
}

interface ConnectedExtension {
  socket: WebSocket;
  profileId: string;
  profileName: string;
  profileEmail?: string;
  browserName: string;
  extensionVersion: string;
  connectedAt: number;
  lastFocusedAt: number;
}

interface ConnectedMcpPeer {
  socket: WebSocket;
  sessionId: string;
  displayName: string;
  preferredProfile?: string;
  boundProfileId: string | null;
}

interface PendingToolCall {
  peer: ConnectedMcpPeer;
  profileId: string;
  timer: NodeJS.Timeout;
}

interface ExtensionWaiter {
  check: () => ConnectedExtension | null;
  resolve: (ext: ConnectedExtension | null) => void;
  timer: NodeJS.Timeout;
}

type ProfileMatchResult =
  | { extension: ConnectedExtension }
  | { error: string };

function toProfileSummary(ext: ConnectedExtension): ConnectedProfileSummary {
  return {
    profileId: ext.profileId,
    profileName: ext.profileName,
    ...(ext.profileEmail ? { profileEmail: ext.profileEmail } : {}),
    browserName: ext.browserName,
    extensionVersion: ext.extensionVersion,
    connectedAt: ext.connectedAt,
    lastFocusedAt: ext.lastFocusedAt
  };
}

function formatProfileList(profiles: ConnectedProfileSummary[]): string {
  if (profiles.length === 0) {
    return "none";
  }
  return profiles
    .map((p) => {
      const emailPart = p.profileEmail ? `, email=${p.profileEmail}` : "";
      return `${p.profileName} (id=${p.profileId}${emailPart})`;
    })
    .join("; ");
}

function isContextToolName(toolName: string): boolean {
  return toolName === "tabs_context_mcp" || toolName === "tabs_context";
}

function matchProfileExact(ext: ConnectedExtension, normalizedQuery: string): boolean {
  if (ext.profileId.toLowerCase() === normalizedQuery) {
    return true;
  }
  if (ext.profileName.toLowerCase() === normalizedQuery) {
    return true;
  }
  if (ext.profileEmail && ext.profileEmail.toLowerCase() === normalizedQuery) {
    return true;
  }
  return false;
}

function matchProfileSubstring(ext: ConnectedExtension, normalizedQuery: string): boolean {
  if (ext.profileId.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  if (ext.profileName.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  if (ext.profileEmail && ext.profileEmail.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  return false;
}

export class BridgeHubServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly extensionWaitMs: number;
  private readonly toolTimeoutMs: number;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly extensions = new Map<string, ConnectedExtension>();
  private readonly socketToProfileId = new Map<WebSocket, string>();
  private readonly extensionWaiters: ExtensionWaiter[] = [];
  private readonly peers = new Map<WebSocket, ConnectedMcpPeer>();
  private readonly pendingCalls = new Map<string, PendingToolCall>();
  private pingInterval: NodeJS.Timeout | null = null;
  private boundPort = 0;

  constructor(options: BridgeHubOptions = {}) {
    this.host = options.host ?? DEFAULT_BRIDGE_HOST;
    this.requestedPort = options.port ?? DEFAULT_BRIDGE_PORT;
    this.extensionWaitMs = options.extensionWaitMs ?? 4000;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 90000;
  }

  private getOpenExtensions(): ConnectedExtension[] {
    const open: ConnectedExtension[] = [];
    for (const ext of this.extensions.values()) {
      if (ext.socket.readyState === WebSocket.OPEN) {
        open.push(ext);
      }
    }
    return open;
  }

  private listConnectedProfileSummaries(): ConnectedProfileSummary[] {
    return this.getOpenExtensions()
      .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.connectedAt - a.connectedAt)
      .map(toProfileSummary);
  }

  private countPeersForProfile(profileId: string): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.boundProfileId === profileId) {
        count += 1;
      }
    }
    return count;
  }

  private sendToExtension(ext: ConnectedExtension, msg: ExtensionInboundMessage): boolean {
    if (ext.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    ext.socket.send(JSON.stringify(msg));
    return true;
  }

  private sendToPeer(peer: ConnectedMcpPeer, msg: McpPeerInboundMessage): void {
    if (peer.socket.readyState === WebSocket.OPEN) {
      peer.socket.send(JSON.stringify(msg));
    }
  }

  private notifyExtensionWaiters(): void {
    for (let i = this.extensionWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.extensionWaiters[i];
      if (!waiter) {
        continue;
      }
      const matched = waiter.check();
      if (matched) {
        this.extensionWaiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(matched);
      }
    }
  }

  private waitForExtension(
    check: () => ConnectedExtension | null
  ): Promise<ConnectedExtension | null> {
    const immediate = check();
    if (immediate) {
      return Promise.resolve(immediate);
    }
    if (this.extensionWaitMs <= 0) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter: ExtensionWaiter = {
        check,
        resolve,
        timer: setTimeout(() => {
          const idx = this.extensionWaiters.indexOf(waiter);
          if (idx !== -1) {
            this.extensionWaiters.splice(idx, 1);
          }
          resolve(check());
        }, this.extensionWaitMs)
      };
      this.extensionWaiters.push(waiter);
    });
  }

  private failPendingCallsForProfile(profileId: string, message: string): void {
    const entries = [...this.pendingCalls.entries()];
    for (const [toolUseId, pending] of entries) {
      if (pending.profileId !== profileId) {
        continue;
      }
      this.pendingCalls.delete(toolUseId);
      clearTimeout(pending.timer);
      this.sendToPeer(pending.peer, {
        type: "mcp_tool_result",
        toolUseId,
        result: {
          isError: true,
          content: [{ type: "text", text: message }]
        }
      });
    }
  }

  private failAllPendingCalls(message: string): void {
    const entries = [...this.pendingCalls.entries()];
    this.pendingCalls.clear();
    for (const [toolUseId, pending] of entries) {
      clearTimeout(pending.timer);
      this.sendToPeer(pending.peer, {
        type: "mcp_tool_result",
        toolUseId,
        result: {
          isError: true,
          content: [{ type: "text", text: message }]
        }
      });
    }
  }

  private resolveExtensionByQuery(query: string): ProfileMatchResult {
    const open = this.getOpenExtensions();
    const normalized = query.trim().toLowerCase();
    const exactMatches = open.filter((ext) => matchProfileExact(ext, normalized));
    if (exactMatches.length === 1 && exactMatches[0]) {
      return { extension: exactMatches[0] };
    }
    if (exactMatches.length > 1) {
      return {
        error: `Profile selector "${query}" matched multiple connected Chrome profiles: ${formatProfileList(
          exactMatches.map(toProfileSummary)
        )}. Specify the exact profileId to disambiguate.`
      };
    }

    const partialMatches = open.filter((ext) => matchProfileSubstring(ext, normalized));
    if (partialMatches.length === 1 && partialMatches[0]) {
      return { extension: partialMatches[0] };
    }
    if (partialMatches.length > 1) {
      return {
        error: `Profile selector "${query}" is ambiguous and matched: ${formatProfileList(
          partialMatches.map(toProfileSummary)
        )}. Specify a more specific profile name, email, or profileId.`
      };
    }

    return {
      error: `Chrome profile "${query}" is not connected. Connected profiles: ${formatProfileList(
        this.listConnectedProfileSummaries()
      )}.`
    };
  }

  private pickDefaultExtension(): ConnectedExtension | null {
    const open = this.getOpenExtensions();
    if (open.length === 0) {
      return null;
    }
    open.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt || b.connectedAt - a.connectedAt);
    return open[0] ?? null;
  }

  private bindPeerToExtension(peer: ConnectedMcpPeer, targetExt: ConnectedExtension): void {
    const previousProfileId = peer.boundProfileId;
    if (previousProfileId === targetExt.profileId) {
      return;
    }
    peer.boundProfileId = targetExt.profileId;

    if (previousProfileId) {
      const prevExt = this.extensions.get(previousProfileId);
      if (prevExt && prevExt.socket.readyState === WebSocket.OPEN) {
        this.sendToExtension(prevExt, {
          type: "peer_disconnected",
          sessionId: peer.sessionId,
          remainingPeers: this.countPeersForProfile(previousProfileId)
        });
      }
    }

    this.sendToExtension(targetExt, {
      type: "peer_connected",
      sessionId: peer.sessionId,
      displayName: peer.displayName,
      activePeers: this.countPeersForProfile(targetExt.profileId)
    });
  }

  private handleExtensionHello(
    ws: WebSocket,
    msg: Extract<ExtensionOutboundMessage, { type: "extension_hello" }>
  ): void {
    const currentId = this.socketToProfileId.get(ws);
    if (!currentId) {
      return;
    }
    const ext = this.extensions.get(currentId);
    if (!ext || ext.socket !== ws) {
      return;
    }

    const nextId =
      typeof msg.profileId === "string" && msg.profileId.trim()
        ? msg.profileId.trim()
        : currentId;

    if (nextId !== currentId) {
      const existingSameProfile = this.extensions.get(nextId);
      if (existingSameProfile && existingSameProfile.socket !== ws) {
        this.socketToProfileId.delete(existingSameProfile.socket);
        this.failPendingCallsForProfile(
          nextId,
          "Chrome extension reconnected for this profile while executing tool call."
        );
        try {
          existingSameProfile.socket.close(1000, "replaced");
        } catch {
          // Ignore close error on stale socket.
        }
      }
      this.extensions.delete(currentId);
      ext.profileId = nextId;
      this.extensions.set(nextId, ext);
      this.socketToProfileId.set(ws, nextId);
    }

    ext.extensionVersion = msg.extensionVersion || ext.extensionVersion;
    ext.browserName = msg.browserName || ext.browserName;
    if (typeof msg.profileEmail === "string" && msg.profileEmail.trim()) {
      ext.profileEmail = msg.profileEmail.trim();
    }
    if (typeof msg.profileName === "string" && msg.profileName.trim()) {
      ext.profileName = msg.profileName.trim();
    } else if (!ext.profileName || ext.profileName === currentId) {
      ext.profileName = ext.profileEmail || ext.profileId;
    }
    if (typeof msg.lastFocusedAt === "number" && Number.isFinite(msg.lastFocusedAt)) {
      ext.lastFocusedAt = msg.lastFocusedAt;
    }

    for (const peer of this.peers.values()) {
      if (peer.boundProfileId === ext.profileId) {
        this.sendToExtension(ext, {
          type: "peer_connected",
          sessionId: peer.sessionId,
          displayName: peer.displayName,
          activePeers: this.countPeersForProfile(ext.profileId)
        });
      }
    }

    this.notifyExtensionWaiters();
  }

  private handleExtensionProfileUpdate(
    ws: WebSocket,
    msg: Extract<ExtensionOutboundMessage, { type: "extension_profile_update" }>
  ): void {
    const profileId = this.socketToProfileId.get(ws);
    if (!profileId) {
      return;
    }
    const ext = this.extensions.get(profileId);
    if (!ext || ext.socket !== ws) {
      return;
    }

    if (typeof msg.profileEmail === "string") {
      ext.profileEmail = msg.profileEmail.trim() || undefined;
    }
    if (typeof msg.profileName === "string" && msg.profileName.trim()) {
      ext.profileName = msg.profileName.trim();
    }
    if (typeof msg.lastFocusedAt === "number" && Number.isFinite(msg.lastFocusedAt)) {
      ext.lastFocusedAt = msg.lastFocusedAt;
    }
    this.notifyExtensionWaiters();
  }

  private handleExtensionConnection(ws: WebSocket): void {
    const now = Date.now();
    const provisionalId = `profile_${randomUUID().slice(0, 8)}`;
    const ext: ConnectedExtension = {
      socket: ws,
      profileId: provisionalId,
      profileName: provisionalId,
      browserName: "Chrome",
      extensionVersion: "unknown",
      connectedAt: now,
      lastFocusedAt: now
    };
    this.extensions.set(provisionalId, ext);
    this.socketToProfileId.set(ws, provisionalId);
    this.notifyExtensionWaiters();

    ws.on("message", (raw) => {
      let parsed: ExtensionOutboundMessage;
      try {
        parsed = JSON.parse(String(raw)) as ExtensionOutboundMessage;
      } catch {
        return;
      }

      if (parsed.type === "ping") {
        this.sendToExtension(ext, { type: "pong" });
        return;
      }
      if (parsed.type === "extension_hello") {
        this.handleExtensionHello(ws, parsed);
        return;
      }
      if (parsed.type === "extension_profile_update") {
        this.handleExtensionProfileUpdate(ws, parsed);
        return;
      }
      if (parsed.type === "tool_result") {
        const pending = this.pendingCalls.get(parsed.toolUseId);
        if (!pending) {
          return;
        }
        this.pendingCalls.delete(parsed.toolUseId);
        clearTimeout(pending.timer);
        this.sendToPeer(pending.peer, {
          type: "mcp_tool_result",
          toolUseId: parsed.toolUseId,
          result: parsed.result
        });
      }
    });

    ws.on("close", () => {
      const profileId = this.socketToProfileId.get(ws);
      this.socketToProfileId.delete(ws);
      if (!profileId) {
        return;
      }
      const current = this.extensions.get(profileId);
      if (current && current.socket === ws) {
        this.extensions.delete(profileId);
        this.failPendingCallsForProfile(
          profileId,
          `Chrome extension for profile "${current.profileName}" (${profileId}) disconnected while executing tool call.`
        );
      }
    });
  }

  private async resolveTargetExtension(
    peer: ConnectedMcpPeer,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ProfileMatchResult> {
    const requestedProfile =
      typeof args.profile === "string" && args.profile.trim() ? args.profile.trim() : undefined;
    const isContextTool = isContextToolName(toolName);

    if (requestedProfile) {
      const matched = await this.waitForExtension(() => {
        const res = this.resolveExtensionByQuery(requestedProfile);
        return "extension" in res ? res.extension : null;
      });
      if (matched) {
        this.bindPeerToExtension(peer, matched);
        return { extension: matched };
      }
      if (this.getOpenExtensions().length === 0) {
        return {
          error:
            "Antigravity Chrome extension is not connected. Make sure Google Chrome is open and the unpacked extension in dist/extension is enabled."
        };
      }
      return this.resolveExtensionByQuery(requestedProfile);
    }

    if (peer.boundProfileId) {
      const existing = this.extensions.get(peer.boundProfileId);
      if (existing && existing.socket.readyState === WebSocket.OPEN) {
        return { extension: existing };
      }

      if (!isContextTool) {
        const reconnected = await this.waitForExtension(() => {
          if (!peer.boundProfileId) {
            return null;
          }
          const candidate = this.extensions.get(peer.boundProfileId);
          return candidate && candidate.socket.readyState === WebSocket.OPEN ? candidate : null;
        });
        if (reconnected) {
          return { extension: reconnected };
        }
        const connectedList = formatProfileList(this.listConnectedProfileSummaries());
        return {
          error: `Chrome profile "${peer.boundProfileId}" bound to this session is no longer connected. Connected profiles: ${connectedList}. Call tabs_context_mcp with a connected \`profile\` to switch.`
        };
      }
    }

    if (peer.preferredProfile) {
      const preferredQuery = peer.preferredProfile;
      const matched = await this.waitForExtension(() => {
        const res = this.resolveExtensionByQuery(preferredQuery);
        return "extension" in res ? res.extension : null;
      });
      if (matched) {
        this.bindPeerToExtension(peer, matched);
        return { extension: matched };
      }
      if (this.getOpenExtensions().length === 0) {
        return {
          error:
            "Antigravity Chrome extension is not connected. Make sure Google Chrome is open and the unpacked extension in dist/extension is enabled."
        };
      }
      return this.resolveExtensionByQuery(preferredQuery);
    }

    const fallback = await this.waitForExtension(() => this.pickDefaultExtension());
    if (!fallback) {
      return {
        error:
          "Antigravity Chrome extension is not connected. Make sure Google Chrome is open and the unpacked extension in dist/extension is enabled."
      };
    }

    this.bindPeerToExtension(peer, fallback);
    return { extension: fallback };
  }

  private async dispatchPeerToolCall(
    peer: ConnectedMcpPeer,
    toolUseId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const resolved = await this.resolveTargetExtension(peer, toolName, args);
    if ("error" in resolved) {
      const errorResult: McpToolCallResult = {
        isError: true,
        content: [{ type: "text", text: resolved.error }]
      };
      this.sendToPeer(peer, {
        type: "mcp_tool_result",
        toolUseId,
        result: errorResult
      });
      return;
    }

    const targetExt = resolved.extension;
    const timer = setTimeout(() => {
      this.pendingCalls.delete(toolUseId);
      this.sendToPeer(peer, {
        type: "mcp_tool_result",
        toolUseId,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: `Timed out waiting for Chrome extension response on tool "${toolName}" (profile "${targetExt.profileName}").`
            }
          ]
        }
      });
    }, this.toolTimeoutMs);

    this.pendingCalls.set(toolUseId, {
      peer,
      profileId: targetExt.profileId,
      timer
    });

    this.sendToExtension(targetExt, {
      type: "tool_call",
      toolUseId,
      toolName,
      args,
      sessionScope: {
        sessionId: peer.sessionId,
        displayName: peer.displayName,
        activeProfile: toProfileSummary(targetExt),
        connectedProfiles: this.listConnectedProfileSummaries()
      }
    });
  }

  private handleMcpPeerConnection(ws: WebSocket): void {
    const peer: ConnectedMcpPeer = {
      socket: ws,
      sessionId: `session_${Math.random().toString(36).slice(2, 10)}`,
      displayName: "Antigravity",
      boundProfileId: null
    };
    this.peers.set(ws, peer);

    ws.on("message", (raw) => {
      let parsed: McpPeerOutboundMessage;
      try {
        parsed = JSON.parse(String(raw)) as McpPeerOutboundMessage;
      } catch {
        return;
      }

      if (parsed.type === "ping") {
        this.sendToPeer(peer, { type: "pong" });
        return;
      }

      if (parsed.type === "mcp_hello") {
        peer.sessionId = parsed.sessionId;
        peer.displayName = parsed.displayName;
        if (typeof parsed.preferredProfile === "string" && parsed.preferredProfile.trim()) {
          peer.preferredProfile = parsed.preferredProfile.trim();
        }
        return;
      }

      if (parsed.type === "mcp_tool_call") {
        void this.dispatchPeerToolCall(
          peer,
          parsed.toolUseId,
          parsed.toolName,
          parsed.args
        );
      }
    });

    ws.on("close", () => {
      const existing = this.peers.get(ws);
      this.peers.delete(ws);
      for (const [toolUseId, pending] of this.pendingCalls.entries()) {
        if (pending.peer.socket === ws) {
          clearTimeout(pending.timer);
          this.pendingCalls.delete(toolUseId);
        }
      }
      if (existing?.boundProfileId) {
        const boundExt = this.extensions.get(existing.boundProfileId);
        if (boundExt && boundExt.socket.readyState === WebSocket.OPEN) {
          this.sendToExtension(boundExt, {
            type: "peer_disconnected",
            sessionId: existing.sessionId,
            remainingPeers: this.countPeersForProfile(existing.boundProfileId)
          });
        }
      }
    });
  }

  private routeConnection(ws: WebSocket, req: IncomingMessage): void {
    const urlPath = req.url ?? "/";
    if (urlPath.startsWith("/extension")) {
      this.handleExtensionConnection(ws);
      return;
    }
    if (urlPath.startsWith("/mcp")) {
      this.handleMcpPeerConnection(ws);
      return;
    }
    ws.close(1008, "unknown endpoint");
  }

  public async start(): Promise<number> {
    if (this.httpServer) {
      return this.boundPort;
    }

    const server = createServer((req, res) => {
      if (req.url === "/health") {
        const connectedProfiles = this.listConnectedProfileSummaries();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            extensionConnected: connectedProfiles.length > 0,
            activeMcpPeers: this.peers.size,
            connectedProfiles
          })
        );
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });

    const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });
    wss.on("connection", (ws, req) => {
      this.routeConnection(ws, req);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.requestedPort, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const addr = server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.requestedPort;
    this.httpServer = server;
    this.wss = wss;

    this.pingInterval = setInterval(() => {
      for (const ext of this.getOpenExtensions()) {
        this.sendToExtension(ext, { type: "ping" });
      }
    }, 20000);

    return this.boundPort;
  }

  public async stop(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const waiter of this.extensionWaiters.splice(0, this.extensionWaiters.length)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.failAllPendingCalls("Bridge hub stopped.");

    for (const ext of this.extensions.values()) {
      ext.socket.terminate();
    }
    this.extensions.clear();
    this.socketToProfileId.clear();

    for (const peer of this.peers.keys()) {
      peer.terminate();
    }
    this.peers.clear();

    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
