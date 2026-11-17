import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from "../protocol/messages.js";
import { BridgeHubServer } from "./hub-server.js";

async function main(): Promise<void> {
  const host = process.env.AGY_BRIDGE_HOST ?? DEFAULT_BRIDGE_HOST;
  const port = Number(process.env.AGY_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
  const hub = new BridgeHubServer({ host, port });
  try {
    await hub.start();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      process.exit(0);
    }
    throw err;
  }

  const shutdown = (): void => {
    void hub.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
