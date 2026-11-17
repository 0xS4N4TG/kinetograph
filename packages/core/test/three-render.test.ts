// three.js and `<ThreeCanvas>` (`@remotion/three`) on the real addon and the built CLI: a frame is the same alone, in
// sequence and at any concurrency, the scene moves, and frame 3 is the stored picture. Needs the built addon, the built
// CLI (`KINETOGRAPH_CLI` names another build), a GPU, and the project's own `three` and `@react-three/fiber`, which are
// not dependencies of this repo: `KINETOGRAPH_THREE_MODULES` names a node_modules folder that holds them (or they
// resolve from here). Skipped where one is missing. The goldens are of three 0.187.0 and @react-three/fiber 9.8.2 on the
// M4; with other versions only the identity checks run.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = process.env.KINETOGRAPH_CLI ?? join(here, '..', '..', 'cli', 'dist', 'cli.js');
const require = createRequire(import.meta.url);

const addon = (() => {
  try {
    require('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();

/** The folder of an installed package: from `KINETOGRAPH_THREE_MODULES`, else wherever Node finds it. */
function packageDir(name: string): string | null {
  const roots = [process.env.KINETOGRAPH_THREE_MODULES, ...(require.resolve.paths(name) ?? [])].filter((r): r is string => r !== undefined);
  for (const root of roots) if (existsSync(join(root, name, 'package.json'))) return join(root, name);
  return null;
}
const threeDir = packageDir('three');
const fiberDir = packageDir('@react-three/fiber');
const versionOf = (dir: string): string => (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
const ready = addon && existsSync(cli) && threeDir !== null && fiberDir !== null;
const pinned = ready && versionOf(threeDir!) === '0.187.0' && versionOf(fiberDir!) === '9.8.2';

const SIZE = 'width=256, height=144';

const HTML = `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="${SIZE}" />
<style>html,body{margin:0;width:256px;height:144px;overflow:hidden;background:#101820}</style></head><body>
<div id="stage" data-composition-id="main" data-start="0" data-width="256" data-height="144" data-duration="0.2" style="position:relative;width:256px;height:144px">
  <canvas id="c" width="256" height="144" style="width:256px;height:144px"></canvas>
</div>
<script type="importmap">{"imports":{"three":"./vendor/three.module.js"}}</script>
<script type="module">
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
renderer.setSize(256, 144, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#203040');
const camera = new THREE.PerspectiveCamera(45, 256 / 144, 0.1, 100);
camera.position.set(2.5, 2, 4);
camera.lookAt(0, 0, 0);
const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshStandardMaterial({ color: '#e8602c', roughness: 0.5, metalness: 0.1 }));
scene.add(box, new THREE.AmbientLight('#ffffff', 0.4));
const sun = new THREE.DirectionalLight('#ffffff', 2.5);
sun.position.set(3, 4, 2);
scene.add(sun);
function tick(t) {
  box.rotation.y = t / 1000;
  box.rotation.x = t / 2000;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
</script>
</body></html>`;

const REACT = `
import { AbsoluteFill, Composition, Sequence, registerRoot, useCurrentFrame, useVideoConfig } from 'remotion';
import { ThreeCanvas } from '@remotion/three';

const Box = ({ x }: { x: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <mesh position={[x, 0, 0]} rotation={[frame / fps / 2, frame / fps, 0]}>
      <boxGeometry args={[1.2, 1.2, 1.2]} />
      <meshStandardMaterial color="#e8602c" roughness={0.5} metalness={0.1} />
    </mesh>
  );
};

const Scene = () => (
  <AbsoluteFill style={{ background: '#101820' }}>
    <ThreeCanvas width={256} height={144} camera={{ position: [0, 1.5, 5], fov: 45 }} flat>
      <color attach="background" args={['#203040']} />
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 4, 2]} intensity={2.5} />
      <Box x={-1.1} />
      <Sequence from={2} layout="none">
        <Box x={1.1} />
      </Sequence>
    </ThreeCanvas>
  </AbsoluteFill>
);
registerRoot(() => <Composition id="Main" component={Scene} width={256} height={144} fps={30} durationInFrames={6} />);
`;

// A metal sphere lit only by `scene.environment`, which a child sets in a passive effect from a half-float equirect upload
// with flipY on, as drei's `<Environment>` does with an HDR file: the frame must be drawn after that effect, and the float upload
// must be taken. Without the environment the sphere is black, so the two pictures differ.
const lit = (environment: boolean): string => `
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { ThreeCanvas } from '@remotion/three';
import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { DataTexture, DataUtils, EquirectangularReflectionMapping, HalfFloatType, LinearFilter, RGBAFormat } from 'three';

const Sky = () => {
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const half = new Uint16Array(8 * 4 * 4);
    for (let i = 0; i < 8 * 4; i++) [0.9, 0.9, 1, 1].forEach((v, c) => (half[i * 4 + c] = DataUtils.toHalfFloat(v * (i < 16 ? 4 : 0.3))));
    const sky = new DataTexture(half, 8, 4, RGBAFormat, HalfFloatType);
    sky.mapping = EquirectangularReflectionMapping;
    sky.minFilter = sky.magFilter = LinearFilter;
    sky.generateMipmaps = false;
    sky.flipY = true;
    sky.needsUpdate = true;
    scene.environment = sky;
  }, [scene]);
  return null;
};

const Scene = () => (
  <AbsoluteFill style={{ background: '#101820' }}>
    <ThreeCanvas width={256} height={144} camera={{ position: [0, 0, 3.5], fov: 45 }} flat>
      ${environment ? '<Sky />' : ''}
      <mesh>
        <sphereGeometry args={[1, 24, 16]} />
        <meshStandardMaterial color="#d8d8e0" metalness={1} roughness={0.15} />
      </mesh>
    </ThreeCanvas>
  </AbsoluteFill>
);
registerRoot(() => <Composition id="Main" component={Scene} width={256} height={144} fps={30} durationInFrames={2} />);
`;

// Inside this package's node_modules, which is ignored: `three` and `@react-three/fiber` are linked in, as a project has them.
const root = join(here, '..', 'node_modules', '.cache', 'three-render-test');
const htmlDir = join(root, 'html');
const reactDir = join(root, 'react');
const litDirs = { sky: join(root, 'lit-sky'), dark: join(root, 'lit-dark') };
beforeAll(() => {
  if (!ready) return;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(htmlDir, 'vendor'), { recursive: true });
  mkdirSync(join(reactDir, 'node_modules', '@react-three'), { recursive: true });
  writeFileSync(join(htmlDir, 'index.html'), HTML);
  for (const file of ['three.module.js', 'three.core.js']) copyFileSync(join(threeDir!, 'build', file), join(htmlDir, 'vendor', file));
  writeFileSync(join(reactDir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(reactDir, 'index.tsx'), REACT);
  symlinkSync(threeDir!, join(reactDir, 'node_modules', 'three'));
  symlinkSync(fiberDir!, join(reactDir, 'node_modules', '@react-three', 'fiber'));
  for (const [key, dir] of Object.entries(litDirs)) {
    mkdirSync(join(dir, 'node_modules', '@react-three'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
    writeFileSync(join(dir, 'index.tsx'), lit(key === 'sky'));
    symlinkSync(threeDir!, join(dir, 'node_modules', 'three'));
    symlinkSync(fiberDir!, join(dir, 'node_modules', '@react-three', 'fiber'));
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function render(dir: string, entry: string, output: string, extra: string[] = []): string {
  const out = join(dir, output);
  const run = spawnSync('node', [cli, 'render', join(dir, entry), '--sequence', '--offline', '-o', out, ...extra], { encoding: 'utf8' });
  expect(run.status, run.stderr + run.stdout).toBe(0);
  return out;
}
const hashes = (dir: string): Record<number, string> =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => [Number(/-(\d+)\.png$/.exec(f)![1]), createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]),
  );

for (const [name, dir, entry] of [
  ['plain three in an HTML page', htmlDir, 'index.html'],
  ['<ThreeCanvas> in a React project', reactDir, 'index.tsx'],
] as const) {
  describe.skipIf(!ready)(name, () => {
    it('draws a frame alone as it is in a sequence and at any concurrency, and the scene moves', () => {
      const sequence = hashes(render(dir, entry, 'seq1', ['--concurrency', '1']));
      expect(Object.keys(sequence)).toHaveLength(6);
      expect(new Set(Object.values(sequence)).size).toBe(6);
      expect(hashes(render(dir, entry, 'seq4', ['--concurrency', '4']))).toEqual(sequence);
      expect(hashes(render(dir, entry, 'alone3', ['--range', '3..=3']))).toEqual({ 3: sequence[3] });
      expect(hashes(render(dir, entry, 'alone0', ['--range', '0..=0']))).toEqual({ 0: sequence[0] });
    });

    it.skipIf(!pinned)('draws frame 3 as the stored picture', () => {
      const out = render(dir, entry, 'golden', ['--range', '3..=3']);
      const file = readdirSync(out).find((f) => f.endsWith('.png'))!;
      const golden = join(here, 'golden', `${name.startsWith('plain') ? 'three-html' : 'three-canvas'}-f3.png`);
      if (process.env.KINETOGRAPH_UPDATE_GOLDEN === '1') copyFileSync(join(out, file), golden);
      expect(readFileSync(join(out, file)).equals(readFileSync(golden))).toBe(true);
    });
  });
}

describe.skipIf(!ready)('<ThreeCanvas> with scene.environment set by a child effect', () => {
  it('lights the scene: the frame is drawn after the effect, from a flipped half-float upload', () => {
    const sky = hashes(render(litDirs.sky, 'index.tsx', 'out', ['--range', '0..=0']));
    const dark = hashes(render(litDirs.dark, 'index.tsx', 'out', ['--range', '0..=0']));
    expect(sky[0]).not.toBe(dark[0]);
  });
});
