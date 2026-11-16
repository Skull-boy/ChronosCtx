// Phase 0 / gate 0.3 + K3 — cross-OS determinism.
//
// K3 asks one question: does the same logical content produce the same tree hash
// on Windows and Linux? The honest answer depends on line endings, git object
// format, symlinks, case folding, and Unicode normalisation — so this harness
// records each of those as a separate case instead of averaging them into a
// single pass/fail. Run on both platforms, then `--compare` the two JSON files.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { arg, writeJson, readJson } from "./lib/stats.mjs";
import { initShadow, makeEnv, git, defaultRoot } from "./lib/gitenv.mjs";
import { genRepo, toCrlf, filePathFor } from "./lib/fstree.mjs";

const OUT = arg("out", `bench/results/${process.platform}-determinism.json`);
const COMPARE = arg("compare", null);
const ISO = "2026-11-16T00:00:00Z";

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Portable identity: independent of git, object format, and tree ordering. */
function contentRoot(entries) {
  const lines = [...entries]
    .filter(([, e]) => e && e.contentHash)
    .map(([p, e]) => `${p}\0${e.contentHash}`)
    .sort();
  return sha256(Buffer.from(lines.join("\n") + "\n", "utf8"));
}

function walk(root, skipGit = true) {
  const out = [];
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipGit && e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) rec(abs);
      else out.push(rel);
    }
  })(root);
  return out.sort();
}

function treeEntries(tree, env) {
  const raw = git(["ls-tree", "-r", "-z", tree], env).out;
  const map = new Map();
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, type, hash] = rec.slice(0, tab).split(" ");
    map.set(rec.slice(tab + 1), { mode, type, hash });
  }
  return map;
}

let caseNo = 0;
/** Build one isolated case: its own worktree, shadow repo, and tree. */
function runCase(name, { files = 40, normalizeEol = false, sha256Repo = false, setup, afterAdd }) {
  const dir = path.join(defaultRoot(), `det-${caseNo++}`);
  const ws = path.join(dir, "ws");
  const shadowDir = path.join(dir, "shadow.git");
  const indexFile = path.join(dir, "shadow.index");
  fs.rmSync(dir, { recursive: true, force: true });
  genRepo(ws, { files, quiet: true });
  initShadow({ shadowDir, workTree: ws, sha256: sha256Repo, untrackedCache: false, normalizeEol });
  const env = makeEnv({ shadowDir, workTree: ws, indexFile, isoDate: ISO });
  const notes = [];
  if (setup) setup({ ws, env, notes });

  // §4.4.3 caps: a file over 5 MiB is skipped and listed, never an exception.
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const skipped = [];
  const exclude = [];
  for (const rel of walk(ws)) {
    try {
      const st = fs.statSync(path.join(ws, rel));
      if (st.size > MAX_FILE_BYTES) { skipped.push({ path: rel, bytes: st.size, reason: "too_large" }); exclude.push("/" + rel); }
    } catch { /* vanished */ }
  }
  if (exclude.length) {
    fs.mkdirSync(path.join(shadowDir, "info"), { recursive: true });
    fs.appendFileSync(path.join(shadowDir, "info", "exclude"), exclude.join("\n") + "\n");
    notes.push(`${skipped.length} file(s) over 5 MiB excluded by cap`);
  }

  git(["add", "-A", "--", "."], env);
  if (afterAdd) afterAdd({ ws, env, notes });
  const tree = git(["write-tree"], env).out;
  const map = treeEntries(tree, env);

  // Two identities, deliberately different:
  //  - tree hash = git's identity, which depends on object format and on the
  //    bytes actually stored (so a CRLF worktree changes it);
  //  - content_root = portable identity over logical content, with CRLF→LF
  //    normalization for text files, so the same knowledge has the same root
  //    on any OS and any object format.
  const contentHashes = {};
  const rawHashes = {};
  for (const [rel, e] of map) {
    if (e.type === "commit") { contentHashes[rel] = e.hash; rawHashes[rel] = e.hash; continue; }
    try {
      const buf = fs.readFileSync(path.join(ws, rel));
      rawHashes[rel] = sha256(buf);
      const isBinary = buf.includes(0);
      contentHashes[rel] = isBinary ? rawHashes[rel] : sha256(Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8"));
    } catch { /* symlink whose target is not resolvable on this host */ }
  }
  const rootHash = contentRoot(Object.entries(contentHashes).map(([p, v]) => [p, { contentHash: v }]));

  return {
    name,
    sha256Repo,
    normalizeEol,
    tree,
    treeAlgo: sha256Repo ? "sha256" : "sha1",
    entries: map.size,
    contentRoot: rootHash,
    rawContentRoot: contentRoot(Object.entries(rawHashes).map(([p, v]) => [p, { contentHash: v }])),
    skippedFiles: skipped,
    paths: [...map.keys()].sort(),
    gitHashes: Object.fromEntries([...map.entries()].map(([p, e]) => [p, e.hash])),
    contentHashes,
    notes,
  };
}

// Each case is a hypothesis about where tree hashes diverge across OSes.
const cases = [];

cases.push(runCase("lf-baseline", {}));
cases.push(runCase("crlf-no-normalize", {
  setup: ({ ws }) => toCrlf(ws, 40),
  // Expectation: this DIVERGES from lf-baseline. core.autocrlf=false is the
  // documented default, so an unguarded tree hash is not portable.
}));
cases.push(runCase("crlf-normalized", {
  normalizeEol: true,
  setup: ({ ws }) => toCrlf(ws, 40),
  // Expectation: this MATCHES lf-baseline, because info/attributes converts on
  // add without ever writing to the user's workspace or .git.
}));
cases.push(runCase("sha256-object-format", { sha256Repo: true }));
cases.push(runCase("large-file-6MiB", {
  setup: ({ ws, notes }) => {
    const buf = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff;
    fs.mkdirSync(path.join(ws, "assets"), { recursive: true });
    fs.writeFileSync(path.join(ws, "assets", "big.bin"), buf);
    notes.push("binary, not text-converted; exercises the >5 MiB path");
  },
}));
cases.push(runCase("symlink", {
  setup: ({ ws, notes }) => {
    try {
      fs.symlinkSync("README.md", path.join(ws, "link-to-readme"), "file");
      notes.push("symlink created");
    } catch (e) {
      notes.push(`symlink unsupported on this host: ${e.code}`);
    }
  },
}));
cases.push(runCase("gitlink", {
  // A submodule pointer must be written after `add -A`, or add -A sees the path
  // as absent from disk and removes the entry again.
  afterAdd: ({ env, notes }) => {
    const fakeCommit = "c".repeat(40);
    git(["update-index", "--add", "--cacheinfo", `160000,${fakeCommit},vendor/dep`], env);
    notes.push("mode 160000 gitlink");
  },
}));
cases.push(runCase("unicode-nfc-vs-nfd", {
  setup: ({ ws, notes }) => {
    const nfc = "src/caf\u00e9.ts";
    const nfd = "src/cafe\u0301.ts";
    fs.writeFileSync(path.join(ws, nfc), "export const nfc = 1;\n");
    if (nfc !== nfd) {
      try { fs.writeFileSync(path.join(ws, nfd), "export const nfd = 1;\n"); } catch { /* collision */ }
    }
    notes.push("precomposed + decomposed filename; core.precomposeUnicode=true on win32");
  },
}));
cases.push(runCase("case-collision", {
  setup: ({ ws, notes }) => {
    fs.writeFileSync(path.join(ws, "src/Case.ts"), "export const upper = 1;\n");
    fs.writeFileSync(path.join(ws, "src/case.ts"), "export const lower = 1;\n");
    const both = fs.existsSync(path.join(ws, "src/Case.ts")) && fs.existsSync(path.join(ws, "src/case.ts"));
    const names = fs.readdirSync(path.join(ws, "src")).filter((f) => /^case\.ts$/i.test(f));
    notes.push(both ? "two distinct files (case-sensitive FS)" : `case-insensitive FS collapsed to ${names.length} file`);
  },
}));

const doc = {
  gate: "0.3",
  title: "Cross-OS tree-hash determinism",
  platform: process.platform,
  host: os.hostname(),
  node: process.version,
  git: git(["--version"], makeEnv({ shadowDir: path.join(defaultRoot(), "det-0", "shadow.git"), workTree: defaultRoot(), indexFile: "x", isoDate: ISO })).out,
  os: os.version(),
  cases: cases.map(({ paths, gitHashes, contentHashes, ...rest }) => {
    const base = cases.find((c) => c.name === "lf-baseline");
    return {
      ...rest,
      pathCount: paths.length,
      // The design question is intra-platform: does this case match the LF
      // baseline on the same host? The cross-host answer is in -compare.json.
      relativeToLfBaseline: {
        treeEqual: rest.tree === base.tree && rest.treeAlgo === base.treeAlgo,
        contentRootEqual: rest.contentRoot === base.contentRoot,
      },
    };
  }),
};
writeJson(OUT, doc);
writeJson(OUT.replace(/\.json$/, ".maps.json"), {
  cases: Object.fromEntries(cases.map((c) => [c.name, { tree: c.tree, contentRoot: c.contentRoot, paths: c.paths, contentHashes: c.contentHashes }])),
});
console.log(`[determinism] wrote ${OUT}`);

// ── compare mode: run after both platform files exist ──────────────────────
if (COMPARE) {
  const mine = readJson(OUT.replace(/\.json$/, ".maps.json"));
  const theirs = readJson(String(COMPARE).replace(/\.json$/, ".maps.json"));
  const rows = [];
  for (const c of cases) {
    const a = mine.cases[c.name];
    const b = theirs.cases[c.name];
    if (!a || !b) { rows.push({ case: c.name, status: "missing" }); continue; }
    const pathSame = JSON.stringify(a.paths) === JSON.stringify(b.paths);
    rows.push({
      case: c.name,
      treeHashEqual: a.tree === b.tree,
      contentRootEqual: a.contentRoot === b.contentRoot,
      pathSetEqual: pathSame,
      mineTree: a.tree.slice(0, 12),
      theirsTree: b.tree.slice(0, 12),
      divergeAt: pathSame ? null : firstDiff(a.paths, b.paths),
    });
  }
  writeJson(OUT.replace(/\.json$/, "-compare.json"), { gate: "0.3", base: OUT, other: COMPARE, rows });
  console.log(rows.map((r) => `${String(r.case).padEnd(22)} tree=${r.treeHashEqual} content=${r.contentRootEqual} paths=${r.pathSetEqual}`).join("\n"));
}

function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return { i, mine: a[i] ?? null, theirs: b[i] ?? null };
  return null;
}
