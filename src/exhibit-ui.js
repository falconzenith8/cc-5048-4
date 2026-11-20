// 展项界面：两个展厅并列渲染 3D 场景与脉冲响应。
// 点选任一脉冲（画布上点击或列表点选）→ 显示本次求值的墙面序列、传播长度、
// 分段长度与对应脉冲样本；可移动听点、转动隔板、删去隔板后重新生成，并载入检查点。
import { ECHO_HUNT_SPEC } from './exhibit-spec.js';
import {
  evaluateEchoes, solveGallery, verifyCheckpoint, regenerateWithoutPartition, instantiate,
} from './exhibit.js';
import { solveScene, C } from './scene-solver.js';
import { OrbitCamera, drawScene } from './view3d.js';
import { drawIR } from './chart.js';

const SAMPLE_RATE = 48000;
const FORMAT = 'echo-hunt-gallery/v1';

const galleryState = {
  A: { listener: null, panelAngles: {}, selected: null, removePanels: [], camera: null, result: null },
  B: { listener: null, panelAngles: {}, selected: null, removePanels: [], camera: null, result: null },
};

function elt(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

function resetState(spec) {
  for (const key of Object.keys(spec.galleries)) {
    const st = galleryState[key];
    st.listener = [...spec.listenerStart];
    st.panelAngles = {};
    for (const p of spec.galleries[key].panels) st.panelAngles[p.id] = p.angleDeg;
    st.selected = 0;
    st.removePanels = [];
  }
}

function solveOne(spec, key) {
  const st = galleryState[key];
  const scene = instantiate(spec, key, {
    listener: st.listener, panelAngles: st.panelAngles, removePanels: st.removePanels,
  });
  const solution = solveScene(scene, { maxOrder: 3, cap: 20000 });
  const evaluated = evaluateEchoes(scene, solution, SAMPLE_RATE, spec);
  st.result = { scene, solution, evaluated };
  return st.result;
}

function fmt(x, d = 3) { return typeof x === 'number' ? x.toFixed(d) : '—'; }

export function mountExhibit(root, { spec = ECHO_HUNT_SPEC } = {}) {
  if (!root) return;
  if (spec.format !== FORMAT) {
    root.append(elt('p', { class: 'muted' }, `不支持的场景格式：${spec.format}`));
    return;
  }
  resetState(spec);

  const grid = elt('div', { class: 'layout', style: 'grid-template-columns:1fr 1fr;gap:14px;' });
  const columns = {};
  for (const key of Object.keys(spec.galleries)) {
    const canvas = elt('canvas', { width: 380, height: 300 });
    const irCanvas = elt('canvas', { width: 380, height: 150 });
    const echoUl = elt('ul', { class: 'echoList' });
    const detail = elt('div', { class: 'explain' });
    const status = elt('div', { class: 'muted', style: 'margin:4px 0;font-size:11px;' });
    const galleryLabel = elt('div', { class: 'muted', style: 'margin-bottom:4px;' },
      `${spec.galleries[key].title} · ${spec.galleries[key].hypothesis}`);
    const btnRemove = elt('button', {}, '删去隔板重生成');
    const btnReset = elt('button', {}, '复位');
    const col = elt('div', {}, [galleryLabel, canvas, irCanvas, status, echoUl, detail,
      elt('div', { class: 'row', style: 'gap:6px;margin-top:6px;' }, [btnRemove, btnReset])]);
    columns[key] = { canvas, irCanvas, echoUl, detail, status, btnRemove, btnReset };
    grid.append(col);
    galleryState[key].camera = new OrbitCamera(canvas);

    canvas.addEventListener('click', () => {
      const ev = galleryState[key].result?.evaluated;
      if (!ev) return;
      const n = Math.max(1, ev.audible.length);
      galleryState[key].selected = ((galleryState[key].selected ?? 0) + 1) % n;
      renderOne(key);
    });
    irCanvas.addEventListener('click', (ev) => pickFromChart(key, ev, irCanvas));

    btnRemove.addEventListener('click', () => {
      const st = galleryState[key];
      const hasPanel = spec.galleries[key].panels.some((p) => !st.removePanels.includes(p.id));
      st.removePanels = hasPanel ? spec.galleries[key].panels.map((p) => p.id) : [];
      st.selected = 0;
      renderOne(key);
    });
    btnReset.addEventListener('click', () => {
      const st = galleryState[key];
      st.listener = [...spec.listenerStart];
      st.panelAngles = {};
      for (const p of spec.galleries[key].panels) st.panelAngles[p.id] = p.angleDeg;
      st.removePanels = [];
      st.selected = 0;
      renderOne(key);
      syncControls();
    });
  }

  // 公共控制：移动听点 / 转动隔板
  const listenerX = elt('input', { type: 'range', min: '0.5', max: '9.5', step: '0.05', value: String(spec.listenerStart[0]) });
  const listenerY = elt('input', { type: 'range', min: '0.5', max: '7.5', step: '0.05', value: String(spec.listenerStart[1]) });
  const angle = elt('input', { type: 'range', min: '40', max: '75', step: '0.5', value: '56.5' });
  const angleLabel = elt('span', { class: 'muted' }, '56.5°');
  const angleRow = elt('div', {}, [elt('label', {}, '转动隔板（B 厅）'), angle, angleLabel]);

  const apply = () => {
    for (const key of Object.keys(spec.galleries)) {
      galleryState[key].listener = [+listenerX.value, +listenerY.value, galleryState[key].listener[2]];
      for (const p of spec.galleries[key].panels) galleryState[key].panelAngles[p.id] = +angle.value;
    }
    angleLabel.textContent = `${(+angle.value).toFixed(1)}°`;
    renderAll();
  };
  listenerX.addEventListener('input', apply);
  listenerY.addEventListener('input', apply);
  angle.addEventListener('input', apply);

  // 检查点按钮
  const checkpointOut = elt('div', { class: 'explain' });
  const cpButtons = spec.routes.map((route) =>
    elt('button', {
      onclick: () => showCheckpoint(route),
    }, `载入检查点：${route.title}`));

  // 删板重生成对照
  const regenOut = elt('div', { class: 'explain' });
  const regenBtn = elt('button', { onclick: () => showRegenerate() }, '对照：删去隔板后重新生成');
  const compareBtn = elt('button', { onclick: () => showStartCompare() }, '对照：起始位姿两厅首回波');

  const controls = elt('div', { class: 'panel', style: 'margin-top:12px;' }, [
    elt('h2', {}, '展项交互'),
    elt('label', {}, '移动听点 x'), listenerX,
    elt('label', {}, '移动听点 y'), listenerY,
    angleRow,
    elt('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-top:8px;' },
      [...cpButtons, regenBtn, compareBtn]),
    checkpointOut, regenOut,
  ]);

  root.append(grid, controls);

  function syncControls() {
    listenerX.value = String(spec.listenerStart[0]);
    listenerY.value = String(spec.listenerStart[1]);
  }

  function pickFromChart(key, ev, canvas) {
    const ir = galleryState[key].result?.evaluated;
    if (!ir || !ir.audible.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
    const total = ir.impulse.ir.length;
    const sample = (x / canvas.width) * total;
    let best = 0, bestD = Infinity;
    ir.audible.forEach((e, i) => {
      const d = Math.abs(e.pulse.sampleFloat - sample);
      if (d < bestD) { bestD = d; best = i; }
    });
    galleryState[key].selected = best;
    renderOne(key);
  }

  function renderAll() {
    for (const key of Object.keys(spec.galleries)) renderOne(key);
  }

  function renderOne(key) {
    const col = columns[key];
    const st = galleryState[key];
    const { scene, solution, evaluated } = solveOne(spec, key);

    drawScene(col.canvas, scene, scene.source, scene.listener, solution, {
      camera: st.camera,
      maxPaths: 40,
    });
    drawIR(col.irCanvas, evaluated.impulse.ir, evaluated.impulse.peaks, SAMPLE_RATE);

    const g0 = 1 / Math.max(solution.direct.distance, 1e-6);
    const removed = st.removePanels.length > 0;
    col.status.textContent =
      `直达声 ${solution.direct.valid ? '可闻' : `被 ${solution.direct.occluder} 挡住`}` +
      ` · 可听回波 ${evaluated.audible.length} 条` +
      (removed ? ' · 隔板已删去' : '');

    // 回波列表：按到达顺序，点选（列表只含可听回波，选择索引也按该子集编号）
    col.echoUl.innerHTML = '';
    const audible = evaluated.audible;
    if (st.selected == null || st.selected >= audible.length) st.selected = 0;
    const selectedEcho = audible[st.selected] ?? null;
    if (!audible.length) {
      col.echoUl.append(elt('li', { class: 'muted' }, '无可闻回波'));
    }
    audible.forEach((e, i) => {
      const li = elt('li', {
        class: e === selectedEcho ? 'active' : '',
        onclick: () => { st.selected = i; renderOne(key); },
      }, [
        elt('span', { class: 'swatch', style: `background:${orderColor(e.order)}` }),
        elt('span', { class: 'seq' }, `${fmt(e.timeMs, 2)} ms · ${e.faceNames.join(' → ')}`),
      ]);
      col.echoUl.append(li);
    });

    // 求值详情
    const e = selectedEcho;
    col.detail.innerHTML = '';
    if (e) {
      col.detail.append(
        elt('div', { class: 'kv' }, [
          elt('span', {}, '墙面序列'), elt('span', {}, e.faceNames.join(' → ')),
          elt('span', {}, '阶次'), elt('span', {}, String(e.order)),
          elt('span', {}, '传播长度'), elt('span', {}, `${fmt(e.distance, 4)} m`),
          elt('span', {}, '分段'), elt('span', {}, e.segmentLengths.map((s) => fmt(s, 3)).join(' + ')),
          elt('span', {}, '到达时间'), elt('span', {}, `${fmt(e.timeMs, 4)} ms`),
          elt('span', {}, '相对直达声'), elt('span', {}, `${fmt(e.relDb, 1)} dB`),
          elt('span', {}, '对应脉冲'), elt('span', {}, `样本 ${fmt(e.pulse?.sampleFloat, 3)}（最近 ${e.pulse?.sampleNearest}）`),
          elt('span', {}, '是否跨隔板'), elt('span', {}, e.passesPartition ? '是' : '否'),
        ]),
        elt('p', { class: 'muted', style: 'margin:8px 0 0;' },
          `传播长度 ${fmt(e.distance, 4)} m ÷ ${C} m/s = ${fmt(e.distance / C * 1000, 4)} ms，` +
          `即脉冲图中 ${fmt(e.timeMs, 2)} ms 处的那个峰。`),
      );
    } else {
      col.detail.append(elt('p', { class: 'muted' }, '点选画布中的脉冲或上方回波列表查看求值。'));
    }

    const anyPanel = spec.galleries[key].panels.some((p) => !st.removePanels.includes(p.id));
    col.btnRemove.textContent = anyPanel ? '删去隔板重生成' : '放回隔板';
  }

  function showStartCompare() {
    const rows = [];
    for (const key of Object.keys(spec.galleries)) {
      const { evaluated } = solveGallery(spec, key, { maxOrder: 2 });
      const f = evaluated.first;
      rows.push(`${key} 厅：${f ? `${f.faceNames.join(' → ')} · ${fmt(f.distance, 4)} m · ${fmt(f.timeMs, 3)} ms（脉冲样本 ${f.pulse?.sampleNearest}）` : '无首回波'}`);
    }
    checkpointOut.innerHTML = '';
    checkpointOut.append(elt('p', { class: 'muted' }, '起始听点 R0：两厅首个可闻回波同刻、来源不同。'), ...rows.map((r) => elt('div', {}, r)));
  }

  function showCheckpoint(route) {
    const cp = verifyCheckpoint(spec, route);
    checkpointOut.innerHTML = '';
    const okBadge = cp.pass ? '✓ 可辨认' : '✗ 不可辨认';
    checkpointOut.append(
      elt('p', { class: 'muted' }, `${route.title}：屏风置于 S→R 之间，两厅直达声均被挡住。`),
      elt('div', {}, `${okBadge} · 到达时刻差 ${cp.firstEchoTimeDiffMs != null ? fmt(cp.firstEchoTimeDiffMs, 2) : '—'} ms`),
      elt('div', {}, `A 厅首条合法路径：${cp.A.faces ? cp.A.faces.join(' → ') : '无'}${cp.A.timeMs ? ` · ${fmt(cp.A.timeMs, 3)} ms` : ''}`),
      elt('div', {}, `B 厅首条合法路径：${cp.B.faces ? cp.B.faces.join(' → ') : '无'}${cp.B.timeMs ? ` · ${fmt(cp.B.timeMs, 3)} ms` : ''}`),
      elt('p', { class: 'muted' }, cp.checks.distinctFirstSources ? '两厅首条路径来源不同，可凭到达时刻辨认展厅。' : '两厅首条路径来源相同，无法凭时刻辨认。'),
    );
  }

  function showRegenerate() {
    const r = regenerateWithoutPartition(spec, 'B');
    regenOut.innerHTML = '';
    regenOut.append(
      elt('p', { class: 'muted' }, '删去隔板后重新生成 B 厅：'),
      elt('div', {}, `直达声：${r.checks.directStillValid ? '仍在 ✓' : '消失了 ✗'}（距离${r.checks.directDistanceUnchanged ? '不变' : '改变'}）`),
      elt('div', {}, `消失：${r.vanished.map((x) => x.faces.join(' → ')).join('；') || '无'}`),
      elt('div', {}, `新出现（被隔板挡住、删板后恢复）：${r.appeared.map((x) => x.faces.join(' → ')).join('；') || '无'}`),
      elt('div', { class: r.checks.everyVanishedEchoPassedPartition ? 'ok' : 'err' },
        r.checks.everyVanishedEchoPassedPartition ? '消失的回波全部真正经过隔板 ✓' : '存在不经过隔板却消失的回波 ✗'),
    );
  }

  renderAll();
  showStartCompare();
}

function orderColor(order) {
  return ['#7ee787', '#e3b341', '#f0883e', '#a371f7', '#ec6cb9', '#56d4dd'][order % 6];
}
