// 与运行环境无关的断言内核（Node 与浏览器共用）
// 每个 check 抛出带 message 的 Error；由外层 runner 捕获汇总。
import { rectRoom, wedgeRoom, V } from './geometry.js';
import { solveRoom } from './solver.js';
import { buildImpulseResponse, convolveNaive, convolveFFT, makeClick } from './acoustics.js';
import { dist } from './geometry.js';

export function approx(a, b, tol = 1e-6) {
  if (Math.abs(a - b) > tol) throw new Error(`${a} ≈ ${b}（容差 ${tol}）`);
}
export function equal(a, b) {
  if (a !== b) throw new Error(`${a} === ${b}`);
}
export function ok(v, msg) {
  if (!v) throw new Error(msg || '期望为真');
}

// 返回 [{group, name, run}]，不依赖任何测试框架
export function buildChecks() {
  const checks = [];
  const group = (g, name, run) => checks.push({ group: g, name, run });

  group('1 手算基线', '直达声距离与时间', () => {
    const sol = solveRoom(rectRoom([6, 4, 3]), V(1, 1, 1.5), V(5, 3, 1.5), { maxOrder: 1 });
    approx(sol.direct.distance, Math.hypot(4, 2), 1e-9);
    approx(sol.direct.timeSec, Math.hypot(4, 2) / 343, 1e-9);
  });
  group('1 手算基线', '一阶反射恰为 6 条', () => {
    const sol = solveRoom(rectRoom([6, 4, 3]), V(1, 1, 1.5), V(5, 3, 1.5), { maxOrder: 1 });
    equal(sol.reflections.length, 6);
  });
  group('1 手算基线', '西墙镜像源/路径长/幅度与手算一致', () => {
    const S = V(1, 1, 1.5), R = V(5, 3, 1.5);
    const sol = solveRoom(rectRoom([6, 4, 3]), S, R, { maxOrder: 1 });
    const west = sol.reflections.find((r) => r.faceNames[0].startsWith('西墙'));
    ok(west, '存在西墙路径');
    approx(west.image.x, -1, 1e-9);
    const dHand = Math.hypot(6, 2);
    approx(west.distance, dHand, 1e-9);
    approx(west.gain, 0.8 / dHand, 1e-9);
    const q = west.points[1];
    approx(q.x, 0, 1e-9);
    approx(dist(S, q) + dist(q, R), dist(west.image, R), 1e-9);
  });
  group('2 移动墙面', '东墙随 Lx 移动、西墙不变', () => {
    const S = V(1, 1, 1.5), R = V(5, 3, 1.5);
    const r6 = solveRoom(rectRoom([6, 4, 3]), S, R, { maxOrder: 1 });
    const r8 = solveRoom(rectRoom([8, 4, 3]), S, R, { maxOrder: 1 });
    const e6 = r6.reflections.find((x) => x.faceNames[0].startsWith('东墙'));
    const e8 = r8.reflections.find((x) => x.faceNames[0].startsWith('东墙'));
    approx(e6.image.x, 11, 1e-9);
    approx(e8.image.x, 15, 1e-9);
    ok(Math.abs(e8.distance - e6.distance) > 1e-6, '东墙路径应变化');
  });
  group('3 声源靠墙', '近墙两峰紧邻且采样落点正确', () => {
    const sol = solveRoom(rectRoom([6, 4, 3]), V(0.05, 2, 1.5), V(4, 2, 1.5), { maxOrder: 1 });
    const west = sol.reflections.find((x) => x.faceNames[0].startsWith('西墙'));
    approx(west.image.x, -0.05, 1e-9);
    approx(west.distance - sol.direct.distance, 0.1, 1e-6);
    const { peaks } = buildImpulseResponse(sol, 48000);
    const wp = peaks.find((p) => p.faceNames[0]?.startsWith('西墙'));
    approx(wp.sampleFloat, wp.timeSec * 48000, 1e-9);
    equal(wp.sampleNearest, Math.round(wp.sampleFloat));
  });
  group('4 不可见路径', '楔形房间存在带原因的剔除且计数守恒', () => {
    const wedge = wedgeRoom({ W: 4, Wt: 2, H: 3, Ly: 4 });
    // 两点均在梯形截面内；斜墙的部分镜像路径会越过墙面范围而被剔除
    const sol = solveRoom(wedge, V(-1.2, 0.5, 0.6), V(1.2, 3.5, 2.0), { maxOrder: 2 });
    ok(sol.culled.length > 0, '应有剔除');
    ok(sol.culled.every((c) => typeof c.reason === 'string'), '剔除带原因');
    ok(sol.reflections.length > 0, '应同时保留合法路径');
    equal(sol.stats.validCount + sol.stats.culledCount, sol.stats.sequencesAttempted);
  });
  group('5 预算', 'cap 触发显式 capped；充足时不截断', () => {
    const S = V(1, 1, 1.5), R = V(5, 3, 1.5);
    const capped = solveRoom(rectRoom([6, 4, 3]), S, R, { maxOrder: 4, cap: 50 });
    equal(capped.stats.capped, true);
    ok(capped.stats.sequencesAttempted <= 50, '不超预算');
    const full = solveRoom(rectRoom([6, 4, 3]), S, R, { maxOrder: 4, cap: 100000 });
    equal(full.stats.capped, false);
    ok(full.reflections.some((r) => r.order === 4), '含四阶路径');
  });
  group('6 卷积', 'FFT 卷积==时域卷积且保留传播延迟', () => {
    const sr = 48000;
    const sol = solveRoom(rectRoom([6, 4, 3]), V(1, 1, 1.5), V(5, 3, 1.5), { maxOrder: 2 });
    const { ir, peaks } = buildImpulseResponse(sol, sr);
    const x = makeClick(sr, { durationSec: 0.02 });
    const a = convolveNaive(x, ir), b = convolveFFT(x, ir, { blockSize: 256 });
    equal(a.length, b.length);
    let err = 0;
    for (let i = 0; i < a.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
    ok(err < 1e-10, `卷积误差 ${err}`);
    const impulse = new Float64Array(8); impulse[0] = 1;
    const y = convolveFFT(impulse, ir);
    const idx = Math.round(peaks[0].sampleFloat);
    for (let i = 0; i < idx - 10; i++) approx(y[i], 0, 1e-12);
  });

  return checks;
}
