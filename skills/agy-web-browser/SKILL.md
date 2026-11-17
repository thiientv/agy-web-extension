---
name: agy-web-browser
description: >-
  Use when automating, inspecting, testing, scraping, filling forms, uploading
  files, capturing screenshots/GIFs, or debugging web pages in Google Chrome via
  the `agy-browser` MCP server without disturbing the user's active tab or mouse
  cursor.
---

# Antigravity Browser Control (`agy-browser`)

Control real Google Chrome tabs in the background through the `agy-browser` MCP server. Every session operates inside its own isolated Chrome Tab Group (`active: false`) using Chrome DevTools Protocol (`Emulation.setFocusEmulationEnabled`, `Input.*`, `Page.captureScreenshot`), so your actions **never** move the user's physical mouse cursor, steal window focus, or switch their active tab.

## Calling Lazy MCP Tools in Antigravity

In Antigravity (`agy`), `agy-browser` tools are lazy-loaded. Invoke them via `call_mcp_tool` with `ServerName: "agy-browser"`. If unsure of an argument field, inspect `<appDataDir>/mcp/agy-browser/<toolName>.json` first. Always pass `tabId` as a JSON **number** (never a string).

## Standard Session Lifecycle

1. **Initialize session Tab Group once per task**:
   Call `tabs_context_mcp` with `{"createIfEmpty": true}`.
   - If this session had no group yet, `createIfEmpty: true` **already creates** the Tab Group and one fresh background tab (`chrome://newtab/`, `active: false`). Reuse that returned `Current Tab ID` directly — do **not** call `tabs_create_mcp` immediately afterward or you will leave an unused blank tab open.
   - Call `tabs_create_mcp` only when you need an **additional** tab in an already-populated group.
2. **Navigate**:
   Call `navigate` with `{"tabId": <number>, "url": "https://..."}`. Supports `"back"`, `"forward"`, and `"force": true` to bypass `beforeunload` dialogs.
3. **Inspect DOM & obtain `ref` IDs (`ref_1`, `ref_2`, ...)**:
   - Prefer `find` (`{"tabId": <number>, "query": "login button"}`) to locate specific controls quickly (searches visible **and** hidden elements, including hidden `<input type="file">`).
   - Use `read_page` (`{"tabId": <number>, "filter": "interactive"}`) for visible interactive controls.
   - **CRITICAL for hidden elements / file uploaders**: `read_page` with `filter: "interactive"` excludes hidden elements (`display: none`, `0x0`). To locate hidden `<input type="file">` elements, always use `find` (e.g. `query: "upload file"`) or `read_page` with `filter: "all"`.
4. **Interact using `ref` first, coordinates second**:
   - Text inputs, textareas, checkboxes, radios, `<select>`: use `form_input` (`{"tabId": <number>, "ref": "ref_N", "value": ...}`).
   - Buttons, links, custom widgets: use `computer` with `{"tabId": <number>, "action": "left_click", "ref": "ref_N"}`.
   - File inputs (`<input type="file">`): **never** click a file input with `computer` (that opens a native OS dialog). Always call `file_upload` with `{"tabId": <number>, "ref": "ref_N", "paths": ["/absolute/path/to/file"]}`.
   - Rich-text / canvas / keyboard shortcuts: click/focus target, then call `computer` with `action: "type"` or `action: "key"` (e.g. `"Enter"`, `"cmd+a Backspace"`). CDP dispatches directly to the background tab's renderer without affecting the user's keyboard focus.
5. **Verify & Clean Up**:
   - Check API calls with `read_network_requests` (`urlPattern`) and JS errors with `read_console_messages` (`onlyErrors: true`).
   - Visual check: `computer` with `{"tabId": <number>, "action": "screenshot"}` (coordinates in clicks always use the full `coordinate_frame` reported with screenshots, even if `scale < 1`).
   - Close temporary tabs you created via `tabs_close_mcp` (`{"tabId": <number>}`) when finished.

## Tool Quick Reference

| Tool | Purpose | Key Arguments |
| :--- | :--- | :--- |
| `tabs_context_mcp` | Get or initialize session's isolated Tab Group | `createIfEmpty?: boolean` |
| `tabs_create_mcp` | Open an additional background tab (`active: false`) in group | *(none)* |
| `tabs_close_mcp` | Close a tab in this session's Tab Group | `tabId: number` |
| `navigate` | Load URL or `"back"` / `"forward"` | `tabId: number`, `url: string`, `force?: boolean` |
| `find` | Local semantic/role/fuzzy search (up to 20 `ref_N`, includes hidden file inputs) | `tabId: number`, `query: string` |
| `read_page` | Accessibility tree with `ref_N` IDs | `tabId: number`, `filter?: "all" \| "interactive"`, `depth?: number`, `ref_id?: string` |
| `form_input` | Set input/textarea/select/checkbox/contenteditable value by `ref` | `tabId: number`, `ref: string`, `value: string \| number \| boolean` |
| `computer` | CDP click/hover/drag/scroll/scroll_to/type/key/wait/screenshot/zoom | `tabId: number`, `action: string`, `ref?: string`, `coordinate?: [x, y]`, `text?: string` |
| `file_upload` | Attach local file(s) to `<input type="file">` without OS picker | `tabId: number`, `ref: string`, `paths?: string[]` |
| `upload_image` | Upload or drag-drop a captured screenshot (`imageId`) | `tabId: number`, `imageId: string`, `ref?: string`, `coordinate?: [x, y]` |
| `javascript_tool` | Run JS in page context (top-level `await` supported) | `tabId: number`, `action: "javascript_exec"`, `text: string` |
| `get_page_text` | Extract clean article/body plain text | `tabId: number`, `max_chars?: number` |
| `read_console_messages` | Read captured console logs & uncaught exceptions | `tabId: number`, `onlyErrors?: boolean`, `pattern?: string`, `clear?: boolean` |
| `read_network_requests` | Read captured XHR/Fetch/HTTP requests (auth params redacted) | `tabId: number`, `urlPattern?: string`, `clear?: boolean` |
| `resize_window` | Resize browser window for responsive testing | `tabId: number`, `width: number`, `height: number` |
| `gif_creator` | Record & export annotated GIF of actions in Tab Group | `tabId: number`, `action: "start_recording" \| "stop_recording" \| "export" \| "clear"`, `download?: boolean` |

## Common Mistakes to Avoid

| Mistake | Fix |
| :--- | :--- |
| Calling `tabs_create_mcp` right after `tabs_context_mcp({ createIfEmpty: true })` created a brand-new group | Reuse the `Current Tab ID` (`chrome://newtab/`) returned by `tabs_context_mcp`; only call `tabs_create_mcp` when all existing tabs in the group are already in use. |
| Using `read_page({ filter: "interactive" })` to find a hidden `<input type="file">` | Hidden elements are excluded from `filter: "interactive"`. Use `find({ query: "upload ..." })` or `read_page({ filter: "all" })`. |
| Clicking `<input type="file">` or an "Upload" button with `computer` | Opens an invisible native OS file picker. Locate the `<input type="file">` `ref` via `find` and pass local file paths to `file_upload`. |
| Passing `tabId` as `"123"` (string) or pressing `"cmd+="` / `"ctrl+-"` to zoom | Pass `tabId` as numeric `123`. Page zoom key shortcuts are rejected; use `computer` with `action: "zoom"` and `region: [x0, y0, x1, y1]`. |

## Connection Troubleshooting

If a tool returns `Antigravity Chrome extension is not connected`:
1. Check bridge health: `curl -s http://127.0.0.1:18765/health` (`{"ok":true,"extensionConnected":true,...}`).
2. Ensure Google Chrome is open and the unpacked extension at `/Users/casterdev/Workspace/MyData/agy-web-extension/dist/extension` is loaded and enabled in `chrome://extensions`.
