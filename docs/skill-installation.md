# Installing `agy-web-browser` Skill & MCP Server in Antigravity

This guide explains how to register both the **`agy-browser` MCP server** and the **`agy-web-browser` global skill** so Antigravity (`agy`) can control Google Chrome in any workspace.

---

## 1. Build the Extension & MCP Server

```bash
cd /Users/casterdev/Workspace/MyData/agy-web-extension
npm install
npm run build
```

This generates:
- `dist/extension/` — Unpacked Chrome Manifest V3 extension
- `dist/mcp-server/server.js` — Antigravity MCP `stdio` server
- `dist/mcp-server/daemon.js` — Multi-session local WebSocket bridge hub (`127.0.0.1:18765`)

---

## 2. Load the Extension in Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** ON (top-right corner).
3. Click **Load unpacked**.
4. Select `/Users/casterdev/Workspace/MyData/agy-web-extension/dist/extension`.

Once loaded, the extension automatically connects to `ws://127.0.0.1:18765/extension` in the background (with MV3 service-worker keepalive).

---

## 3. Register the Global MCP Server in Antigravity

Edit `~/.gemini/config/mcp_config.json` and add the `"agy-browser"` entry inside `"mcpServers"`:

```json
{
  "mcpServers": {
    "agy-browser": {
      "command": "/Users/casterdev/.nvm/versions/node/v22.23.4/bin/node",
      "args": [
        "/Users/casterdev/Workspace/MyData/agy-web-extension/dist/mcp-server/server.js"
      ]
    }
  }
}
```

---

## 4. Install the `agy-web-browser` Skill Globally

Antigravity discovers global skills from `~/.gemini/config/skills/<skill-name>/SKILL.md` (and workspace-local skills from `.agents/skills/<skill-name>/SKILL.md`).

Copy the skill from this repository into your global Antigravity config directory:

```bash
mkdir -p ~/.gemini/config/skills/agy-web-browser
cp /Users/casterdev/Workspace/MyData/agy-web-extension/skills/agy-web-browser/SKILL.md \
   ~/.gemini/config/skills/agy-web-browser/SKILL.md
```

---

## 5. Verify Connection Health

Start or restart an Antigravity (`agy`) session so it reloads `mcp_config.json` and global skills, then verify the local bridge hub health endpoint:

```bash
curl -s http://127.0.0.1:18765/health
```

Expected response when Chrome has the extension enabled:

```json
{"ok":true,"extensionConnected":true,"activeMcpPeers":1}
```
