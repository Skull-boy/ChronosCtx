import { readFileSync } from "node:fs";
import type {
  DaemonIdentity,
  EnforcementTier,
  Envelope,
  Estimator,
  SourceSurface,
  TokenAccounting,
  Warning,
} from "@chronos-ctx/shared-types";

/**
 * The v1 response envelope (§4.5.0). Every pager response carries one, and its
 * serialized size is part of the budget, not overhead outside it.
 */

let cachedVersion: string | undefined;

function engineVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    cachedVersion = manifest.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export function daemonIdentity(pid: number = process.pid): DaemonIdentity {
  return { version: engineVersion(), pid };
}

export interface EnvelopeInput {
  surface: SourceSurface;
  tier: EnforcementTier;
  tokens: TokenAccounting;
  estimator?: Estimator;
  daemon?: DaemonIdentity;
  warnings?: Warning[];
}

export function makeEnvelope(input: EnvelopeInput): Envelope {
  return {
    schema_version: 1,
    surface: input.surface,
    tier: input.tier,
    tokens: input.tokens,
    estimator: input.estimator ?? "chars4",
    daemon: input.daemon ?? daemonIdentity(),
    warnings: input.warnings ?? [],
  };
}

export function envelopeFactory(base: Omit<EnvelopeInput, "tokens">) {
  return (tokens: TokenAccounting): string => JSON.stringify(makeEnvelope({ ...base, tokens }));
}
