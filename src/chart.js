// IR 波形/峰值标注绘制
export function drawIR(canvas, irData, peaks, sampleRate) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f1420';
  ctx.fillRect(0, 0, W, H);

  let peak = 1e-12;
  for (const v of irData) peak = Math.max(peak, Math.abs(v));
  const mid = H / 2;
  ctx.strokeStyle = 'rgba(139,148,158,0.25)';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(W, mid);
  ctx.stroke();

  ctx.strokeStyle = '#58a6ff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < irData.length; i++) {
    const x = (i / irData.length) * W;
    const y = mid - (irData[i] / peak) * (mid - 8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 峰值位置竖线与到达时间
  ctx.font = '10px sans-serif';
  peaks.forEach((p, idx) => {
    const x = (p.sampleFloat / irData.length) * W;
    ctx.strokeStyle = idx === 0 ? '#7ee787' : 'rgba(227,179,65,0.7)';
    ctx.beginPath();
    ctx.moveTo(x, 6);
    ctx.lineTo(x, H - 6);
    ctx.stroke();
    if (peaks.length <= 14 || idx === 0) {
      ctx.fillStyle = '#e6edf3';
      ctx.fillText(`${(p.timeSec * 1000).toFixed(2)}ms`, Math.min(x + 2, W - 48), idx === 0 ? 14 : 26);
    }
  });

  ctx.fillStyle = '#8b949e';
  ctx.font = '11px sans-serif';
  ctx.fillText(`脉冲响应时长 ${(irData.length / sampleRate * 1000).toFixed(1)} ms · ${irData.length} 样本 @ ${sampleRate} Hz`, 10, H - 8);
}
