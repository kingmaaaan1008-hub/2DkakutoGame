/**
 * 背景ステージ。
 *
 * 画像を使わず手続きで描いている。ダウンロード量が増えないのと、
 * どんな画面比率でも破綻しないため。背景画像を足したくなったら
 * drawStage を差し替えるだけで済むよう、ここに閉じ込めてある。
 */
import { STAGE_WIDTH } from '../game/constants.js';

/** 奥から手前へ。speed が小さいほど遠景（動きが緩い）。 */
const LAYERS = [
  { speed: 0.12, color: '#232a44', top: 0.30, jag: 150, step: 420, seed: 7 },
  { speed: 0.28, color: '#1b2138', top: 0.44, jag: 120, step: 300, seed: 23 },
  { speed: 0.5, color: '#141829', top: 0.58, jag: 90, step: 210, seed: 41 },
];

/** 決定的な擬似ノイズ。層の形が毎フレーム変わらないように。 */
function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

export function drawStage(ctx, cam, canvasW, canvasH) {
  // 空
  const sky = ctx.createLinearGradient(0, 0, 0, cam.groundY);
  sky.addColorStop(0, '#0d1020');
  sky.addColorStop(0.55, '#1a2140');
  sky.addColorStop(1, '#33305a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // 月
  const moonX = canvasW * 0.78 - cam.x * 0.04;
  const moonY = canvasH * 0.18;
  const glow = ctx.createRadialGradient(moonX, moonY, 0, moonX, moonY, canvasH * 0.22);
  glow.addColorStop(0, 'rgba(255,246,214,0.5)');
  glow.addColorStop(1, 'rgba(255,246,214,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.fillStyle = '#fdf3d0';
  ctx.beginPath();
  ctx.arc(moonX, moonY, canvasH * 0.045, 0, Math.PI * 2);
  ctx.fill();

  // 遠景の稜線
  for (const layer of LAYERS) {
    const offset = cam.x * layer.speed;
    const baseY = canvasH * layer.top;
    ctx.fillStyle = layer.color;
    ctx.beginPath();
    ctx.moveTo(-40, canvasH);
    let i = 0;
    for (let sx = -offset % layer.step - layer.step; sx < canvasW + layer.step; sx += layer.step) {
      const h = hash(layer.seed + Math.round((sx + offset) / layer.step)) * layer.jag;
      ctx.lineTo(sx, baseY + layer.jag - h);
      ctx.lineTo(sx + layer.step / 2, baseY + h * 0.4);
      i += 1;
    }
    ctx.lineTo(canvasW + 40, canvasH);
    ctx.closePath();
    ctx.fill();
  }

  // 地面
  const groundGrad = ctx.createLinearGradient(0, cam.groundY, 0, canvasH);
  groundGrad.addColorStop(0, '#3a3252');
  groundGrad.addColorStop(1, '#171423');
  ctx.fillStyle = groundGrad;
  ctx.fillRect(0, cam.groundY, canvasW, canvasH - cam.groundY);

  // 地面のハイライト
  ctx.fillStyle = 'rgba(255,220,180,0.16)';
  ctx.fillRect(0, cam.groundY, canvasW, 3 * cam.zoom);

  // 床のライン（奥行き感）
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const spacing = 120 * cam.zoom;
  const start = -((cam.x * cam.zoom) % spacing);
  for (let sx = start; sx < canvasW; sx += spacing) {
    ctx.beginPath();
    ctx.moveTo(sx, cam.groundY);
    ctx.lineTo(sx, canvasH);
    ctx.stroke();
  }

  // ステージ端の壁
  drawWall(ctx, cam, 0, canvasH);
  drawWall(ctx, cam, STAGE_WIDTH, canvasH);
}

function drawWall(ctx, cam, worldX, canvasH) {
  const sx = cam.toScreenX(worldX);
  if (sx < -60 || sx > cam.canvasW + 60) return;
  const grad = ctx.createLinearGradient(sx - 30 * cam.zoom, 0, sx + 30 * cam.zoom, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(sx - 30 * cam.zoom, 0, 60 * cam.zoom, canvasH);
}
