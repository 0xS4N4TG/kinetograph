// size: 100 50
// A small bitmap that CSS stretches to another size and rounds (the test's page sets the style).
ctx.fillStyle = '#264653';
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#e9c46a';
ctx.beginPath();
ctx.arc(30, 25, 18, 0, Math.PI * 2);
ctx.fill();
ctx.strokeStyle = '#f4a261';
ctx.lineWidth = 4;
ctx.beginPath();
ctx.moveTo(55, 40);
ctx.lineTo(70, 10);
ctx.lineTo(90, 40);
ctx.stroke();
