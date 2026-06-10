import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

let scene;
let camera;
let renderer;
let controls;
let model;
let animationStarted = false;

const START_CAMERA_POSITION = {
  x: 2.850,
  y: 28.310,
  z: -8.898
};

const START_TARGET_POSITION = {
  x: 2.850,
  y: 0.000,
  z: -8.898
};

export function initViewer(container) {
  if (!container) return;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222222);

  camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    1000
  );

  // This helps stabilise the screen-up direction for the top-down view.
  camera.up.set(0, 0, -1);

  renderer = new THREE.WebGLRenderer({
    antialias: true
  });

  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;

  resetCamera();

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "l") {
      logCameraPosition();
    }

    if (event.key.toLowerCase() === "r") {
      resetCamera();
    }
  });

  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(5, 5, 5);
  scene.add(light);

  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambient);

  const mtlLoader = new MTLLoader();
  mtlLoader.setPath("/models/");

  mtlLoader.load("hand.mtl", (materials) => {
    materials.preload();

    const objLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath("/models/");

    objLoader.load("hand.obj", (object) => {
      model = object;

      model.scale.set(1, 1, 1);
      model.position.set(0, 0, 0);

      scene.add(model);

      // Force the same view as the reset button after the model is actually loaded.
      requestAnimationFrame(() => {
        resetCamera();
      });

      console.log("OBJ model loaded:", model);

      model.traverse((child) => {
        if (child.isMesh) {
          console.log("Mesh name:", child.name);
        }
      });
    });
  });

  window.addEventListener("resize", () => {
    if (!camera || !renderer) return;

    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

  if (!animationStarted) {
    animationStarted = true;
    animate();
  }
}

function animate() {
  requestAnimationFrame(animate);

  if (controls) {
    controls.update();
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

export function resetCamera() {
  if (!camera || !controls) return;

  camera.position.set(
    START_CAMERA_POSITION.x,
    START_CAMERA_POSITION.y,
    START_CAMERA_POSITION.z
  );

  controls.target.set(
    START_TARGET_POSITION.x,
    START_TARGET_POSITION.y,
    START_TARGET_POSITION.z
  );

  controls.update();

  console.log("Camera reset to start position");
}

export function colourPart(partName, value) {
  if (!model) return;

  let found = false;

  model.traverse((child) => {
    if (!child.isMesh) return;

    if (child.name !== partName) return;

    found = true;

    child.material = child.material.clone();

    if (value < 0.3) {
      child.material.color.set("#00aa00");
    } else if (value < 0.7) {
      child.material.color.set("#ffaa00");
    } else {
      child.material.color.set("#ff0000");
    }
  });

  if (!found) {
    console.warn("No mesh found called:", partName);
  }
}

function logCameraPosition() {
  if (!camera || !controls) return;

  console.log("Camera position:");
  console.log(
    `camera.position.set(${camera.position.x.toFixed(3)}, ${camera.position.y.toFixed(3)}, ${camera.position.z.toFixed(3)});`
  );

  console.log("Orbit target:");
  console.log(
    `controls.target.set(${controls.target.x.toFixed(3)}, ${controls.target.y.toFixed(3)}, ${controls.target.z.toFixed(3)});`
  );

  console.table({
    camera_x: camera.position.x,
    camera_y: camera.position.y,
    camera_z: camera.position.z,
    target_x: controls.target.x,
    target_y: controls.target.y,
    target_z: controls.target.z
  });
}