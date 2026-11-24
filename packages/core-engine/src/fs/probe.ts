import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, posix, resolve } from "node:path";
import { ChronosError } from "@chronos-ctx/shared-types";

/**
 * Filesystem probe (roadmap §3.3, gate 1.14).
 *
 * WAL + a shadow git store on a sync client is a corruption generator, not a
 * feature. The daemon therefore classifies `CHRONOS_HOME`, the object store and
 * the workspace before it opens the database, and refuses network or synced
 * paths with `UNSAFE_FILESYSTEM`.
 *
 * Classification is heuristic and deliberately conservative in one direction:
 * a known network filesystem or a known sync-folder name is refused; an
 * undetermined filesystem is allowed but reported as `unknown`. Refusing every
 * `unknown` would make the daemon unusable on platforms where the filesystem
 * type is not exposed, and the write probe still catches a read-only or
 * locking-broken volume.
 */

export type FilesystemKind = "local" | "network" | "synced" | "unknown";

export interface FilesystemClassification {
  path: string;
  kind: FilesystemKind;
  fs_type: string | null;
  mount_point: string | null;
  evidence: string;
  safe: boolean;
  remediation?: string;
}

export interface MountEntry {
  source: string;
  mountPoint: string;
  fsType: string;
  options: string;
}

export interface MountProbe {
  fsType: string;
  mountPoint: string;
  source: string;
}

export interface WriteProbe {
  ok: boolean;
  error: string | null;
}

export interface ClassifyInput {
  path: string;
  fsType?: string | null;
  mountPoint?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface ProbeFilesystemOptions {
  platform?: NodeJS.Platform;
  /** Injected `/proc/mounts` text, for tests and non-Linux hosts. */
  mounts?: string;
  env?: NodeJS.ProcessEnv;
  /** Skip the write probe. Defaults to running it for an existing directory. */
  probeWrite?: boolean;
}

const REMEDIATION =
  "Move CHRONOS_HOME (and the workspace) to a local disk, for example ~/.chronos-ctx, " +
  "then set CHRONOS_HOME. Network shares and sync clients (OneDrive, Dropbox, iCloud, " +
  "Google Drive) can corrupt the WAL database and the shadow git store.";

const NETWORK_FS_TYPES: ReadonlySet<string> = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smbfs",
  "smb3",
  "afs",
  "afs3",
  "sshfs",
  "fuse.sshfs",
  "9p",
  "virtiofs",
  "glusterfs",
  "ceph",
  "davfs",
  "davfs2",
  "fuse.davfs2",
  "ncpfs",
]);

const SYNCED_COMPONENTS: readonly string[] = [
  "onedrive",
  "dropbox",
  "google drive",
  "googledrive",
  "icloud drive",
  "iclouddrive",
  "pcloud",
  "mega",
  "nextcloud",
  "seafile",
  "syncthing",
  "yandex.disk",
  "yandexdisk",
  "box sync",
  "box drive",
];

const SYNCED_ENV_KEYS: readonly string[] = [
  "OneDrive",
  "OneDriveCommercial",
  "OneDriveConsumer",
  "Dropbox",
  "GoogleDrive",
  "iCloudDrive",
];

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** Parse `/proc/mounts` (or an equivalent table) into entries. */
export function parseMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/u);
    const source = parts[0];
    const mountPoint = parts[1];
    const fsType = parts[2];
    const options = parts[3];
    if (
      source === undefined ||
      mountPoint === undefined ||
      fsType === undefined ||
      options === undefined
    ) {
      continue;
    }
    entries.push({
      source: unescapeMount(source),
      mountPoint: unescapeMount(mountPoint),
      fsType: fsType.toLowerCase(),
      options,
    });
  }
  return entries;
}

function normalizeTarget(path: string): string {
  const slashed = path.replace(/\\/gu, "/");
  const resolved = posix.resolve(slashed);
  return resolved.length > 1 ? resolved.replace(/\/+$/u, "") : resolved;
}

function isWithin(path: string, mountPoint: string): boolean {
  const normalizedMount = mountPoint.length > 1 ? mountPoint.replace(/\/+$/u, "") : mountPoint;
  if (path === normalizedMount) return true;
  const prefix = normalizedMount === "/" ? "/" : `${normalizedMount}/`;
  return path.startsWith(prefix);
}

/**
 * Find the longest mount point that contains `path`. This is the only correct
 * way to read `/proc/mounts`: `/` matches everything, but `/mnt/nas` is more
 * specific and must win for a path beneath it.
 */
export function probeFromMounts(path: string, mountsText: string): MountProbe | null {
  const target = normalizeTarget(path);
  let best: MountEntry | null = null;
  for (const entry of parseMounts(mountsText)) {
    const mountPoint = normalizeTarget(entry.mountPoint);
    if (!isWithin(target, mountPoint)) continue;
    if (best === null || mountPoint.length > normalizeTarget(best.mountPoint).length) {
      best = entry;
    }
  }
  if (best === null) return null;
  return {
    fsType: best.fsType,
    mountPoint: normalizeTarget(best.mountPoint),
    source: best.source,
  };
}

function syncedMarker(path: string, env: NodeJS.ProcessEnv): string | null {
  const lower = path.replace(/\\/gu, "/").toLowerCase();
  const candidates = [
    ...SYNCED_ENV_KEYS,
    ...Object.keys(env).filter((key) => key.startsWith("OneDrive")),
  ];
  for (const key of candidates) {
    const value = env[key];
    if (value === undefined || value.trim().length === 0) continue;
    const prefix = value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
    if (prefix.length > 0 && (lower === prefix || lower.startsWith(`${prefix}/`))) return key;
  }

  const components = lower.split("/").filter((component) => component.length > 0);
  for (const component of components) {
    for (const marker of SYNCED_COMPONENTS) {
      if (component === marker || component.startsWith(`${marker} `)) return marker;
    }
  }

  if (lower.includes("/library/cloudstorage/")) return "cloudstorage";
  return null;
}

function isUncPath(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const windows = path.replace(/\//gu, "\\");
    if (windows.toLowerCase().startsWith("\\\\?\\unc\\")) return true;
    if (windows.startsWith("\\\\?\\")) return false;
    return windows.startsWith("\\\\");
  }
  return path.startsWith("//");
}

function classify(
  path: string,
  kind: FilesystemKind,
  fsType: string | null,
  mountPoint: string | null,
  evidence: string,
  safe: boolean,
): FilesystemClassification {
  const base: FilesystemClassification = {
    path,
    kind,
    fs_type: fsType,
    mount_point: mountPoint,
    evidence,
    safe,
  };
  return safe ? base : { ...base, remediation: REMEDIATION };
}

export function classifyFilesystem(input: ClassifyInput): FilesystemClassification {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const fsType = input.fsType?.toLowerCase() ?? null;
  const mountPoint = input.mountPoint ?? null;

  const marker = syncedMarker(input.path, env);
  if (marker !== null) {
    return classify(
      input.path,
      "synced",
      fsType,
      mountPoint,
      `path matches the sync folder "${marker}"`,
      false,
    );
  }

  if (isUncPath(input.path, platform)) {
    return classify(input.path, "network", fsType, mountPoint, "UNC path", false);
  }

  if (fsType !== null && NETWORK_FS_TYPES.has(fsType)) {
    return classify(
      input.path,
      "network",
      fsType,
      mountPoint,
      `filesystem type "${fsType}" is a network filesystem`,
      false,
    );
  }

  if (fsType !== null) {
    return classify(input.path, "local", fsType, mountPoint, `filesystem type "${fsType}"`, true);
  }

  return classify(
    input.path,
    "unknown",
    null,
    mountPoint,
    "filesystem type not determined; no network or sync marker matched",
    true,
  );
}

/**
 * Create, fsync, rename and remove a file in `dir`. This is not a SQLite lock
 * test, but it catches read-only mounts and volumes where the sync client
 * intercepts writes. It never creates the directory itself.
 */
export function probeWritableDirectory(dir: string): WriteProbe {
  try {
    if (!existsSync(dir)) return { ok: false, error: "directory does not exist" };
    if (!statSync(dir).isDirectory()) return { ok: false, error: "path is not a directory" };
    accessSync(dir, constants.W_OK);

    const temporary = join(dir, `.chronos-probe-${process.pid}-${Date.now().toString(36)}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, "chronos-ctx filesystem probe");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, `${temporary}.done`);
    rmSync(`${temporary}.done`, { force: true });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readProcMounts(): string | null {
  try {
    return readFileSync("/proc/mounts", "utf8");
  } catch {
    return null;
  }
}

export function probeFilesystem(
  path: string,
  options: ProbeFilesystemOptions = {},
): FilesystemClassification {
  const platform = options.platform ?? process.platform;
  const nativeTarget =
    platform === "win32" ? resolve(path) : posix.resolve(path.replace(/\\/gu, "/"));

  let fsType: string | null = null;
  let mountPoint: string | null = null;
  if (platform !== "win32") {
    const mountsText = options.mounts ?? readProcMounts();
    if (mountsText !== null) {
      const mount = probeFromMounts(nativeTarget, mountsText);
      if (mount !== null) {
        fsType = mount.fsType;
        mountPoint = mount.mountPoint;
      }
    }
  }

  let classification = classifyFilesystem({
    path: nativeTarget,
    fsType,
    mountPoint,
    platform,
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  if (
    classification.safe &&
    options.probeWrite !== false &&
    existsSync(nativeTarget) &&
    statSync(nativeTarget).isDirectory()
  ) {
    const write = probeWritableDirectory(nativeTarget);
    if (!write.ok) {
      classification = {
        ...classification,
        kind: "unknown",
        safe: false,
        evidence: `write probe failed: ${write.error ?? "unknown error"}`,
        remediation: REMEDIATION,
      };
    }
  }

  return classification;
}

export function assertSafeFilesystem(
  path: string,
  options: ProbeFilesystemOptions = {},
): FilesystemClassification {
  const probe = probeFilesystem(path, options);
  if (!probe.safe) {
    throw new ChronosError(
      "UNSAFE_FILESYSTEM",
      `${probe.path} is not on a supported local filesystem (${probe.evidence})`,
      {
        ...(probe.remediation === undefined ? {} : { hint: probe.remediation }),
        details: {
          path: probe.path,
          kind: probe.kind,
          fs_type: probe.fs_type,
          mount_point: probe.mount_point,
        },
      },
    );
  }
  return probe;
}

/** Probe each path in order and throw on the first unsafe one. */
export function assertSafeFilesystems(
  paths: readonly string[],
  options: ProbeFilesystemOptions = {},
): FilesystemClassification[] {
  return paths.map((path) => assertSafeFilesystem(path, options));
}
