// 带内部遮挡物的场景求解器（镜像源法 + 逐段可见性校验）
//
// 与凸房间求解器的区别：反射面不再只有房间六个面，还包括内部板材的正面/背面；
// 合法性检查从"端点在凸体内"改为"反射点位于该面多边形内 + 每段线段未被任何面遮挡"。
// 板材零厚度但两面都参与反射，因此可重建"隔板后方的两次反射"这类路径。
import {
  add, sub, scale, dist, dot,
  reflectPoint, rayPlane, faceContainsPoint, contains,
} from './geometry.js';

export const C = 343; // m/s
const EPS_T = 1e-7;
const EPS_PLANE = 1e-6;

// S → q0 → q1 … → R 的完整传播长度
export function polylineLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += dist(points[i - 1], points[i]);
  return d;
}

// 线段 a→b 是否被某面遮挡（返回第一个遮挡面，忽略 skip 集合中的面）
export function firstOccluder(poly, a, b, skip = new Set()) {
  const dir = sub(b, a);
  const segLen = Math.hypot(dir.x, dir.y, dir.z);
  if (segLen < 1e-12) return null;
  for (const f of poly.faces) {
    if (skip.has(f)) continue;
    const denom = dot(f.normal, dir);
    if (Math.abs(denom) < 1e-12) continue; // 平行（含共面）
    const t = -(dot(f.normal, a) + f.d) / denom;
    if (t <= 1e-9 || t >= 1 - 1e-9) continue; // 只在严格内部交点算遮挡
    const p = add(a, scale(dir, t));
    if (!faceContainsPoint(f, p, 1e-7)) continue;
    // 位于房间边界上的点不算遮挡（端点/贴面情形）
    if (f.role === 'room' && contains(poly.room, p, 1e-6)) continue;
    return f;
  }
  return null;
}

export function pathIsVisible(poly, points, endFaces = []) {
  for (let i = 1; i < points.length - 1; i++) {
    const skip = new Set(endFaces);
    if (i === 1) skip.add(null);
    const hit = firstOccluder(poly, points[i - 1], points[i], skip);
    if (hit) return { visible: false, segment: i, occluder: hit };
  }
  return { visible: true, segment: -1, occluder: null };
}

// 重建并校验一条候选序列（face 数组，按反射先后）
export function validateScenePath(poly, source, listener, seq) {
  const n = seq.length;
  const images = [];
  let p = source;
  for (let i = 0; i < n; i++) {
    p = reflectPoint(p, seq[i]);
    images.push(p);
  }
  const points = [source];
  let origin = listener;
  let target = images[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    const face = seq[i];
    const dir = sub(target, origin);
    const t = rayPlane(origin, dir, face);
    if (t === null) return { valid: false, reason: `射线与${face.name}平行` };
    if (t <= EPS_T) return { valid: false, reason: `反射点在反向射线上（${face.name}不可见）` };
    const q = add(origin, scale(dir, t));
    if (!faceContainsPoint(face, q, 1e-7)) {
      return { valid: false, reason: `反射点落在${face.name}范围外` };
    }
    if (face.role === 'room' && !contains(poly.room, q, 1e-5)) {
      return { valid: false, reason: `反射点位于房间外（${face.name}）` };
    }
    points.splice(1, 0, q);
    origin = q;
    target = i > 0 ? images[i - 1] : source;
  }
  points.push(listener);

  // 镜面反射必须发生在反射面所朝向的一侧：房间面的内侧为 -n，板材的反射侧为 +n。
  // 这条约束同时禁止零厚度板材的"透射"（入射/出射分处两侧）。
  for (let i = 0; i < n; i++) {
    const face = seq[i];
    const side = face.role === 'room' ? -1 : 1;
    const nx = scale(face.normal, side);
    const q = points[i + 1];
    const inc = sub(q, points[i]);
    const out = sub(points[i + 2], q);
    if (dot(inc, nx) > -1e-9) {
      return { valid: false, reason: `入射方向不在${face.name}的反射侧` };
    }
    if (dot(out, nx) < 1e-9) {
      return { valid: false, reason: `出射方向穿到${face.name}背面（板材不透射）` };
    }
  }

  // 逐段遮挡检查：第 i 段的两个端点分别落在 seq[i-1] 与 seq[i]（或 S/R）上，
  // 这两张面本身不能算遮挡自家端点。
  for (let i = 1; i < points.length; i++) {
    const skip = new Set();
    if (i - 1 >= 1) skip.add(seq[i - 2]);
    if (i <= n) skip.add(seq[i - 1]);
    const hit = firstOccluder(poly, points[i - 1], points[i], skip);
    if (hit) {
      return { valid: false, reason: `第${i}段被${hit.name}遮挡`, occluder: hit.name };
    }
  }
  return { valid: true, points, reason: null, distance: polylineLength(points) };
}

export function pathGain(seq, d, { airAttenuation = 0 } = {}) {
  let g = 1;
  for (const f of seq) g *= 1 - f.absorption;
  if (airAttenuation > 0) g *= Math.exp(-airAttenuation * d);
  return g / Math.max(d, 1e-6);
}

// 枚举至多 maxOrder 阶；面板两面共面且同属一块板，连续两次反射同一块板物理上
// 意味着在零厚度上折返，直接排除（面索引相邻且 panelId 相同）。
export function solveScene(scene, { maxOrder = 3, cap = 20000, airAttenuation = 0 } = {}) {
  const faces = scene.faces;
  const S = scene.source, R = scene.listener;

  const directBlock = firstOccluder(scene, S, R);
  const direct = {
    source: S, listener: R,
    distance: dist(S, R),
    timeSec: dist(S, R) / C,
    gain: directBlock ? 0 : 1 / Math.max(dist(S, R), 1e-6),
    valid: !directBlock,
    occluder: directBlock ? directBlock.name : null,
    points: [S, R],
  };

  const reflections = [];
  const culled = [];
  let attempted = 0, capped = false;

  let frontier = [[]];
  for (let order = 1; order <= maxOrder; order++) {
    const current = [];
    for (const prefix of frontier) {
      const last = prefix.length ? prefix[prefix.length - 1] : -1;
      for (let fi = 0; fi < faces.length; fi++) {
        if (fi === last) continue;
        const lastFace = last >= 0 ? faces[last] : null;
        const f = faces[fi];
        if (lastFace && lastFace.panelId && lastFace.panelId === f.panelId) continue;
        current.push([...prefix, fi]);
      }
    }
    frontier = current;
    for (const seqIdx of current) {
      if (attempted >= cap) { capped = true; break; }
      attempted++;
      const seq = seqIdx.map((i) => faces[i]);
      const check = validateScenePath(scene, S, R, seq);
      if (!check.valid) {
        culled.push({ order, faceNames: seq.map((f) => f.name), reason: check.reason });
        continue;
      }
      const d = check.distance;
      reflections.push({
        order,
        faceNames: seq.map((f) => f.name),
        faces: seq,
        faceIds: seq.map((f) => f.name),
        incidenceSurfaces: seq.map((f) => surfaceKey(f)),
        panelSequence: seq.filter((f) => f.panelId).map((f) => `${f.panelId}:${f.side}`),
        passesPartition: seq.some((f) => f.panelId === 'partition'),
        points: check.points,
        distance: d,
        timeSec: d / C,
        gain: pathGain(seq, d, { airAttenuation }),
        delaySamples: {},
      });
    }
    if (capped) break;
  }
  reflections.sort((a, b) => a.timeSec - b.timeSec);
  return {
    direct, reflections, culled,
    stats: {
      maxOrder, cap, sequencesAttempted: attempted,
      validCount: reflections.length, culledCount: culled.length, capped,
    },
  };
}

// 面 → 板块级来源标识（用于作答/评分：正面、背面都归到板/墙上）
export function surfaceKey(face) {
  if (face.panelId) return face.panelId;
  return face.name;
}

// 首次到达的回波（不含直达声）
export function firstEcho(solution) {
  return solution.reflections[0] || null;
}

// 某条路径对应的镜像源（最后一级镜像）
export function pathImage(scene, path) {
  let p = scene.source;
  for (const f of path.faces) p = reflectPoint(p, f);
  return p;
}

// 路径传播长度的逐段分解
export function segmentLengths(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) out.push(dist(points[i - 1], points[i]));
  return out;
}
