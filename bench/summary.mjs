// Phase 0 — consolidate every result file into one printable table.
// Used to write docs/phase0/REPORT.md without transcribing numbers by hand.
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./lib/stats.mjs";

const DIR = "bench/results";
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.includes("maps") && !f.includes("compare")) : [];
const f2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : Number(n).toFixed(1));

for (const file of files.sort()) {
  const j = readJson(path.join(DIR, file));
  console.log(`\n=== ${file} — ${j.title ?? j.gate ?? ""}`);
  if (j.series) {
    console.log(`${"series".padEnd(34)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)} ${"add p95".padStart(9)} ${"spawns".padStart(7)}`);
    for (const s of j.series) {
      const t = s.total ?? {};
      console.log(`${String(s.label).padEnd(34)} ${f2(t.p50).padStart(8)} ${f2(t.p95).padStart(8)} ${f2(t.p99).padStart(8)} ${f2(s.add?.p95).padStart(9)} ${String(t.spawnsPerCheckpoint ?? "").padStart(7)}`);
    }
    if (j.spawnFloor) console.log(`spawn floor p50: ${f2(j.spawnFloor.p50)} ms  (n=${j.spawnFloor.n})`);
    if (j.stepsPerCheckpoint) console.log(`steps per checkpoint: ${j.stepsPerCheckpoint}`);
  }
  if (j.restore) console.log(`restore: p50 ${f2(j.restore.total.p50)}  p95 ${f2(j.restore.total.p95)}  (${j.restore.iterations} iters)`);
  if (j.k8) console.log(`K8: ${j.k8.passed}/${j.k8.of}  ${j.k8.verdictOnFixture}`);
  if (j.surface) {
    console.log(`tool surface: cl100k ${j.surface.full.cl100k} (target ${j.surface.target.cl100k_target}/hard ${j.surface.target.cl100k_hard}), o200k ${j.surface.full.o200k}, lean ${j.surface.lean.cl100k}`);
    for (const t of j.surface.perTool) console.log(`  ${t.name.padEnd(24)} ${String(t.cl100k).padStart(5)} tok`);
  }
  if (j.bootIndex) console.log(`boot index (300 nodes): grouped ${j.bootIndex.indexOnly.grouped.cl100k}, flat ${j.bootIndex.indexOnly.flat.cl100k}`);
  if (j.netTokens) {
    const n = j.netTokens;
    console.log(`net tokens: baseline ${n.baseline.total} → chronos ${n.chronos.total} = ${n.reductionPct.toFixed(1)}% | cache-adjusted ${n.cacheAdjusted.reductionPct.toFixed(1)}%`);
  }
  if (j.spawn) { /* crash runs */ }
  if (j.crashInjection) for (const c of j.crashInjection) console.log(`crash ${c.crashPoint.padEnd(16)} resume ok=${c.resumedOk} ${f2(c.resumeMs)} ms`);
  if (j.typeConflict) console.log(`type conflict: ${JSON.stringify(j.typeConflict)}`);
  if (j.untrackedPreservation) console.log(`untracked preserved: ${JSON.stringify(j.untrackedPreservation)}`);
  if (j.closures) for (const c of j.closures) console.log(`dep ${c.dir.padEnd(12)} ${String(c.total ?? "?").padStart(3)} pkgs  ${String(c.transitive ?? "?").padStart(3)} transitive  ${(c.lifecycleScripts ?? []).length} scripts`);
  if (j.scope) console.log(`scope: ${j.scope.map((s) => `${s.name}=${s.available ? "free" : "TAKEN"}`).join(" ")}`);
  if (j.installContract) {
    const c = j.installContract;
    if (c.cleanInstall) console.log(`install contract: ${JSON.stringify(c.cleanInstall)}`);
    if (c.scriptPolicy) console.log(`script policy:   ${JSON.stringify(c.scriptPolicy)}`);
    if (c.error) console.log(`install contract error: ${c.error}`);
  }
  if (j.measurements) {
    const m = j.measurements;
    if (m.spawn) console.log(`spawn: spawnSync p50 ${f2(m.spawn.spawnSync.p50)} execa p50 ${f2(m.spawn.execa.p50)} (delta ${f2(m.spawn.p50DeltaPct)}%)`);
    if (m.http) console.log(`http p95: node:http ${f2(m.http.nodeHttp.p95)} fastify ${f2(m.http.fastify.p95)} (delta ${f2(m.http.p95DeltaPct)}%)`);
    if (m.boot) console.log(`boot p50: node:http ${f2(m.boot.nodeHttp.p50)} fastify ${f2(m.boot.fastify.p50)}`);
    if (m.logging) console.log(`logging: pino ${f2(m.logging.pino.recordsPerSec)} rec/s ndjson ${f2(m.logging.ndjson.recordsPerSec)} rec/s`);
    if (m.colour) console.log(`colour: picocolors ${f2(m.colour.picocolorsMs)} ms styleText ${f2(m.colour.styleTextMs)} ms`);
  }
  if (j.k8 === undefined && j.cases) {
    console.log("determinism cases:");
    for (const c of j.cases) console.log(`  ${c.name.padEnd(22)} tree ${String(c.tree).slice(0, 12)} entries ${c.entries} ${c.normalizeEol ? "[normalized]" : ""}`);
  }
  if (j.rows) for (const r of j.rows) console.log(`  ${r.case.padEnd(22)} treeEqual=${r.treeHashEqual} contentEqual=${r.contentRootEqual} pathsEqual=${r.pathSetEqual}`);
}
