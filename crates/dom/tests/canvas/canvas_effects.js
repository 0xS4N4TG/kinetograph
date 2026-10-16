// size: 360 230
// Shadows, then the `filter` functions one by one, then a list.
ctx.fillStyle = '#f4efe6';
ctx.fillRect(0, 0, W, H);

// A card with a soft shadow.
ctx.save();
ctx.shadowColor = 'rgba(30, 20, 60, 0.45)';
ctx.shadowBlur = 24;
ctx.shadowOffsetY = 12;
ctx.fillStyle = '#ffffff';
ctx.beginPath();
ctx.roundRect(20, 16, 120, 64, 14);
ctx.fill();
ctx.restore();

// Hard shadows of a circle, a stroke and a gradient, the last under a transform and a global alpha.
ctx.save();
ctx.shadowColor = '#2a6df4';
ctx.shadowOffsetX = 8;
ctx.shadowOffsetY = 6;
ctx.fillStyle = '#ff7a59';
ctx.beginPath();
ctx.arc(190, 46, 26, 0, Math.PI * 2);
ctx.fill();
ctx.lineWidth = 8;
ctx.strokeStyle = '#18a058';
ctx.beginPath();
ctx.moveTo(240, 24);
ctx.lineTo(330, 70);
ctx.stroke();
ctx.restore();

ctx.save();
ctx.translate(60, 140);
ctx.rotate(0.3);
ctx.globalAlpha = 0.7;
ctx.shadowColor = 'black';
ctx.shadowBlur = 10;
ctx.shadowOffsetX = 6;
ctx.shadowOffsetY = 6;
const g = ctx.createLinearGradient(-25, 0, 25, 0);
g.addColorStop(0, '#ffd166');
g.addColorStop(1, '#ef476f');
ctx.fillStyle = g;
ctx.fillRect(-25, -20, 50, 40);
ctx.restore();

// The functions, each on two overlapping squares.
const tile = (x, y, filter) => {
  ctx.save();
  ctx.filter = filter;
  ctx.fillStyle = '#e8503a';
  ctx.fillRect(x, y, 24, 24);
  ctx.fillStyle = '#2f9e8f';
  ctx.fillRect(x + 12, y + 12, 24, 24);
  ctx.restore();
};
const filters = ['blur(3px)', 'brightness(1.6)', 'contrast(2)', 'grayscale(1)', 'hue-rotate(90deg)', 'invert(1)', 'saturate(3)', 'sepia(1)'];
filters.forEach((filter, i) => tile(120 + (i % 4) * 58, 110 + Math.floor(i / 4) * 52, filter));
// A drop shadow, a list, opacity.
tile(20, 186, 'drop-shadow(5px 5px 4px rgba(0, 0, 0, 0.6))');
tile(78, 186, 'contrast(1.5) hue-rotate(-40deg) blur(1px)');
tile(136, 186, 'opacity(50%)');
