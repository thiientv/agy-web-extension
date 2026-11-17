export interface FindNodeTexts {
  aria?: string;
  label?: string;
  placeholder?: string;
  title?: string;
  alt?: string;
  value?: string;
  text?: string;
  container?: string;
  ids?: string;
  describedby?: string;
}

export interface FindNodeMeta {
  visible: boolean;
  inViewport: boolean;
  disabled: boolean;
  texts: FindNodeTexts;
}

export interface FindCandidateNode {
  ref: string;
  depth: number;
  role: string;
  name: string;
  href?: string;
  placeholder?: string;
  options?: string[];
  meta?: FindNodeMeta;
}

export interface FindRankResult {
  output?: string;
  noMatch?: string;
  refs: string[];
  matches: number;
  total: number;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "file-input",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "slider",
  "spinbutton"
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "at", "with", "and", "or",
  "this", "that", "these", "is", "are", "be", "it", "its", "please", "me", "my",
  "your", "our", "i", "you", "we", "find", "locate", "get", "show", "click",
  "press", "tap", "hit", "select", "choose", "open", "go", "enter", "type",
  "fill", "use", "called", "named", "labeled", "labelled", "titled", "says",
  "which", "where", "element", "thing", "page", "one", "can", "want", "need",
  "from", "by", "near", "about", "into", "under", "above", "below", "inside",
  "within", "next", "there", "here"
]);

const ROLE_SYNONYMS = new Map<string, string[]>();
const ROLE_SYNONYM_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["button btn", "button file-input"],
  ["link hyperlink", "link"],
  ["field input box bar textbox textfield textarea", "textbox searchbox combobox"],
  ["checkbox tickbox", "checkbox"],
  ["radio", "radio"],
  ["dropdown select selector picker combobox", "combobox listbox"],
  ["tab", "tab"],
  ["heading headline title", "heading"],
  ["image img picture photo icon logo thumbnail", "image"],
  ["toggle switch", "switch checkbox"],
  ["slider", "slider"],
  ["option", "option"],
  ["menuitem", "menuitem"]
];

for (const [keys, targets] of ROLE_SYNONYM_GROUPS) {
  const targetList = targets.split(" ");
  for (const key of keys.split(" ")) {
    ROLE_SYNONYMS.set(key, targetList);
  }
}

const WORD_RE = /[\p{L}\p{N}]+/gu;
const CJK_THAI_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const HAN_RE = /\p{Script=Han}/u;

function stripMarks(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "");
}

function splitCamelCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function stemToken(token: string): string {
  if (token.length <= 3) {
    return token;
  }
  const stemmed = token.replace(/ies$/, "y").replace(/(ing|ed|es|s)$/, "");
  return stemmed || token;
}

function tokenizeQuery(query: string): string[] {
  if (!query) {
    return [];
  }
  return splitCamelCase(stripMarks(query)).toLowerCase().match(WORD_RE) ?? [];
}

function buildFieldStemSet(values: ReadonlyArray<string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const val of values) {
    if (!val) {
      continue;
    }
    const stripped = stripMarks(val);
    const split = splitCamelCase(stripped);
    for (const token of split.toLowerCase().match(WORD_RE) ?? []) {
      out.add(stemToken(token));
    }
    if (split !== stripped) {
      for (const token of stripped.toLowerCase().match(WORD_RE) ?? []) {
        out.add(stemToken(token));
      }
    }
  }
  return out;
}

function withinEditDistanceOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] !== b[j]) {
      edits += 1;
      if (edits > 1) {
        return false;
      }
      if (a.length > b.length) {
        i += 1;
      } else if (b.length > a.length) {
        j += 1;
      } else {
        i += 1;
        j += 1;
      }
    } else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function isFuzzyTokenMatch(queryStem: string, candidateStem: string): boolean {
  if (queryStem.length >= 4 && candidateStem.startsWith(queryStem)) {
    return true;
  }
  if (candidateStem.length >= 4 && queryStem.startsWith(candidateStem)) {
    return true;
  }
  if (queryStem.length >= 5 && withinEditDistanceOne(queryStem, candidateStem)) {
    return true;
  }
  if (
    CJK_THAI_RE.test(queryStem) &&
    (queryStem.length >= 3 || (queryStem.length === 2 && HAN_RE.test(queryStem))) &&
    candidateStem.includes(queryStem)
  ) {
    return true;
  }
  return false;
}

interface ScoredCandidate {
  node: FindCandidateNode;
  index: number;
  score: number;
}

function formatFindOutput(topItems: ReadonlyArray<ScoredCandidate>, matchedTotal: number): string {
  const lines = topItems.map(({ node }) => {
    const parts: string[] = [`${node.role}`];
    if (node.name) {
      parts.push(`"${node.name.replace(/"/g, '\\"')}"`);
    }
    parts.push(`[${node.ref}]`);
    if (node.placeholder) {
      parts.push(`placeholder="${node.placeholder.replace(/"/g, '\\"')}"`);
    }
    if (node.href) {
      parts.push(`href="${node.href.replace(/"/g, '\\"')}"`);
    }
    if (node.meta) {
      const flags: string[] = [];
      if (!node.meta.visible) {
        flags.push("hidden");
      } else if (!node.meta.inViewport) {
        flags.push("off-screen");
      }
      if (node.meta.disabled) {
        flags.push("disabled");
      }
      if (flags.length > 0) {
        parts.push(`(${flags.join(", ")})`);
      }
      if (node.meta.texts.container) {
        parts.push(`— context: "${node.meta.texts.container.slice(0, 100)}"`);
      }
    }
    return `- ${parts.join(" ")}`;
  });

  const shownDirect = Math.min(matchedTotal, topItems.length);
  const header =
    matchedTotal > 20
      ? `Found ${matchedTotal} matching elements (showing top 20 closest; use a more specific query to narrow down):`
      : `Found ${shownDirect} matching element${shownDirect === 1 ? "" : "s"}${
          topItems.length > shownDirect ? ", plus other controls on screen" : ""
        }:`;
  return `${header}\n${lines.join("\n")}`;
}

export function rankFindCandidates(
  nodes: ReadonlyArray<FindCandidateNode>,
  query: string,
  options?: { truncated?: boolean; metaPartial?: boolean }
): FindRankResult {
  const rawTokens = tokenizeQuery(query);
  const targetRoles = new Set<string>();
  const contentTerms: string[] = [];

  for (const token of rawTokens) {
    const mappedRoles = ROLE_SYNONYMS.get(token) ?? ROLE_SYNONYMS.get(stemToken(token));
    if (mappedRoles) {
      for (const role of mappedRoles) {
        targetRoles.add(role);
      }
    } else if (!STOP_WORDS.has(token)) {
      contentTerms.push(token);
    }
  }

  const roleOnlyQuery = contentTerms.length === 0 && targetRoles.size > 0;
  if (contentTerms.length === 0 && !roleOnlyQuery) {
    contentTerms.push(...rawTokens.slice(0, 16));
  }

  const queryStems = [...new Set(contentTerms.map(stemToken))].slice(0, 16);
  const phrase = contentTerms.join(" ");
  const scored: ScoredCandidate[] = [];

  nodes.forEach((node, index) => {
    const roleMatches = targetRoles.has(node.role);
    if (roleOnlyQuery && !roleMatches) {
      return;
    }

    const texts = node.meta?.texts ?? {};
    const primarySet = buildFieldStemSet([
      node.name,
      texts.label,
      texts.aria,
      texts.placeholder ?? node.placeholder,
      texts.title,
      texts.alt,
      texts.value,
      texts.text,
      node.role === "file-input" ? "file files upload attach" : undefined,
      ...(node.options ?? []).slice(0, 30)
    ]);
    const secondarySet = buildFieldStemSet([texts.ids, node.href]);
    const contextSet = buildFieldStemSet([texts.container, texts.describedby]);

    const buckets: ReadonlyArray<readonly [Set<string>, number]> = [
      [primarySet, 1.0],
      [secondarySet, 0.5],
      [contextSet, 0.3]
    ];

    let termScoreSum = 0;
    for (const qStem of queryStems) {
      let best = 0;
      for (const [bucket, weight] of buckets) {
        if (bucket.has(qStem)) {
          best = Math.max(best, weight);
        } else if (best < weight) {
          for (const candidateStem of bucket) {
            if (isFuzzyTokenMatch(qStem, candidateStem)) {
              best = Math.max(best, 0.7 * weight);
              break;
            }
          }
        }
      }
      termScoreSum += best;
    }

    let finalScore = queryStems.length > 0 ? termScoreSum / queryStems.length : 0;
    if (finalScore === 0 && !roleOnlyQuery) {
      return;
    }
    if (roleMatches) {
      finalScore += 0.4;
    }

    const normalizedName = stripMarks(
      [node.name, texts.label, texts.placeholder].filter(Boolean).join(" ")
    );
    if (
      phrase &&
      (splitCamelCase(normalizedName).toLowerCase().includes(phrase) ||
        normalizedName.toLowerCase().includes(phrase))
    ) {
      finalScore += 0.3;
    }
    if (node.meta && !node.meta.visible) {
      finalScore *= 0.8;
    }

    scored.push({ node, index, score: finalScore });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const directMatchCount = scored.filter((item) => item.score > 0 || roleOnlyQuery).length;

  if (directMatchCount > 0) {
    const includedIndices = new Set(scored.map((item) => item.index));
    const appendFallback = (predicate: (candidate: FindCandidateNode) => boolean): void => {
      nodes.forEach((candidate, idx) => {
        if (!includedIndices.has(idx) && predicate(candidate)) {
          includedIndices.add(idx);
          scored.push({ node: candidate, index: idx, score: 0 });
        }
      });
    };

    if (targetRoles.size > 0) {
      appendFallback((candidate) => targetRoles.has(candidate.role));
    }
    appendFallback(
      (candidate) =>
        INTERACTIVE_ROLES.has(candidate.role) &&
        Boolean(candidate.meta?.visible) &&
        Boolean(candidate.meta?.inViewport)
    );
  }

  const topItems = scored.slice(0, 20);
  const notices: string[] = [];
  if (scored[20]?.score && scored[20].score === scored[0]?.score) {
    notices.push("To see the others, use a more specific query.");
  }
  if (options?.truncated) {
    notices.push(
      "Only the first part of the page was searched, so an element further down may be missing."
    );
  }
  if (options?.metaPartial) {
    notices.push(
      "Elements late in the page were searched by their names only, and their lines do not say whether they are hidden, off-screen or disabled."
    );
  }
  const suffix = notices.length > 0 ? `\n\n${notices.join(" ")}` : "";

  if (topItems.length === 0) {
    return {
      noMatch: `No matching elements found. Try words that appear on the page, or use read_page to list its elements.${suffix}`,
      refs: [],
      matches: 0,
      total: 0
    };
  }

  return {
    output: `${formatFindOutput(topItems, directMatchCount)}${suffix}`,
    refs: topItems.map((item) => item.node.ref),
    matches: Math.min(directMatchCount, 20),
    total: directMatchCount
  };
}
