/**
 * The v1 response envelope and surface types (§4.5).
 *
 * `surface` and `tier` are authenticated by the daemon, never declared by the
 * model: a web surface cannot claim to be a CLI surface in order to promote a
 * node to `verified`.
 */

import type { Estimator, TokenAccounting } from "./tokens.js";

export const SURFACES = [
  "opencode-cli",
  "antigravity",
  "claude-code",
  "cline",
  "cursor",
  "pi",
  "gemini-web",
  "chatgpt-web",
  "claude-web",
  "qwen-web",
  "extension",
  "cli",
  "import",
] as const;

export type SourceSurface = (typeof SURFACES)[number];

export type WebSurface = "gemini-web" | "chatgpt-web" | "claude-web" | "qwen-web";

export const WEB_SURFACES: readonly WebSurface[] = [
  "gemini-web",
  "chatgpt-web",
  "claude-web",
  "qwen-web",
];

export function isWebSurface(surface: SourceSurface): surface is WebSurface {
  return (WEB_SURFACES as readonly string[]).includes(surface);
}

export type EnforcementTier = "T0" | "T1" | "T2" | "T3" | "web";

export interface Warning {
  code: string;
  message: string;
  path?: string;
}

export interface DaemonIdentity {
  version: string;
  pid: number;
}

export interface Envelope {
  schema_version: 1;
  surface: SourceSurface;
  tier: EnforcementTier;
  tokens: TokenAccounting;
  estimator: Estimator;
  daemon: DaemonIdentity;
  warnings: Warning[];
}

export type NodeStatus = "unverified" | "verified" | "deprecated";

export type Freshness = "fresh" | "stale" | "unknown";
