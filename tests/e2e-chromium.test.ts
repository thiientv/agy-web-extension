import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(rootDir, "dist/extension");
const mcpServerPath = join(rootDir, "dist/mcp-server/server.js");
const cftBinary =
  "/Users/casterdev/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

interface TextBlock {
  type: "text";
  text: string;
}

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

type ToolContent = TextBlock | ImageBlock;

function extractFirstText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const block = (content as ToolContent[]).find((item) => item.type === "text");
  return block && block.type === "text" ? block.text : "";
}

describe("Real Chrome for Testing E2E: Extension + Bridge + MCP Server", () => {
  let webServer: HttpServer | null = null;
  let webPort = 0;
  let chromeProc: ChildProcess | null = null;
  let userDataDir = "";
  let mcpClient: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let sampleUploadPath = "";

  let fgHiddenEvents = 0;

  beforeAll(async () => {
    webServer = createServer((req, res) => {
      const reqUrl = req.url ?? "/";
      if (reqUrl.startsWith("/fg-hidden")) {
        fgHiddenEvents += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      if (reqUrl.startsWith("/user-foreground")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html>
            <head><title>User Active Tab</title></head>
            <body>
              <h1>User Foreground Work</h1>
              <script>
                document.addEventListener("visibilitychange", () => {
                  if (document.hidden) fetch("/fg-hidden").catch(() => {});
                });
              </script>
            </body>
          </html>`);
        return;
      }

      if (reqUrl.startsWith("/api/items")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: ["mango", "papaya"], status: "ok" }));
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <head><title>Antigravity Test Playground</title></head>
          <body>
            <main>
              <h1>Antigravity Automation Lab</h1>
              <p>This article verifies non-intrusive background tab control via Chrome DevTools Protocol.</p>
              <label for="search-box">Product Search</label>
              <input id="search-box" type="text" placeholder="Search organic fruit..." />
              <label><input id="express-check" type="checkbox" /> Express Delivery</label>
              <button id="increment-btn" type="button">Add Item (0)</button>
              <input id="avatar-upload" type="file" aria-label="Upload Avatar File" style="opacity:0.01;width:10px;height:10px" />
              <div id="upload-status">no-file</div>
            </main>
            <script>
              let count = 0;
              document.getElementById("increment-btn").addEventListener("click", () => {
                count += 1;
                document.getElementById("increment-btn").textContent = "Add Item (" + count + ")";
                console.error("TestErrorLog: clicked_count=" + count);
                fetch("/api/items?access_token=supersecret999&count=" + count).catch(() => {});
              });
              document.getElementById("avatar-upload").addEventListener("change", (e) => {
                const f = e.target.files && e.target.files[0];
                document.getElementById("upload-status").textContent = f ? ("uploaded:" + f.name + ":" + f.size) : "empty";
              });
            </script>
          </body>
        </html>`);
    });

    await new Promise<void>((resolve) => {
      webServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = webServer.address();
    webPort = typeof addr === "object" && addr ? addr.port : 0;

    userDataDir = mkdtempSync(join(tmpdir(), "agy-ext-e2e-"));
    sampleUploadPath = join(userDataDir, "hello-agy.txt");
    writeFileSync(sampleUploadPath, "Antigravity upload payload!", "utf8");

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpServerPath],
      env: {
        ...(process.env as Record<string, string>),
        AGY_BRIDGE_PORT: "18765"
      }
    });
    mcpClient = new Client(
      { name: "agy-e2e-verifier", version: "1.0.0" },
      { capabilities: {} }
    );
    await mcpClient.connect(transport);

    chromeProc = spawn(
      cftBinary,
      [
        `--user-data-dir=${userDataDir}`,
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,800",
        `http://127.0.0.1:${webPort}/user-foreground`
      ],
      { stdio: "ignore" }
    );

    let connected = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const res = await fetch("http://127.0.0.1:18765/health").catch(() => null);
      if (res && res.ok) {
        const body = (await res.json()) as { extensionConnected?: boolean };
        if (body.extensionConnected) {
          connected = true;
          break;
        }
      }
    }
    expect(connected).toBe(true);
  });

  afterAll(async () => {
    if (mcpClient) {
      await mcpClient.close().catch(() => undefined);
    }
    if (chromeProc) {
      chromeProc.kill("SIGTERM");
    }
    if (webServer) {
      await new Promise<void>((resolve) => webServer!.close(() => resolve()));
    }
    if (userDataDir) {
      await new Promise((r) => setTimeout(r, 300));
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it("controls background tabs in an isolated Tab Group via CDP without disturbing the foreground tab", async () => {
    const toolsList = await mcpClient!.listTools();
    expect(toolsList.tools.length).toBe(16);

    const ctxRes = await mcpClient!.callTool({
      name: "tabs_context_mcp",
      arguments: { createIfEmpty: true }
    });
    const ctxText = extractFirstText(ctxRes.content);
    expect(ctxText).toContain("MCP Tab Group ID:");
    const tabIdMatch = /Current Tab ID:\s*(\d+)/.exec(ctxText);
    expect(tabIdMatch).not.toBeNull();
    const tabId = Number(tabIdMatch![1]);

    const navRes = await mcpClient!.callTool({
      name: "navigate",
      arguments: {
        tabId,
        url: `http://127.0.0.1:${webPort}/playground`
      }
    });
    expect(extractFirstText(navRes.content)).toContain("Antigravity Test Playground");

    const focusCheckRes = await mcpClient!.callTool({
      name: "javascript_tool",
      arguments: {
        tabId,
        action: "javascript_exec",
        text: "({ hasFocus: document.hasFocus(), hidden: document.hidden })"
      }
    });
    const focusInfo = JSON.parse(extractFirstText(focusCheckRes.content)) as {
      hasFocus: boolean;
      hidden: boolean;
    };
    expect(focusInfo.hasFocus).toBe(true);
    expect(fgHiddenEvents).toBe(0);

    const readRes = await mcpClient!.callTool({
      name: "read_page",
      arguments: { tabId, filter: "interactive" }
    });
    const treeText = extractFirstText(readRes.content);
    expect(treeText).toContain("Search organic fruit...");
    expect(treeText).toContain("Add Item (0)");

    const findSearchRes = await mcpClient!.callTool({
      name: "find",
      arguments: { tabId, query: "product search input" }
    });
    const searchRefMatch = /\[(ref_\d+)\]/.exec(extractFirstText(findSearchRes.content));
    expect(searchRefMatch).not.toBeNull();
    const searchRef = searchRefMatch![1]!;

    const formRes = await mcpClient!.callTool({
      name: "form_input",
      arguments: { tabId, ref: searchRef, value: "Alphonso Mango" }
    });
    expect(extractFirstText(formRes.content)).toContain("Updated input");

    const findBtnRes = await mcpClient!.callTool({
      name: "find",
      arguments: { tabId, query: "Add Item button" }
    });
    const btnRefMatch = /\[(ref_\d+)\]/.exec(extractFirstText(findBtnRes.content));
    expect(btnRefMatch).not.toBeNull();
    const btnRef = btnRefMatch![1]!;

    const clickRes = await mcpClient!.callTool({
      name: "computer",
      arguments: {
        tabId,
        action: "left_click",
        ref: btnRef
      }
    });
    expect(extractFirstText(clickRes.content)).toContain("Performed left_click");

    await new Promise((r) => setTimeout(r, 200));

    const verifyDomRes = await mcpClient!.callTool({
      name: "javascript_tool",
      arguments: {
        tabId,
        action: "javascript_exec",
        text: "({ inputVal: document.getElementById('search-box').value, btnText: document.getElementById('increment-btn').textContent })"
      }
    });
    const domState = JSON.parse(extractFirstText(verifyDomRes.content)) as {
      inputVal: string;
      btnText: string;
    };
    expect(domState.inputVal).toBe("Alphonso Mango");
    expect(domState.btnText).toBe("Add Item (1)");

    const shotRes = await mcpClient!.callTool({
      name: "computer",
      arguments: { tabId, action: "screenshot" }
    });
    const contentArr = shotRes.content as ToolContent[];
    const imgBlock = contentArr.find((b) => b.type === "image");
    expect(imgBlock).toBeDefined();
    if (imgBlock && imgBlock.type === "image") {
      expect(imgBlock.data.length).toBeGreaterThan(500);
    }

    const pageTextRes = await mcpClient!.callTool({
      name: "get_page_text",
      arguments: { tabId }
    });
    expect(extractFirstText(pageTextRes.content)).toContain(
      "This article verifies non-intrusive background tab control"
    );

    const consoleRes = await mcpClient!.callTool({
      name: "read_console_messages",
      arguments: { tabId, onlyErrors: true, pattern: "TestErrorLog" }
    });
    expect(extractFirstText(consoleRes.content)).toContain("clicked_count=1");

    const netRes = await mcpClient!.callTool({
      name: "read_network_requests",
      arguments: { tabId, urlPattern: "/api/items" }
    });
    const netText = extractFirstText(netRes.content);
    expect(netText).toContain("access_token=REDACTED");
    expect(netText).not.toContain("supersecret999");

    const findUploadRes = await mcpClient!.callTool({
      name: "find",
      arguments: { tabId, query: "upload avatar file" }
    });
    const fileRefMatch = /\[(ref_\d+)\]/.exec(extractFirstText(findUploadRes.content));
    expect(fileRefMatch).not.toBeNull();
    const fileRef = fileRefMatch![1]!;

    const uploadRes = await mcpClient!.callTool({
      name: "file_upload",
      arguments: {
        tabId,
        ref: fileRef,
        paths: [sampleUploadPath]
      }
    });
    expect(extractFirstText(uploadRes.content)).toContain("hello-agy.txt");

    const uploadStateRes = await mcpClient!.callTool({
      name: "javascript_tool",
      arguments: {
        tabId,
        action: "javascript_exec",
        text: "document.getElementById('upload-status').textContent"
      }
    });
    expect(extractFirstText(uploadStateRes.content)).toBe("uploaded:hello-agy.txt:27");

    const secondTabRes = await mcpClient!.callTool({
      name: "tabs_create_mcp",
      arguments: {}
    });
    const newTabMatch = /background tab (\d+)/.exec(extractFirstText(secondTabRes.content));
    expect(newTabMatch).not.toBeNull();
    const secondTabId = Number(newTabMatch![1]);

    const closeRes = await mcpClient!.callTool({
      name: "tabs_close_mcp",
      arguments: { tabId: secondTabId }
    });
    expect(extractFirstText(closeRes.content)).toContain(`Closed tab ${secondTabId}`);
    expect(fgHiddenEvents).toBe(0);
  });
});
