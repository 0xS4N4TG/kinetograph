// size: 320 240
// Fills, strokes, arcs, curves, round rectangles, transforms.
ctx.fillStyle = '#10131a';
ctx.fillRect(0, 0, W, H);

// Even-odd: a rectangle with a hole.
ctx.fillStyle = '#ffd166';
ctx.beginPath();
ctx.rect(10, 10, 60, 40);
ctx.rect(25, 20, 30, 20);
ctx.fill('evenodd');

// Round joins and caps.
ctx.strokeStyle = '#ef476f';
ctx.lineWidth = 6;
ctx.lineJoin = 'round';
ctx.lineCap = 'round';
ctx.beginPath();
ctx.moveTo(90, 15);
ctx.lineTo(130, 45);
ctx.lineTo(170, 15);
ctx.stroke();

// A dashed outline.
ctx.setLineDash([8, 5]);
ctx.lineWidth = 3;
ctx.lineCap = 'butt';
ctx.lineJoin = 'miter';
ctx.strokeStyle = '#06d6a0';
ctx.strokeRect(190, 12, 60, 40);
ctx.setLineDash([]);

// A pie and a turned ellipse.
ctx.fillStyle = '#118ab2';
ctx.beginPath();
ctx.arc(40, 100, 28, 0, Math.PI * 1.5);
ctx.lineTo(40, 100);
ctx.fill();
ctx.beginPath();
ctx.ellipse(120, 100, 40, 22, Math.PI / 6, 0, Math.PI * 2);
ctx.fillStyle = '#9b5de5';
ctx.fill();

// Cubic and quadratic curves in one path.
ctx.beginPath();
ctx.moveTo(190, 80);
ctx.bezierCurveTo(210, 60, 230, 130, 250, 90);
ctx.quadraticCurveTo(270, 70, 290, 110);
ctx.lineWidth = 4;
ctx.strokeStyle = '#f15bb5';
ctx.stroke();

// A round rectangle with a radius for each corner, and a corner rounded by arcTo.
ctx.beginPath();
ctx.roundRect(15, 150, 80, 50, [20, 5, 20, 5]);
ctx.fillStyle = '#fee440';
ctx.fill();
ctx.beginPath();
ctx.moveTo(110, 200);
ctx.arcTo(160, 200, 160, 150, 25);
ctx.lineTo(160, 150);
ctx.strokeStyle = '#ffffff';
ctx.lineWidth = 3;
ctx.stroke();

// A square turned and squashed by the transform, with a translucent fill.
ctx.save();
ctx.translate(230, 175);
ctx.rotate(0.5);
ctx.scale(1.4, 0.7);
ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
ctx.fillRect(-25, -25, 50, 50);
ctx.strokeStyle = '#ef476f';
ctx.lineWidth = 4;
ctx.strokeRect(-25, -25, 50, 50);
ctx.restore();
