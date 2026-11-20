// 展项分析层：把场景规格变成两个展厅的可计算实例，并提供
//   · 回波求值（墙面序列、传播长度、到达时刻、对应脉冲峰）
//   · 删除隔板后重新生成（检查直达声是否仍在、只有跨隔板回波消失）
//   · 检查点判定（屏风挡直达声后，能否凭首条合法路径的到达时刻辨认展厅）
// 全部同步、无 DOM 依赖，Node 与浏览器共用同一套实现。
import { buildScene } from './scene.js';
import {
  solveScene, firstEcho, pathImage, segmentLengths, surfaceKey, C,
} from './scene-solver.js';
import { buildImpulseResponse } from './acoustics.js';

export const DEFAULT_MAX_ORDER = 3;

// 用场景规格 + 展厅键构建可求解场景；overrides 允许改听点、隔板角度、删板等。
export function instantiate(spec, galleryKey, {
  listener, panelAngles = {}, removePanels = [], extraPanels = [], materials,
} = {}) {
  const g = spec.galleries[galleryKey];
  if (!g) throw new Error(`未知展厅 ${galleryKey}`);
  let panels = g.panels
    .filter((p) => !removePanels.includes(p.id))
    .map((p) => (panelAngles[p.id] != null ? { ...p, angleDeg: panelAngles[p.id] } : { ...p }));
  panels = [...panels, ...extraPanels.map((p) => ({ ...p }))];
  const scene = buildScene({
    id: galleryKey,
    room: { dims: spec.room.dims },
    materials: materials || spec.materials,
    source: spec.source,
    listener: listener || spec.listenerStart,
    panels,
  });
  return scene;
}

// 在可听阈值下按时到达排序的合法回波；relDb 相对直达声 1/d 幅度。
export function audibleEchoes(spec, solution) {
  const threshold = spec.echoAudibilityThresholdDb ?? -20;
  const g0 = 1 / Math.max(solution.direct.distance, 1e-6);
  return solution.reflections
    .map((r) => ({ ...r, relDb: 20 * Math.log10(r.gain / g0) }))
    .filter((r) => r.relDb >= threshold);
}

// 求值：给定场景与求解结果，为每条回波生成可展示的解释，
// 并把脉冲响应里对应峰的样本落点挂回去。
export function evaluateEchoes(scene, solution, sampleRate = 48000, spec = null) {
  const built = buildImpulseResponse(
    { direct: solution.direct, reflections: solution.reflections }, sampleRate,
  );
  const g0 = 1 / Math.max(solution.direct.distance, 1e-6);
  // peaks[0] 为直达声（若有效），其后顺序与 solution.reflections 对应
  const offset = solution.direct.valid ? 1 : 0;
  const echoes = solution.reflections.map((r, i) => {
    const peak = built.peaks[i + offset];
    const segs = segmentLengths(r.points);
    const image = pathImage(scene, r);
    return {
      faceNames: r.faceNames,
      surfaces: r.incidenceSurfaces,
      order: r.order,
      panelSequence: r.panelSequence,
      passesPartition: r.passesPartition,
      points: r.points,
      distance: r.distance,
      timeSec: r.timeSec,
      timeMs: r.timeSec * 1000,
      relDb: 20 * Math.log10(r.gain / g0),
      gain: r.gain,
      segmentLengths: segs,
      image,
      pulse: peak ? {
        sampleFloat: peak.sampleFloat,
        sampleNearest: peak.sampleNearest,
        timeSec: peak.timeSec,
        gain: peak.gain,
      } : null,
    };
  });
  const threshold = spec?.echoAudibilityThresholdDb ?? -20;
  return {
    direct: solution.direct,
    edges: echoes,
    audible: echoes.filter((e) => e.relDb >= threshold),
    first: echoes.filter((e) => e.relDb >= threshold)[0] || null,
    impulse: built,
    stats: solution.stats,
  };
}

// 一次完整求解：展厅键 + 覆盖参数 → { scene, solution, evaluated }
export function solveGallery(spec, galleryKey, opts = {}) {
  const scene = instantiate(spec, galleryKey, opts);
  const solution = solveScene(scene, {
    maxOrder: opts.maxOrder ?? DEFAULT_MAX_ORDER,
    cap: opts.cap ?? 20000,
    airAttenuation: opts.airAttenuation ?? 0,
  });
  const evaluated = evaluateEchoes(scene, solution, opts.sampleRate ?? 48000, spec);
  return { scene, solution, evaluated };
}

// 两个展厅在起始听点的首回波对照。
export function compareStart(spec) {
  const out = {};
  for (const key of Object.keys(spec.galleries)) {
    const { evaluated } = solveGallery(spec, key, { maxOrder: 2 });
    const f = evaluated.first;
    out[key] = {
      directValid: evaluated.direct.valid,
      first: f ? {
        order: f.order, faces: f.faceNames, surfaces: f.surfaces, distance: f.distance,
        timeMs: f.timeMs, relDb: f.relDb, passesPartition: f.passesPartition,
        sampleNearest: f.pulse?.sampleNearest,
      } : null,
    };
  }
  return out;
}

// 删除隔板后重新生成：对比 A/B 两条解释的回波集合。
// 期望：直达声仍在；只在 B 厅出现、且经过隔板的回波消失；不经过隔板的回波保留。
export function regenerateWithoutPartition(spec, galleryKey = 'B', opts = {}) {
  const before = solveGallery(spec, galleryKey, opts);
  const after = solveGallery(spec, galleryKey, { ...opts, removePanels: ['partition'] });

  const key = (e) => `${e.order}|${e.faceNames.join('->')}`;
  const beforeAud = new Map(before.evaluated.audible.map((e) => [key(e), e]));
  const afterAud = new Map(after.evaluated.audible.map((e) => [key(e), e]));

  const vanished = [];
  for (const [k, e] of beforeAud) if (!afterAud.has(k)) vanished.push(e);
  const kept = [];
  for (const [k, e] of afterAud) if (beforeAud.has(k)) kept.push(e);
  const appeared = [];
  for (const [k, e] of afterAud) if (!beforeAud.has(k)) appeared.push(e);

  const vanishedThroughPartition = vanished.filter((e) => e.passesPartition);
  const vanishedOther = vanished.filter((e) => !e.passesPartition);
  const afterNonPartition = [...afterAud.values()].filter((e) => !e.passesPartition);

  const checks = {
    directStillValid: after.evaluated.direct.valid === true,
    directDistanceUnchanged:
      Math.abs(after.evaluated.direct.distance - before.evaluated.direct.distance) < 1e-9,
    everyVanishedEchoPassedPartition: vanishedOther.length === 0,
    partitionFirstEchoGone:
      !afterAud.has(key(before.evaluated.first)) && before.evaluated.first?.passesPartition === true,
    // 隔板曾把墙面单次反射挡进声影；删板后它应重新出现，说明消失的只是跨隔板的那条
    blockedWallEchoRestored: appeared.some((e) => !e.passesPartition),
  };
  return {
    before, after,
    vanished: vanished.map(brief),
    vanishedThroughPartition: vanishedThroughPartition.map(brief),
    kept: kept.map(brief),
    appeared: appeared.map(brief),
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}

function brief(e) {
  return {
    order: e.order, faces: e.faceNames, distance: e.distance,
    timeMs: e.timeMs, relDb: e.relDb, passesPartition: e.passesPartition,
    sampleNearest: e.pulse?.sampleNearest,
  };
}

// 检查点：在指定听点加屏风，比较两厅首条合法路径的到达时刻。
// 期望：两厅直达声都被屏风挡住；各自仍有一条可听合法路径；到达时刻可区分。
export function verifyCheckpoint(spec, route, { sampleRate = 48000 } = {}) {
  const cp = route.checkpoint;
  const extra = cp?.screen ? [cp.screen] : [];
  const listener = cp?.listener || spec.listenerStart;
  const results = {};
  for (const key of Object.keys(spec.galleries)) {
    const { evaluated } = solveGallery(spec, key, {
      listener, extraPanels: extra, maxOrder: 2, sampleRate,
    });
    results[key] = evaluated;
  }
  const [a, b] = [results.A, results.B];
  const t = (r) => (r.first ? r.first.timeMs : null);
  const diffMs = t(a) != null && t(b) != null ? Math.abs(t(a) - t(b)) : null;
  const checks = {
    directBlockedInBoth: !a.direct.valid && !b.direct.valid,
    blockedByScreen:
      /screen/.test(a.direct.occluder || '') && /screen/.test(b.direct.occluder || ''),
    bothKeepAudibleEcho: !!a.first && !!b.first,
    firstEchoesDistinguishable: diffMs != null && diffMs > 0.5,
    // 「辨认展厅」要求两厅首条路径来源不同，而不只是到达时刻略有差异
    distinctFirstSources: !!a.first && !!b.first &&
      a.first.faceNames.join('->') !== b.first.faceNames.join('->'),
    firstEchoDoesNotUseScreen: !(a.first?.faceNames.concat(b.first?.faceNames || []).some((n) => n.includes('screen'))),
  };
  return {
    routeId: route.id,
    listener,
    A: a.first ? { faces: a.first.faceNames, timeMs: a.first.timeMs, distance: a.first.distance, occluder: a.direct.occluder } : { occluder: a.direct.occluder },
    B: b.first ? { faces: b.first.faceNames, timeMs: b.first.timeMs, distance: b.first.distance, occluder: b.direct.occluder } : { occluder: b.direct.occluder },
    firstEchoTimeDiffMs: diffMs,
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}

// 路线试听：从 listenerStart 沿 listenerSweep（或 panelSweep）逐格求解，
// 记录每帧首回波与来源，用于“移动听点/转动隔板能否排除一种解释”的演示。
export function runRoute(spec, route, { sampleRate = 48000 } = {}) {
  const frames = [];
  const angles = route.panelSweep;
  const points = route.listenerSweep && route.listenerSweep.length ? route.listenerSweep : [route.listenerStart];
  const g = spec.galleries[route.gallery];
  for (const p of points) {
    const panelAngles = {};
    const angleList = angles && angles.length ? angles : [g.panels[0]?.angleDeg];
    for (const ang of angleList) {
      if (ang != null) for (const panel of g.panels) panelAngles[panel.id] = ang;
      const { evaluated } = solveGallery(spec, route.gallery, {
        listener: p, panelAngles, maxOrder: 2, sampleRate,
      });
      frames.push({
        listener: p,
        panelAngle: angleList.length === 1 ? angleList[0] : ang,
        first: evaluated.first ? {
          faces: evaluated.first.faceNames,
          surfaces: evaluated.first.surfaces,
          passesPartition: evaluated.first.passesPartition,
          distance: evaluated.first.distance,
          timeMs: evaluated.first.timeMs,
          relDb: evaluated.first.relDb,
        } : null,
        audibleCount: evaluated.audible.length,
      });
    }
  }
  return { routeId: route.id, gallery: route.gallery, frames };
}

export { C as SPEED_OF_SOUND, surfaceKey, firstEcho };
