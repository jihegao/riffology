#!/usr/bin/env bash

set -euo pipefail

script_source="$0"
if [ -n "${BASH_SOURCE:-}" ]; then
  script_source="${BASH_SOURCE[0]}"
fi
script_dir="$(cd "$(dirname "${script_source}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "docs check: Node.js is required but was not found" >&2
  exit 1
fi

echo "docs check: validating Markdown links and active-document status"

DOCS_REPO_ROOT="${repo_root}" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = process.env.DOCS_REPO_ROOT;
const markdownOutput = execFileSync(
  "git",
  ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", "*.md"],
  { cwd: repoRoot },
);
const markdownFiles = markdownOutput
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((markdownFile) => {
    const absoluteFile = path.join(repoRoot, markdownFile);
    return fs.existsSync(absoluteFile) && fs.statSync(absoluteFile).isFile();
  });

const failures = [];
const seenLinks = new Set();

function lineNumberAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function extractDestination(rawDestination) {
  const trimmed = rawDestination.trim();
  if (trimmed.startsWith("<")) {
    const closingBracket = trimmed.indexOf(">");
    return closingBracket === -1
      ? trimmed.slice(1)
      : trimmed.slice(1, closingBracket);
  }
  return trimmed.split(/\s+/, 1)[0].replace(/\\(.)/g, "$1");
}

function maskFencedCode(markdown) {
  let activeFence = null;
  const lines = markdown.match(/[^\n]*(?:\n|$)/g) || [];

  const blockMaskedMarkdown = lines
    .filter((line, index) => line !== "" || index < lines.length - 1)
    .map((line) => {
      const content = line.replace(/\r?\n$/, "");
      const openingFence = content.match(/^ {0,3}(`{3,}|~{3,})/);
      const indentedCode = /^(?: {4}|\t)/.test(content);
      let shouldMask = activeFence !== null || indentedCode;

      if (activeFence === null && openingFence) {
        activeFence = {
          character: openingFence[1][0],
          length: openingFence[1].length,
        };
        shouldMask = true;
      } else if (activeFence !== null) {
        const escapedCharacter = activeFence.character.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const closingFence = new RegExp(
          `^ {0,3}${escapedCharacter}{${activeFence.length},}\\s*$`,
        );
        if (closingFence.test(content)) {
          activeFence = null;
        }
      }

      return shouldMask ? line.replace(/[^\r\n]/g, " ") : line;
    })
    .join("");

  const characters = blockMaskedMarkdown.split("");
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== "`") {
      continue;
    }

    let openingEnd = index;
    while (characters[openingEnd] === "`") {
      openingEnd += 1;
    }
    const delimiterLength = openingEnd - index;
    let searchIndex = openingEnd;
    let closingEnd = -1;

    while (searchIndex < characters.length) {
      if (characters[searchIndex] !== "`") {
        searchIndex += 1;
        continue;
      }

      let candidateEnd = searchIndex;
      while (characters[candidateEnd] === "`") {
        candidateEnd += 1;
      }
      if (candidateEnd - searchIndex === delimiterLength) {
        closingEnd = candidateEnd;
        break;
      }
      searchIndex = candidateEnd;
    }

    if (closingEnd === -1) {
      index = openingEnd - 1;
      continue;
    }

    for (let maskIndex = index; maskIndex < closingEnd; maskIndex += 1) {
      if (characters[maskIndex] !== "\r" && characters[maskIndex] !== "\n") {
        characters[maskIndex] = " ";
      }
    }
    index = closingEnd - 1;
  }

  return characters.join("");
}

function inlineDestinations(markdown, searchableMarkdown) {
  const destinations = [];

  for (let index = 0; index < searchableMarkdown.length - 1; index += 1) {
    if (
      searchableMarkdown[index] !== "]" ||
      searchableMarkdown[index + 1] !== "("
    ) {
      continue;
    }

    let cursor = index + 2;
    while (cursor < searchableMarkdown.length && /[ \t]/.test(searchableMarkdown[cursor])) {
      cursor += 1;
    }
    const destinationStart = cursor;

    if (searchableMarkdown[cursor] === "<") {
      cursor += 1;
      while (cursor < searchableMarkdown.length) {
        if (searchableMarkdown[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (searchableMarkdown[cursor] === ">") {
          destinations.push({
            rawDestination: markdown.slice(destinationStart, cursor + 1),
            offset: index,
          });
          break;
        }
        if (searchableMarkdown[cursor] === "\n") {
          break;
        }
        cursor += 1;
      }
      continue;
    }

    let parenthesisDepth = 1;
    while (cursor < searchableMarkdown.length) {
      const character = searchableMarkdown[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === "\n") {
        break;
      }
      if (character === "(") {
        parenthesisDepth += 1;
      } else if (character === ")") {
        parenthesisDepth -= 1;
        if (parenthesisDepth === 0) {
          destinations.push({
            rawDestination: markdown.slice(destinationStart, cursor),
            offset: index,
          });
          break;
        }
      }
      cursor += 1;
    }
  }

  return destinations;
}

function activeDocumentMetadata(searchableMarkdown) {
  const leadingLines = searchableMarkdown.split("\n").slice(0, 30);
  const metadata = new Map();
  const metadataPattern =
    /^-\s+(?:\*\*)?(Status|Role|Scope|Source of truth|Last reviewed)(?:\*\*)?:\s*(.+?)\s*$/i;

  for (const line of leadingLines) {
    const match = line.match(metadataPattern);
    if (match) {
      metadata.set(match[1].toLowerCase(), match[2]);
    }
  }

  const status = metadata.get("status") || "";
  return {
    isActive: /^(?:active|proposed)\b/i.test(status),
    metadata,
  };
}

function checkLink(markdownFile, markdown, rawDestination, offset) {
  let destination = extractDestination(rawDestination);
  if (
    destination === "" ||
    destination.startsWith("#") ||
    destination.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(destination)
  ) {
    return;
  }

  destination = destination.split("#", 1)[0].split("?", 1)[0];
  if (destination === "") {
    return;
  }

  try {
    destination = decodeURIComponent(destination);
  } catch {
    failures.push(
      `${markdownFile}:${lineNumberAt(markdown, offset)}: invalid URL encoding in link "${destination}"`,
    );
    return;
  }

  const target = destination.startsWith("/")
    ? path.resolve(repoRoot, `.${destination}`)
    : path.resolve(repoRoot, path.dirname(markdownFile), destination);
  const relativeTarget = path.relative(repoRoot, target);
  const linkKey = `${markdownFile}:${offset}:${destination}`;

  if (seenLinks.has(linkKey)) {
    return;
  }
  seenLinks.add(linkKey);

  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    !fs.existsSync(target)
  ) {
    failures.push(
      `${markdownFile}:${lineNumberAt(markdown, offset)}: missing relative link target "${destination}"`,
    );
  }
}

for (const markdownFile of markdownFiles) {
  const absoluteFile = path.join(repoRoot, markdownFile);
  const markdown = fs.readFileSync(absoluteFile, "utf8");
  const searchableMarkdown = maskFencedCode(markdown);

  for (const link of inlineDestinations(markdown, searchableMarkdown)) {
    checkLink(markdownFile, markdown, link.rawDestination, link.offset);
  }

  const referenceLinkPattern = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const match of searchableMarkdown.matchAll(referenceLinkPattern)) {
    checkLink(markdownFile, markdown, match[1], match.index);
  }

  const documentMetadata = activeDocumentMetadata(searchableMarkdown);
  if (!documentMetadata.isActive) {
    continue;
  }

  for (const requiredField of [
    "status",
    "role",
    "scope",
    "source of truth",
    "last reviewed",
  ]) {
    if (!documentMetadata.metadata.has(requiredField)) {
      failures.push(
        `${markdownFile}:1: active document is missing leading "${requiredField}" metadata`,
      );
    }
  }

  const stalePatterns = [
    /\bA3-2a2[abc]\b.{0,180}?\bcurrent\s+branch\b/gis,
    /\bcurrent\s+branch\b.{0,180}?\bA3-2a2[abc]\b/gis,
    /\b(?:plus|and)\s+current\s+A3-2a2[abc](?:\s+branch(?:\s+boundary)?)?\b/gis,
    /\bA3-2a2[abc]\b.{0,180}?\bnot\s+yet\s+(?:merged|published)(?:\s*\/\s*(?:merged|published))?\b/gis,
    /\bA3-2a2[abc]\b.{0,180}?\b(?:has|have|had)\s+not\s+(?:yet\s+)?been\s+(?:merged|published)\b/gis,
  ];
  const seenStaleOffsets = new Set();

  for (const stalePattern of stalePatterns) {
    for (const match of searchableMarkdown.matchAll(stalePattern)) {
      if (seenStaleOffsets.has(match.index)) {
        continue;
      }
      seenStaleOffsets.add(match.index);
      const excerpt = match[0].replace(/\s+/g, " ").slice(0, 180);
      failures.push(
        `${markdownFile}:${lineNumberAt(markdown, match.index)}: stale merged-slice status "${excerpt}"`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("docs check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`docs check: ${markdownFiles.length} Markdown files passed`);
NODE

echo "docs check: validating Git whitespace"
git -C "${repo_root}" diff --check
git -C "${repo_root}" diff --cached --check

echo "docs check: passed"
