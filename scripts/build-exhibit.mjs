#!/usr/bin/env node
// 素材脚本：从单一真源 src/exhibit-spec.js 生成 scenes/echo-hunt.json，
// 重建两个展厅并验证展项的全部设计约束，输出可试听路线与参照结果。
// 运行：node scripts/build-exhibit.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECHO_HUNT_SPEC as spec } from '../src/exhibit-spec.js';
import {
  compareStart, solveGallery, regenerateWithoutPartition, verifyCheckpoint, runRoute,
} from '../src/exhibit.js';
import { C } from '../src/scene-solver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const specPath = path.join(root, 'scenes', 'echo-hunt.json');
const write = process.argv.includes('--write');

if (write) {
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`已写出场景规格 → ${path.relative(root, specPath)}`);
}

const fmt = (x, d = 4) => (typeof x === 'number' ? x.toFixed(d) : String(x));
let failures = 0;
function assert(name, cond, detail = '') {
  const mark = cond ? '✓' : '✗';
  if (!cond) failures++;
  console.log(`  ${mark} ${name}${detail ? `  ${detail}` : ''}`);
}

const report = { generatedAt: new Date().toISOString(), spec: path.relative(root, specPath), sections: {} };

console.log(`\n# ${spec.title} · 素材重建与约束校验`);
console.log(`房间 ${spec.room.dims.join('×')} m，声速 ${C} m/s，可听阈值 ${spec.echoAudibilityThresholdDb} dB\n`);

// ---- 1. 起始位姿：两厅首回波同刻、来源不同 ----
console.log('1 起始位姿');
const cmp = compareStart(spec);
report.sections.start = cmp;
for (const [k, v] of Object.entries(cmp)) {
  const f = v.first;
  console.log(`  ${k} 厅：直达声 ${v.directValid ? '可闻' : '被挡'}；首回波 ${f ? f.faces.join('→') : '无'}` +
    `${f ? `，d=${fmt(f.distance)} m，t=${fmt(f.timeMs, 3)} ms，样本 ${f.sampleNearest}` : ''}`);
}
const fa = cmp.A.first, fb = cmp.B.first;
assert('A 首回波来自南墙（单次反射）', fa && fa.faces.length === 1 && fa.faces[0].startsWith('南墙'));
assert('B 首回波是两次反射且经过隔板', fb && fb.order === 2 && fb.passesPartition);
assert('B 首回波含「隔板背面」这一环', fb && fb.faces.some((n) => n.includes('partition:背面')));
assert('两厅首回波到达时刻相同（<0.01 ms）',
  fa && fb && Math.abs(fa.timeMs - fb.timeMs) < 0.01,
  `Δt=${fmt(Math.abs(fa.timeMs - fb.timeMs), 5)} ms`);
assert('两厅直达声都成立', cmp.A.directValid && cmp.B.directValid);

// ---- 2. 移动听点 / 转动隔板能排除一种解释 ----
console.log('\n2 可排除性（试听路线）');
for (const route of spec.routes) {
  const run = runRoute(spec, route);
  report.sections[route.id] = run;
  console.log(`  ${route.title}`);
  for (const fr of run.frames) {
    const f = fr.first;
    console.log(`    听点 ${fr.listener.join(',')}  隔板 ${fr.panelAngle}°  →  ` +
      `${f ? f.faces.join('→') : '无回波'}${f ? `  t=${fmt(f.timeMs, 3)} ms` : ''}`);
  }
}
// 路线 2：转动隔板时，双反射解释只在窄角度存活
const r2 = report.sections['route-partition'].frames;
const doubleAlive = r2.filter((f) => f.first && f.first.faces.some((n) => n.includes('partition:背面')));
const doubleDead = r2.filter((f) => !f.first || !f.first.faces.some((n) => n.includes('partition:背面')));
assert('转动隔板可让双反射解释失效', doubleAlive.length >= 1 && doubleDead.length >= 1,
  `存活 ${doubleAlive.length} 格 / 失效 ${doubleDead.length} 格`);

// ---- 3. 删除隔板后重新生成 ----
console.log('\n3 删除隔板后重新生成（B 厅）');
const regen = regenerateWithoutPartition(spec, 'B');
report.sections.regenerate = {
  checks: regen.checks, pass: regen.pass,
  vanished: regen.vanished, kept: regen.kept, appeared: regen.appeared,
};
assert('直达声仍在', regen.checks.directStillValid);
assert('直达声距离不变', regen.checks.directDistanceUnchanged);
assert('消失的回波全部经过隔板', regen.checks.everyVanishedEchoPassedPartition);
assert('原来的隔板首回波消失', regen.checks.partitionFirstEchoGone);
assert('曾被隔板挡住的不跨板回波重新出现', regen.checks.blockedWallEchoRestored);
console.log('    消失：' + (regen.vanished.map((e) => e.faces.join('→')).join('；') || '无'));
console.log('    保留：' + (regen.kept.map((e) => e.faces.join('→')).join('；') || '无'));
console.log('    新出现：' + (regen.appeared.map((e) => e.faces.join('→')).join('；') || '无'));

// ---- 4. 屏风后检查点 ----
console.log('\n4 屏风后检查点');
for (const route of spec.routes) {
  const cp = verifyCheckpoint(spec, route);
  report.sections[`checkpoint:${route.id}`] = cp;
  console.log(`  ${route.id}：屏风挡直达声 ${cp.A.occluder || '—'} / ${cp.B.occluder || '—'}`);
  console.log(`    A 首条合法路径 ${cp.A.faces ? cp.A.faces.join('→') : '无'}  t=${cp.A.timeMs ? fmt(cp.A.timeMs, 3) : '—'} ms`);
  console.log(`    B 首条合法路径 ${cp.B.faces ? cp.B.faces.join('→') : '无'}  t=${cp.B.timeMs ? fmt(cp.B.timeMs, 3) : '—'} ms`);
  console.log(`    到达时刻差 ${cp.firstEchoTimeDiffMs != null ? fmt(cp.firstEchoTimeDiffMs, 3) : '—'} ms`);
  assert(`  ${route.id}：两厅直达声都被屏风挡住`, cp.checks.directBlockedInBoth && cp.checks.blockedByScreen);
  assert(`  ${route.id}：两厅各留一条可听合法路径`, cp.checks.bothKeepAudibleEcho);
  assert(`  ${route.id}：首路径不经过屏风`, cp.checks.firstEchoDoesNotUseScreen);
  assert(`  ${route.id}：两厅首路径来源不同`, cp.checks.distinctFirstSources);
  assert(`  ${route.id}：可凭到达时刻辨认展厅`, cp.checks.firstEchoesDistinguishable);
}

// ---- 5. 源墙面 ↔ 可听片段的对应（供展项点选回波用） ----
console.log('\n5 作答映射（源墙面 ↔ 可听片段）');
for (const g of Object.keys(spec.galleries)) {
  const { evaluated } = solveGallery(spec, g, { maxOrder: 2 });
  const first = evaluated.first;
  if (!first) continue;
  const mapping = {
    gallery: g,
    faces: first.faceNames,
    surfaces: first.surfaces,
    distance: first.distance,
    timeMs: first.timeMs,
    sampleFloat: first.pulse?.sampleFloat,
    sampleNearest: first.pulse?.sampleNearest,
    segmentLengths: first.segmentLengths,
  };
  report.sections[`mapping:${g}`] = mapping;
  console.log(`  ${g} 厅：${mapping.faces.join(' → ')}`);
  console.log(`    墙面序列 → 传播长度 ${fmt(mapping.distance)} m（分段 ${mapping.segmentLengths.map((s) => fmt(s, 3)).join(' + ')}）`);
  console.log(`    → 到达 ${fmt(mapping.timeMs, 4)} ms → 脉冲样本 ${fmt(mapping.sampleFloat, 3)}（最近 ${mapping.sampleNearest}）`);
}

// ---- 6. 移动屏风可重新验证 ----
console.log('\n6 移动屏风重新验证');
const route = spec.routes[0];
const cp = route.checkpoint;
// 把屏风沿垂直视线方向平移，检验判别是否随位置改变（设计可重验）
const perp = (() => {
  const dx = cp.listener[0] - spec.source[0], dy = cp.listener[1] - spec.source[1];
  const L = Math.hypot(dx, dy);
  return [-dy / L, dx / L];
})();
const shifts = [-0.3, -0.15, 0, 0.15, 0.3];
const sweep = shifts.map((s) => {
  const screen = structuredClone(cp.screen);
  screen.center = [cp.screen.center[0] + perp[0] * s, cp.screen.center[1] + perp[1] * s, cp.screen.center[2]];
  const r = verifyCheckpoint(spec, { ...route, checkpoint: { ...cp, screen } });
  console.log(`    屏风偏移 ${fmt(s, 2)} m：直达声${r.checks.directBlockedInBoth ? '仍被挡' : '泄漏'}，` +
    `首路径 ${r.A.faces ? r.A.faces.join('→') : '无'} / ${r.B.faces ? r.B.faces.join('→') : '无'}，` +
    `时刻差 ${r.firstEchoTimeDiffMs != null ? fmt(r.firstEchoTimeDiffMs, 2) : '—'} ms，` +
    `${r.checks.bothKeepAudibleEcho ? '两厅各有路径' : '有厅失去可听路径'}`);
  return { shift: s, blocked: r.checks.directBlockedInBoth, diffMs: r.firstEchoTimeDiffMs, pass: r.pass };
});
report.sections.screenSweep = sweep;
assert('移动屏风后仍可重新验证设计', sweep.some((s) => s.blocked && s.pass));
assert('屏风明显偏离时判别随之失效（说明该观测位置必要）',
  sweep.some((s) => s.blocked && !s.pass));

// ---- 写出参照结果与可试听素材 ----
if (write) {
  const refPath = path.join(root, 'reference', 'exhibit-reference.json');
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(refPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n已写出参照结果 → ${path.relative(root, refPath)}`);

  // 可试听素材：两条路线逐格的脉冲响应峰表 + 首回波解释，供展项直接载入
  const routeAssets = spec.routes.map((route) => {
    const g = spec.galleries[route.gallery];
    const frames = [];
    const angles = route.panelSweep && route.panelSweep.length ? route.panelSweep : [null];
    for (const p of route.listenerSweep || [route.listenerStart]) {
      for (const ang of angles) {
        const panelAngles = {};
        if (ang != null) for (const panel of g.panels) panelAngles[panel.id] = ang;
        const { evaluated } = solveGallery(spec, route.gallery, {
          listener: p, panelAngles, maxOrder: 2,
        });
        frames.push({
          listener: p,
          panelAngle: ang,
          direct: { valid: evaluated.direct.valid, occluder: evaluated.direct.occluder, timeMs: evaluated.direct.timeSec * 1000 },
          first: evaluated.first ? {
            faces: evaluated.first.faceNames,
            surfaces: evaluated.first.surfaces,
            order: evaluated.first.order,
            passesPartition: evaluated.first.passesPartition,
            distance: evaluated.first.distance,
            timeMs: evaluated.first.timeMs,
            sampleNearest: evaluated.first.pulse?.sampleNearest,
          } : null,
          peaks: evaluated.impulse.peaks.map((pk) => ({
            label: pk.label, timeMs: pk.timeSec * 1000,
            sampleFloat: pk.sampleFloat, sampleNearest: pk.sampleNearest, gain: pk.gain,
          })),
        });
      }
    }
    return { routeId: route.id, gallery: route.gallery, title: route.title, frames };
  });
  const assetPath = path.join(root, 'reference', 'route-assets.json');
  fs.writeFileSync(assetPath, JSON.stringify({
    title: spec.title, sampleRate: 48000, routes: routeAssets,
  }, null, 2) + '\n');
  console.log(`已写出试听路线素材 → ${path.relative(root, assetPath)}`);
}

console.log(`\n${failures === 0 ? '全部约束通过 ✓' : `${failures} 项约束未通过 ✗`}`);
process.exitCode = failures === 0 ? 0 : 1;
