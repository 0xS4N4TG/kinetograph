// size: 320 240
// Gradients, alpha, a clip, composite operations, a canvas drawn into a canvas, text.
const sky = ctx.createLinearGradient(0, 0, W, H);
sky.addColorStop(0, '#1d2b64');
sky.addColorStop(1, '#f8cdda');
ctx.fillStyle = sky;
ctx.fillRect(0, 0, W, H);

// A radial gradient between two circles.
const ball = ctx.createRadialGradient(60, 50, 4, 70, 60, 36);
ball.addColorStop(0, '#ffffff');
ball.addColorStop(1, '#073b4c');
ctx.fillStyle = ball;
ctx.beginPath();
ctx.arc(70, 60, 36, 0, Math.PI * 2);
ctx.fill();

// A conic gradient.
const sweep = ctx.createConicGradient(0, 160, 60);
sweep.addColorStop(0, '#ff0000');
sweep.addColorStop(0.5, '#00ff00');
sweep.addColorStop(1, '#0000ff');
ctx.fillStyle = sweep;
ctx.fillRect(130, 30, 60, 60);

// A clip: what is painted past it is cut off.
ctx.save();
ctx.beginPath();
ctx.arc(250, 60, 30, 0, Math.PI * 2);
ctx.clip();
ctx.fillStyle = '#06d6a0';
ctx.fillRect(200, 20, 100, 30);
ctx.globalAlpha = 0.5;
ctx.fillStyle = '#ef476f';
ctx.fillRect(220, 40, 100, 60);
ctx.restore();

// Composite operations over a shape.
ctx.fillStyle = '#ffd166';
ctx.fillRect(20, 120, 60, 50);
ctx.globalCompositeOperation = 'multiply';
ctx.fillStyle = '#3a86ff';
ctx.fillRect(50, 140, 60, 50);
ctx.globalCompositeOperation = 'screen';
ctx.fillStyle = '#ff006e';
ctx.fillRect(70, 120, 40, 30);
ctx.globalCompositeOperation = 'destination-out';
ctx.fillStyle = '#000000';
ctx.fillRect(25, 125, 20, 15);
ctx.globalCompositeOperation = 'source-over';

// A canvas of its own, drawn into this one scaled.
const badge = canvas2(30, 30);
const b = badge.getContext('2d');
b.fillStyle = '#e63946';
b.fillRect(0, 0, 30, 30);
b.fillStyle = '#f1faee';
b.beginPath();
b.arc(15, 15, 9, 0, Math.PI * 2);
b.fill();
ctx.globalAlpha = 0.9;
ctx.drawImage(badge, 140, 130, 60, 60);
ctx.drawImage(badge, 10, 10, 20, 20, 210, 130, 40, 40);
ctx.globalAlpha = 1;

// Text. Left, centred and right of a point.
ctx.fillStyle = '#ffffff';
ctx.font = '20px "DM Sans"';
ctx.fillText('Canvas', 20, 215);
ctx.textAlign = 'center';
ctx.fillText('2D', 170, 215);
ctx.textAlign = 'right';
ctx.fillText('native', 300, 215);
