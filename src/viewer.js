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
const PAD_ACTIVE_COLOUR = new THREE.Color(0xff0000);
const DEFAULT_Z_FULL_SCALE = 4000.0;
const CALIBRATION_STORAGE_KEY = "srlHandUntouchedCalibration";

let slotBodyMap = new Map();
let mappedBodyIds = new Set();
let bodyMeshIndex = new Map();
let latestFrame = null;
let zFullScale = DEFAULT_Z_FULL_SCALE;
let calibrationBySlot = new Map();
let calibrationTimestamp = null;
let activeProfileName = "legacy";
let activeModelConfig = null;


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

    // The model is loaded after config/ui_config.json is parsed.
    // That lets the config choose between multiple CAD models.

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
    Load the configured hand model.

    The model path comes from the active config profile. This allows different
    CAD models to use different slot-to-body mappings without changing code.
*/
function loadConfiguredModel(modelConfig)
{
    activeModelConfig = modelConfig || {};

    const objPath = String(activeModelConfig.obj_path || "./models/hand.obj");
    const mtlPath = String(activeModelConfig.mtl_path || "./models/hand.mtl");
    const modelScale = Number.isFinite(Number(activeModelConfig.scale)) ? Number(activeModelConfig.scale) : 1.0;

    if (model)
    {
        scene.remove(model);
        model = null;
    }

    bodyMeshIndex = new Map();

    const objAsset = splitAssetPath(objPath);
    const mtlAsset = splitAssetPath(mtlPath);

    if (!mtlPath || mtlPath.trim().length === 0)
    {
        loadObjOnlyModel(objAsset, modelScale);
        return;
    }

    const mtlLoader = new MTLLoader();
    mtlLoader.setPath(mtlAsset.directory);

    mtlLoader.load(
        mtlAsset.fileName,
        (materials) =>
        {
            materials.preload();

            const objLoader = new OBJLoader();
            objLoader.setMaterials(materials);
            objLoader.setPath(objAsset.directory);

            objLoader.load(
                objAsset.fileName,
                (object) =>
                {
                    finishLoadedModel(object, modelScale);
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
            console.warn("MTL loading failed, trying OBJ without MTL:", err);
            loadObjOnlyModel(objAsset, modelScale);
        }
    );
}

/*
    Load an OBJ without an MTL file.
*/
function loadObjOnlyModel(objAsset, modelScale)
{
    const objLoader = new OBJLoader();
    objLoader.setPath(objAsset.directory);

    objLoader.load(
        objAsset.fileName,
        (object) =>
        {
            finishLoadedModel(object, modelScale);
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
}

/*
    Finish adding a loaded OBJ to the scene.
*/
function finishLoadedModel(object, modelScale)
{
    model = object;

    model.scale.set(modelScale, modelScale, modelScale);
    model.position.set(0, 0, 0);

    scene.add(model);

    requestAnimationFrame(() =>
    {
        resetCamera();
    });

    console.log(`OBJ model loaded for profile '${activeProfileName}':`, model);

    model.traverse((child) =>
    {
        if (child.isMesh)
        {
            console.log("Mesh name:", child.name);
        }
    });

    buildBodyMeshIndex();
    applyLatestFrameToModel();
}

/*
    Split a browser asset path into loader directory and file name.
*/
function splitAssetPath(assetPath)
{
    const cleanPath = String(assetPath || "").trim();
    const slashIndex = cleanPath.lastIndexOf("/");

    if (slashIndex < 0)
    {
        return {
            directory: "./",
            fileName: cleanPath
        };
    }

    return {
        directory: cleanPath.slice(0, slashIndex + 1),
        fileName: cleanPath.slice(slashIndex + 1)
    };
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
    Load the UI configuration used to map ROS sensor slots to OBJ body IDs.

    Preferred config format:
    - active_profile chooses which CAD model and slot map to use.
    - profiles[active_profile].model chooses OBJ/MTL files.
    - profiles[active_profile].slot_body_map maps slots to model body IDs.
    - each slot can override z_full_scale.

    The legacy top-level slot_body_map format is still supported.
*/
export function loadUiConfig(config)
{
    const resolved = resolveActiveProfile(config);
    const profile = resolved.profile;

    activeProfileName = resolved.name;
    slotBodyMap = new Map();
    mappedBodyIds = new Set();

    zFullScale = getPositiveNumber(profile.z_full_scale,
                                   getPositiveNumber(config?.z_full_scale, DEFAULT_Z_FULL_SCALE));

    const entries = Array.isArray(profile.slot_body_map) ? profile.slot_body_map : [];

    entries.forEach((entry) =>
    {
        const slot = Number(entry.slot);
        const bodyId = String(entry.body_id || "").trim();

        if (!Number.isInteger(slot) || bodyId.length === 0)
        {
            return;
        }

        const slotFullScale = getSlotFullScale(entry, zFullScale);

        slotBodyMap.set(slot,
        {
            bodyId: bodyId,
            zFullScale: slotFullScale
        });

        mappedBodyIds.add(bodyId);
    });

    loadStoredCalibration();
    loadConfiguredModel(profile.model || config?.model || {});

    console.log(`Loaded profile '${activeProfileName}' with ${slotBodyMap.size} slot-to-body mappings`);
}

/*
    Resolve the active model/profile from the UI config.
*/
function resolveActiveProfile(config)
{
    const profiles = config?.profiles;

    if (profiles && typeof profiles === "object" && !Array.isArray(profiles))
    {
        const profileNames = Object.keys(profiles);
        const requestedName = String(config?.active_profile || profileNames[0] || "default");
        const selectedName = profiles[requestedName] ? requestedName : profileNames[0];

        return {
            name: selectedName || "default",
            profile: profiles[selectedName] || {}
        };
    }

    return {
        name: "legacy",
        profile: config || {}
    };
}

/*
    Read the Z full-scale value for one slot mapping.
*/
function getSlotFullScale(entry, fallback)
{
    const possibleValues = [
        entry?.z_full_scale,
        entry?.zFullScale,
        entry?.z_max,
        entry?.max_z,
        entry?.max_value
    ];

    for (const value of possibleValues)
    {
        if (Number.isFinite(Number(value)) && Number(value) > 0)
        {
            return Number(value);
        }
    }

    return getPositiveNumber(fallback, DEFAULT_Z_FULL_SCALE);
}

/*
    Return a positive number or a fallback.
*/
function getPositiveNumber(value, fallback)
{
    const number = Number(value);

    if (Number.isFinite(number) && number > 0)
    {
        return number;
    }

    return fallback;
}

/*
    Apply one ROS MagneticHandFrame message to the model.

    The message is expected to contain samples with slot, raw_x, raw_y and
    raw_z fields. Only raw_z is used for colouring at the moment.
*/
export function applyMagneticHandFrame(frame)
{
    latestFrame = frame;
    applyLatestFrameToModel();
}

/*
    Capture the current untouched readings as the calibration baseline.

    The Z value for each slot is stored. Later colouring uses the magnitude of
    current_z - calibrated_z so either sign of movement produces red intensity.
*/
export function captureCalibrationFromFrame()
{
    if (!latestFrame || !Array.isArray(latestFrame.samples))
    {
        return {
            ok: false,
            message: "No ROS frame has been received yet"
        };
    }

    calibrationBySlot = new Map();
    calibrationTimestamp = new Date().toISOString();

    latestFrame.samples.forEach((sample) =>
    {
        const slot = Number(sample.slot);
        const rawZ = Number(sample.raw_z);

        if (!Number.isInteger(slot) || !Number.isFinite(rawZ))
        {
            return;
        }

        calibrationBySlot.set(slot, rawZ);
    });

    const calibration = {
        timestamp: calibrationTimestamp,
        baselines: Object.fromEntries(calibrationBySlot)
    };

    localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(calibration));
    applyLatestFrameToModel();

    return {
        ok: true,
        message: `Calibrated ${calibrationBySlot.size} slots at ${calibrationTimestamp}`,
        calibration: calibration
    };
}

/*
    Return a short calibration status string for the sidebar.
*/
export function getCalibrationSummary()
{
    loadStoredCalibration();

    if (!calibrationTimestamp)
    {
        return "Not calibrated";
    }

    return `${calibrationBySlot.size} slots, ${calibrationTimestamp}`;
}

/*
    Colour one named model part from its base material colour towards red.

    @param partName Mesh/material/body name to colour.
    @param value Normalised value from 0 to 1.
*/
export function colourPart(partName, value)
{
    const mesh = findMeshByBodyId(partName);

    if (!mesh)
    {
        return;
    }

    setMeshRedIntensity(mesh, value);
}

/*
    Load the last calibration from localStorage if one exists.
*/
function loadStoredCalibration()
{
    if (calibrationBySlot.size > 0)
    {
        return;
    }

    const storedText = localStorage.getItem(CALIBRATION_STORAGE_KEY);

    if (!storedText)
    {
        return;
    }

    try
    {
        const stored = JSON.parse(storedText);
        const baselines = stored.baselines || {};

        calibrationBySlot = new Map();

        Object.entries(baselines).forEach(([slotText, rawZ]) =>
        {
            const slot = Number(slotText);
            const value = Number(rawZ);

            if (Number.isInteger(slot) && Number.isFinite(value))
            {
                calibrationBySlot.set(slot, value);
            }
        });

        calibrationTimestamp = stored.timestamp || null;
    }
    catch (err)
    {
        console.warn("Could not load stored calibration:", err);
    }
}

/*
    Build a lookup table from possible body identifiers to meshes.

    Supported identifiers:
    - mesh name
    - parent object name
    - material name
    - mesh uuid
*/
function buildBodyMeshIndex()
{
    bodyMeshIndex = new Map();

    if (!model)
    {
        return;
    }

    model.traverse((child) =>
    {
        if (!child.isMesh)
        {
            return;
        }

        addMeshIndexName(child.name, child);
        addMeshIndexName(child.parent?.name, child);
        addMeshIndexName(child.material?.name, child);
        addMeshIndexName(child.uuid, child);
    });

    console.log(`Built model body index with ${bodyMeshIndex.size} names`);
}

/*
    Add one name to the model body lookup if it is usable.
*/
function addMeshIndexName(name, mesh)
{
    const key = String(name || "").trim();

    if (!key || bodyMeshIndex.has(key))
    {
        return;
    }

    bodyMeshIndex.set(key, mesh);
}

/*
    Apply the latest ROS frame to every mapped body.
*/
function applyLatestFrameToModel()
{
    if (!model || !latestFrame || !Array.isArray(latestFrame.samples))
    {
        return;
    }

    const bodyValues = new Map();

    latestFrame.samples.forEach((sample) =>
    {
        const slot = Number(sample.slot);
        const mapping = slotBodyMap.get(slot);

        if (!mapping || !mapping.bodyId)
        {
            return;
        }

        const rawZ = Number(sample.raw_z);

        if (!Number.isFinite(rawZ))
        {
            return;
        }

        const calibratedZ = calibrationBySlot.has(slot) ? calibrationBySlot.get(slot) : 0.0;
        const zMagnitude = Math.abs(rawZ - calibratedZ);
        const slotIntensity = clamp01(zMagnitude / mapping.zFullScale);

        if (!bodyValues.has(mapping.bodyId))
        {
            bodyValues.set(mapping.bodyId, []);
        }

        bodyValues.get(mapping.bodyId).push(slotIntensity);
    });

    mappedBodyIds.forEach((bodyId) =>
    {
        const mesh = findMeshByBodyId(bodyId);

        if (!mesh)
        {
            return;
        }

        const values = bodyValues.get(bodyId) || [];
        const intensity = average(values);

        setMeshRedIntensity(mesh, intensity);
    });
}

/*
    Find a mesh by body identifier.
*/
function findMeshByBodyId(bodyId)
{
    const key = String(bodyId || "").trim();

    if (!key)
    {
        return null;
    }

    return bodyMeshIndex.get(key) || null;
}

/*
    Set one mesh colour from its original material colour towards red.
*/
function setMeshRedIntensity(mesh, intensity)
{
    if (!mesh || !mesh.isMesh || !mesh.material)
    {
        return;
    }

    const clampedIntensity = clamp01(intensity);
    const materials = makeMeshMaterialsUnique(mesh);

    materials.forEach((material) =>
    {
        if (!material || !material.color)
        {
            return;
        }

        const baseColour = getMaterialBaseColour(material);
        const targetColour = baseColour.clone().lerp(PAD_ACTIVE_COLOUR, clampedIntensity);

        material.color.copy(targetColour);
    });
}

/*
    Get the original material colour, storing it the first time it is seen.
*/
function getMaterialBaseColour(material)
{
    if (material.userData.baseColourHex === undefined)
    {
        material.userData.baseColourHex = material.color.getHex();
    }

    return new THREE.Color(material.userData.baseColourHex);
}

/*
    Return the average of a list of numeric values.
*/
function average(values)
{
    if (!Array.isArray(values) || values.length === 0)
    {
        return 0.0;
    }

    let total = 0.0;

    values.forEach((value) =>
    {
        total += value;
    });

    return total / values.length;
}

/*
    Clamp one number between 0 and 1.
*/
function clamp01(value)
{
    if (!Number.isFinite(value))
    {
        return 0.0;
    }

    return Math.max(0.0, Math.min(1.0, value));
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