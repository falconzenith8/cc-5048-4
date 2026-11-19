// 几何声学求解器：镜像源（image source）法
// 仅适用于凸多面体房间；非凸/遮挡场景靠逐段合法性校验剔除非法路径。
import {
  add, sub, scale, dist,
  reflectPoint, rayPlane, faceContainsPoint, contains,
} from './geometry.js';

const EPS_T = 1e-9;

// 按反射顺序折叠声源：seq 为面的反弹次序（seq[0] 为第一次反射）
// I = R_seq[n-1](...R_seq[0](S)...)，即沿序逐次反射
export function imageSource(source, faces, seq) {
  let p = source;
  for (const f of seq) p = reflectPoint(p, f);
  return p;
}

// 重建一条候选路径并做完整合法性校验
// 返回 { valid, points, reason }；points = [S, q0, q1, ..., qn-1, R]
export function validatePath(poly, source, receiver, seq) {
  const n = seq.length;
  // 各级镜像源 I_i = 折叠 seq[0..i]
  const images = [];
  let p = source;
  for (let i = 0; i < n; i++) {
    p = reflectPoint(p, seq[i]);
    images.push(p);
  }
  const points = [source];
  let origin = receiver;
  let target = images[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    const face = seq[i];
    // 从当前点指向该级镜像源；t>0 保证沿正向，面内/室内检查保证物理合法
    const dir = sub(target, origin);
    const t = rayPlane(origin, dir, face);
    if (t === null) return { valid: false, reason: '射线与反射面平行', points };
    if (t <= EPS_T) {
      return { valid: false, reason: '反射点落在反向射线上（路径不可见）', points };
    }
    const q = add(origin, scale(dir, t));
    if (!faceContainsPoint(face, q)) {
      return { valid: false, reason: `反射点落在${face.name}区域外（被遮挡/越过边缘）`, points };
    }
    // 凸体中线段端点（含墙面边界）在体内即保证整段在室内；origin 可能位于前一级反射面上
    if (!contains(poly, q, 1e-5)) {
      return { valid: false, reason: '反射点在房间外部（路径穿出房间，更早击中其他墙面）', points };
    }
    points.splice(1, 0, q); // 逆序求得，插到声源之后
    origin = q;
    target = i > 0 ? images[i - 1] : source;
  }
  points.push(receiver);
  return { valid: true, points, reason: null };
}

function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += dist(points[i - 1], points[i]);
  return d;
}

// 反射幅度因子 Π(1-α)；空气吸收 exp(-m d)，m=0 表示忽略
export function reflectionFactor(seq) {
  let g = 1;
  for (const f of seq) g *= 1 - f.absorption;
  return g;
}

// 枚举至多 maxOrder 阶反射；cap 为候选序列硬上限（计算预算）
export function solveRoom(poly, source, receiver, { maxOrder = 3, cap = 20000, airAttenuation = 0 } = {}) {
  const directInside = contains(poly, source, 1e-6) && contains(poly, receiver, 1e-6);
  const direct = {
    source, receiver,
    distance: dist(source, receiver),
    timeSec: dist(source, receiver) / 343,
    gain: directInside ? 1 / Math.max(dist(source, receiver), 1e-6) : 0,
    valid: directInside,
    reason: directInside ? null : '声源或听点不在房间内',
  };

  const reflections = [];
  const culled = [];
  let attempted = 0;
  let capped = false;
  const faces = poly.faces;

  // BFS：每层是面索引序列集合；相邻两次不能是同一面（平面连续自反射退化）
  // 不按合法性剪枝：标准镜像源枚举要求全部候选都做校验，再由几何检查剔除。
  let frontier = [[]];
  for (let order = 1; order <= maxOrder; order++) {
    const current = [];
    for (const prefix of frontier) {
      const last = prefix.length ? prefix[prefix.length - 1] : -1;
      for (let fi = 0; fi < faces.length; fi++) {
        if (fi === last) continue;
        current.push([...prefix, fi]);
      }
    }
    frontier = current;
    for (const seqIdx of current) {
      if (attempted >= cap) { capped = true; break; }
      const seq = seqIdx.map((i) => faces[i]);
      attempted++;
      const image = imageSource(source, faces, seq);
      const check = validatePath(poly, source, receiver, seq);
      if (!check.valid) {
        culled.push({
          order, faceNames: seq.map((f) => f.name), reason: check.reason, image,
        });
        continue;
      }
      const d = pathLength(check.points);
      const rFactor = reflectionFactor(seq);
      const air = airAttenuation > 0 ? Math.exp(-airAttenuation * d) : 1;
      reflections.push({
        order,
        faceNames: seq.map((f) => f.name),
        faces: seq,
        image,
        points: check.points,
        distance: d,
        timeSec: d / 343,
        reflectionFactor: rFactor,
        gain: (rFactor * air) / Math.max(d, 1e-6),
      });
    }
    if (capped) break;
  }

  reflections.sort((a, b) => a.timeSec - b.timeSec);
  return {
    direct,
    reflections,
    culled,
    stats: {
      maxOrder, cap, sequencesAttempted: attempted,
      validCount: reflections.length, culledCount: culled.length, capped,
    },
  };
}
