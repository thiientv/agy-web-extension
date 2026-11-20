import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  type McpPeerInboundMessage,
  type McpPeerOutboundMessage,
  type McpToolCallResult
} from "../protocol/messages.js";

export interface McpBridgeClientOptions {
  host?: string;
  port?: number;
  sessionId?: string;
  displayName?: string;
  preferredProfile?: string;
  autoSpawnDaemon?: boolean;
  daemonScriptPath?: string;
  callTimeoutMs?: number;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip"
};

function guessMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx === -1) {
    return "application/octet-stream";
  }
  return MIME_BY_EXT[lower.slice(dotIdx)] ?? "application/octet-stream";
}

async function enrichFileUploadArgs(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (toolName !== "file_upload" || !Array.isArray(args.paths) || args.paths.length === 0) {
    return args;
  }
  const resolvedFiles: Array<{ data: string; name: string; mimeType: string }> = Array.isArray(
    args.files
  )
    ? (args.files as Array<{ data: string; name: string; mimeType: string }>)
    : [];

  for (const rawPath of args.paths) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      continue;
    }
    const bytes = await readFile(rawPath);
    resolvedFiles.push({
      data: bytes.toString("base64"),
      name: basename(rawPath),
      mimeType: guessMimeType(rawPath)
    });
  }

  const nextArgs: Record<string, unknown> = { ...args, files: resolvedFiles };
  delete nextArgs.paths;
  return nextArgs;
}

export class McpBridgeClient {
  private readonly host: string;
  private readonly port: number;
  private readonly sessionId: string;
  private readonly displayName: string;
  private readonly preferredProfile?: string;
  private readonly autoSpawnDaemon: boolean;
  private readonly daemonScriptPath: string;
  private readonly callTimeoutMs: number;
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (res: McpToolCallResult) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  constructor(options: McpBridgeClientOptions = {}) {
    this.host = options.host ?? process.env.AGY_BRIDGE_HOST ?? DEFAULT_BRIDGE_HOST;
    this.port = options.port ?? Number(process.env.AGY_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
    this.sessionId = options.sessionId ?? `agy_${randomUUID().slice(0, 8)}`;
    this.displayName = options.displayName ?? "Antigravity";
    const rawPreferredProfile = options.preferredProfile ?? process.env.AGY_BROWSER_PROFILE;
    this.preferredProfile =
      typeof rawPreferredProfile === "string" && rawPreferredProfile.trim()
        ? rawPreferredProfile.trim()
        : undefined;
    this.autoSpawnDaemon = options.autoSpawnDaemon ?? true;
    const currentDir = dirname(fileURLToPath(import.meta.url));
    this.daemonScriptPath = options.daemonScriptPath ?? join(currentDir, "daemon.js");
    this.callTimeoutMs = options.callTimeoutMs ?? 95000;
  }

  private send(ws: WebSocket, msg: McpPeerOutboundMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private spawnBackgroundDaemon(): void {
    const child = spawn(process.execPath, [this.daemonScriptPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AGY_BRIDGE_HOST: this.host,
        AGY_BRIDGE_PORT: String(this.port)
      }
    });
    child.unref();
  }

  private openSocketOnce(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${this.port}/mcp`, {
        maxPayload: 64 * 1024 * 1024
      });
      const onError = (err: Error): void => {
        ws.removeAllListeners();
        reject(err);
      };
      ws.once("error", onError);
      ws.once("open", () => {
        ws.off("error", onError);
        this.send(ws, {
          type: "mcp_hello",
          sessionId: this.sessionId,
          displayName: this.displayName,
          ...(this.preferredProfile ? { preferredProfile: this.preferredProfile } : {})
        });

        ws.on("message", (raw) => {
          let parsed: McpPeerInboundMessage;
          try {
            parsed = JSON.parse(String(raw)) as McpPeerInboundMessage;
          } catch {
            return;
          }
          if (parsed.type === "ping") {
            this.send(ws, { type: "pong" });
            return;
          }
          if (parsed.type === "mcp_tool_result") {
            const waiter = this.pending.get(parsed.toolUseId);
            if (waiter) {
              this.pending.delete(parsed.toolUseId);
              clearTimeout(waiter.timer);
              waiter.resolve(parsed.result);
            }
          }
        });

        ws.on("close", () => {
          if (this.ws === ws) {
            this.ws = null;
          }
          const entries = [...this.pending.entries()];
          this.pending.clear();
          for (const [, waiter] of entries) {
            clearTimeout(waiter.timer);
            waiter.resolve({
              isError: true,
              content: [{ type: "text", text: "Connection to local bridge hub closed." }]
            });
          }
        });

        resolve(ws);
      });
    });
  }

  private async ensureConnected(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    if (this.connecting) {
      return this.connecting;
    }

    const promise = (async (): Promise<WebSocket> => {
      try {
        const sock = await this.openSocketOnce();
        this.ws = sock;
        return sock;
      } catch (firstErr) {
        if (!this.autoSpawnDaemon) {
          throw firstErr;
        }
        this.spawnBackgroundDaemon();
        for (let attempt = 0; attempt < 15; attempt += 1) {
          await new Promise((r) => setTimeout(r, 120));
          try {
            const sock = await this.openSocketOnce();
            this.ws = sock;
            return sock;
          } catch {
            // Retry until daemon finishes binding.
          }
        }
        throw firstErr;
      } finally {
        this.connecting = null;
      }
    })();

    this.connecting = promise;
    return promise;
  }

  public warmup(): Promise<void> {
    return this.ensureConnected()
      .then(() => undefined)
      .catch(() => undefined);
  }

  public async callTool(
    toolName: string,
    rawArgs: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    if (this.closed) {
      return {
        isError: true,
        content: [{ type: "text", text: "MCP bridge client is closed." }]
      };
    }

    let args: Record<string, unknown>;
    try {
      args = await enrichFileUploadArgs(toolName, rawArgs);
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to read file(s) for upload: ${err instanceof Error ? err.message : String(err)}`
          }
        ]
      };
    }

    let ws: WebSocket;
    try {
      ws = await this.ensureConnected();
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to connect to Antigravity browser bridge hub: ${
              err instanceof Error ? err.message : String(err)
            }`
          }
        ]
      };
    }

    const toolUseId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseId);
        resolve({
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool "${toolName}" timed out after ${this.callTimeoutMs}ms.`
            }
          ]
        });
      }, this.callTimeoutMs);

      this.pending.set(toolUseId, { resolve, timer });
      this.send(ws, {
        type: "mcp_tool_call",
        toolUseId,
        toolName,
        args
      });
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) {
      return;
    }
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      ws.close();
      setTimeout(resolve, 200);
    });
  }
}
