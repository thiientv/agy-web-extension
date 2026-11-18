# AGENTS.md — Antigravity Browser Control (`agy-web-extension`)

## Project Purpose

`agy-web-extension` provides non-intrusive Chrome browser automation for **Antigravity (`agy`)** via isolated background Chrome Tab Groups and lazy Chrome DevTools Protocol (CDP) control.

It consists of three parts:
1. **Chrome Manifest V3 Extension** (`src/extension/` -> `dist/extension/`): Manages isolated Chrome Tab Groups (`active: false`), attaches `chrome.debugger` (CDP 1.3) with `Emulation.setFocusEmulationEnabled({ enabled: true })` and background tab mute protection, renders the orange pulsing glow border + curved phantom cursor + in-page Stop button, and executes all 16 browser tools with zero domain permission prompts.
2. **Multi-Session Local WebSocket Bridge Hub** (`src/bridge/` -> `dist/mcp-server/daemon.js`): Listens on `ws://127.0.0.1:18765`, allowing multiple concurrent `agy` CLI/IDE sessions to control separate Chrome Tab Groups simultaneously over a single extension WebSocket connection.
3. **Antigravity MCP Stdio Server** (`src/mcp/` -> `dist/mcp-server/server.js`): Exposes all 16 browser control tools over MCP `stdio` and auto-spawns the background bridge daemon when needed.

## Commands

- **Install dependencies**: `npm install`
- **Build extension & MCP server**: `npm run build`
- **Typecheck (strict, zero `any`)**: `npm run typecheck`
- **Run unit tests**: `npm run test:unit`
- **Run real Chromium E2E test**: `npm run test:e2e`
- **Run full test suite**: `npm test`

## Coding Conventions & Strict Rules

1. **Zero `any` in TypeScript**: Never use `any`. Prefer explicit interfaces, discriminated unions, or `unknown` narrowed safely.
2. **Export Rules**:
   - Export only symbols imported outside the defining file.
   - Do not add barrel files (`index.ts`) or re-exports without concrete external consumers.
3. **Ordering Inside Files & Classes**:
   - Inside classes, place `private` methods **before** `public` methods.
   - Inside modules, declare helper/called functions **before** the functions that call them (avoid forward function references unless mutually recursive).
4. **Non-Intrusive Browser Invariants**:
   - Never pass `active: true` when creating agent tabs or intercepting `<a target="_blank">` popups (`TabGroupManager` must always pass `active: false`).
   - Never focus the browser window (`chrome.windows.update(..., { focused: true })`) during background tool calls.
   - Always hide visual overlays (`HIDE_FOR_TOOL_USE`) prior to `Page.captureScreenshot` and restore them (`SHOW_AFTER_TOOL_USE`) afterward so screenshots remain unpolluted.
   - Always disable `Emulation.setFocusEmulationEnabled` and lift extension-applied tab mute when detaching `chrome.debugger`.
