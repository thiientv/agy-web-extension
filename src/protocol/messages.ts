export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 18765;

export interface SessionScope {
  sessionId: string;
  displayName: string;
  tabGroupId?: number;
}

export type McpContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      data: string;
      mimeType: string;
    };

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface ExtensionHelloMessage {
  type: "extension_hello";
  extensionVersion: string;
  browserName: string;
}

export interface ExtensionToolResultMessage {
  type: "tool_result";
  toolUseId: string;
  result: McpToolCallResult;
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

export type ExtensionOutboundMessage =
  | ExtensionHelloMessage
  | ExtensionToolResultMessage
  | PingMessage
  | PongMessage;

export interface ExtensionToolCallMessage {
  type: "tool_call";
  toolUseId: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionScope: SessionScope;
}

export interface PeerConnectedMessage {
  type: "peer_connected";
  sessionId: string;
  displayName: string;
  activePeers: number;
}

export interface PeerDisconnectedMessage {
  type: "peer_disconnected";
  sessionId: string;
  remainingPeers: number;
}

export type ExtensionInboundMessage =
  | ExtensionToolCallMessage
  | PeerConnectedMessage
  | PeerDisconnectedMessage
  | PingMessage
  | PongMessage;

export interface McpPeerHelloMessage {
  type: "mcp_hello";
  sessionId: string;
  displayName: string;
}

export interface McpPeerToolCallMessage {
  type: "mcp_tool_call";
  toolUseId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type McpPeerOutboundMessage =
  | McpPeerHelloMessage
  | McpPeerToolCallMessage
  | PingMessage
  | PongMessage;

export interface McpPeerToolResultMessage {
  type: "mcp_tool_result";
  toolUseId: string;
  result: McpToolCallResult;
}

export type McpPeerInboundMessage =
  | McpPeerToolResultMessage
  | PingMessage
  | PongMessage;
