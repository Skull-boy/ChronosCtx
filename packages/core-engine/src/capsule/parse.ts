import { ChronosError } from "@chronos-ctx/shared-types";
import { CAPSULE_HEADER } from "./types.js";

/**
 * Parser for the model-visible capsule text (ADR-0009).
 *
 * It exists for two reasons: `chronos capsule verify` must reject a file that
 * is not a capsule, and the tests assert the section order is the contract
 * rather than a renderer accident.
 */

export const CAPSULE_SECTIONS = {
  verified: "VERIFIED (trust):",
  hypotheses: "HYPOTHESES (validate before use):",
  constraints: "DO NOT RETRY (caution unless promoted):",
  sideEffects: "SIDE EFFECTS IN RANGE:",
  resume: "RESUME PROTOCOL:",
} as const;

export type CapsuleSectionName = keyof typeof CAPSULE_SECTIONS;

export interface ParsedCapsule {
  project: string;
  projectId: string;
  branch: string;
  head: string;
  tree: string;
  snapshot: string;
  objective: string | null;
  verified: string[];
  hypotheses: string[];
  constraints: string[];
  sideEffects: string[];
  resume: string;
  sectionOrder: CapsuleSectionName[];
}

const ORDER: readonly CapsuleSectionName[] = [
  "verified",
  "hypotheses",
  "constraints",
  "sideEffects",
  "resume",
];

function invalid(message: string): ChronosError {
  return new ChronosError("CAPSULE_INVALID", message);
}

function sectionName(header: string): CapsuleSectionName | null {
  for (const [name, prefix] of Object.entries(CAPSULE_SECTIONS)) {
    if (header.startsWith(prefix)) return name as CapsuleSectionName;
  }
  return null;
}

function bullets(lines: readonly string[], section: string): string[] {
  const items: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (!line.startsWith("- ")) {
      throw invalid(`${section} contains a line that is not a bullet: ${JSON.stringify(line)}`);
    }
    items.push(line.slice(2));
  }
  return items;
}

export function parseCapsule(text: string): ParsedCapsule {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) throw invalid("capsule text is empty");

  const blocks = normalized.split("\n\n");
  const headerBlock = blocks[0];
  if (headerBlock === undefined) throw invalid("capsule text is empty");

  const headerLines = headerBlock.split("\n");
  if (headerLines[0] !== CAPSULE_HEADER) {
    throw invalid(`expected "${CAPSULE_HEADER}" on the first line`);
  }

  const projectLine = headerLines[1] ?? "";
  const projectMatch = /^project: (.+?) \(([^)]+)\) {3}branch: (.+)$/u.exec(projectLine);
  if (projectMatch === null) {
    throw invalid("second line must be `project: <slug> (<id>)   branch: <name>`");
  }

  const headLine = headerLines[2] ?? "";
  const headMatch = /^head: (.+?) {3}tree: (.+?) {3}snapshot: (.+)$/u.exec(headLine);
  if (headMatch === null) {
    throw invalid("third line must be `head: <checkpoint>   tree: <hash|none>   snapshot: <hash>`");
  }

  let objective: string | null = null;
  for (const line of headerLines.slice(3)) {
    if (line.startsWith("objective: ")) objective = line.slice("objective: ".length);
  }

  const parsed: ParsedCapsule = {
    project: projectMatch[1] as string,
    projectId: projectMatch[2] as string,
    branch: projectMatch[3] as string,
    head: headMatch[1] as string,
    tree: headMatch[2] as string,
    snapshot: headMatch[3] as string,
    objective,
    verified: [],
    hypotheses: [],
    constraints: [],
    sideEffects: [],
    resume: "",
    sectionOrder: [],
  };

  let lastRank = -1;
  for (const block of blocks.slice(1)) {
    const lines = block.split("\n");
    const header = lines[0] ?? "";
    const name = sectionName(header);
    if (name === null) {
      throw invalid(`unknown section header: ${JSON.stringify(header)}`);
    }
    const rank = ORDER.indexOf(name);
    if (rank <= lastRank) {
      throw invalid(`section "${name}" is out of order or repeated`);
    }
    lastRank = rank;
    parsed.sectionOrder.push(name);

    const body = lines.slice(1);
    if (name === "resume") {
      parsed.resume = [header, ...body].join("\n");
      continue;
    }
    const items = bullets(body, name);
    if (name === "verified") parsed.verified = items;
    else if (name === "hypotheses") parsed.hypotheses = items;
    else if (name === "constraints") parsed.constraints = items;
    else parsed.sideEffects = items;
  }

  if (!parsed.sectionOrder.includes("verified")) {
    throw invalid("capsule has no VERIFIED section");
  }
  if (!parsed.sectionOrder.includes("resume")) {
    throw invalid("capsule has no RESUME PROTOCOL section");
  }

  return parsed;
}
