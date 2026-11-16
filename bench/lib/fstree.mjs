// Phase 0 — deterministic fixture generator. Same seed must produce byte-identical
// trees on Windows and Linux; this is what K3 is actually testing.
import fs from "node:fs";
import path from "node:path";
import { rng } from "./stats.mjs";

const WORDS = [
  "export", "const", "function", "return", "await", "async", "type", "interface",
  "import", "from", "if", "else", "for", "while", "throw", "new", "class",
  "extends", "implements", "readonly", "string", "number", "boolean", "Promise",
];

function makePool(bytes, seed) {
  const r = rng(seed);
  const parts = [];
  let n = 0;
  while (n < bytes) {
    const words = 6 + Math.floor(r() * 10);
    const out = [];
    for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(r() * WORDS.length)] + (1 + Math.floor(r() * 89)));
    const line = out.join(" ") + "\n";
    parts.push(line);
    n += line.length;
  }
  return Buffer.from(parts.join(""), "utf8");
}

const pools = new Map();
function pool(seed) {
  if (!pools.has(seed)) pools.set(seed, makePool(1 << 20, seed));
  return pools.get(seed);
}

export function filePathFor(i, ext = "ts") {
  return `src/m${i % 40}/p${i % 97}/f${i}.${ext}`;
}

export function fileContent(i, seed = 1) {
  const p = pool(seed);
  const size = 180 + ((i * 37) % 4200);
  const off = (i * 7919) % (p.length - size - 1);
  return p.subarray(off, off + size);
}

export function genRepo(root, { files = 2000, seed = 1, quiet = false, fresh = false } = {}) {
  // Marker lives *beside* the worktree: a file inside it would be captured by
  // every snapshot, and its buildMs would make the tree non-deterministic.
  const marker = `${root}.fixture.json`;
  if (!fresh && fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, "utf8"));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(root, { recursive: true });

  const made = new Set();
  const t0 = performance.now();
  for (let i = 0; i < files; i++) {
    const rel = filePathFor(i);
    const abs = path.join(root, rel);
    const dir = path.dirname(abs);
    if (!made.has(dir)) { fs.mkdirSync(dir, { recursive: true }); made.add(dir); }
    fs.writeFileSync(abs, fileContent(i, seed));
    if (!quiet && i > 0 && i % 5000 === 0) process.stderr.write(`  … ${i} files\n`);
  }

  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.chronos/\n*.log\n", "utf8");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p0-fixture", version: "1.0.0" }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# p0 fixture\n\nDeterministic content for the Phase 0 harness.\n", "utf8");

  // Ignored content must not reach the tree.
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
  fs.mkdirSync(path.join(root, ".chronos"), { recursive: true });
  fs.writeFileSync(path.join(root, ".chronos", "state.json"), '{"ignored":true}\n', "utf8");
  fs.writeFileSync(path.join(root, "debug.log"), "ignored\n", "utf8");

  const meta = { files, seed, bytes: 0, buildMs: performance.now() - t0 };
  fs.writeFileSync(marker, JSON.stringify(meta), "utf8");
  return meta;
}

/** Deterministically rewrite `count` tracked files, simulating an edit burst. */
export function mutate(root, count, salt = 1, files = 20000) {
  for (let j = 0; j < count; j++) {
    const i = (j * 13 + salt * 7) % files;
    const abs = path.join(root, filePathFor(i));
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, Buffer.concat([fileContent(i, salt + 2), Buffer.from(`// edit ${salt}:${j}\n`)]));
  }
}

export function toCrlf(root, files = 2000) {
  for (let i = 0; i < files; i++) {
    const abs = path.join(root, filePathFor(i));
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    const text = buf.toString("utf8").replace(/\r?\n/g, "\r\n");
    fs.writeFileSync(abs, text, "utf8");
  }
}
