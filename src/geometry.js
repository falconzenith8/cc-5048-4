// 3D 向量与凸多面体几何（镜像源法所需的全部原语）
// 长度单位：米。所有面以逆时针顶点定义，法线由叉积得到并要求朝外。

export const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a, k) => V(a.x * k, a.y * k, a.z * k);
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) =>
  V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a) => Math.hypot(a.x, a.y, a.z);
export const dist = (a, b) => length(sub(a, b));
export const normalize = (a) => {
  const l = length(a) || 1;
  return scale(a, 1 / l);
};
export const lerp = (a, b, t) => add(a, scale(sub(b, a), t));

const EPS = 1e-9;

// 由三个顶点构造一个三角形/多边形面，法线取 (v1-v0)x(v2-v0)
function makeFace(name, vertices, absorption) {
  const n = normalize(cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0])));
  return {
    name,
    vertices,
    normal: n,
    d: -dot(n, vertices[0]), // 平面方程 n·x + d = 0
    absorption,
  };
}

// 校验：所有面法线朝外（其余顶点必须在面的内侧），且点严格在多面体内部
export function validateConvex(poly, samplePoints = []) {
  for (const f of poly.faces) {
    for (const other of poly.faces) {
      for (const p of other.vertices) {
        if (dot(f.normal, p) + f.d > 1e-7) {
          throw new Error(`面 ${f.name} 法线不朝外或多面体非凸`);
        }
      }
    }
  }
  for (const p of samplePoints) {
    if (!contains(poly, p, 1e-6)) throw new Error('点不在多面体内部');
  }
  return true;
}

export function contains(poly, p, eps = 1e-6) {
  return poly.faces.every((f) => dot(f.normal, p) + f.d <= eps);
}

// 矩形房间 [0,Lx]×[0,Ly]×[0,Lz]，约定 x/y 为地面两轴、z 为高度
// 六面四边形顶点逆时针（从室外看），使叉积法线朝外
export function rectRoom(dims, absorptions = {}) {
  const [Lx, Ly, Lz] = dims;
  const a = (k) => absorptions[k] ?? 0.2;
  const faces = [
    makeFace('西墙 x=0', [V(0, 0, 0), V(0, 0, Lz), V(0, Ly, Lz), V(0, Ly, 0)], a('west')),
    makeFace('东墙 x=Lx', [V(Lx, 0, 0), V(Lx, Ly, 0), V(Lx, Ly, Lz), V(Lx, 0, Lz)], a('east')),
    makeFace('南墙 y=0', [V(0, 0, 0), V(Lx, 0, 0), V(Lx, 0, Lz), V(0, 0, Lz)], a('south')),
    makeFace('北墙 y=Ly', [V(0, Ly, 0), V(0, Ly, Lz), V(Lx, Ly, Lz), V(Lx, Ly, 0)], a('north')),
    makeFace('地面 z=0', [V(0, 0, 0), V(0, Ly, 0), V(Lx, Ly, 0), V(Lx, 0, 0)], a('floor')),
    makeFace('天花 z=Lz', [V(0, 0, Lz), V(Lx, 0, Lz), V(Lx, Ly, Lz), V(0, Ly, Lz)], a('ceiling')),
  ];
  const poly = { kind: 'rect', dims, faces };
  validateConvex(poly);
  return poly;
}

// 楔形房间：x-z 平面截面为梯形（两侧墙倾斜），y 方向纵深 Ly
// 下宽 W、上宽 Wt、高 H（z 向）、纵深 Ly
export function wedgeRoom({ W = 4, Wt = 2, H = 3, Ly = 4 } = {}, absorptions = {}) {
  const xb = W / 2, xt = Wt / 2;
  const a = (k) => absorptions[k] ?? 0.2;
  // 截面梯形顶点（z 为高度）：底左、底右、顶右、顶左
  const bl = V(-xb, 0, 0), br = V(xb, 0, 0), tr = V(xt, 0, H), tl = V(-xt, 0, H);
  // 沿纵深 y 平移到指定 y 平面
  const at = (p, y) => V(p.x, y, p.z);
  const faces = [
    makeFace('地面 z=0', [at(bl, 0), at(bl, Ly), at(br, Ly), at(br, 0)], a('floor')),
    makeFace('天花 z=H', [at(tl, 0), at(tr, 0), at(tr, Ly), at(tl, Ly)], a('ceiling')),
    makeFace('左斜墙', [at(bl, 0), at(tl, 0), at(tl, Ly), at(bl, Ly)], a('west')),
    makeFace('右斜墙', [at(br, 0), at(br, Ly), at(tr, Ly), at(tr, 0)], a('east')),
    makeFace('端面 y=0', [at(bl, 0), at(br, 0), at(tr, 0), at(tl, 0)], a('south')),
    makeFace('端面 y=Ly', [at(bl, Ly), at(tl, Ly), at(tr, Ly), at(br, Ly)], a('north')),
  ];
  const poly = { kind: 'wedge', params: { W, Wt, H, Ly }, faces };
  validateConvex(poly);
  return poly;
}

// 点关于平面反射
export function reflectPoint(p, face) {
  const n = face.normal;
  const k = dot(n, p) + face.d; // n·p + d
  return sub(p, scale(n, 2 * k));
}

// 射线 o+t*d 与平面求交，返回 t（无向），平行返回 null
export function rayPlane(o, d, face) {
  const denom = dot(face.normal, d);
  if (Math.abs(denom) < EPS) return null;
  return -(dot(face.normal, o) + face.d) / denom;
}

// 点是否落在凸多边形面内（已知点在面平面上）：对每条边检查半平面符号一致
export function faceContainsPoint(face, p, eps = 1e-7) {
  const verts = face.vertices;
  let ref = 0;
  for (let i = 0; i < verts.length; i++) {
    const e = sub(verts[(i + 1) % verts.length], verts[i]);
    const w = sub(p, verts[i]);
    const s = dot(cross(e, w), face.normal);
    if (Math.abs(s) < eps) continue; // 在边上
    if (ref === 0) ref = Math.sign(s);
    else if (Math.sign(s) !== ref) return false;
  }
  return true;
}

// 线段是否完全在凸多面体内（含边界）：凸体只需两端点在内部
export function segmentInside(poly, a, b, eps = 1e-6) {
  return contains(poly, a, eps) && contains(poly, b, eps);
}
