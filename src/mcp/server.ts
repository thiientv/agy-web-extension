import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { BROWSER_TOOL_SCHEMAS } from "../protocol/tool-schemas.js";
import { McpBridgeClient } from "./bridge-client.js";

async function startMcpServer(): Promise<void> {
  const bridgeClient = new McpBridgeClient({
    displayName: process.env.AGY_TAB_GROUP_NAME ?? "Antigravity",
    preferredProfile: process.env.AGY_BROWSER_PROFILE
  });
  void bridgeClient.warmup();

  const server = new Server(
    {
      name: "agy-browser",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BROWSER_TOOL_SCHEMAS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawArgs =
      request.params.arguments && typeof request.params.arguments === "object"
        ? (request.params.arguments as Record<string, unknown>)
        : {};
    const res = await bridgeClient.callTool(toolName, rawArgs);
    return {
      content: res.content,
      isError: res.isError
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = (): void => {
    void bridgeClient.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

void startMcpServer();
