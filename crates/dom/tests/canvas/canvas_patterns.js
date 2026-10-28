// size: 320 200
// Patterns of a canvas: a 2 x 2 checker repeated over the whole canvas (16,000 tiles), a stripe tile in a stroke and
// in text, and one that repeats along x only, under a transform.
const checker = canvas2(2, 2);
const c = checker.getContext('2d');
c.fillStyle = '#f2e8cf';
c.fillRect(0, 0, 2, 2);
c.fillStyle = '#386641';
c.fillRect(0, 0, 1, 1);
c.fillRect(1, 1, 1, 1);
ctx.fillStyle = ctx.createPattern(checker, 'repeat');
ctx.fillRect(0, 0, W, H);

const stripes = canvas2(12, 12);
const s = stripes.getContext('2d');
s.fillStyle = '#bc4749';
s.fillRect(0, 0, 12, 12);
s.fillStyle = '#ffd166';
s.fillRect(0, 0, 12, 5);
const pattern = ctx.createPattern(stripes, 'repeat');

ctx.strokeStyle = pattern;
ctx.lineWidth = 14;
ctx.lineJoin = 'round';
ctx.beginPath();
ctx.moveTo(20, 30);
ctx.lineTo(120, 90);
ctx.lineTo(40, 170);
ctx.stroke();

ctx.fillStyle = pattern;
ctx.font = '64px "DM Sans"';
ctx.fillText('Pat', 150, 90);

const along = ctx.createPattern(stripes, 'repeat-x');
along.setTransform({ a: 1, b: 0, c: 0, d: 1, e: 150, f: 130 });
ctx.fillStyle = along;
ctx.fillRect(140, 120, 170, 60);
