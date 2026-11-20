import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist");
const extOutDir = join(distDir, "extension");
const mcpOutDir = join(distDir, "mcp-server");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(extOutDir, { recursive: true });
mkdirSync(mcpOutDir, { recursive: true });

await build({
  entryPoints: [join(rootDir, "src/extension/background.ts")],
  outfile: join(extOutDir, "background.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: true
});

await build({
  entryPoints: [join(rootDir, "src/extension/popup.ts")],
  outfile: join(extOutDir, "popup.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: true
});

cpSync(join(rootDir, "src/extension/static"), extOutDir, { recursive: true });

const manifest = {
  manifest_version: 3,
  name: "Antigravity Browser Control",
  version: "1.0.0",
  description: "Non-intrusive background tab & CDP automation for Antigravity (agy)",
  minimum_chrome_version: "116",
  icons: {
    16: "icon-16.png",
    32: "icon-32.png",
    48: "icon-48.png",
    128: "icon-128.png"
  },
  action: {
    default_title: "Antigravity Browser Control",
    default_popup: "popup.html",
    default_icon: {
      16: "icon-16.png",
      32: "icon-32.png",
      48: "icon-48.png",
      128: "icon-128.png"
    }
  },
  background: {
    service_worker: "background.js",
    type: "module"
  },
  permissions: [
    "storage",
    "activeTab",
    "scripting",
    "debugger",
    "tabGroups",
    "tabs",
    "alarms",
    "webNavigation",
    "offscreen",
    "unlimitedStorage",
    "downloads",
    "identity",
    "identity.email"
  ],
  host_permissions: ["<all_urls>"],
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:;"
  },
  content_scripts: [
    {
      all_frames: true,
      js: ["content/accessibility-tree.js"],
      matches: ["<all_urls>"],
      run_at: "document_start"
    },
    {
      all_frames: false,
      js: ["content/cursor-motion.js", "content/agent-visual-indicator.js"],
      matches: ["<all_urls>"],
      run_at: "document_idle"
    }
  ],
  web_accessible_resources: [
    {
      matches: ["<all_urls>"],
      resources: [
        "content/accessibility-tree.js",
        "content/cursor-motion.js",
        "content/agent-visual-indicator.js"
      ],
      use_dynamic_url: false
    }
  ]
};

writeFileSync(join(extOutDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

await build({
  entryPoints: [join(rootDir, "src/mcp/server.ts")],
  outfile: join(mcpOutDir, "server.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  banner: {
    js: "#!/usr/bin/env node"
  }
});

await build({
  entryPoints: [join(rootDir, "src/bridge/daemon-entry.ts")],
  outfile: join(mcpOutDir, "daemon.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  banner: {
    js: "#!/usr/bin/env node"
  }
});

chmodSync(join(mcpOutDir, "server.js"), 0o755);
chmodSync(join(mcpOutDir, "daemon.js"), 0o755);

console.log("Built dist/extension and dist/mcp-server successfully.");
