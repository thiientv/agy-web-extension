import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
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

interface ConnectedMcpPeer {
  socket: WebSocket;
  sessionId: string;
  displayName: string;
}

interface PendingToolCall {
  peer: ConnectedMcpPeer;
  timer: NodeJS.Timeout;
}

export class BridgeHubServer {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly extensionWaitMs: number;
  private readonly toolTimeoutMs: number;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private extensionSocket: WebSocket | null = null;
  private extensionWaiters: Array<(sock: WebSocket | null) => void> = [];
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

  private sendToExtension(msg: ExtensionInboundMessage): boolean {
    if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.extensionSocket.send(JSON.stringify(msg));
    return true;
  }

  private sendToPeer(peer: ConnectedMcpPeer, msg: McpPeerInboundMessage): void {
    if (peer.socket.readyState === WebSocket.OPEN) {
      peer.socket.send(JSON.stringify(msg));
    }
  }

  private waitForExtension(): Promise<WebSocket | null> {
    if (this.extensionSocket && this.extensionSocket.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.extensionSocket);
    }
    if (this.extensionWaitMs <= 0) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter = (sock: WebSocket | null): void => {
        clearTimeout(timer);
        resolve(sock);
      };
      const timer = setTimeout(() => {
        const idx = this.extensionWaiters.indexOf(waiter);
        if (idx !== -1) {
          this.extensionWaiters.splice(idx, 1);
        }
        resolve(null);
      }, this.extensionWaitMs);
      this.extensionWaiters.push(waiter);
    });
  }

  private failPendingCallsWithError(message: string): void {
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

  private handleExtensionConnection(ws: WebSocket): void {
    if (this.extensionSocket && this.extensionSocket !== ws) {
      try {
        this.extensionSocket.close(1000, "replaced");
      } catch {
        // Ignore close error on stale socket.
      }
    }
    this.extensionSocket = ws;

    const waiters = this.extensionWaiters.splice(0, this.extensionWaiters.length);
    for (const waiter of waiters) {
      waiter(ws);
    }

    for (const peer of this.peers.values()) {
      this.sendToExtension({
        type: "peer_connected",
        sessionId: peer.sessionId,
        displayName: peer.displayName,
        activePeers: this.peers.size
      });
    }

    ws.on("message", (raw) => {
      let parsed: ExtensionOutboundMessage;
      try {
        parsed = JSON.parse(String(raw)) as ExtensionOutboundMessage;
      } catch {
        return;
      }

      if (parsed.type === "ping") {
        this.sendToExtension({ type: "pong" });
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
      if (this.extensionSocket === ws) {
        this.extensionSocket = null;
        this.failPendingCallsWithError(
          "Chrome extension disconnected while executing tool call."
        );
      }
    });
  }

  private async dispatchPeerToolCall(
    peer: ConnectedMcpPeer,
    toolUseId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const ext = await this.waitForExtension();
    if (!ext || ext.readyState !== WebSocket.OPEN) {
      const errorResult: McpToolCallResult = {
        isError: true,
        content: [
          {
            type: "text",
            text:
              "Antigravity Chrome extension is not connected. Make sure Google Chrome is open and the unpacked extension in dist/extension is enabled."
          }
        ]
      };
      this.sendToPeer(peer, {
        type: "mcp_tool_result",
        toolUseId,
        result: errorResult
      });
      return;
    }

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
              text: `Timed out waiting for Chrome extension response on tool "${toolName}".`
            }
          ]
        }
      });
    }, this.toolTimeoutMs);

    this.pendingCalls.set(toolUseId, { peer, timer });
    this.sendToExtension({
      type: "tool_call",
      toolUseId,
      toolName,
      args,
      sessionScope: {
        sessionId: peer.sessionId,
        displayName: peer.displayName
      }
    });
  }

  private handleMcpPeerConnection(ws: WebSocket): void {
    const peer: ConnectedMcpPeer = {
      socket: ws,
      sessionId: `session_${Math.random().toString(36).slice(2, 10)}`,
      displayName: "Antigravity"
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
        this.sendToExtension({
          type: "peer_connected",
          sessionId: peer.sessionId,
          displayName: peer.displayName,
          activePeers: this.peers.size
        });
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
      if (existing) {
        this.sendToExtension({
          type: "peer_disconnected",
          sessionId: existing.sessionId,
          remainingPeers: this.peers.size
        });
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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            extensionConnected:
              this.extensionSocket !== null &&
              this.extensionSocket.readyState === WebSocket.OPEN,
            activeMcpPeers: this.peers.size
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
      this.sendToExtension({ type: "ping" });
    }, 20000);

    return this.boundPort;
  }

  public async stop(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const waiter of this.extensionWaiters.splice(0, this.extensionWaiters.length)) {
      waiter(null);
    }
    this.failPendingCallsWithError("Bridge hub stopped.");

    if (this.extensionSocket) {
      this.extensionSocket.terminate();
      this.extensionSocket = null;
    }
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
