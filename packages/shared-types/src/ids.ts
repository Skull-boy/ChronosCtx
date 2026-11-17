/**
 * ULIDs and prefixed entity identifiers (§4.1).
 *
 * Format: `<prefix>_<26-char Crockford base32 ULID>`.
 * The ULID is lexicographically sortable, monotonic within a process, and the
 * prefix makes an identifier self-describing at the MCP boundary.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALPHABET_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;
const MAX_RANDOM = (1n << 80n) - 1n;

export const ID_PREFIXES = [
  "prj",
  "brn",
  "nod",
  "ver",
  "chk",
  "nc",
  "vev",
  "rwd",
  "snp",
  "edg",
  "ses",
  "sfe",
  "cap",
  "prp",
  "dev",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

export type PrefixedId = `${IdPrefix}_${string}`;

export interface Clock {
  now(): number;
}

export interface RandomSource {
  bytes(count: number): Uint8Array;
}

export const systemClock: Clock = {
  now: (): number => Date.now(),
};

export const cryptoRandomSource: RandomSource = {
  bytes: (count: number): Uint8Array => {
    const out = new Uint8Array(count);
    globalThis.crypto.getRandomValues(out);
    return out;
  },
};

/** Deterministic PRNG (mulberry32) used only when `CHRONOS_DETERMINISTIC=1`. */
export class SeededRandomSource implements RandomSource {
  private state: number;

  public constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  public bytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      this.state = (this.state + 0x6d2b79f5) >>> 0;
      let t = this.state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
    }
    return out;
  }
}

function encodeTime(timestamp: number): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${timestamp}`);
  }
  let remaining = timestamp;
  let out = "";
  for (let i = 0; i < TIME_LEN; i += 1) {
    const mod = remaining % ALPHABET_LEN;
    out = (ALPHABET[mod] as string) + out;
    remaining = (remaining - mod) / ALPHABET_LEN;
  }
  return out;
}

function encodeRandom(value: bigint): string {
  let remaining = value;
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    const mod = Number(remaining & 31n);
    out = (ALPHABET[mod] as string) + out;
    remaining >>= 5n;
  }
  return out;
}

function decodeTime(encoded: string): number {
  let value = 0;
  for (const char of encoded) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new RangeError(`invalid Crockford base32 character: ${char}`);
    value = value * ALPHABET_LEN + index;
  }
  return value;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  // 80 bits of entropy, taken from the low end of the byte string.
  return value & MAX_RANDOM;
}

/**
 * Monotonic ULID factory. Two calls in the same millisecond increment the
 * random component rather than regenerating it, so ordering is preserved even
 * under a coarse clock.
 */
export class UlidFactory {
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private lastTime = -1;
  private lastRandom = 0n;

  public constructor(options: { clock?: Clock; random?: RandomSource } = {}) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? cryptoRandomSource;
  }

  public next(at?: number): string {
    let timestamp = at ?? this.clock.now();
    let randomValue: bigint;

    if (timestamp <= this.lastTime) {
      timestamp = this.lastTime;
      randomValue = this.lastRandom + 1n;
      if (randomValue > MAX_RANDOM) {
        // 80-bit overflow inside one millisecond: advance the clock by 1 ms.
        timestamp += 1;
        randomValue = bytesToBigInt(this.random.bytes(10));
      }
    } else {
      randomValue = bytesToBigInt(this.random.bytes(10));
    }

    this.lastTime = timestamp;
    this.lastRandom = randomValue;
    return encodeTime(timestamp) + encodeRandom(randomValue);
  }
}

export interface IdGeneratorOptions {
  clock?: Clock;
  random?: RandomSource;
  deterministic?: boolean;
}

export interface IdGenerator {
  ulid(): string;
  id(prefix: IdPrefix): PrefixedId;
}

const FIXED_DETERMINISTIC_TIME = Date.UTC(2026, 10, 16, 0, 0, 0, 0);

export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const deterministic = options.deterministic ?? process.env.CHRONOS_DETERMINISTIC === "1";
  const clock =
    options.clock ??
    (deterministic ? { now: (): number => FIXED_DETERMINISTIC_TIME } : systemClock);
  const random = options.random ?? (deterministic ? new SeededRandomSource() : cryptoRandomSource);
  const factory = new UlidFactory({ clock, random });

  return {
    ulid: (): string => factory.next(),
    id: (prefix: IdPrefix): PrefixedId => `${prefix}_${factory.next()}`,
  };
}

const ID_RE =
  /^(prj|brn|nod|ver|chk|nc|vev|rwd|snp|edg|ses|sfe|cap|prp|dev)_([0-9A-HJKMNP-TV-Z]{26})$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

export function isId(value: string): boolean {
  return ID_RE.test(value);
}

export interface ParsedId {
  prefix: IdPrefix;
  ulid: string;
  timestamp: number;
}

export function parseId(value: string): ParsedId {
  const match = ID_RE.exec(value);
  if (!match) throw new RangeError(`malformed id: ${value}`);
  const prefix = match[1] as IdPrefix;
  const ulid = match[2] as string;
  return { prefix, ulid, timestamp: decodeTime(ulid.slice(0, TIME_LEN)) };
}

export function idTimestamp(value: string): number {
  return parseId(value).timestamp;
}

const defaultGenerator = createIdGenerator();

export function newId(prefix: IdPrefix): PrefixedId {
  return defaultGenerator.id(prefix);
}

export function newUlid(): string {
  return defaultGenerator.ulid();
}
