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
const MODEL_COLOUR_UPDATE_INTERVAL_MS = 33;
const INTENSITY_CHANGE_EPSILON = 0.005;
const DEFAULT_GRADIENT_VISUAL_GAIN = 1.05;
const DEFAULT_GRADIENT_VISUAL_EXPONENT = 0.55;
const DEFAULT_GRADIENT_DEADBAND = 0.10;
const GRADIENT_MIN_RED_CORE = 0.10;
const GRADIENT_MAX_RED_CORE = 0.46;
const GRADIENT_MIN_SPREAD = 0.62;
const GRADIENT_MAX_SPREAD = 0.96;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const activeHighlights = new Map();
const activeClickMarkers = [];

const HIGHLIGHT_COLOUR = new THREE.Color(0xff0000);
const HIGHLIGHT_DURATION_MS = 1200;
const PAD_ACTIVE_COLOUR = new THREE.Color(0xff0000);
const DEFAULT_SENSITIVITY = 4000.0;
const CALIBRATION_STORAGE_KEY = "srlHandUntouchedCalibration";

let slotBodyMap = new Map();
let mappedBodyIds = new Set();
let bodyMeshIndex = new Map();
let latestFrame = null;
let pendingFrameApply = false;
let lastModelColourUpdateTime = 0.0;
let defaultSensitivity = DEFAULT_SENSITIVITY;
let gradientVisualGain = DEFAULT_GRADIENT_VISUAL_GAIN;
let gradientVisualExponent = DEFAULT_GRADIENT_VISUAL_EXPONENT;
let gradientDeadband = DEFAULT_GRADIENT_DEADBAND;
let calibrationBySlot = new Map();
let calibrationTimestamp = null;
let activeProfileName = "legacy";
let activeModelConfig = null;
let colourMode = "red";
let padGroups = new Map();
let padGradientInfoByKey = new Map();
let padMultiHotspotInfoByKey = new Map();
const reusableGradientRgb = [1.0, 0.0, 0.0];


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
    x: 8.53,
    y: 270.46,
    z: -84.08
};

const START_TARGET_POSITION =
{
    x: 8.53,
    y: 0.00,
    z: -84.08
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
    padGradientInfoByKey = new Map();
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
    applyPendingFrameToModel();

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
    - each slot can override red_sensitivity, gradient_sensitivity and hybrid_sensitivity.

    The legacy top-level slot_body_map format is still supported.
*/
export function loadUiConfig(config)
{
    const resolved = resolveActiveProfile(config);
    const profile = resolved.profile;

    activeProfileName = resolved.name;
    slotBodyMap = new Map();
    mappedBodyIds = new Set();
    padGroups = new Map();
    padGradientInfoByKey = new Map();
    padMultiHotspotInfoByKey = new Map();

    defaultSensitivity = getDefaultSensitivity(profile, config);
    gradientVisualGain = getPositiveNumber(profile?.gradient_visual_gain,
                         getPositiveNumber(config?.gradient_visual_gain, DEFAULT_GRADIENT_VISUAL_GAIN));
    gradientVisualExponent = getPositiveNumber(profile?.gradient_visual_exponent,
                             getPositiveNumber(config?.gradient_visual_exponent, DEFAULT_GRADIENT_VISUAL_EXPONENT));
    gradientDeadband = clamp01(Number(profile?.gradient_deadband ?? config?.gradient_deadband ?? DEFAULT_GRADIENT_DEADBAND));

    colourMode = String(profile.colour_mode ||
                        profile.color_mode ||
                        config?.colour_mode ||
                        config?.color_mode ||
                        "red").trim().toLowerCase();

    if ((colourMode !== "red") && (colourMode !== "gradient") && (colourMode !== "hybrid"))
    {
        console.warn(`Unknown colour_mode '${colourMode}', using red mode`);
        colourMode = "red";
    }

    const entries = Array.isArray(profile.slot_body_map) ? profile.slot_body_map : [];

    entries.forEach((entry) =>
    {
        const slot = Number(entry.slot);
        const bodyId = String(entry.body_id || "").trim();
        const component = String(entry.component || "").trim();
        const pad = String(entry.pad || "").trim();

        if (!Number.isInteger(slot) || bodyId.length === 0)
        {
            return;
        }

        const sensitivities = getSlotSensitivities(entry, profile, config, defaultSensitivity);
        const padKey = getPadKey(component, pad, bodyId);

        slotBodyMap.set(slot,
        {
            bodyId: bodyId,
            component: component,
            pad: pad,
            padKey: padKey,
            redSensitivity: sensitivities.red,
            gradientSensitivity: sensitivities.gradient,
            hybridSensitivity: sensitivities.hybrid,
            gradientHotspotWorld: getVectorConfig(entry.gradient_hotspot_world || entry.gradientHotspotWorld),
            hybridHotspotWorld: getVectorConfig(entry.hybrid_hotspot_world || entry.hybridHotspotWorld)
        });

        mappedBodyIds.add(bodyId);

        if (!padGroups.has(padKey))
        {
            padGroups.set(padKey,
            {
                component: component,
                pad: pad,
                bodyIds: new Set(),
                slots: []
            });
        }

        const padGroup = padGroups.get(padKey);
        padGroup.bodyIds.add(bodyId);
        padGroup.slots.push(slot);
    });

    loadStoredCalibration();
    loadConfiguredModel(profile.model || config?.model || {});

    console.log(`Loaded profile '${activeProfileName}' with ${slotBodyMap.size} slot-to-body mappings in ${colourMode} mode`);
}

/*
    Return the currently active colour mode.
*/
export function getColourMode()
{
    return colourMode;
}

/*
    Change the colour mode live and immediately repaint the model.
*/
export function setColourMode(mode)
{
    const nextMode = String(mode || "").trim().toLowerCase();

    if ((nextMode !== "red") && (nextMode !== "gradient") && (nextMode !== "hybrid"))
    {
        console.warn(`Unknown colour mode '${mode}' ignored`);
        return false;
    }

    colourMode = nextMode;
    pendingFrameApply = true;
    applyLatestFrameToModel();
    return true;
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
    Read the default sensitivity value for the active profile.

    Lower sensitivity values make the colour react more strongly. The old
    z_full_scale names are still accepted as a fallback so existing configs do
    not break.
*/
function getDefaultSensitivity(profile, config)
{
    return getPositiveNumber(profile?.sensitivity,
           getPositiveNumber(config?.sensitivity,
           getPositiveNumber(profile?.z_full_scale,
           getPositiveNumber(config?.z_full_scale, DEFAULT_SENSITIVITY))));
}

/*
    Read the per-mode sensitivity values for one slot mapping.
*/
function getSlotSensitivities(entry, profile, config, fallback)
{
    return {
        red: getModeSensitivityValue(entry, profile, config, "red", fallback),
        gradient: getModeSensitivityValue(entry, profile, config, "gradient", fallback),
        hybrid: getModeSensitivityValue(entry, profile, config, "hybrid", fallback)
    };
}

/*
    Resolve one mode-specific sensitivity value.

    Preferred names are red_sensitivity, gradient_sensitivity and
    hybrid_sensitivity. Legacy z_full_scale values are still accepted.
*/
function getModeSensitivityValue(entry, profile, config, mode, fallback)
{
    const snakeName = `${mode}_sensitivity`;
    const camelName = `${mode}Sensitivity`;
    const fullScaleSnakeName = `${mode}_full_scale`;
    const fullScaleCamelName = `${mode}FullScale`;

    const possibleValues = [
        entry?.[snakeName],
        entry?.[camelName],
        entry?.[fullScaleSnakeName],
        entry?.[fullScaleCamelName],
        entry?.sensitivity,

        profile?.[snakeName],
        profile?.[camelName],
        profile?.[fullScaleSnakeName],
        profile?.[fullScaleCamelName],
        profile?.sensitivity,

        config?.[snakeName],
        config?.[camelName],
        config?.[fullScaleSnakeName],
        config?.[fullScaleCamelName],
        config?.sensitivity,

        entry?.z_full_scale,
        entry?.zFullScale,
        entry?.z_max,
        entry?.max_z,
        entry?.max_value,
        profile?.z_full_scale,
        profile?.zFullScale,
        config?.z_full_scale,
        config?.zFullScale
    ];

    for (const value of possibleValues)
    {
        if (Number.isFinite(Number(value)) && Number(value) > 0)
        {
            return Number(value);
        }
    }

    return getPositiveNumber(fallback, DEFAULT_SENSITIVITY);
}

/*
    Return the sensitivity value that applies to one mapping for one mode.
*/
function getMappingSensitivity(mapping, mode)
{
    if (mode === "gradient")
    {
        return getPositiveNumber(mapping?.gradientSensitivity, defaultSensitivity);
    }

    if (mode === "hybrid")
    {
        return getPositiveNumber(mapping?.hybridSensitivity, defaultSensitivity);
    }

    return getPositiveNumber(mapping?.redSensitivity, defaultSensitivity);
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
    Read an optional XYZ vector from config.

    This is used for rare cases where the visual hotspot should be pinned to
    a known world-space point instead of the centre of the CAD body.
*/
function getVectorConfig(value)
{
    if (!value || typeof value !== "object")
    {
        return null;
    }

    if (isEmptyVectorComponent(value.x) ||
        isEmptyVectorComponent(value.y) ||
        isEmptyVectorComponent(value.z))
    {
        return null;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
    {
        return null;
    }

    return {x: x, y: y, z: z};
}

/*
    Return true when a vector component is deliberately blank in the config.

    This allows every hotspot field to always contain x/y/z keys while still
    letting the code fall back to the calculated geometric centre when the
    values are unused.
*/
function isEmptyVectorComponent(value)
{
    return value === null || value === undefined || String(value).trim() === "";
}

/*
    Apply a normalised deadband and rescale the remaining value to 0..1.
*/
function applyNormalisedDeadband(value, deadband)
{
    const clampedValue = clamp01(value);
    const clampedDeadband = clamp01(deadband);

    if (clampedValue <= clampedDeadband)
    {
        return 0.0;
    }

    return clamp01((clampedValue - clampedDeadband) / Math.max(1.0 - clampedDeadband, 1e-9));
}

/*
    Build one pad-group key from component and pad.

    If component/pad are missing, fall back to the body ID so the mapping still works.
*/
function getPadKey(component, pad, bodyId)
{
    const safeComponent = String(component || "").trim();
    const safePad = String(pad || "").trim();

    if (safeComponent.length > 0 || safePad.length > 0)
    {
        return `${safeComponent}::${safePad}`;
    }

    return `body::${String(bodyId || "").trim()}`;
}

/*
    Apply one ROS MagneticHandFrame message to the model.

    The message is expected to contain samples with slot, raw_x, raw_y and
    raw_z fields. Only raw_z is used for colouring at the moment.
*/
export function applyMagneticHandFrame(frame)
{
    latestFrame = frame;
    pendingFrameApply = true;
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
    reportMissingMappedBodies();
}

/*
    Warn if any configured body IDs do not exist in the loaded model.
*/
function reportMissingMappedBodies()
{
    const missingBodyIds = [];

    mappedBodyIds.forEach((bodyId) =>
    {
        if (!findMeshByBodyId(bodyId))
        {
            missingBodyIds.push(bodyId);
        }
    });

    if (missingBodyIds.length === 0)
    {
        console.log("All configured body IDs were found in the loaded model");
        return;
    }

    console.warn("Configured body IDs not found in model:", missingBodyIds);
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
    Apply the newest ROS frame at the render-loop rate.

    ROS messages can arrive much faster than the renderer can recolour the CAD
    model. This keeps only the latest frame and drops intermediate frames so the
    UI does not spend all its time processing stale data.
*/
function applyPendingFrameToModel()
{
    if (!pendingFrameApply)
    {
        return;
    }

    const now = performance.now();

    if ((now - lastModelColourUpdateTime) < MODEL_COLOUR_UPDATE_INTERVAL_MS)
    {
        return;
    }

    pendingFrameApply = false;
    lastModelColourUpdateTime = now;
    applyLatestFrameToModel();
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

    if (colourMode === "gradient")
    {
        applyGradientModeFrame();
        return;
    }

    if (colourMode === "hybrid")
    {
        applyHybridModeFrame();
        return;
    }

    applyRedModeFrame();
}

/*
    Collect averaged pad intensities for pad-based colouring modes.

    The returned map uses padKey as the key and stores a single normalised
    intensity per pad, computed from the average Z magnitude and the average
    mode-specific sensitivity across all sensors in that pad.
*/
function buildPadIntensityMap(mode)
{
    const padValues = new Map();
    const padIntensityMap = new Map();

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

        if (!padValues.has(mapping.padKey))
        {
            padValues.set(mapping.padKey,
            {
                zValues: [],
                zScales: []
            });
        }

        const padEntry = padValues.get(mapping.padKey);
        padEntry.zValues.push(zMagnitude);
        padEntry.zScales.push(getMappingSensitivity(mapping, mode));
    });

    padGroups.forEach((group, padKey) =>
    {
        const padEntry = padValues.get(padKey);
        const averageReading = average(padEntry?.zValues || []);
        const averageScale = average(padEntry?.zScales || []);
        const intensity = clamp01(averageReading / Math.max(averageScale, 1e-9));

        padIntensityMap.set(padKey, intensity);
    });

    return padIntensityMap;
}

/*
    Apply the current frame using red mode.

    All sensors that belong to the same pad share one averaged reading and one
    averaged red_sensitivity. Every body that belongs to that pad is then coloured
    with the same red intensity.
*/
function applyRedModeFrame()
{
    const padIntensityMap = buildPadIntensityMap("red");

    mappedBodyIds.forEach((bodyId) =>
    {
        const mesh = findMeshByBodyId(bodyId);

        if (!mesh)
        {
            return;
        }

        setMeshRedIntensity(mesh, 0.0);
    });

    padGroups.forEach((group, padKey) =>
    {
        const intensity = padIntensityMap.get(padKey) || 0.0;

        group.bodyIds.forEach((bodyId) =>
        {
            const mesh = findMeshByBodyId(bodyId);

            if (!mesh)
            {
                return;
            }

            setMeshRedIntensity(mesh, intensity);
        });
    });
}

/*
    Apply the current frame using hybrid mode.

    Sensors are grouped by pad exactly like red mode, but the whole pad is
    coloured using the gradient visual treatment instead of a flat red fill.
    Every body that belongs to the same pad therefore gets the same gradient
    strength.
*/
function applyHybridModeFrame()
{
    const padIntensityMap = buildPadIntensityMap("hybrid");

    padGroups.forEach((group, padKey) =>
    {
        const intensity = padIntensityMap.get(padKey) || 0.0;

        group.bodyIds.forEach((bodyId) =>
        {
            const mesh = findMeshByBodyId(bodyId);

            if (!mesh)
            {
                return;
            }

            setMeshPadGradientIntensity(mesh, intensity, padKey);
        });
    });
}

/*
    Apply the current frame using gradient mode.

    Each sensor is treated independently. Its own body is coloured using its
    own Z magnitude and gradient_sensitivity value. If multiple slots map to the same
    body, their normalised intensities are averaged.
*/
function applyGradientModeFrame()
{
    const slotIntensityMap = new Map();

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
        const rawSlotIntensity = clamp01(zMagnitude / Math.max(getMappingSensitivity(mapping, "gradient"), 1e-9));
        const slotIntensity = applyNormalisedDeadband(rawSlotIntensity, gradientDeadband);

        slotIntensityMap.set(slot, slotIntensity);
    });

    padGroups.forEach((group, padKey) =>
    {
        const modeKey = buildMultiHotspotModeKey(padKey, group.slots, slotIntensityMap);

        group.bodyIds.forEach((bodyId) =>
        {
            const mesh = findMeshByBodyId(bodyId);

            if (!mesh)
            {
                return;
            }

            setMeshMultiHotspotGradientIntensity(mesh, padKey, group.slots, slotIntensityMap, modeKey);
        });
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
    Build a compact key representing the current multi-hotspot state for one pad.

    This lets the renderer skip colour-buffer writes when the visible values have
    not changed enough to matter.
*/
function buildMultiHotspotModeKey(padKey, slots, slotIntensityMap)
{
    const parts = [String(padKey)];

    slots.forEach((slot) =>
    {
        const intensity = slotIntensityMap.get(slot) || 0.0;

        // Quantise to 2 percent steps so sensor jitter does not force a full
        // vertex-colour repaint every received ROS frame.
        parts.push(`${slot}:${Math.round(intensity * 50)}`);
    });

    return parts.join("|");
}

/*
    Apply continuous multi-hotspot gradient mode to one mesh.

    Unlike the old local gradient, each vertex is evaluated against every sensor
    hotspot in the same pad. Since all distances are calculated in world space,
    adjacent CAD bodies blend together instead of each body having its own hard
    centred gradient.
*/
function setMeshMultiHotspotGradientIntensity(mesh, padKey, slots, slotIntensityMap, modeKey)
{
    if (!mesh || !mesh.isMesh || !mesh.material || !mesh.geometry)
    {
        return;
    }

    const activeModeKey = `multi:${modeKey}`;

    if (mesh.userData.lastMultiHotspotModeKey === activeModeKey)
    {
        return;
    }

    const padInfo = getPadMultiHotspotInfo(padKey);
    const meshInfo = padInfo?.meshInfo?.get(mesh.uuid);

    if (!meshInfo)
    {
        return;
    }

    mesh.userData.lastMultiHotspotModeKey = activeModeKey;
    mesh.userData.lastGradientIntensity = undefined;
    mesh.userData.lastGradientModeKey = undefined;
    mesh.userData.lastRedIntensity = undefined;

    const materials = makeMeshMaterialsUnique(mesh);
    const firstMaterial = Array.isArray(materials) ? materials[0] : materials;
    const baseColour = getMaterialBaseColour(firstMaterial);
    const colours = ensureMeshColourAttribute(mesh);
    const colourArray = colours.array;

    const activeHotspots = [];

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++)
    {
        const slot = slots[slotIndex];
        const intensity = slotIntensityMap.get(slot) || 0.0;

        if (intensity <= 0.0001)
        {
            continue;
        }

        const distanceNorms = meshInfo.distanceNormsBySlot.get(slot);

        if (!distanceNorms)
        {
            continue;
        }

        // Sensitivity converts the raw magnetic reading to a 0 to 1 value.
        // This visual curve makes gradient mode show useful colour before the
        // raw value is fully saturated.
        const visualIntensity = clamp01(Math.pow(intensity, gradientVisualExponent) * gradientVisualGain);
        const spread = GRADIENT_MIN_SPREAD + ((GRADIENT_MAX_SPREAD - GRADIENT_MIN_SPREAD) * visualIntensity);
        const redCoreRadius = GRADIENT_MIN_RED_CORE + ((GRADIENT_MAX_RED_CORE - GRADIENT_MIN_RED_CORE) * visualIntensity);

        activeHotspots.push(
        {
            distances: distanceNorms,
            visualIntensity: visualIntensity,
            inverseSpread: 1.0 / Math.max(spread, 1e-9),
            redCoreRadius: redCoreRadius
        });
    }

    if (activeHotspots.length === 0)
    {
        fillMeshColourArray(colourArray, baseColour.r, baseColour.g, baseColour.b);
        colours.needsUpdate = true;
        enableVertexColours(materials);
        return;
    }

    for (let vertexIndex = 0; vertexIndex < meshInfo.vertexCount; vertexIndex++)
    {
        let combinedActivation = 0.0;
        let weightedDistance = 0.0;
        let totalWeight = 0.0;

        for (let hotspotIndex = 0; hotspotIndex < activeHotspots.length; hotspotIndex++)
        {
            const hotspot = activeHotspots[hotspotIndex];
            const distanceNorm = hotspot.distances[vertexIndex];
            const localDistance = clamp01(distanceNorm * hotspot.inverseSpread);
            const closeness = 1.0 - localDistance;

            if (closeness <= 0.0)
            {
                continue;
            }

            // Broad, smooth falloff. This is intentionally wide so adjacent
            // sectioned bodies blend together instead of showing hard gaps.
            const spatialWeight = Math.pow(smooth01(closeness), 1.35);
            const contribution = clamp01(hotspot.visualIntensity * spatialWeight);

            if (contribution <= 0.0001)
            {
                continue;
            }

            combinedActivation = 1.0 - ((1.0 - combinedActivation) * (1.0 - contribution));
            weightedDistance += localDistance * contribution;
            totalWeight += contribution;
        }

        const arrayIndex = vertexIndex * 3;

        if (totalWeight <= 0.0001)
        {
            colourArray[arrayIndex + 0] = baseColour.r;
            colourArray[arrayIndex + 1] = baseColour.g;
            colourArray[arrayIndex + 2] = baseColour.b;
            continue;
        }

        const blendedDistance = clamp01(weightedDistance / totalWeight);
        const blendedCoreRadius = GRADIENT_MIN_RED_CORE + ((GRADIENT_MAX_RED_CORE - GRADIENT_MIN_RED_CORE) * combinedActivation);
        const gradient = sampleGradientRgbNoAlloc(blendedDistance, blendedCoreRadius);
        const mixAmount = clamp01(combinedActivation * 1.20);

        colourArray[arrayIndex + 0] = baseColour.r + ((gradient[0] - baseColour.r) * mixAmount);
        colourArray[arrayIndex + 1] = baseColour.g + ((gradient[1] - baseColour.g) * mixAmount);
        colourArray[arrayIndex + 2] = baseColour.b + ((gradient[2] - baseColour.b) * mixAmount);
    }

    colours.needsUpdate = true;
    enableVertexColours(materials);
}

/*
    Build or return cached distance fields for continuous gradient mode.

    Each sensor hotspot is placed at the centre of its mapped body. Offsets are
    deliberately disabled in this version to keep the continuous gradient fast
    and easy to debug.
*/
function getPadMultiHotspotInfo(padKey)
{
    if (padMultiHotspotInfoByKey.has(padKey))
    {
        return padMultiHotspotInfoByKey.get(padKey);
    }

    const group = padGroups.get(padKey);

    if (!group)
    {
        return null;
    }

    const meshes = [];
    const seenMeshIds = new Set();

    group.bodyIds.forEach((bodyId) =>
    {
        const mesh = findMeshByBodyId(bodyId);

        if (!mesh || seenMeshIds.has(mesh.uuid))
        {
            return;
        }

        seenMeshIds.add(mesh.uuid);
        meshes.push(mesh);
    });

    if (meshes.length === 0)
    {
        return null;
    }

    if (model)
    {
        model.updateMatrixWorld(true);
    }

    const hotspotCentersBySlot = new Map();

    group.slots.forEach((slot) =>
    {
        const mapping = slotBodyMap.get(slot);
        const mesh = findMeshByBodyId(mapping?.bodyId);

        if (!mapping || !mesh)
        {
            return;
        }

        hotspotCentersBySlot.set(slot, getSensorHotspotWorldPosition(mapping, mesh));
    });

    if (hotspotCentersBySlot.size === 0)
    {
        return null;
    }

    const worldPoint = new THREE.Vector3();
    const meshWorldPoints = new Map();

    meshes.forEach((mesh) =>
    {
        const position = mesh.geometry.attributes.position;

        if (!position)
        {
            return;
        }

        const worldPoints = new Float32Array(position.count * 3);

        for (let index = 0; index < position.count; index++)
        {
            worldPoint.set(position.getX(index), position.getY(index), position.getZ(index));
            worldPoint.applyMatrix4(mesh.matrixWorld);

            const arrayIndex = index * 3;
            worldPoints[arrayIndex + 0] = worldPoint.x;
            worldPoints[arrayIndex + 1] = worldPoint.y;
            worldPoints[arrayIndex + 2] = worldPoint.z;
        }

        meshWorldPoints.set(mesh.uuid,
        {
            vertexCount: position.count,
            worldPoints: worldPoints
        });
    });

    const distanceRangesBySlot = new Map();

    hotspotCentersBySlot.forEach((hotspotCenter, slot) =>
    {
        distanceRangesBySlot.set(slot,
        {
            min: Number.POSITIVE_INFINITY,
            max: 0.0
        });

        const range = distanceRangesBySlot.get(slot);

        meshWorldPoints.forEach((meshData) =>
        {
            const worldPoints = meshData.worldPoints;

            for (let index = 0; index < meshData.vertexCount; index++)
            {
                const arrayIndex = index * 3;
                const dx = worldPoints[arrayIndex + 0] - hotspotCenter.x;
                const dy = worldPoints[arrayIndex + 1] - hotspotCenter.y;
                const dz = worldPoints[arrayIndex + 2] - hotspotCenter.z;
                const distance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));

                if (distance < range.min)
                {
                    range.min = distance;
                }

                if (distance > range.max)
                {
                    range.max = distance;
                }
            }
        });

        if (!Number.isFinite(range.min) || ((range.max - range.min) < 1e-9))
        {
            range.min = 0.0;
            range.max = 1.0;
        }
    });

    const meshInfo = new Map();

    meshWorldPoints.forEach((meshData, meshUuid) =>
    {
        const distanceNormsBySlot = new Map();

        hotspotCentersBySlot.forEach((hotspotCenter, slot) =>
        {
            const range = distanceRangesBySlot.get(slot);
            const rangeSize = Math.max(range.max - range.min, 1e-9);
            const distances = new Float32Array(meshData.vertexCount);
            const worldPoints = meshData.worldPoints;

            for (let index = 0; index < meshData.vertexCount; index++)
            {
                const arrayIndex = index * 3;
                const dx = worldPoints[arrayIndex + 0] - hotspotCenter.x;
                const dy = worldPoints[arrayIndex + 1] - hotspotCenter.y;
                const dz = worldPoints[arrayIndex + 2] - hotspotCenter.z;
                const distance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));

                // Normalise so the closest visible vertices to a hotspot become 0.
                // This fixes solid/rounded bodies where the mathematical centre is
                // inside the mesh and no actual vertex sits at the centre.
                distances[index] = clamp01((distance - range.min) / rangeSize);
            }

            distanceNormsBySlot.set(slot, distances);
        });

        meshInfo.set(meshUuid,
        {
            vertexCount: meshData.vertexCount,
            distanceNormsBySlot: distanceNormsBySlot
        });
    });

    const padInfo =
    {
        hotspotCentersBySlot: hotspotCentersBySlot,
        meshInfo: meshInfo,
        distanceRangesBySlot: distanceRangesBySlot
    };

    padMultiHotspotInfoByKey.set(padKey, padInfo);

    return padInfo;
}

/*
    Return the world-space hotspot position for a sensor entry.

    This version uses the centre of the mapped sensor body. Per-slot offsets are
    intentionally not used until the continuous field is stable and performant.
*/
function getSensorHotspotWorldPosition(mapping, mesh)
{
    if (mapping?.gradientHotspotWorld)
    {
        return new THREE.Vector3(
            mapping.gradientHotspotWorld.x,
            mapping.gradientHotspotWorld.y,
            mapping.gradientHotspotWorld.z
        );
    }

    const geometry = mesh.geometry;

    if (!geometry.boundingBox)
    {
        geometry.computeBoundingBox();
    }

    const box = geometry.boundingBox;
    const center = new THREE.Vector3();

    box.getCenter(center);

    return center.applyMatrix4(mesh.matrixWorld);
}

/*
    Apply a shared pad-level gradient to one mesh.

    Hybrid mode uses this so every body in a pad is treated as part of one
    larger imaginary body. The red centre is calculated from the centre of the
    combined pad geometry, not from each individual mesh centre.
*/
function setMeshPadGradientIntensity(mesh, intensity, padKey)
{
    const padInfo = getPadGradientInfo(padKey);
    const meshInfo = padInfo?.meshInfo?.get(mesh.uuid) || null;

    setMeshGradientIntensity(mesh, intensity, meshInfo, `pad:${padKey}`);
}

/*
    Build or return cached shared gradient data for one pad.

    The centre and radius are calculated in world space using all meshes that
    belong to the pad. Each mesh then receives distance values relative to that
    shared centre and shared radius.
*/
function getPadGradientInfo(padKey)
{
    if (padGradientInfoByKey.has(padKey))
    {
        return padGradientInfoByKey.get(padKey);
    }

    const group = padGroups.get(padKey);

    if (!group)
    {
        return null;
    }

    const meshes = [];
    const seenMeshIds = new Set();

    group.bodyIds.forEach((bodyId) =>
    {
        const mesh = findMeshByBodyId(bodyId);

        if (!mesh || seenMeshIds.has(mesh.uuid))
        {
            return;
        }

        seenMeshIds.add(mesh.uuid);
        meshes.push(mesh);
    });

    if (meshes.length === 0)
    {
        return null;
    }

    if (model)
    {
        model.updateMatrixWorld(true);
    }

    const combinedBox = new THREE.Box3();
    const meshBox = new THREE.Box3();

    meshes.forEach((mesh) =>
    {
        if (!mesh.geometry.boundingBox)
        {
            mesh.geometry.computeBoundingBox();
        }

        meshBox.copy(mesh.geometry.boundingBox);
        meshBox.applyMatrix4(mesh.matrixWorld);
        combinedBox.union(meshBox);
    });

    const padCenter = new THREE.Vector3();
    const hybridHotspots = [];

    group.slots.forEach((slot) =>
    {
        const mapping = slotBodyMap.get(slot);

        if (mapping?.hybridHotspotWorld)
        {
            hybridHotspots.push(mapping.hybridHotspotWorld);
        }
    });

    if (hybridHotspots.length > 0)
    {
        hybridHotspots.forEach((hotspot) =>
        {
            padCenter.x += hotspot.x;
            padCenter.y += hotspot.y;
            padCenter.z += hotspot.z;
        });

        padCenter.multiplyScalar(1.0 / hybridHotspots.length);
    }
    else
    {
        combinedBox.getCenter(padCenter);
    }

    const worldPoint = new THREE.Vector3();
    let maxRadius = 0.001;

    meshes.forEach((mesh) =>
    {
        const position = mesh.geometry.attributes.position;

        if (!position)
        {
            return;
        }

        for (let index = 0; index < position.count; index++)
        {
            worldPoint.set(position.getX(index), position.getY(index), position.getZ(index));
            worldPoint.applyMatrix4(mesh.matrixWorld);

            const radius = worldPoint.distanceTo(padCenter);

            if (radius > maxRadius)
            {
                maxRadius = radius;
            }
        }
    });

    const meshInfo = new Map();

    meshes.forEach((mesh) =>
    {
        const position = mesh.geometry.attributes.position;

        if (!position)
        {
            return;
        }

        const distanceNorms = new Float32Array(position.count);

        for (let index = 0; index < position.count; index++)
        {
            worldPoint.set(position.getX(index), position.getY(index), position.getZ(index));
            worldPoint.applyMatrix4(mesh.matrixWorld);

            distanceNorms[index] = clamp01(worldPoint.distanceTo(padCenter) / maxRadius);
        }

        meshInfo.set(mesh.uuid,
        {
            center: padCenter,
            maxRadius: maxRadius,
            distanceNorms: distanceNorms
        });
    });

    const padInfo =
    {
        center: padCenter,
        maxRadius: maxRadius,
        meshInfo: meshInfo
    };

    padGradientInfoByKey.set(padKey, padInfo);

    return padInfo;
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

    if (Math.abs((mesh.userData.lastRedIntensity ?? -1.0) - clampedIntensity) < INTENSITY_CHANGE_EPSILON)
    {
        return;
    }

    mesh.userData.lastRedIntensity = clampedIntensity;
    mesh.userData.lastGradientIntensity = undefined;
    mesh.userData.lastGradientModeKey = undefined;
    mesh.userData.lastMultiHotspotModeKey = undefined;

    const materials = makeMeshMaterialsUnique(mesh);

    materials.forEach((material) =>
    {
        if (!material || !material.color)
        {
            return;
        }

        const baseColour = getMaterialBaseColour(material);

        material.vertexColors = false;
        material.color.setRGB(
            baseColour.r + ((PAD_ACTIVE_COLOUR.r - baseColour.r) * clampedIntensity),
            baseColour.g + ((PAD_ACTIVE_COLOUR.g - baseColour.g) * clampedIntensity),
            baseColour.b + ((PAD_ACTIVE_COLOUR.b - baseColour.b) * clampedIntensity)
        );
        material.needsUpdate = true;
    });
}

/*
    Set one mesh to a radial false-colour gradient.

    The centre becomes red and expands as intensity increases. The outer area
    fades through orange and yellow before ending in blue near the edges.
*/
function setMeshGradientIntensity(mesh, intensity, gradientInfo = null, gradientModeKey = "local")
{
    if (!mesh || !mesh.isMesh || !mesh.material || !mesh.geometry)
    {
        return;
    }

    const clampedIntensity = clamp01(intensity);
    const activeGradientModeKey = String(gradientModeKey || "local");

    if ((mesh.userData.lastGradientModeKey === activeGradientModeKey) &&
        (Math.abs((mesh.userData.lastGradientIntensity ?? -1.0) - clampedIntensity) < INTENSITY_CHANGE_EPSILON))
    {
        return;
    }

    mesh.userData.lastGradientIntensity = clampedIntensity;
    mesh.userData.lastGradientModeKey = activeGradientModeKey;
    mesh.userData.lastRedIntensity = undefined;
    mesh.userData.lastMultiHotspotModeKey = undefined;

    const materials = makeMeshMaterialsUnique(mesh);
    const geometry = mesh.geometry;

    if (!geometry.attributes || !geometry.attributes.position)
    {
        return;
    }

    const firstMaterial = Array.isArray(materials) ? materials[0] : materials;
    const baseColour = getMaterialBaseColour(firstMaterial);
    const colours = ensureMeshColourAttribute(mesh);
    const colourArray = colours.array;

    const isPadGradient = activeGradientModeKey.startsWith("pad:");
    const visualIntensity = isPadGradient ? Math.sqrt(clampedIntensity) : clampedIntensity;

    if (visualIntensity <= 0.0001)
    {
        fillMeshColourArray(colourArray, baseColour.r, baseColour.g, baseColour.b);
        colours.needsUpdate = true;
        enableVertexColours(materials);
        return;
    }

    const info = gradientInfo || getMeshGradientInfo(mesh);
    const distanceNorms = info.distanceNorms;

    // In local gradient mode, keep a smaller hot spot so individual sensors stay distinct.
    // In hybrid mode, the pad is treated as one larger body, so the red area needs to
    // spread much further and reach full red when the pad saturates.
    const coreRadius = isPadGradient ?
        clamp01(0.06 + (0.94 * visualIntensity)) :
        clamp01(0.12 + (0.58 * visualIntensity));

    for (let index = 0; index < distanceNorms.length; index++)
    {
        const distanceNorm = distanceNorms[index];
        const gradient = sampleGradientRgbNoAlloc(distanceNorm, coreRadius);
        const arrayIndex = index * 3;

        colourArray[arrayIndex + 0] = baseColour.r + ((gradient[0] - baseColour.r) * visualIntensity);
        colourArray[arrayIndex + 1] = baseColour.g + ((gradient[1] - baseColour.g) * visualIntensity);
        colourArray[arrayIndex + 2] = baseColour.b + ((gradient[2] - baseColour.b) * visualIntensity);
    }

    colours.needsUpdate = true;
    enableVertexColours(materials);
}

/*
    Get the local centre and normalised vertex distances used for gradient colouring.

    This is computed once per mesh and reused every frame.
*/
function getMeshGradientInfo(mesh)
{
    if (mesh.userData.gradientInfo)
    {
        return mesh.userData.gradientInfo;
    }

    const geometry = mesh.geometry;
    geometry.computeBoundingBox();

    const box = geometry.boundingBox;
    const center = new THREE.Vector3();
    box.getCenter(center);

    const position = geometry.attributes.position;
    const distances = new Float32Array(position.count);
    let maxRadius = 0.001;

    for (let index = 0; index < position.count; index++)
    {
        const dx = position.getX(index) - center.x;
        const dy = position.getY(index) - center.y;
        const dz = position.getZ(index) - center.z;
        const radius = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));

        distances[index] = radius;

        if (radius > maxRadius)
        {
            maxRadius = radius;
        }
    }

    for (let index = 0; index < distances.length; index++)
    {
        distances[index] = clamp01(distances[index] / maxRadius);
    }

    mesh.userData.gradientInfo = {
        center: center,
        maxRadius: maxRadius,
        distanceNorms: distances
    };

    return mesh.userData.gradientInfo;
}

/*
    Ensure a geometry colour attribute exists and return it.
*/
function ensureMeshColourAttribute(mesh)
{
    const geometry = mesh.geometry;
    let colours = geometry.getAttribute("color");

    if (colours)
    {
        return colours;
    }

    const position = geometry.attributes.position;
    const array = new Float32Array(position.count * 3);
    colours = new THREE.BufferAttribute(array, 3);
    geometry.setAttribute("color", colours);

    return colours;
}

/*
    Enable per-vertex colours on every material used by a mesh.
*/
function enableVertexColours(materials)
{
    materials.forEach((material) =>
    {
        if (!material)
        {
            return;
        }

        material.vertexColors = true;

        if (material.color)
        {
            material.color.set(0xffffff);
        }

        material.needsUpdate = true;
    });
}

/*
    Fill one colour buffer with a solid RGB value.
*/
function fillMeshColourArray(array, r, g, b)
{
    for (let index = 0; index < array.length; index += 3)
    {
        array[index + 0] = r;
        array[index + 1] = g;
        array[index + 2] = b;
    }
}

/*
    Smoothly interpolate a 0 to 1 value.
*/
function smooth01(value)
{
    const t = clamp01(value);
    return t * t * (3.0 - (2.0 * t));
}

/*
    Sample heat-map colour by activation rather than by radial distance.

    0 is blue/low and 1 is red/hot. Values in between move through yellow
    and orange.
*/
function sampleHeatRgbFromActivationNoAlloc(activation)
{
    const value = clamp01(activation);

    if (value < 0.33)
    {
        const t = value / 0.33;
        reusableGradientRgb[0] = 0.0823529412 + ((1.0 - 0.0823529412) * t);
        reusableGradientRgb[1] = 0.3960784314 + ((0.9019607843 - 0.3960784314) * t);
        reusableGradientRgb[2] = 1.0 + ((0.0 - 1.0) * t);
        return reusableGradientRgb;
    }

    if (value < 0.66)
    {
        const t = (value - 0.33) / 0.33;
        reusableGradientRgb[0] = 1.0;
        reusableGradientRgb[1] = 0.9019607843 + ((0.4784313725 - 0.9019607843) * t);
        reusableGradientRgb[2] = 0.0;
        return reusableGradientRgb;
    }

    const t = (value - 0.66) / 0.34;
    reusableGradientRgb[0] = 1.0;
    reusableGradientRgb[1] = 0.4784313725 + ((0.0 - 0.4784313725) * t);
    reusableGradientRgb[2] = 0.0;

    return reusableGradientRgb;
}

/*
    Sample the false-colour gradient for one normalised distance.

    The result is returned as plain numbers rather than THREE.Color objects so
    gradient updates avoid thousands of temporary allocations per frame.
*/
function sampleGradientRgbNoAlloc(distanceNorm, coreRadius)
{
    if (distanceNorm <= coreRadius)
    {
        reusableGradientRgb[0] = 1.0;
        reusableGradientRgb[1] = 0.0;
        reusableGradientRgb[2] = 0.0;
        return reusableGradientRgb;
    }

    const outerNorm = clamp01((distanceNorm - coreRadius) / Math.max(1.0 - coreRadius, 1e-9));

    if (outerNorm < 0.33)
    {
        const t = outerNorm / 0.33;
        reusableGradientRgb[0] = 1.0;
        reusableGradientRgb[1] = 0.4784313725 * t;
        reusableGradientRgb[2] = 0.0;
        return reusableGradientRgb;
    }

    if (outerNorm < 0.66)
    {
        const t = (outerNorm - 0.33) / 0.33;
        reusableGradientRgb[0] = 1.0;
        reusableGradientRgb[1] = 0.4784313725 + ((0.9019607843 - 0.4784313725) * t);
        reusableGradientRgb[2] = 0.0;
        return reusableGradientRgb;
    }

    const t = (outerNorm - 0.66) / 0.34;

    reusableGradientRgb[0] = 1.0 + ((0.0823529412 - 1.0) * t);
    reusableGradientRgb[1] = 0.9019607843 + ((0.3960784314 - 0.9019607843) * t);
    reusableGradientRgb[2] = 0.0 + (1.0 * t);

    return reusableGradientRgb;
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