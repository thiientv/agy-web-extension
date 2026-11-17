# Antigravity Browser Control (`agy-web-extension`)

Non-intrusive Chrome browser automation for **Antigravity (`agy`)**, modeled 1:1 on Anthropic's *Claude in Chrome* extension architecture (statically analyzed via REA).

## Key Highlights

- **Zero Mouse / Tab Disruption**: Every `agy` session opens and controls tabs with `active: false` inside its own isolated **Chrome Tab Group** (`Antigravity`), with `<a target="_blank">` background interception so popups never steal focus or shift your active tab index.
- **Background Focus Emulation + CDP Input**: Uses `chrome.debugger` (`1.3`) with `Emulation.setFocusEmulationEnabled({ enabled: true })`, automatic background audio mute protection, `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`, and `Page.captureScreenshot` — background tabs respond as if focused without touching your OS cursor or keyboard focus.
- **Original Visuals & In-Page Stop Kept**: Preserves the pulsing orange glow border (`#D97757`), smooth curved phantom cursor with click ripple rings, and the in-page **Stop Antigravity** button whenever you peek inside an agent-controlled tab (automatically hidden during screenshots).
- **Personal Zero-Prompt Mode**: All domain permission dialogs, OAuth sign-in gates, Meet bots, and sidepanel bloat are stripped out for instant personal automation across `<all_urls>`.
- **Multi-Session Concurrent Hub**: Multiple `agy` terminals can run browser tasks simultaneously via the local WebSocket hub (`127.0.0.1:18765`), each managing its own color-coded Tab Group.

---

## Repository Layout

```text
├── AGENTS.md                        # Coding rules & non-intrusive browser invariants
├── README.md                        # Project overview & quickstart
├── docs/
│   ├── architecture.md              # REA reverse-engineering findings & CDP/Bridge design
│   └── skill-installation.md        # Step-by-step global MCP + Skill setup for agy
├── skills/
│   └── agy-web-browser/SKILL.md     # Antigravity skill for browser automation
├── src/
│   ├── protocol/                    # Bridge RPC messages & 16 MCP tool schemas
│   ├── shared/                      # Local semantic find matcher, CDP input & URL redaction
│   ├── bridge/                      # Multi-session WebSocket hub & detached daemon
│   ├── mcp/                         # MCP stdio server & auto-spawning bridge client
│   └── extension/                   # MV3 Service Worker, TabGroupManager, CdpController, ToolExecutor
└── tests/                           # Unit tests + real Chromium E2E test suite
```

---

## Quickstart

### 1. Install & Build

```bash
npm install
npm run build
```

### 2. Load Unpacked Extension in Chrome

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select:
   `/Users/casterdev/Workspace/MyData/agy-web-extension/dist/extension`

### 3. Antigravity Global Setup (Already Configured on This Machine)

- **Global MCP Config**: `~/.gemini/config/mcp_config.json` -> `"agy-browser"`
- **Global Skill**: `~/.gemini/config/skills/agy-web-browser/SKILL.md`

See [docs/skill-installation.md](./docs/skill-installation.md) for manual installation details and [docs/architecture.md](./docs/architecture.md) for technical internals.

---

## Supported MCP Tools (16 Tools)

| Tool | Description |
| :--- | :--- |
| `tabs_context_mcp` | List or create (`createIfEmpty: true`) this session's isolated Chrome Tab Group |
| `tabs_create_mcp` | Create a new background tab (`active: false`) inside this session's Tab Group |
| `tabs_close_mcp` | Close a tab belonging to this session's Tab Group |
| `navigate` | Navigate a tab to a URL or `"back"` / `"forward"` (supports `force: true` for `beforeunload`) |
| `read_page` | Generate compact ARIA accessibility tree with stable `[ref_N]` element references |
| `find` | Local semantic + role-synonym + fuzzy search across visible & hidden DOM elements |
| `form_input` | Fill inputs, textareas, checkboxes, radios, `<select>`, and `contenteditable` by `ref` |
| `computer` | Virtual CDP mouse/keyboard (`left_click`, `right_click`, `double_click`, `triple_click`, `hover`, `left_click_drag`, `scroll`, `scroll_to`, `type`, `key`, `wait`, `screenshot`, `zoom`) |
| `file_upload` | Attach local files (`paths` or base64 `files`) directly to `<input type="file">` without OS dialogs |
| `upload_image` | Attach or drag-drop a previously captured screenshot (`imageId`) |
| `javascript_tool` | Evaluate JavaScript in page context with top-level `await` REPL semantics |
| `get_page_text` | Extract clean article/main readable text |
| `read_console_messages` | Inspect captured `console.*` logs and uncaught exceptions |
| `read_network_requests` | Inspect captured HTTP/XHR/Fetch requests with automatic auth query redaction |
| `resize_window` | Resize browser window dimensions |
| `gif_creator` | Record action frames and export annotated animated GIFs via Offscreen Canvas |

---

## Verification

```bash
npm run typecheck   # Strict TypeScript check (zero `any`)
npm run test:unit   # Fast unit tests
npm run test:e2e    # Real Chromium E2E test loading dist/extension
npm test            # Full test suite
```
