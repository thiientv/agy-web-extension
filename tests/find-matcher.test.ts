import { describe, expect, it } from "vitest";
import { rankFindCandidates, type FindCandidateNode } from "../src/shared/find-matcher.js";

describe("rankFindCandidates", () => {
  const sampleNodes: FindCandidateNode[] = [
    {
      ref: "ref_1",
      depth: 1,
      role: "heading",
      name: "Welcome to Antigravity Store",
      meta: {
        visible: true,
        inViewport: true,
        disabled: false,
        texts: {}
      }
    },
    {
      ref: "ref_2",
      depth: 2,
      role: "textbox",
      name: "",
      placeholder: "Search organic products...",
      meta: {
        visible: true,
        inViewport: true,
        disabled: false,
        texts: { placeholder: "Search organic products...", ids: "global-search" }
      }
    },
    {
      ref: "ref_3",
      depth: 2,
      role: "button",
      name: "Add to Cart",
      meta: {
        visible: true,
        inViewport: true,
        disabled: false,
        texts: { text: "Add to Cart", container: "Organic Mango 500g $4.99" }
      }
    },
    {
      ref: "ref_4",
      depth: 2,
      role: "file-input",
      name: "Upload avatar",
      meta: {
        visible: false,
        inViewport: false,
        disabled: false,
        texts: { label: "Upload avatar" }
      }
    }
  ];

  it("ranks textbox highest when searching for 'search bar' via role synonyms and placeholder", () => {
    const res = rankFindCandidates(sampleNodes, "search field");
    expect(res.refs[0]).toBe("ref_2");
    expect(res.output).toContain("[ref_2]");
  });

  it("matches button inside container context when searching 'organic mango add to cart button'", () => {
    const res = rankFindCandidates(sampleNodes, "organic mango add to cart button");
    expect(res.refs[0]).toBe("ref_3");
    expect(res.matches).toBeGreaterThan(0);
  });

  it("matches hidden file input when searching 'upload file'", () => {
    const res = rankFindCandidates(sampleNodes, "upload file");
    expect(res.refs).toContain("ref_4");
  });

  it("prefers the actual textbox control over a preceding label with matching text when query asks for an input", () => {
    const labelAndInput: FindCandidateNode[] = [
      {
        ref: "ref_label",
        depth: 1,
        role: "label",
        name: "Product Search",
        meta: { visible: true, inViewport: true, disabled: false, texts: {} }
      },
      {
        ref: "ref_input",
        depth: 1,
        role: "textbox",
        name: "Search organic fruit...",
        placeholder: "Search organic fruit...",
        meta: {
          visible: true,
          inViewport: true,
          disabled: false,
          texts: { label: "Product Search", placeholder: "Search organic fruit..." }
        }
      }
    ];
    const res = rankFindCandidates(labelAndInput, "product search input");
    expect(res.refs[0]).toBe("ref_input");
  });

  it("returns noMatch message when nothing matches and no interactive fallback applies", () => {
    const res = rankFindCandidates([], "nonexistent quantum widget");
    expect(res.noMatch).toContain("No matching elements found");
  });
});
