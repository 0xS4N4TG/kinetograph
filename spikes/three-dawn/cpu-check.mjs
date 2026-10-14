// The GPU-free half of render.mjs, runnable anywhere: build the figure, export a .glb with GLTFExporter, load it back
// with GLTFLoader. It proves the FileReader stand-in works in Node. `npm run check`.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

globalThis.FileReader ??= class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((buffer) => this.#done(buffer));
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.#done(`data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`);
    });
  }
  #done(result) {
    this.result = result;
    this.onloadend?.({ target: this });
    this.onload?.({ target: this });
  }
};

const figure = new THREE.Group();
figure.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3fa7d6 })));
figure.add(new THREE.Mesh(new THREE.SphereGeometry(0.7, 32, 16), new THREE.MeshStandardMaterial({ color: 0xf4d35e })));
const glb = await new GLTFExporter().parseAsync(figure, { binary: true });
const gltf = await new GLTFLoader().parseAsync(glb, '');
let meshes = 0;
gltf.scene.traverse((o) => {
  if (o.isMesh) meshes++;
});
console.log(JSON.stringify({ glbBytes: glb.byteLength, meshes }));
if (meshes !== 2) process.exit(1);
