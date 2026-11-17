import type { FindCandidateNode } from "../shared/find-matcher.js";

interface AccessibilityWindow extends Window {
  __claudeElementMap?: Record<string, WeakRef<Element>>;
  __generateAccessibilityTree?: (
    filter: string,
    depth: number | null,
    maxChars: number | null,
    refId: string | null,
    options?: {
      findData?: boolean;
      fileInputRefs?: boolean;
      redactMaskedFields?: boolean;
    }
  ) => {
    error?: string;
    pageContent: string;
    viewport: { width: number; height: number };
    findNodes?: FindCandidateNode[];
    findTruncated?: boolean;
    findMetaPartial?: boolean;
    fileInputRefs?: string[];
  };
  __agyBgClickGuard?: {
    armed: boolean;
    armedAt: number;
    hrefs: string[];
    installed: boolean;
  };
}

export interface ReadPageResult {
  error?: string;
  pageContent: string;
  viewport: { width: number; height: number };
  findNodes?: FindCandidateNode[];
  findTruncated?: boolean;
  findMetaPartial?: boolean;
  fileInputRefs?: string[];
}

export interface ElementBoxResult {
  ok: boolean;
  error?: string;
  x?: number;
  y?: number;
  tagName?: string;
}

export interface UploadFilePayload {
  name: string;
  data: string;
  mimeType: string;
}

async function ensureAccessibilityScriptInjected(tabId: number): Promise<void> {
  const probe = await chrome.scripting.executeScript({
    target: { tabId },
    func: () =>
      typeof (window as unknown as AccessibilityWindow).__generateAccessibilityTree ===
      "function"
  });
  if (probe[0]?.result === true) {
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/accessibility-tree.js"]
  });
}

export async function executeReadPageTree(
  tabId: number,
  options: {
    filter?: string;
    depth?: number | null;
    maxChars?: number | null;
    refId?: string | null;
    findData?: boolean;
  }
): Promise<ReadPageResult> {
  await ensureAccessibilityScriptInjected(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (
      filterArg: string,
      depthArg: number | null,
      maxCharsArg: number | null,
      refIdArg: string | null,
      wantFindData: boolean
    ) => {
      const win = window as unknown as AccessibilityWindow;
      if (typeof win.__generateAccessibilityTree !== "function") {
        return {
          error: "Accessibility tree helper is unavailable on this page.",
          pageContent: "",
          viewport: { width: window.innerWidth, height: window.innerHeight }
        };
      }
      return win.__generateAccessibilityTree(filterArg, depthArg, maxCharsArg, refIdArg, {
        findData: wantFindData,
        fileInputRefs: wantFindData,
        redactMaskedFields: true
      });
    },
    args: [
      options.filter ?? "all",
      options.depth ?? null,
      options.maxChars ?? null,
      options.refId ?? null,
      Boolean(options.findData)
    ]
  });

  const first = results[0]?.result;
  if (!first) {
    throw new Error("No accessibility tree result returned from tab.");
  }
  return first;
}

export async function resolveElementViewportCenter(
  tabId: number,
  ref: string,
  scrollIntoView: boolean
): Promise<ElementBoxResult> {
  await ensureAccessibilityScriptInjected(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (targetRef: string, shouldScroll: boolean): ElementBoxResult => {
      const win = window as unknown as AccessibilityWindow;
      const weak = win.__claudeElementMap?.[targetRef];
      const el = weak?.deref();
      if (!el || !el.isConnected) {
        return {
          ok: false,
          error: `Element "${targetRef}" was not found or is no longer attached to the DOM. Call read_page or find to refresh refs.`
        };
      }
      if (shouldScroll) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return {
          ok: false,
          error: `Element "${targetRef}" has zero visible dimensions (0x0).`
        };
      }
      return {
        ok: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        tagName: el.tagName.toLowerCase()
      };
    },
    args: [ref, scrollIntoView]
  });

  return (
    results[0]?.result ?? {
      ok: false,
      error: `Failed to resolve element "${ref}".`
    }
  );
}

export async function executeSetFormInput(
  tabId: number,
  ref: string,
  value: string | number | boolean
): Promise<{ ok: boolean; message: string }> {
  await ensureAccessibilityScriptInjected(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (
      targetRef: string,
      inputVal: string | number | boolean
    ): { ok: boolean; message: string } => {
      const win = window as unknown as AccessibilityWindow;
      const rawEl = win.__claudeElementMap?.[targetRef]?.deref();
      if (!rawEl || !rawEl.isConnected) {
        return {
          ok: false,
          message: `Element "${targetRef}" not found. Call read_page or find to obtain a fresh ref.`
        };
      }
      const el = rawEl instanceof HTMLLabelElement && rawEl.control ? rawEl.control : rawEl;

      const tag = el.tagName.toLowerCase();
      if (el instanceof HTMLInputElement) {
        const inputType = (el.getAttribute("type") ?? "text").toLowerCase();
        if (inputType === "checkbox" || inputType === "radio") {
          const desired =
            typeof inputVal === "boolean"
              ? inputVal
              : String(inputVal).toLowerCase() === "true" || String(inputVal) === "1";
          if (el.checked !== desired) {
            el.click();
            if (el.checked !== desired) {
              el.checked = desired;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
          return {
            ok: true,
            message: `Set ${inputType} [${targetRef}] checked=${String(el.checked)}.`
          };
        }

        el.focus();
        const strVal = String(inputVal);
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        if (setter) {
          setter.call(el, strVal);
        } else {
          el.value = strVal;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, message: `Updated input [${targetRef}] value.` };
      }

      if (el instanceof HTMLTextAreaElement) {
        el.focus();
        const strVal = String(inputVal);
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        if (setter) {
          setter.call(el, strVal);
        } else {
          el.value = strVal;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, message: `Updated textarea [${targetRef}] value.` };
      }

      if (el instanceof HTMLSelectElement) {
        const target = String(inputVal);
        const options = Array.from(el.options);
        const match =
          options.find((opt) => opt.value === target) ??
          options.find((opt) => (opt.textContent ?? "").trim() === target) ??
          options.find((opt) =>
            (opt.textContent ?? "").trim().toLowerCase().includes(target.toLowerCase())
          );
        if (!match) {
          return {
            ok: false,
            message: `No option matching "${target}" found in select [${targetRef}].`
          };
        }
        el.value = match.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          ok: true,
          message: `Selected option "${(match.textContent ?? match.value).trim()}" in [${targetRef}].`
        };
      }

      if (el instanceof HTMLElement && el.isContentEditable) {
        el.focus();
        el.textContent = String(inputVal);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(inputVal) }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, message: `Updated contenteditable [${targetRef}].` };
      }

      return {
        ok: false,
        message: `Element [${targetRef}] (<${tag}>) is not an editable form control.`
      };
    },
    args: [ref, value]
  });

  return (
    results[0]?.result ?? {
      ok: false,
      message: `Failed to execute form_input on [${ref}].`
    }
  );
}

export async function executeGetPageText(
  tabId: number,
  maxChars: number
): Promise<{
  text: string;
  title: string;
  url: string;
  source: string;
  error?: string;
}> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (limitChars: number) => {
      const selectors = [
        "article",
        "main",
        '[class*="articleBody"]',
        '[class*="article-body"]',
        '[class*="post-content"]',
        '[class*="entry-content"]',
        '[class*="content-body"]',
        '[role="main"]',
        ".content",
        "#content"
      ];

      let container: HTMLElement | null = null;
      for (const sel of selectors) {
        const matches = document.querySelectorAll<HTMLElement>(sel);
        if (matches.length > 0) {
          let best = matches[0] ?? null;
          let bestLen = 0;
          matches.forEach((candidate) => {
            const len = candidate.innerText?.length ?? 0;
            if (len > bestLen) {
              bestLen = len;
              best = candidate;
            }
          });
          container = best;
          break;
        }
      }

      if (!container) {
        container = document.body;
      }

      const cleanText = (node: HTMLElement | null): string =>
        (node?.innerText ?? "")
          .replace(/[^\S\n]+/g, " ")
          .replace(/ ?\n ?/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

      let extracted = cleanText(container);
      if (extracted.length < 10 && document.body && container !== document.body) {
        container = document.body;
        extracted = cleanText(container);
      }

      if (extracted.length === 0) {
        return {
          text: "",
          source: "none",
          title: document.title,
          url: window.location.href,
          error:
            "No text content found. Page may contain only images, videos, or canvas-rendered content."
        };
      }

      if (extracted.length > limitChars) {
        const total = extracted.length;
        let cut = extracted.lastIndexOf("\n", limitChars);
        if (cut <= 0) {
          cut = Math.max(0, limitChars);
        }
        extracted = `${extracted.slice(0, cut)}\n\n[output truncated at ${limitChars} of ${total} characters. Pass a larger max_chars (default 50000) to see more.]`;
      }

      return {
        text: extracted,
        source: container?.tagName.toLowerCase() ?? "body",
        title: document.title,
        url: window.location.href
      };
    },
    args: [maxChars]
  });

  const res = results[0]?.result;
  if (!res) {
    throw new Error("Failed to extract page text.");
  }
  return res;
}

export async function executeFileUploadOnRef(
  tabId: number,
  ref: string,
  files: ReadonlyArray<UploadFilePayload>
): Promise<{ ok: boolean; message: string }> {
  await ensureAccessibilityScriptInjected(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (
      targetRef: string,
      items: ReadonlyArray<UploadFilePayload>
    ): { ok: boolean; message: string } => {
      const win = window as unknown as AccessibilityWindow;
      const el = win.__claudeElementMap?.[targetRef]?.deref();
      if (!el || !el.isConnected) {
        return {
          ok: false,
          message: `Element "${targetRef}" not found. Call read_page or find first.`
        };
      }

      let fileInput: HTMLInputElement | null = null;
      if (el instanceof HTMLInputElement && el.type.toLowerCase() === "file") {
        fileInput = el;
      } else {
        fileInput = el.querySelector('input[type="file"]');
      }

      if (!fileInput) {
        return {
          ok: false,
          message: `Element "${targetRef}" is not an <input type="file">.`
        };
      }

      const dt = new DataTransfer();
      for (const item of items) {
        const binary = atob(item.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        const file = new File([bytes], item.name, {
          type: item.mimeType || "application/octet-stream"
        });
        dt.items.add(file);
      }

      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        message: `Uploaded ${items.length} file(s) (${items.map((f) => f.name).join(", ")}) to [${targetRef}].`
      };
    },
    args: [ref, files]
  });

  return (
    results[0]?.result ?? {
      ok: false,
      message: "File upload script execution failed."
    }
  );
}

export async function executeDropFileAtPoint(
  tabId: number,
  x: number,
  y: number,
  filePayload: UploadFilePayload
): Promise<{ ok: boolean; message: string }> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (
      dropX: number,
      dropY: number,
      payload: UploadFilePayload
    ): { ok: boolean; message: string } => {
      const target = document.elementFromPoint(dropX, dropY) ?? document.body;
      if (!target) {
        return { ok: false, message: "No target element found at drop coordinates." };
      }

      const binary = atob(payload.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const file = new File([bytes], payload.name, {
        type: payload.mimeType || "image/png"
      });
      const dt = new DataTransfer();
      dt.items.add(file);

      for (const eventType of ["dragenter", "dragover", "drop"] as const) {
        const evt = new DragEvent(eventType, {
          bubbles: true,
          cancelable: true,
          clientX: dropX,
          clientY: dropY,
          dataTransfer: dt
        });
        target.dispatchEvent(evt);
      }
      return {
        ok: true,
        message: `Dropped "${payload.name}" onto <${target.tagName.toLowerCase()}> at (${dropX}, ${dropY}).`
      };
    },
    args: [x, y, filePayload]
  });

  return (
    results[0]?.result ?? {
      ok: false,
      message: "Failed to dispatch drop event."
    }
  );
}

export async function armTabBackgroundClickGuard(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const win = window as unknown as AccessibilityWindow;
        const guard = (win.__agyBgClickGuard ??= {
          armed: false,
          armedAt: 0,
          hrefs: [],
          installed: false
        });
        guard.armed = true;
        guard.armedAt = Date.now();
        guard.hrefs = [];
        if (!guard.installed) {
          guard.installed = true;
          window.addEventListener(
            "click",
            (evt) => {
              if (!guard.armed || Date.now() - guard.armedAt > 10000) {
                return;
              }
              if (!evt.isTrusted || evt.defaultPrevented) {
                return;
              }
              const path = typeof evt.composedPath === "function" ? evt.composedPath() : [evt.target];
              let anchor: HTMLAnchorElement | null = null;
              for (const node of path) {
                if (node instanceof HTMLAnchorElement && node.hasAttribute("href")) {
                  anchor = node;
                  break;
                }
              }
              if (!anchor) {
                return;
              }
              const targetAttr = (anchor.getAttribute("target") ?? "").trim().toLowerCase();
              if (targetAttr === "_blank" && /^https?:/i.test(anchor.href)) {
                evt.preventDefault();
                guard.hrefs.push(anchor.href);
              }
            },
            true
          );
        }
      }
    });
  } catch {
    // Ignore on chrome:// or restricted pages.
  }
}

export async function drainTabBackgroundClickGuard(tabId: number): Promise<string[]> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (): string[] => {
        const win = window as unknown as AccessibilityWindow;
        const guard = win.__agyBgClickGuard;
        if (!guard) {
          return [];
        }
        guard.armed = false;
        const collected = [...guard.hrefs];
        guard.hrefs = [];
        return collected;
      }
    });
    return results[0]?.result ?? [];
  } catch {
    return [];
  }
}
