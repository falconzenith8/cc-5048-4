// 纯 Canvas 3D 线框渲染：轨道相机 + 凸多面体 + 声源/听点/反射路径
import { V, sub, dot, cross, normalize, scale, add } from './geometry.js';

export class OrbitCamera {
  constructor(canvas) {
    this.canvas = canvas;
    this.yaw = -0.7;
    this.pitch = 0.45;
    this.dist = 0;
    this.target = V(0, 0, 0);
    this._drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      this._drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      this.yaw = this._drag.yaw - (e.clientX - this._drag.x) * 0.01;
      this.pitch = Math.max(-1.4, Math.min(1.4, this._drag.pitch + (e.clientY - this._drag.y) * 0.01));
    });
    const end = () => { this._drag = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  basis() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // 相机位置（轨道）
    const eye = add(this.target, V(this.dist * cp * sy, this.dist * cp * cy, this.dist * sp));
    const forward = normalize(sub(this.target, eye));
    const worldUp = V(0, 0, 1);
    const right = normalize(cross(forward, worldUp));
    const up = cross(right, forward);
    return { eye, forward, right, up };
  }

  project(p, width, height) {
    const { eye, forward, right, up } = this.basis();
    const rel = sub(p, eye);
    const z = dot(rel, forward);
    if (z <= 0.05) return null;
    const x = dot(rel, right);
    const y = dot(rel, up);
    const f = height * 1.1;
    return { x: width / 2 + (x / z) * f, y: height / 2 - (y / z) * f, z };
  }
}

export function drawScene(canvas, poly, source, receiver, result, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f1420';
  ctx.fillRect(0, 0, W, H);

  // 相机取景：以全部顶点与 S/R 的包围球为尺度
  const all = [];
  for (const f of poly.faces) all.push(...f.vertices);
  all.push(source, receiver);
  const min = V(Math.min(...all.map((p) => p.x)), Math.min(...all.map((p) => p.y)), Math.min(...all.map((p) => p.z)));
  const max = V(Math.max(...all.map((p) => p.x)), Math.max(...all.map((p) => p.y)), Math.max(...all.map((p) => p.z)));
  const cam = opts.camera;
  cam.target = scale(add(min, max), 0.5);
  cam.dist = 1.6 * Math.max(max.x - min.x, max.y - min.y, max.z - min.z) + 1;

  const proj = (p) => cam.project(p, W, H);

  // 墙面（半透明填充 + 边线）
  for (const f of poly.faces) {
    const pts = f.vertices.map(proj);
    if (pts.some((p) => !p)) continue;
    const depth = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(90,140,220,${0.06 + Math.min(0.1, 2 / depth)})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,180,230,0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  const drawLine = (points, color, width, dash = []) => {
    const pp = points.map(proj);
    if (pp.some((p) => !p)) return;
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.moveTo(pp[0].x, pp[0].y);
    for (let i = 1; i < pp.length; i++) ctx.lineTo(pp[i].x, pp[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // 直达声
  if (result.direct.valid) drawLine([source, receiver], '#7ee787', 2);

  // 反射路径（按阶次着色）
  const orderColors = ['#e3b341', '#f0883e', '#a371f7', '#ec6cb9', '#56d4dd'];
  const maxShow = opts.maxPaths ?? result.reflections.length;
  result.reflections.slice(0, maxShow).forEach((r) => {
    drawLine(r.points, orderColors[(r.order - 1) % orderColors.length], 1.3);
  });

  // 可选：被剔除路径（虚线，连到镜像源以示为何非法）
  if (opts.showCulled) {
    for (const c of result.culled.slice(0, 30)) {
      drawLine([receiver, c.image], 'rgba(248,81,73,0.5)', 1, [5, 5]);
    }
  }

  const marker = (p, color, label) => {
    const q = proj(p);
    if (!q) return;
    ctx.beginPath();
    ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#e6edf3';
    ctx.font = '12px sans-serif';
    ctx.fillText(label, q.x + 9, q.y - 7);
  };
  marker(source, '#ffd33d', '声源 S');
  marker(receiver, '#7ee787', '听点 R');

  // 坐标轴小标记
  ctx.fillStyle = '#8b949e';
  ctx.font = '11px sans-serif';
  ctx.fillText('拖拽旋转视角 · z 轴向上', 10, H - 12);
}
