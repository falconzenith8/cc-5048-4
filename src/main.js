// 主应用：房间编辑 -> 几何求解 -> IR -> 真实卷积 -> 试听
import { rectRoom, wedgeRoom, V, validateConvex, contains } from './geometry.js';
import { solveRoom } from './solver.js';
import {
  buildImpulseResponse, convolveFFT, normalize, mixDryWet, encodeWav, makeClick,
  SPEED_OF_SOUND,
} from './acoustics.js';
import { OrbitCamera, drawScene } from './view3d.js';
import { drawIR } from './chart.js';

const $ = (id) => document.getElementById(id);
const state = {
  roomType: 'rect',
  sampleRate: 48000,
  solution: null,
  irData: null,
  dry: null,
  wet: null,
  audio: null,
  currentUrl: null,
};

const MATERIAL_PRESETS = {
  全反射硬墙: 0.05,
  抹灰砖墙: 0.2,
  木质: 0.35,
  吸声软垫: 0.7,
};

function readParams() {
  return {
    Lx: +$('dimX').value, Ly: +$('dimY').value, Lz: +$('dimZ').value,
    sx: +$('srcX').value, sy: +$('srcY').value, sz: +$('srcZ').value,
    rx: +$('rcvX').value, ry: +$('rcvY').value, rz: +$('rcvZ').value,
    order: +$('maxOrder').value,
    cap: +$('cap').value,
    absorption: +$('absorption').value,
    airAttenuation: $('airOn').checked ? +$('airAtten').value : 0,
    wet: +$('wetMix').value / 100,
  };
}

function buildRoom(p) {
  const abs = { west: p.absorption, east: p.absorption, south: p.absorption, north: p.absorption, floor: p.absorption, ceiling: p.absorption };
  if (state.roomType === 'wedge') {
    return wedgeRoom({ W: p.Lx, Wt: Math.max(0.5, p.Lx * 0.5), H: p.Lz, Ly: p.Ly }, abs);
  }
  return rectRoom([p.Lx, p.Ly, p.Lz], abs);
}

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = isError ? '#f85149' : '#8b949e';
}

function recompute() {
  const p = readParams();
  const S = V(p.sx, p.sy, p.sz), R = V(p.rx, p.ry, p.rz);
  let room;
  try {
    room = buildRoom(p);
    validateConvex(room, [S, R]);
  } catch (e) {
    setStatus(`几何错误：${e.message}`, true);
    return;
  }
  if (!contains(room, S, 1e-6) || !contains(room, R, 1e-6)) {
    setStatus('声源或听点不在房间内部，请调整坐标。', true);
    return;
  }
  const t0 = performance.now();
  const sol = solveRoom(room, S, R, { maxOrder: p.order, cap: p.cap, airAttenuation: p.airAttenuation });
  const ms = (performance.now() - t0).toFixed(1);
  state.solution = sol;
  state.room = room; state.S = S; state.R = R;

  const built = buildImpulseResponse(sol, state.sampleRate);
  state.irData = built;
  renderTables(sol, built);
  renderBaseline(p, sol);
  renderBudget(sol, ms);
  drawScene($('view3d'), room, S, R, sol, { camera: state.camera, showCulled: $('showCulled').checked });
  drawIR($('irChart'), built.ir, built.peaks, state.sampleRate);
  state.wet = null; // 旧卷积失效
  setStatus(`已求解：${sol.reflections.length} 条合法反射、${sol.culled.length} 条剔除，耗时 ${ms} ms。`);
}

function renderTables(sol, built) {
  // 路径表
  const rows = [];
  if (sol.direct.valid) {
    const pk = built.peaks[0];
    rows.push(pathRow('直达声', 0, '—', sol.direct.distance, sol.direct.timeSec, sol.direct.gain, pk));
  }
  sol.reflections.forEach((r, i) => {
    const pk = built.peaks[i + 1];
    rows.push(pathRow(`${r.order}阶`, r.order, r.faceNames.join('→'), r.distance, r.timeSec, r.gain, pk));
  });
  $('pathRows').innerHTML = rows.join('');

  // 剔除表
  $('culledRows').innerHTML = sol.culled.map((c) =>
    `<tr><td>${c.order}</td><td>${c.faceNames.join('→')}</td><td class="muted">${c.reason}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">无剔除路径</td></tr>';
}

function pathRow(label, order, faces, d, t, gain, pk) {
  return `<tr>
    <td>${label}</td><td>${order}</td><td class="faces">${faces}</td>
    <td>${d.toFixed(4)}</td>
    <td>${(t * 1000).toFixed(4)}</td>
    <td>${(t * state.sampleRate).toFixed(3)}</td>
    <td>${pk ? pk.sampleNearest : '—'}</td>
    <td>${gain.toExponential(3)}</td>
  </tr>`;
}

// 手算基线面板：矩形房间一阶西墙反射，公式与数值并列，并与求解器结果对照
function renderBaseline(p, sol) {
  if (state.roomType !== 'rect') {
    $('baseline').innerHTML = '<p class="muted">手算基线仅在矩形房间下展示（楔形房间用同样的镜像源公式，逐面数值校验）。</p>';
    return;
  }
  const c = 343;
  const dd = Math.hypot(p.rx - p.sx, p.ry - p.sy, p.rz - p.sz);
  // 西墙 x=0：镜像源 S'=(-sx, sy, sz)
  const dWest = Math.hypot(p.rx + p.sx, p.ry - p.sy, p.rz - p.sz);
  const west = sol.reflections.find((r) => r.faceNames[0].startsWith('西墙'));
  const match = west ? Math.abs(west.distance - dWest) < 1e-9 : false;
  $('baseline').innerHTML = `
    <p>矩形房间 Lx×Ly×Lz = ${p.Lx}×${p.Ly}×${p.Lz} m，吸收系数 α=${p.absorption}，声速 c=${c} m/s。</p>
    <ol>
      <li>直达声：d₀=√(Δx²+Δy²+Δz²)=<b>${dd.toFixed(4)} m</b>，到达 t₀=d₀/c=<b>${(dd / c * 1000).toFixed(4)} ms</b>，幅度 1/d₀=<b>${(1 / dd).toFixed(4)}</b>。</li>
      <li>西墙（x=0）一阶反射：镜像源 S′=(${(-p.sx).toFixed(2)}, ${p.sy}, ${p.sz})，
        路径长 d=√((${p.rx}−${(-p.sx).toFixed(2)})²+Δy²+Δz²)=<b>${dWest.toFixed(4)} m</b>，
        到达 <b>${(dWest / c * 1000).toFixed(4)} ms</b>，
        反射因子 (1−α)=${(1 - p.absorption).toFixed(2)}，幅度=(1−α)/d=<b>${((1 - p.absorption) / dWest).toFixed(4)}</b>。</li>
      <li>样本落点（fs=${state.sampleRate}）：n=t·fs=<b>${(dWest / c * state.sampleRate).toFixed(3)}</b>，最近整数样本 <b>${Math.round(dWest / c * state.sampleRate)}</b>，分数部分由 Hann-sinc 核分配。</li>
    </ol>
    <p class="${match ? 'ok' : 'err'}">求解器西墙路径长 ${west ? west.distance.toFixed(6) : '缺失'} m，与手算 ${match ? '一致 ✓' : '不一致 ✗'}</p>`;
}

function renderBudget(sol, ms) {
  const s = sol.stats;
  const warn = s.capped
    ? `<span class="err">⚠ 达到候选上限 ${s.cap}，阶次 ${s.maxOrder} 未枚举完整。请降低阶次或提高上限——程序不会用随机回声冒充缺失路径。</span>`
    : `阶次上限 ${s.maxOrder}，候选 ${s.sequencesAttempted} 条全部枚举完成（无静默截断）。`;
  $('budget').innerHTML = `<p>${warn}</p>
    <p class="muted">枚举空间随阶次指数增长：N 面、k 阶约 N·(N−1)^(k−1) 条序列。本场景合法 ${s.validCount} / 剔除 ${s.culledCount}，几何求解 ${ms} ms。</p>`;
}

// ---- 音频 ----
function ensureDry() {
  if (state.dry) return state.dry;
  state.dry = makeClick(state.sampleRate, { durationSec: 0.08 });
  return state.dry;
}

async function renderWet() {
  const p = readParams();
  const dry = ensureDry();
  setStatus('FFT overlap-add 卷积中…');
  await new Promise((r) => setTimeout(r, 20));
  const t0 = performance.now();
  const conv = convolveFFT(dry, state.irData.ir, { blockSize: 8192 });
  const norm = normalize(conv, 0.9);
  state.wet = { raw: conv, normalized: norm.data, gain: norm.gain };
  state.convMs = (performance.now() - t0).toFixed(1);
  setStatus(`卷积完成（${state.convMs} ms，归一化增益 ${norm.gain.toFixed(3)}）。`);
  return p;
}

function stopAudio() {
  if (state.audio) { state.audio.pause(); state.audio = null; }
  if (state.currentUrl) { URL.revokeObjectURL(state.currentUrl); state.currentUrl = null; }
}

async function play(kind) {
  stopAudio();
  if (!state.wet) await renderWet();
  const p = readParams();
  let samples;
  if (kind === 'dry') samples = state.dry;
  else if (kind === 'wet') samples = state.wet.normalized;
  else samples = normalize(mixDryWet(state.dry, state.wet.raw, p.wet), 0.9).data;
  const blob = encodeWav(samples, state.sampleRate);
  state.currentUrl = URL.createObjectURL(blob);
  state.audio = new Audio(state.currentUrl);
  state.audio.play();
}

function downloadWav() {
  const samples = state.wet ? state.wet.normalized : state.irData.ir;
  const blob = encodeWav(samples, state.sampleRate);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = kindDownload();
  a.click();
  URL.revokeObjectURL(a.href);
}
function kindDownload() { return state.wet ? 'wet-convolved.wav' : 'impulse-response.wav'; }

async function handleUpload(file) {
  const buf = await file.arrayBuffer();
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await actx.decodeAudioData(buf);
  const ch = decoded.getChannelData(0);
  // 重采样到工作采样率
  if (decoded.sampleRate === state.sampleRate) state.dry = new Float64Array(ch);
  else {
    const ratio = decoded.sampleRate / state.sampleRate;
    const n = Math.floor(ch.length / ratio);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = ch[Math.floor(i * ratio)];
    state.dry = out;
  }
  state.wet = null;
  setStatus(`已载入干声 ${file.name}（${(state.dry.length / state.sampleRate).toFixed(2)} s）。`);
  actx.close();
}

// ---- 事件绑定 ----
function init() {
  state.camera = new OrbitCamera($('view3d'));
  document.querySelectorAll('#controls input').forEach((el) => el.addEventListener('change', recompute));
  $('roomType').addEventListener('change', (e) => {
    state.roomType = e.target.value;
    if (state.roomType === 'wedge') {
      // 楔形上宽下窄，把声源/听点收到梯形截面内，避免默认点出界
      $('srcX').value = -1.2; $('srcY').value = 0.5; $('srcZ').value = 0.6;
      $('rcvX').value = 1.2; $('rcvY').value = 3.5; $('rcvZ').value = 2.0;
    } else {
      $('srcX').value = 1; $('srcY').value = 1; $('srcZ').value = 1.5;
      $('rcvX').value = 5; $('rcvY').value = 3; $('rcvZ').value = 1.5;
    }
    recompute();
  });
  $('airOn').addEventListener('change', (e) => {
    $('airAtten').disabled = !e.target.checked;
    recompute();
  });
  $('materialPreset').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    $('absorption').value = MATERIAL_PRESETS[e.target.value];
    recompute();
  });
  $('showCulled').addEventListener('change', () => drawScene($('view3d'), state.room, state.S, state.R, state.solution, { camera: state.camera, showCulled: $('showCulled').checked }));
  $('btnDry').onclick = () => play('dry');
  $('btnWet').onclick = () => play('wet');
  $('btnMix').onclick = () => play('mix');
  $('btnStop').onclick = stopAudio;
  $('btnDownload').onclick = downloadWav;
  $('btnUpload').addEventListener('change', (e) => e.target.files[0] && handleUpload(e.target.files[0]));
  $('btnTests').onclick = runBrowserTests;
  $('wetMix').addEventListener('input', (e) => {
    const v = +e.target.value;
    $('wetLabel').textContent = v === 0 ? '0% 湿声（纯干声）' : v === 100 ? '100% 湿声' : `湿声 ${v}% / 干声 ${100 - v}%`;
  });

  // 尺寸联动：约束声源/听点在房间内
  $('dimX').addEventListener('change', clampPoints);
  $('dimY').addEventListener('change', clampPoints);
  $('dimZ').addEventListener('change', clampPoints);

  recompute();
  requestAnimationFrame(function loop() {
    if (state.room) drawScene($('view3d'), state.room, state.S, state.R, state.solution, { camera: state.camera, showCulled: $('showCulled').checked });
    requestAnimationFrame(loop);
  });
}

function clampPoints() {
  const p = readParams();
  for (const [ax, dim] of [['X', 'Lx'], ['Y', 'Ly'], ['Z', 'Lz']]) {
    const lim = p[dim] - 0.05;
    for (const who of ['src', 'rcv']) {
      const el = $(who + ax);
      el.value = Math.min(+el.value, lim);
    }
  }
}

async function runBrowserTests() {
  const out = $('testOut');
  out.style.display = 'block';
  out.textContent = '运行中…';
  await new Promise((r) => setTimeout(r, 30));
  try {
    const { buildChecks } = await import('./checks.js');
    const checks = buildChecks();
    let pass = 0, group = '';
    const lines = [];
    for (const c of checks) {
      if (c.group !== group) { group = c.group; lines.push(`\n${group}`); }
      try { c.run(); pass++; lines.push(`  ✓ ${c.name}`); }
      catch (e) { lines.push(`  ✗ ${c.name} — ${e.message}`); }
    }
    lines.push(`\n${pass}/${checks.length} 项检查通过（与 npm test 同一套断言）`);
    out.textContent = lines.join('\n');
  } catch (e) {
    out.textContent = '检查模块加载失败：' + e.message;
  }
}

window.addEventListener('DOMContentLoaded', init);
