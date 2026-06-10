import * as THREE from "three";
import {OBJLoader} from "three/addons/loaders/OBJLoader.js";
import {MTLLoader} from "three/addons/loaders/MTLLoader.js";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";

let scene;
let camera;
let renderer;
let controls;
let model;
let animationStarted = false;

let fpsCounterElement;
let fpsFrameCount = 0;
let fpsLastUpdateTime = performance.now();

const FPS_UPDATE_INTERVAL_MS = 250;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const activeHighlights = new Map();
const activeClickMarkers = [];

const HIGHLIGHT_COLOUR = new THREE.Color(0xff0000);
const HIGHLIGHT_DURATION_MS = 1200;

const CLICK_MARKER_COLOUR = 0xff0000;
const CLICK_MARKER_RADIUS = 0.30;
const CLICK_MARKER_DURATION_MS = 800;
const CLICK_MARKER_SURFACE_OFFSET = 0.03;

let pointerDownPosition =
{
    x: 0,
    y: 0
};

let pointerDownButton = 0;

const START_CAMERA_POSITION =
{
    x: 2.850,
    y: 28.310,
    z: -8.898
};

const START_TARGET_POSITION =
{
    x: 2.850,
    y: 0.000,
    z: -8.898
};

/*
    Initialise the Three.js viewer.

    Creates the scene, camera, renderer, orbit controls, lights, FPS counter,
    resize handling, keyboard shortcuts and starts loading the hand model.
*/
export function initViewer(container)
{
    if (!container)
    {
        return;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);

    camera = new THREE.PerspectiveCamera(
        45,
        container.clientWidth / container.clientHeight,
        0.1,
        1000
    );

    // Stabilises the screen-up direction for the top-down camera view.
    camera.up.set(0, 0, -1);

    renderer = new THREE.WebGLRenderer(
    {
        antialias: true
    });

    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    setupFpsCounter(container);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    resetCamera();
    setupModelClickDebug();

    window.addEventListener("keydown", (event) =>
    {
        if (event.key.toLowerCase() === "l")
        {
            logCameraPosition();
        }

        if (event.key.toLowerCase() === "r")
        {
            resetCamera();
        }
    });

    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(5, 5, 5);
    scene.add(light);

    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambient);

    loadHandModel();

    window.addEventListener("resize", () =>
    {
        if (!camera || !renderer)
        {
            return;
        }

        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
    });

    if (!animationStarted)
    {
        animationStarted = true;
        animate();
    }
}

/*
    Create the FPS counter overlay.

    The counter is added directly to the viewer container so it sits above
    the Three.js canvas.
*/
function setupFpsCounter(container)
{
    if (!container)
    {
        return;
    }

    if (getComputedStyle(container).position === "static")
    {
        container.style.position = "relative";
    }

    fpsCounterElement = document.createElement("div");
    fpsCounterElement.textContent = "FPS: --";

    fpsCounterElement.style.position = "absolute";
    fpsCounterElement.style.top = "10px";
    fpsCounterElement.style.right = "10px";
    fpsCounterElement.style.padding = "6px 10px";
    fpsCounterElement.style.background = "rgba(0, 0, 0, 0.65)";
    fpsCounterElement.style.color = "#ffffff";
    fpsCounterElement.style.fontFamily = "monospace";
    fpsCounterElement.style.fontSize = "13px";
    fpsCounterElement.style.borderRadius = "4px";
    fpsCounterElement.style.pointerEvents = "none";
    fpsCounterElement.style.zIndex = "10";

    container.appendChild(fpsCounterElement);
}

/*
    Update the FPS counter.

    The value is averaged over a short interval so it is readable and does
    not flicker too much.
*/
function updateFpsCounter()
{
    if (!fpsCounterElement)
    {
        return;
    }

    fpsFrameCount++;

    const now = performance.now();
    const elapsed = now - fpsLastUpdateTime;

    if (elapsed < FPS_UPDATE_INTERVAL_MS)
    {
        return;
    }

    const fps = Math.round((fpsFrameCount * 1000) / elapsed);

    fpsCounterElement.textContent = `FPS: ${fps}`;

    fpsFrameCount = 0;
    fpsLastUpdateTime = now;
}

/*
    Set up click debugging on the renderer canvas.

    This records pointer movement so that normal orbit dragging is ignored,
    while a genuine click runs the mesh selection debug code.

    Left click:
    - Flashes the whole clicked mesh.

    Right click:
    - Flashes a small localised marker at the clicked point.
*/
function setupModelClickDebug()
{
    if (!renderer)
    {
        return;
    }

    renderer.domElement.addEventListener("contextmenu", (event) =>
    {
        event.preventDefault();
    });

    renderer.domElement.addEventListener("pointerdown", (event) =>
    {
        pointerDownPosition.x = event.clientX;
        pointerDownPosition.y = event.clientY;
        pointerDownButton = event.button;
    });

    renderer.domElement.addEventListener("pointerup", (event) =>
    {
        const movementX = Math.abs(event.clientX - pointerDownPosition.x);
        const movementY = Math.abs(event.clientY - pointerDownPosition.y);

        const wasClick = movementX < 5 && movementY < 5;

        if (!wasClick)
        {
            return;
        }

        if (pointerDownButton !== 0 && pointerDownButton !== 2)
        {
            return;
        }

        logClickedModelPart(event, pointerDownButton);
    });
}

/*
    Detect which mesh was clicked and print useful debug information.

    Uses raycasting from the camera through the clicked screen position.
    Left click flashes the whole clicked mesh.
    Right click places a small temporary marker at the exact clicked point.
*/
function logClickedModelPart(event, button)
{
    if (!model || !camera || !renderer)
    {
        console.warn("Model, camera, or renderer is not ready yet.");
        return;
    }

    const rect = renderer.domElement.getBoundingClientRect();

    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    const intersections = raycaster.intersectObject(model, true);

    if (intersections.length === 0)
    {
        console.log("Clicked viewer background, no model part selected.");
        return;
    }

    const selectedIntersection = intersections[0];
    const selectedObject = selectedIntersection.object;
    const selectedName = getReadableObjectName(selectedObject);

    console.log("Selected model part:", selectedName);

    console.table(
    {
        selected_name: selectedName,
        mesh_name: selectedObject.name || "",
        parent_name: selectedObject.parent?.name || "",
        material_name: selectedObject.material?.name || "",
        uuid: selectedObject.uuid,
        click_type: button === 2 ? "right click local marker" : "left click whole mesh",
        click_x: selectedIntersection.point.x,
        click_y: selectedIntersection.point.y,
        click_z: selectedIntersection.point.z
    });

    if (button === 2)
    {
        flashClickPoint(selectedIntersection);
        return;
    }

    flashSelectedMesh(selectedObject);
}

/*
    Flash a selected mesh red and fade it back to its base colour.

    The material is made unique first so that other meshes sharing the same
    material are not affected by the highlight.
*/
function flashSelectedMesh(mesh)
{
    if (!mesh || !mesh.isMesh || !mesh.material)
    {
        return;
    }

    const materials = makeMeshMaterialsUnique(mesh);

    materials.forEach((material) =>
    {
        if (!material || !material.color)
        {
            return;
        }

        if (material.userData.baseColourHex === undefined)
        {
            material.userData.baseColourHex = material.color.getHex();
        }

        const baseColour = new THREE.Color(material.userData.baseColourHex);

        material.color.copy(HIGHLIGHT_COLOUR);

        activeHighlights.set(material.uuid,
        {
            material: material,
            baseColour: baseColour,
            startTime: performance.now(),
            durationMs: HIGHLIGHT_DURATION_MS
        });
    });
}

/*
    Create a small temporary red marker at the exact clicked point.

    This highlights only the local clicked area instead of changing the colour
    of the full mesh or full pad.
*/
function flashClickPoint(intersection)
{
    if (!intersection || !scene)
    {
        return;
    }

    const markerGeometry = new THREE.SphereGeometry(
        CLICK_MARKER_RADIUS,
        24,
        24
    );

    const markerMaterial = new THREE.MeshBasicMaterial(
    {
        color: CLICK_MARKER_COLOUR,
        transparent: true,
        opacity: 1,
        depthTest: true,
        depthWrite: false
    });

    const marker = new THREE.Mesh(markerGeometry, markerMaterial);

    marker.position.copy(intersection.point);

    if (intersection.face && intersection.face.normal)
    {
        const normal = intersection.face.normal.clone();

        normal.transformDirection(intersection.object.matrixWorld);
        marker.position.add(normal.multiplyScalar(CLICK_MARKER_SURFACE_OFFSET));
    }

    scene.add(marker);

    activeClickMarkers.push(
    {
        mesh: marker,
        material: markerMaterial,
        geometry: markerGeometry,
        startTime: performance.now(),
        durationMs: CLICK_MARKER_DURATION_MS
    });
}

/*
    Ensure a mesh has unique material instances.

    OBJ files can share materials between multiple meshes. Cloning prevents
    a colour change on one clicked part from affecting other parts.
*/
function makeMeshMaterialsUnique(mesh)
{
    if (Array.isArray(mesh.material))
    {
        mesh.material = mesh.material.map((material) =>
        {
            return makeMaterialUnique(material);
        });

        return mesh.material;
    }

    mesh.material = makeMaterialUnique(mesh.material);

    return [mesh.material];
}

/*
    Clone a material if it has not already been cloned for click highlighting.

    Returns the existing material if it is already unique.
*/
function makeMaterialUnique(material)
{
    if (!material)
    {
        return material;
    }

    if (material.userData.clickHighlightUnique)
    {
        return material;
    }

    const clonedMaterial = material.clone();

    clonedMaterial.userData =
    {
        ...material.userData,
        clickHighlightUnique: true
    };

    if (material.color)
    {
        clonedMaterial.userData.baseColourHex = material.color.getHex();
    }

    return clonedMaterial;
}

/*
    Update all active click-highlight animations.

    Each highlighted material fades from red back to its stored base colour.
*/
function updateHighlightAnimations()
{
    if (activeHighlights.size === 0)
    {
        return;
    }

    const now = performance.now();

    activeHighlights.forEach((highlight, materialUuid) =>
    {
        const elapsed = now - highlight.startTime;
        const progress = Math.min(elapsed / highlight.durationMs, 1);

        const smoothProgress = progress * progress * (3 - 2 * progress);

        highlight.material.color.copy(HIGHLIGHT_COLOUR);
        highlight.material.color.lerp(highlight.baseColour, smoothProgress);

        if (progress >= 1)
        {
            highlight.material.color.copy(highlight.baseColour);
            activeHighlights.delete(materialUuid);
        }
    });
}

/*
    Update and remove temporary click markers.

    Each marker fades out and then gets removed from the scene.
*/
function updateClickMarkers()
{
    if (activeClickMarkers.length === 0)
    {
        return;
    }

    const now = performance.now();

    for (let index = activeClickMarkers.length - 1; index >= 0; index--)
    {
        const marker = activeClickMarkers[index];
        const elapsed = now - marker.startTime;
        const progress = Math.min(elapsed / marker.durationMs, 1);

        marker.material.opacity = 1 - progress;

        if (progress >= 1)
        {
            scene.remove(marker.mesh);
            marker.geometry.dispose();
            marker.material.dispose();

            activeClickMarkers.splice(index, 1);
        }
    }
}

/*
    Return the best readable name for a selected object.

    Preference order:
    - Mesh name
    - Parent object name
    - Material name
    - Generic fallback
*/
function getReadableObjectName(object)
{
    if (!object)
    {
        return "Unknown object";
    }

    if (object.name)
    {
        return object.name;
    }

    if (object.parent && object.parent.name)
    {
        return object.parent.name;
    }

    if (object.material && object.material.name)
    {
        return object.material.name;
    }

    return "Unnamed mesh";
}

/*
    Load the hand model from the local models folder.

    Expected files:
    - ./models/hand.mtl
    - ./models/hand.obj
*/
function loadHandModel()
{
    const mtlLoader = new MTLLoader();
    mtlLoader.setPath("./models/");

    mtlLoader.load(
        "hand.mtl",
        (materials) =>
        {
            materials.preload();

            const objLoader = new OBJLoader();
            objLoader.setMaterials(materials);
            objLoader.setPath("./models/");

            objLoader.load(
                "hand.obj",
                (object) =>
                {
                    model = object;

                    model.scale.set(1, 1, 1);
                    model.position.set(0, 0, 0);

                    scene.add(model);

                    requestAnimationFrame(() =>
                    {
                        resetCamera();
                    });

                    console.log("OBJ model loaded:", model);

                    model.traverse((child) =>
                    {
                        if (child.isMesh)
                        {
                            console.log("Mesh name:", child.name);
                        }
                    });
                },
                (progress) =>
                {
                    console.log("OBJ loading progress:", progress);
                },
                (err) =>
                {
                    console.error("OBJ loading error:", err);
                }
            );
        },
        undefined,
        (err) =>
        {
            console.error("MTL loading error:", err);
        }
    );
}

/*
    Main render loop.

    Updates FPS counter, highlight animations, click markers, orbit controls
    and renders the scene once per frame.
*/
function animate()
{
    requestAnimationFrame(animate);

    updateFpsCounter();
    updateHighlightAnimations();
    updateClickMarkers();

    if (controls)
    {
        controls.update();
    }

    if (renderer && scene && camera)
    {
        renderer.render(scene, camera);
    }
}

/*
    Reset the camera and orbit target to the saved start view.
*/
export function resetCamera()
{
    if (!camera || !controls)
    {
        return;
    }

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

/*
    Placeholder for future serial-driven model colouring.

    Later this can find a mesh by name and update its material colour based
    on incoming serial data.
*/
export function colourPart(partName, value)
{
    void partName;
    void value;
}

/*
    Log the current camera position and orbit target.

    The output is formatted so the values can be copied back into the start
    camera constants.
*/
function logCameraPosition()
{
    if (!camera || !controls)
    {
        return;
    }

    console.log("Camera position:");
    console.log(
        `camera.position.set(${camera.position.x.toFixed(3)}, ${camera.position.y.toFixed(3)}, ${camera.position.z.toFixed(3)});`
    );

    console.log("Orbit target:");
    console.log(
        `controls.target.set(${controls.target.x.toFixed(3)}, ${controls.target.y.toFixed(3)}, ${controls.target.z.toFixed(3)});`
    );

    console.table(
    {
        camera_x: camera.position.x,
        camera_y: camera.position.y,
        camera_z: camera.position.z,
        target_x: controls.target.x,
        target_y: controls.target.y,
        target_z: controls.target.z
    });
}