// 场景构建：矩形房间 + 可旋转的有限尺寸竖直板材（隔板/屏风）
// 板材为零厚度镜面：正反两面各自有材质与吸收系数，边缘绕射不在几何声学模型内。
import { V, add, sub, scale, normalize, cross, dot, rectRoom } from './geometry.js';

export const DEFAULT_MATERIALS = {
  room: { absorption: 0.18 },
  floor: { absorption: 0.22 },
  ceiling: { absorption: 0.28 },
  partition: { front: 0.12, back: 0.55 },
  screen: { front: 0.92, back: 0.96 },
};

const DEG = Math.PI / 180;

function makeFace(name, vertices, absorption, meta) {
  const n = normalize(cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0])));
  return {
    name,
    vertices,
    normal: n,
    d: -dot(n, vertices[0]),
    absorption,
    ...meta,
  };
}

// 竖直板材：center 为中心，width 沿局部 u=(cosθ,sinθ)，height 沿 z。
// 正面法线 n=(-sinθ,cosθ)，背面法线 -n；两面共面（零厚度）。
export function panelFaces(panel, material) {
  const th = (panel.angleDeg ?? 0) * DEG;
  const c = V(...panel.center);
  const u = V(Math.cos(th), Math.sin(th), 0);
  const n = V(-Math.sin(th), Math.cos(th), 0);
  const hw = panel.width / 2, hh = panel.height / 2;
  const z = V(0, 0, 1);
  const p = (su, sz) => add(c, add(scale(u, su * hw), scale(z, sz * hh)));
  const quad = [p(-1, -1), p(-1, 1), p(1, 1), p(1, -1)];
  const meta = { panelId: panel.id, role: panel.role, panel };
  const front = makeFace(`${panel.id}:正面`, quad, material.front, { ...meta, side: 'front' });
  const back = makeFace(`${panel.id}:背面`, [...quad].reverse(), material.back, { ...meta, side: 'back' });
  // 两面共面，法线相反；d 相同
  return [front, back];
}

export function buildScene(spec) {
  const mats = { ...DEFAULT_MATERIALS, ...(spec.materials || {}) };
  const [Lx, Ly, Lz] = spec.room.dims;
  const abs = {
    west: (mats.walls?.west ?? mats.room.absorption),
    east: (mats.walls?.east ?? mats.room.absorption),
    south: (mats.walls?.south ?? mats.room.absorption),
    north: (mats.walls?.north ?? mats.room.absorption),
    floor: (mats.walls?.floor ?? mats.floor.absorption),
    ceiling: (mats.walls?.ceiling ?? mats.ceiling.absorption),
  };
  const room = rectRoom([Lx, Ly, Lz], abs);
  const roomFaces = room.faces.map((f) => ({ ...f, role: 'room', side: null }));
  const panels = (spec.panels || []).map((p) => {
    const material = mats[p.material || p.role] || mats.partition;
    const faces = panelFaces(p, material);
    return { spec: p, faces, material };
  });
  const faces = [...roomFaces, ...panels.flatMap((p) => p.faces)];
  return {
    spec,
    room,
    roomFaces,
    faces,
    panels,
    source: V(...spec.source),
    listener: V(...spec.listener),
    materials: mats,
  };
}

// 只替换板材参数，保持其余场景不变
export function withPanel(scene, panelId, updates) {
  const spec = structuredClone(scene.spec);
  const p = spec.panels.find((x) => x.id === panelId);
  if (!p) throw new Error(`场景中没有板材 ${panelId}`);
  Object.assign(p, updates);
  return buildScene(spec);
}

export function withoutPanel(scene, panelId) {
  const spec = structuredClone(scene.spec);
  spec.panels = spec.panels.filter((p) => p.id !== panelId);
  return buildScene(spec);
}

export function withListener(scene, listener) {
  const spec = structuredClone(scene.spec);
  spec.listener = [...listener];
  return buildScene(spec);
}

export function sceneToJSON(spec) {
  return JSON.stringify(spec, null, 2);
}
