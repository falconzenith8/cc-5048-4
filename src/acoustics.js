// 声学层：把几何路径转成脉冲响应（IR），再与干声做真实线性卷积
import { fft, nextPow2 } from './fft.js';

export const SPEED_OF_SOUND = 343; // m/s
const HALF_TAPS = 8; // 分数延迟每侧 8 个抽头（共 16）

// Hann 加权 sinc 分数延迟核，归一化保证直流增益为 1（保持幅度量纲）
function sincKernel(delayFloat) {
  const base = Math.floor(delayFloat);
  const frac = delayFloat - base;
  const taps = 2 * HALF_TAPS;
  const k = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - HALF_TAPS; // 核内偏移
    const x = m - frac;
    const w = 0.5 * (1 + Math.cos((2 * Math.PI * (i - (HALF_TAPS - 0.5))) / taps));
    let v;
    if (Math.abs(x) < 1e-12) v = 1;
    else {
      const px = Math.PI * x;
      v = Math.sin(px) / px;
    }
    k[i] = v * w;
    sum += k[i];
  }
  for (let i = 0; i < taps; i++) k[i] /= sum;
  return { base, k };
}

// 生成单声道 IR。每条路径 = 一个幅度为 gain 的分数延迟脉冲。
// 返回采样数组与每条峰的落点明细（整数样本、分数位置、时间）。
export function buildImpulseResponse(solution, sampleRate, { tailSec = 0.02 } = {}) {
  const paths = [];
  if (solution.direct.valid) {
    paths.push({
      label: '直达声', order: 0, faceNames: [],
      timeSec: solution.direct.timeSec, gain: solution.direct.gain,
    });
  }
  for (const r of solution.reflections) {
    paths.push({
      label: `${r.order}阶反射`, order: r.order, faceNames: r.faceNames,
      timeSec: r.timeSec, gain: r.gain,
    });
  }
  const maxTime = paths.reduce((m, p) => Math.max(m, p.timeSec), 0);
  const lengthSamples = Math.ceil((maxTime + tailSec) * sampleRate) + 2 * HALF_TAPS + 2;
  const ir = new Float64Array(lengthSamples);
  const peaks = [];

  for (const p of paths) {
    const delayFloat = p.timeSec * sampleRate;
    const { base, k } = sincKernel(delayFloat);
    const start = base - HALF_TAPS;
    let energy = 0;
    for (let i = 0; i < k.length; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= lengthSamples) continue;
      ir[idx] += p.gain * k[i];
      energy += k[i];
    }
    peaks.push({
      label: p.label,
      order: p.order,
      faceNames: p.faceNames,
      timeSec: p.timeSec,
      sampleFloat: delayFloat,
      sampleNearest: Math.round(delayFloat),
      gain: p.gain,
    });
  }
  return { ir, peaks, lengthSamples, durationSec: lengthSamples / sampleRate };
}

// 时域直接卷积（仅用于短信号核对，FFT 卷积的参照实现）
export function convolveNaive(x, h) {
  const y = new Float64Array(x.length + h.length - 1);
  for (let i = 0; i < x.length; i++) {
    if (x[i] === 0) continue;
    for (let j = 0; j < h.length; j++) y[i + j] += x[i] * h[j];
  }
  return y;
}

// overlap-add FFT 卷积，输出长度 = x.length + h.length - 1
export function convolveFFT(x, h, { blockSize = 8192, onProgress = null } = {}) {
  const n = nextPow2(blockSize + h.length - 1);
  const L = n - h.length + 1; // 每块有效输入长度
  const Hre = new Float64Array(n), Him = new Float64Array(n);
  Hre.set(h);
  fft(Hre, Him);

  const outLen = x.length + h.length - 1;
  const y = new Float64Array(outLen);
  const blocks = Math.ceil(x.length / L);
  for (let b = 0; b < blocks; b++) {
    const start = b * L;
    const Xre = new Float64Array(n), Xim = new Float64Array(n);
    const take = Math.min(L, x.length - start);
    Xre.set(x.subarray(start, start + take));
    fft(Xre, Xim);
    // 复乘
    for (let i = 0; i < n; i++) {
      const rr = Xre[i] * Hre[i] - Xim[i] * Him[i];
      const ri = Xre[i] * Him[i] + Xim[i] * Hre[i];
      Xre[i] = rr;
      Xim[i] = ri;
    }
    fft(Xre, Xim, true);
    for (let i = 0; i < n && start + i < outLen; i++) y[start + i] += Xre[i];
    if (onProgress) onProgress((b + 1) / blocks);
  }
  return y;
}

// 峰值归一化到 0.9，返回缩放因子（界面显示，避免削波；不改变相对峰结构）
export function normalize(y, target = 0.9) {
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? target / peak : 1;
  const out = new Float64Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = y[i] * g;
  return { data: out, gain: g, peakBefore: peak };
}

// 混合干湿信号（湿声为卷积输出，按其长度对齐）
export function mixDryWet(dry, wet, wetMix) {
  const n = Math.max(dry.length, wet.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = i < dry.length ? dry[i] : 0;
    const w = i < wet.length ? wet[i] : 0;
    out[i] = d * (1 - wetMix) + w * wetMix;
  }
  return out;
}

// 编码 16-bit PCM 单声道 WAV
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + 2 * n);
  const view = new DataView(buffer);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF');
  view.setUint32(4, 36 + 2 * n, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ws(36, 'data');
  view.setUint32(40, 2 * n, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// 内置测试干声：短促指数衰减正弦“啪”声（1 kHz，含 5 ms 淡入）
export function makeClick(sampleRate, { freq = 1000, durationSec = 0.05, decay = 60 } = {}) {
  const n = Math.floor(durationSec * sampleRate);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, i / (0.005 * sampleRate));
    x[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-decay * t) * attack;
  }
  return x;
}
