# @remotion/three and three.js to the scene3d layer

Kinetograph has no `@remotion/three`, `three` or `@react-three/fiber`. A `<ThreeCanvas>` import stops the bundle with
`"@remotion/three" is not supported by Kinetograph yet`. Rebuild the scene with the own 3D layer from `@kinetograph/core`.
It is drawn by the GPU compositor, so it renders at the same speed as the rest of the frame and needs no WebGL.

Details: `../kinetograph/references/AUTHORING.md` section 6.6 and `../kinetograph/references/SCENE.md` ("scene3d") in the Kinetograph repo
(github.com/0xS4N4TG/kinetograph); they are not in the npm package.

## Mapping

| three / react-three-fiber | scene3d |
|---|---|
| `<ThreeCanvas width height>` | `<Scene3D width height>` (a layer: takes `x`, `y`, `effects`, `opacity`, ...) |
| `<PerspectiveCamera fov position>` / `camera` prop | `<Camera3D fov position target>`; `type="orthographic"` with `height` |
| `<ambientLight intensity>` | `<AmbientLight intensity>` |
| `<directionalLight position intensity castShadow>` | `<DirectionalLight direction intensity castShadow>`; it takes a direction, not a position: use `target - position` |
| `<pointLight position intensity>` | `<PointLight position intensity range>` |
| `<mesh><boxGeometry/><meshStandardMaterial color/></mesh>` | `<Mesh geometry={{ kind: 'box' }} material={{ color, roughness, metallic }} />`; kinds: `box`, `sphere`, `plane`, `cylinder`, `torus` |
| `useGLTF` / `<primitive object>` / `GLTFLoader` | `<Model src={staticFile('a.glb')} />`; `animation` and `time` pose a clip |
| `<group>` | `<Group3D>` |
| `<Text>` from drei, `TextGeometry` | `<Text3D font size depth>text</Text3D>`; register the font first |
| `ExtrudeGeometry` from an SVG path | `<Extrude path size depth>` |
| `<Environment files>` (HDRI) | `environment` prop of `<Scene3D>`: an equirectangular `.hdr`, `.png` or `.jpg` |
| `useFrame((s, dt) => ...)`, `useThree` | not needed: compute from `useCurrentFrame()` and pass plain props |
| rotation in radians | `rotation` is in **degrees**: multiply by `180 / Math.PI` |
| `useLoader`, `Suspense`, `delayRender` for assets | not needed: `src` is read when the frame is drawn |

Every 3D element takes `position`, `rotation`, `scale` (number or `[x, y, z]`), `visible`, `id`. `<Mesh>`, `<Model>`,
`<Text3D>`, `<Extrude>` also take `castShadow` and `receiveShadow`. 3D elements must sit inside `<Scene3D>`.

## Worked example

Before (Remotion):

```tsx
import { ThreeCanvas } from '@remotion/three';
import { useCurrentFrame, useVideoConfig } from 'remotion';

export const Spin = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  return (
    <ThreeCanvas width={width} height={height} camera={{ fov: 40, position: [0, 0, 5] }}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 4, 5]} intensity={1.5} />
      <mesh rotation={[0.4, frame * 0.05, 0]}>
        <boxGeometry args={[1.5, 1.5, 1.5]} />
        <meshStandardMaterial color="#e66" />
      </mesh>
    </ThreeCanvas>
  );
};
```

After:

```tsx
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { AmbientLight, Camera3D, DirectionalLight, Mesh, Scene3D } from '@kinetograph/core';

export const Spin = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  return (
    <Scene3D width={width} height={height}>
      <Camera3D fov={40} position={[0, 0, 5]} target={[0, 0, 0]} />
      <AmbientLight intensity={0.4} />
      <DirectionalLight direction={[-3, -4, -5]} intensity={1.5} />
      <Mesh
        geometry={{ kind: 'box', width: 1.5, height: 1.5, depth: 1.5 }}
        rotation={[0.4 * (180 / Math.PI), frame * 0.05 * (180 / Math.PI), 0]}
        material={{ color: '#e66', roughness: 0.5 }}
      />
    </Scene3D>
  );
};
```

Notes on the example: `args={[1.5, 1.5, 1.5]}` became `width`, `height` and `depth` (geometry sizes are plain numbers;
animate `scale` instead). The light moved from `position` `[3, 4, 5]` aimed at the origin to `direction` `[-3, -4, -5]`.
`metalness` is `metallic` in a scene3d material; `color`, `roughness`, `emissive`, `opacity` and `texture` keep their names.

## A glTF model with a light

```tsx
<Scene3D width={1280} height={720} environment={staticFile('studio.hdr')}>
  <Camera3D fov={35} position={[0, 1, 6]} target={[0, 0.8, 0]} />
  <DirectionalLight direction={[-1, -1.5, -1]} intensity={2} castShadow />
  <Model src={staticFile('robot.glb')} rotation={[0, frame * 2, 0]} castShadow receiveShadow />
</Scene3D>
```

`robot.glb` goes in `public/` next to the entry. Run `kinetograph doctor`: a model that uses a glTF feature the layer
does not read (for example `KHR_materials_clearcoat`, bevels, GPU skinning, occlusion and emissive maps) is listed with
the feature name. Those are drawn without the feature. Say so in the report.

## Light values

A scene3d point light falls off as `1 / d^2`, and its `intensity` is what a directional light of that intensity gives at
distance 1; `range` (default 0) is no limit. three.js point lights also fall off with distance squared, so a value such
as `intensity={60}` at a distance of about 7 is a fair start. Directional and ambient values (around 0.4 to 2) carry
over. Tune from a `still`, and say in the report that the lighting is approximate.

## What to check

- Run `kinetograph still <entry> <frame>`. Wrong size, back-to-front or dark means the camera, scale or light
  direction is off; `kinetograph inspect <entry> --frame N` shows each layer's resolved bounds.
- Shaders (`shaderMaterial`, `extend`, custom GLSL), postprocessing (`@react-three/postprocessing`) and physics have no
  scene3d equivalent. Approximate with materials and the effects list on the `<Scene3D>` (`glow`, `blur`, `grain`,
  `chromaticAberration`), or leave them out. Report it. Do not bring `three` into the render path.
- At most 4 lights cast shadows. Do not rely on `preserve-3d` for crossing planes.
