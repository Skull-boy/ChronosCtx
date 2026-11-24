import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeFilesystem,
  assertSafeFilesystems,
  classifyFilesystem,
  parseMounts,
  probeFilesystem,
  probeFromMounts,
  probeWritableDirectory,
} from "./probe.js";

const MOUNTS = [
  "/dev/sda1 / ext4 rw,relatime 0 0",
  "nas:/export /mnt/data nfs4 rw,relatime 0 0",
  "nas:/export/deep /mnt/data/deep nfs4 rw,relatime 0 0",
  "//server/share /mnt/share cifs rw 0 0",
  "sshfs#host:/srv /mnt/ssh fuse.sshfs rw 0 0",
].join("\n");

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "chronos-probe-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("classifyFilesystem", () => {
  it("refuses every network filesystem type on the denylist", () => {
    for (const fsType of [
      "nfs",
      "nfs4",
      "cifs",
      "smbfs",
      "sshfs",
      "fuse.sshfs",
      "9p",
      "virtiofs",
    ]) {
      const result = classifyFilesystem({
        path: "/mnt/data/project",
        fsType,
        platform: "linux",
      });
      expect(result.kind, fsType).toBe("network");
      expect(result.safe, fsType).toBe(false);
      expect(result.remediation).toContain("local disk");
    }
  });

  it("refuses sync-folder names in the path", () => {
    for (const path of [
      "C:\\Users\\me\\OneDrive\\repo",
      "/Users/me/Dropbox/repo",
      "/Users/me/Google Drive/repo",
      "/Users/me/iCloud Drive/repo",
    ]) {
      const result = classifyFilesystem({ path, platform: "win32" });
      expect(result.kind, path).toBe("synced");
      expect(result.safe, path).toBe(false);
    }
  });

  it("refuses an environment-declared OneDrive root", () => {
    const result = classifyFilesystem({
      path: "/home/me/work/repo",
      env: { OneDrive: "/home/me/work" },
      platform: "linux",
    });
    expect(result.kind).toBe("synced");
    expect(result.safe).toBe(false);
  });

  it("refuses UNC paths on Windows and POSIX", () => {
    expect(classifyFilesystem({ path: "\\\\server\\share\\repo", platform: "win32" }).kind).toBe(
      "network",
    );
    expect(classifyFilesystem({ path: "//server/share/repo", platform: "linux" }).kind).toBe(
      "network",
    );
  });

  it("allows a local filesystem and reports an undetermined one as unknown/safe", () => {
    const local = classifyFilesystem({
      path: "/home/me/repo",
      fsType: "ext4",
      platform: "linux",
    });
    expect(local).toMatchObject({ kind: "local", safe: true });

    const unknown = classifyFilesystem({ path: "/home/me/repo", platform: "linux" });
    expect(unknown).toMatchObject({ kind: "unknown", safe: true });
    expect(unknown.evidence).toContain("not determined");
  });
});

describe("mount parsing", () => {
  it("unescapes octal sequences in mount points", () => {
    const entries = parseMounts("/dev/sda1 /mnt/with\\040space ext4 rw 0 0\n");
    expect(entries[0]).toMatchObject({ mountPoint: "/mnt/with space", fsType: "ext4" });
  });

  it("selects the longest matching mount point", () => {
    expect(probeFromMounts("/mnt/data/deep/project", MOUNTS)).toMatchObject({
      fsType: "nfs4",
      mountPoint: "/mnt/data/deep",
    });
    expect(probeFromMounts("/mnt/data/project", MOUNTS)).toMatchObject({
      mountPoint: "/mnt/data",
    });
    expect(probeFromMounts("/srv/app", MOUNTS)).toMatchObject({
      fsType: "ext4",
      mountPoint: "/",
    });
  });
});

describe("probeFilesystem and assertSafeFilesystem", () => {
  it("accepts a real temporary directory and leaves no probe file behind", () => {
    const dir = temporaryDirectory();
    const probe = probeFilesystem(dir);
    expect(probe.safe).toBe(true);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("refuses an injected network mount with UNSAFE_FILESYSTEM", () => {
    let thrown: unknown;
    try {
      assertSafeFilesystem("/mnt/data/project", {
        platform: "linux",
        mounts: MOUNTS,
        probeWrite: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "UNSAFE_FILESYSTEM" });
  });

  it("returns the classification for a safe path", () => {
    const dir = temporaryDirectory();
    const result = assertSafeFilesystem(dir);
    expect(result.path).toBe(dir);
    expect(result.safe).toBe(true);
  });

  it("stops at the first unsafe path in a set", () => {
    const dir = temporaryDirectory();
    let thrown: unknown;
    try {
      assertSafeFilesystems([dir, "/mnt/share/project"], {
        platform: "linux",
        mounts: MOUNTS,
        probeWrite: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "UNSAFE_FILESYSTEM" });
  });
});

describe("probeWritableDirectory", () => {
  it("writes, fsyncs, renames and removes its probe file", () => {
    const dir = temporaryDirectory();
    expect(probeWritableDirectory(dir)).toEqual({ ok: true, error: null });
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("reports a missing directory instead of creating it", () => {
    const dir = join(temporaryDirectory(), "missing");
    expect(probeWritableDirectory(dir).ok).toBe(false);
  });
});
