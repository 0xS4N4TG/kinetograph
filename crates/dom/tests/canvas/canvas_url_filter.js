// size: 240 120
// `ctx.filter = 'url(#id)'`, naming SVG filters the page has (tests/canvas.rs puts them in): a soft blur, a flood in
// objectBoundingBox units over what is drawn, and a channel swap after a blur() in one list.
ctx.fillStyle = '#f4f1de';
ctx.fillRect(0, 0, W, H);

ctx.filter = 'url(#soft)';
ctx.fillStyle = '#e07a5f';
ctx.beginPath();
ctx.arc(45, 60, 30, 0, Math.PI * 2);
ctx.fill();

ctx.filter = 'url(#tint)';
ctx.fillStyle = '#3d405b';
ctx.fillRect(95, 25, 50, 70);

ctx.filter = 'blur(1px) url(#swap)';
ctx.fillStyle = '#e63946';
ctx.font = '28px "DM Sans"';
ctx.fillText('Hi', 170, 70);
ctx.fillRect(165, 80, 50, 15);
