export interface ToolDefinitionSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const BROWSER_TOOL_SCHEMAS: ReadonlyArray<ToolDefinitionSchema> = [
  {
    name: "tabs_context_mcp",
    description:
      "Get context information about the current MCP tab group and connected Chrome profiles. Returns all tab IDs inside the group if it exists, along with the active Chrome profile and all connected profiles. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. When multiple Chrome profiles are open, pass `profile` to select or switch the Chrome profile for this session. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.",
    inputSchema: {
      type: "object",
      properties: {
        createIfEmpty: {
          type: "boolean",
          description:
            "Creates a new MCP tab group if none exists, containing a background tab (active: false) without disturbing the user's focused tab or mouse cursor. If an MCP tab group already exists for this session, this parameter has no effect."
        },
        profile: {
          type: "string",
          description:
            "Optional Chrome profile selector (matches the custom profile name set in the extension popup, the Google account email of the profile, or its profileId). Pins this session to the selected Chrome profile so subsequent tool calls stay on that profile. Omit to use the currently bound or most recently focused Chrome profile."
        }
      },
      required: []
    }
  },
  {
    name: "tabs_create_mcp",
    description:
      "Creates a new empty background tab (active: false) inside this session's MCP tab group without stealing focus or moving the user's active tab.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "tabs_close_mcp",
    description:
      "Close a tab in the MCP tab group by its tab ID. Use when you're done with a tab to keep the browser tidy. Only tabs in this session's group can be closed.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "integer",
          description:
            "The ID of the tab to close. Must be in this session's tab group — call tabs_context_mcp first to see valid IDs."
        }
      },
      required: ["tabId"]
    }
  },
  {
    name: "navigate",
    description:
      "Navigate to a URL, or go forward/back in browser history in the specified tab without stealing focus. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'
        },
        tabId: {
          type: "number",
          description:
            "Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        },
        force: {
          type: "boolean",
          description:
            'If the page shows a "Leave site?" beforeunload dialog because of unsaved changes, discard those changes and navigate anyway. Defaults to false.'
        }
      },
      required: ["url", "tabId"]
    }
  },
  {
    name: "read_page",
    description:
      "Get an accessibility tree representation of elements on the page with stable ref IDs (e.g. ref_1, ref_2). By default returns all elements including non-visible ones. Output is limited to 50000 characters by default.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["interactive", "all"],
          description:
            'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: "all").'
        },
        tabId: {
          type: "number",
          description:
            "Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        },
        depth: {
          type: "number",
          description:
            "Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."
        },
        ref_id: {
          type: "string",
          description:
            "Reference ID of a parent element to read. Returns the specified element and all its children."
        },
        max_chars: {
          type: "number",
          description:
            "Maximum characters for output (default: 50000)."
        }
      },
      required: ["tabId"]
    }
  },
  {
    name: "find",
    description:
      'Find elements on the page using natural language. Searches by purpose (e.g., "search bar", "login button") or text content (e.g., "organic mango product"). Returns up to 20 matching elements with ref IDs (e.g., ref_1) usable in computer, form_input, and file_upload.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic").'
        },
        tabId: {
          type: "number",
          description:
            "Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        }
      },
      required: ["query", "tabId"]
    }
  },
  {
    name: "form_input",
    description:
      "Set values in form elements (inputs, textareas, checkboxes, radios, selects, contenteditable) using an element reference ID from read_page or find.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description:
            'Element reference ID from read_page or find (e.g., "ref_1", "ref_2").'
        },
        value: {
          type: ["string", "boolean", "number"],
          description:
            "The value to set. For checkboxes/radios use boolean, for selects use option value or visible text, for other inputs use string or number."
        },
        tabId: {
          type: "number",
          description:
            "Tab ID to set form value in. Must be a tab in the current group."
        }
      },
      required: ["ref", "value", "tabId"]
    }
  },
  {
    name: "computer",
    description:
      "Use virtual CDP mouse and keyboard to interact with a web tab in the background without moving the user's physical cursor or switching tabs, and capture screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "left_click",
            "right_click",
            "type",
            "screenshot",
            "wait",
            "scroll",
            "key",
            "left_click_drag",
            "double_click",
            "triple_click",
            "zoom",
            "scroll_to",
            "hover"
          ],
          description:
            "Action to perform: left_click, right_click, double_click, triple_click, hover, left_click_drag, scroll, scroll_to, type, key, wait, screenshot, or zoom."
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description:
            "(x, y) coordinates in the full-resolution screenshot frame. Required for click/hover/scroll/drag actions when ref is not supplied."
        },
        text: {
          type: "string",
          description:
            'Text to type (for `type`) or space-separated key chords (for `key`, e.g. "Backspace Enter", "cmd+a", "ctrl+a"). Page zoom shortcuts ("cmd+=", "ctrl+-", "cmd+0") are rejected; use `zoom` instead.'
        },
        duration: {
          type: "number",
          minimum: 0,
          maximum: 10,
          description: "Seconds to wait for `wait` action (max 10)."
        },
        scroll_direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Direction to scroll for `scroll` action."
        },
        scroll_amount: {
          type: "number",
          minimum: 1,
          maximum: 10,
          description: "Number of scroll wheel ticks (default: 3)."
        },
        start_coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "Starting [x, y] coordinates for `left_click_drag`."
        },
        region: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
          description: "Region [x0, y0, x1, y1] for `zoom` action."
        },
        scale: {
          type: "number",
          minimum: 0.1,
          maximum: 1,
          description:
            "Scale factor in [0.1, 1] for `screenshot` and `zoom` output size (default: 1)."
        },
        repeat: {
          type: "number",
          minimum: 1,
          maximum: 100,
          description: "Repeat count for `key` action (1-100, default: 1)."
        },
        ref: {
          type: "string",
          description:
            'Element reference ID from read_page or find (e.g., "ref_1"). Required for `scroll_to`; can be used instead of `coordinate` for click and hover actions.'
        },
        modifiers: {
          type: "string",
          description:
            'Modifier keys for click actions: "ctrl", "shift", "alt", "cmd" ("meta"), combinable with "+".'
        },
        tabId: {
          type: "number",
          description: "Tab ID to execute the action on."
        }
      },
      required: ["action", "tabId"]
    }
  },
  {
    name: "javascript_tool",
    description:
      "Execute JavaScript code in the context of the page with REPL semantics (top-level await supported; last expression value returned automatically).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Must be set to 'javascript_exec'."
        },
        text: {
          type: "string",
          description:
            "The JavaScript code to evaluate in the page context."
        },
        tabId: {
          type: "number",
          description: "Tab ID to execute the code in."
        }
      },
      required: ["action", "text", "tabId"]
    }
  },
  {
    name: "get_page_text",
    description:
      "Extract raw readable text content from the page, prioritizing article/main content without HTML formatting.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Tab ID to extract text from."
        },
        max_chars: {
          type: "number",
          description: "Maximum characters for output (default: 50000)."
        }
      },
      required: ["tabId"]
    }
  },
  {
    name: "read_console_messages",
    description:
      "Read browser console messages and uncaught exceptions captured from a specific tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Tab ID to read console messages from."
        },
        onlyErrors: {
          type: "boolean",
          description: "If true, only return error and exception messages (default: false)."
        },
        clear: {
          type: "boolean",
          description: "If true, clear captured messages after reading (default: false)."
        },
        pattern: {
          type: "string",
          description: "Regex pattern to filter console messages."
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 100)."
        }
      },
      required: ["tabId"]
    }
  },
  {
    name: "read_network_requests",
    description:
      "Read HTTP/XHR/Fetch network requests captured on a specific tab (with sensitive auth query params redacted).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "Tab ID to read network requests from."
        },
        urlPattern: {
          type: "string",
          description: "Substring filter matched against the redacted request URL."
        },
        clear: {
          type: "boolean",
          description: "If true, clear captured requests after reading (default: false)."
        },
        limit: {
          type: "number",
          description: "Maximum number of requests to return (default: 100)."
        }
      },
      required: ["tabId"]
    }
  },
  {
    name: "resize_window",
    description:
      "Resize the browser window containing the specified tab to exact pixel dimensions.",
    inputSchema: {
      type: "object",
      properties: {
        width: {
          type: "number",
          description: "Target window width in pixels."
        },
        height: {
          type: "number",
          description: "Target window height in pixels."
        },
        tabId: {
          type: "number",
          description: "Tab ID whose browser window should be resized."
        }
      },
      required: ["width", "height", "tabId"]
    }
  },
  {
    name: "upload_image",
    description:
      "Upload a previously captured screenshot (by imageId) to a file input (via ref) or drag & drop target (via coordinate).",
    inputSchema: {
      type: "object",
      properties: {
        imageId: {
          type: "string",
          description: "ID of a previously captured screenshot returned by `computer` screenshot."
        },
        ref: {
          type: "string",
          description: "Element reference ID (e.g. ref_1) for file inputs."
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          description: "[x, y] coordinates for drag & drop targets."
        },
        tabId: {
          type: "number",
          description: "Tab ID where the target element is located."
        },
        filename: {
          type: "string",
          description: 'Optional filename (default: "image.png").'
        }
      },
      required: ["imageId", "tabId"]
    }
  },
  {
    name: "file_upload",
    description:
      "Upload one or multiple files to a file input element on the page without opening the native OS file dialog. Pass either `files` (base64) or local filesystem `paths` (resolved automatically by the local MCP server).",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              data: { type: "string" },
              name: { type: "string" },
              mimeType: { type: "string" }
            },
            required: ["data", "name"]
          },
          description: "Files to upload as base64-encoded bytes."
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Local filesystem paths to read and upload."
        },
        ref: {
          type: "string",
          description: 'Element reference ID of the file input from read_page or find (e.g., "ref_1").'
        },
        tabId: {
          type: "number",
          description: "Tab ID where the file input is located."
        }
      },
      required: ["ref", "tabId"]
    }
  },
  {
    name: "gif_creator",
    description:
      "Record browser automation frames in a tab group and export an animated GIF with click rings, drag arrows, action labels, and progress bar.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start_recording", "stop_recording", "export", "clear"],
          description: "Lifecycle action for GIF recording."
        },
        tabId: {
          type: "number",
          description: "Tab ID identifying the tab group."
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          description: "[x, y] coordinates for drag & drop upload when download is not true."
        },
        download: {
          type: "boolean",
          description: "If true, download the generated GIF via Chrome downloads."
        },
        filename: {
          type: "string",
          description: "Optional filename for exported GIF."
        },
        options: {
          type: "object",
          properties: {
            showClickIndicators: { type: "boolean" },
            showDragPaths: { type: "boolean" },
            showActionLabels: { type: "boolean" },
            showProgressBar: { type: "boolean" },
            showWatermark: { type: "boolean" },
            quality: { type: "number" }
          }
        }
      },
      required: ["action", "tabId"]
    }
  }
];
