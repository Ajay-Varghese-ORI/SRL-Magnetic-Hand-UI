import { connectRosBridge } from "./rosbridge.js";
import {
    applyMagneticHandFrame,
    captureCalibrationFromFrame,
    flashMappedBody,
    flashMappedPoint,
    getCalibrationSummary,
    getColourMode,
    initViewer,
    loadUiConfig,
    resetCamera,
    setColourMode,
    setDebugMode,
    setModelClickHandler
} from "./viewer.js";

const viewerElement = document.getElementById("viewer");
const connectRosButton = document.getElementById("connectRosButton");
const calibrateButton = document.getElementById("calibrateButton");
const resetViewButton = document.getElementById("resetViewButton");
const clearLogButton = document.getElementById("clearLogButton");
const rosbridgeUrlInput = document.getElementById("rosbridgeUrlInput");
const colourModeSelect = document.getElementById("colourModeSelect");
const statusElement = document.getElementById("status");
const frameRateElement = document.getElementById("frameRate");
const calibrationElement = document.getElementById("calibrationStatus");
const lastMessageElement = document.getElementById("lastMessage");
const mappingProfileSelect = document.getElementById("mappingProfileSelect");
const startMappingButton = document.getElementById("startMappingButton");
const stopMappingButton = document.getElementById("stopMappingButton");
const downloadMappedConfigButton = document.getElementById("downloadMappedConfigButton");
const mappingStatusElement = document.getElementById("mappingStatus");
const mappingPromptElement = document.getElementById("mappingPrompt");
const mappingSectionElement = document.getElementById("mappingSection");
const sidebarToggleButton = document.getElementById("sidebarToggleButton");

const EMPTY_HOTSPOT = {x: null, y: null, z: null};

let appConfig = null;
let receivedFrameCount = 0;
let lastRateUpdateTime = performance.now();
let framesSinceRateUpdate = 0;
let mappingState = null;
let debugMode = false;

initViewer(viewerElement);
initialiseApp();

/**
 * Load UI config and initialise controls.
*/
async function initialiseApp()
{
    try
    {
        const response = await fetch("./config/ui_config.json");
        appConfig = await response.json();
        normaliseConfigInPlace(appConfig);
        configureDebugMode();

        loadUiConfig(appConfig);
        populateProfileSelect();

        rosbridgeUrlInput.value = appConfig.rosbridge_url || "ws://localhost:9090";
        colourModeSelect.value = getColourMode();
        calibrationElement.textContent = getCalibrationSummary();
        statusElement.textContent = "Ready";
        setMappingText("Idle", "Press Start Mapping Current Profile to begin.\nLeft click selects. Right click confirms and moves on.");
    }
    catch (err)
    {
        console.error(err);
        statusElement.textContent = "Config load failed: " + err.message;
    }
}

colourModeSelect.addEventListener("change", () =>
{
    const selectedMode = colourModeSelect.value;
    setColourMode(selectedMode);
    statusElement.textContent = `Colour mode: ${selectedMode}`;
});

connectRosButton.addEventListener("click", () =>
{
    if (!appConfig)
    {
        statusElement.textContent = "Config is not loaded yet";
        return;
    }

    statusElement.textContent = "Connecting to ROS...";

    connectRosBridge(
    {
        url: rosbridgeUrlInput.value.trim(),
        frameTopic: appConfig.frame_topic || "/srl_magnetic_hand/frame",
        metadataTopic: appConfig.metadata_topic || "/srl_magnetic_hand/metadata",
        frameThrottleMs: Number(appConfig.frame_throttle_ms || 16),
        onFrame: handleRosFrame,
        onMetadata: handleRosMetadata,
        onStatus: (newStatus) =>
        {
            statusElement.textContent = newStatus;
        },
        onError: (message) =>
        {
            console.error(message);
            statusElement.textContent = message;
        }
    });
});

calibrateButton.addEventListener("click", () =>
{
    const result = captureCalibrationFromFrame();

    if (!result.ok)
    {
        calibrationElement.textContent = result.message;
        return;
    }

    calibrationElement.textContent = result.message;
    lastMessageElement.textContent = JSON.stringify(result.calibration, null, 2);
});

resetViewButton.addEventListener("click", () =>
{
    resetCamera();
});

clearLogButton.addEventListener("click", () =>
{
    lastMessageElement.textContent = "";
    console.clear();
});

startMappingButton.addEventListener("click", () =>
{
    startMappingRoutine();
});

stopMappingButton.addEventListener("click", () =>
{
    stopMappingRoutine("Mapping stopped.");
});

downloadMappedConfigButton.addEventListener("click", () =>
{
    downloadMappedConfig();
});

if (sidebarToggleButton)
{
    sidebarToggleButton.addEventListener("click", () =>
    {
        document.body.classList.toggle("sidebar-open");
    });
}

/**
 * Handle one MagneticHandFrame message from rosbridge.
 *
 * @param {object} msg MagneticHandFrame ROS message represented as JSON.
*/
function handleRosFrame(msg)
{
    receivedFrameCount++;
    framesSinceRateUpdate++;

    applyMagneticHandFrame(msg);
    updateFrameRateReadout(msg);

    if ((receivedFrameCount % 25) === 0)
    {
        const sampleCount = Array.isArray(msg.samples) ? msg.samples.length : 0;
        const serialHz = Number(msg.serial_frequency_hz || 0).toFixed(1);

        lastMessageElement.textContent =
            `frame=${msg.frame_counter} samples=${sampleCount} serial=${serialHz} Hz`;
    }
}

/**
 * Handle one metadata message from rosbridge.
 *
 * @param {object} msg SensorMetadataArray ROS message represented as JSON.
*/
function handleRosMetadata(msg)
{
    const count = Array.isArray(msg.sensors) ? msg.sensors.length : 0;
    console.log(`Received ROS metadata for ${count} sensors`, msg);
}

/**
 * Update the frame-rate readout in the sidebar.
 *
 * @param {object} msg MagneticHandFrame ROS message represented as JSON.
*/
function updateFrameRateReadout(msg)
{
    const now = performance.now();
    const elapsedMs = now - lastRateUpdateTime;

    if (elapsedMs < 500)
    {
        return;
    }

    const uiRateHz = (framesSinceRateUpdate * 1000) / elapsedMs;
    const serialHz = Number(msg.serial_frequency_hz || 0);

    frameRateElement.textContent =
        `ROS UI: ${uiRateHz.toFixed(1)} Hz | Serial: ${serialHz.toFixed(1)} Hz`;

    framesSinceRateUpdate = 0;
    lastRateUpdateTime = now;
}

/**
 * Apply debug-mode UI and viewer behaviour from config.
*/
function configureDebugMode()
{
    debugMode = Boolean(appConfig?.debug_mode ?? appConfig?.debugMode ?? false);
    setDebugMode(debugMode);

    document.body.classList.toggle("debug-mode", debugMode);
    document.body.classList.toggle("sidebar-open", debugMode);

    if (mappingSectionElement)
    {
        mappingSectionElement.hidden = !debugMode;
    }

    if (!debugMode)
    {
        stopMappingRoutine("Mapping disabled because debug_mode is false.");
    }
}

/**
 * Populate the mapping profile dropdown from the config profiles.
*/
function populateProfileSelect()
{
    if (!mappingProfileSelect || !appConfig?.profiles)
    {
        return;
    }

    mappingProfileSelect.innerHTML = "";

    Object.keys(appConfig.profiles).forEach((profileName) =>
    {
        const option = document.createElement("option");
        option.value = profileName;
        option.textContent = profileName;
        mappingProfileSelect.appendChild(option);
    });

    mappingProfileSelect.value = appConfig.active_profile || Object.keys(appConfig.profiles)[0] || "";
}

/**
 * Start the guided mapping routine for the selected profile.
*/
function startMappingRoutine()
{
    if (!debugMode)
    {
        return;
    }

    if (!appConfig)
    {
        setMappingText("Config not loaded", "Load the config before starting mapping.");
        return;
    }

    normaliseConfigInPlace(appConfig);

    const profileName = mappingProfileSelect?.value || appConfig.active_profile;
    const profile = appConfig.profiles?.[profileName];

    if (!profile || !Array.isArray(profile.slot_body_map) || profile.slot_body_map.length === 0)
    {
        setMappingText("No slots", `Profile '${profileName}' has no slot_body_map entries.`);
        return;
    }

    appConfig.active_profile = profileName;
    loadUiConfig(appConfig);
    colourModeSelect.value = getColourMode();

    mappingState = buildMappingState(profileName, profile.slot_body_map);
    setModelClickHandler(handleMappingClick);
    showCurrentMappingPrompt();
}

/**
 * Stop mapping and return clicks to the normal debug behaviour.
 *
 * @param {string} message Message to show in the mapping box.
*/
function stopMappingRoutine(message = "Mapping stopped.")
{
    mappingState = null;
    setModelClickHandler(null);
    setMappingText("Idle", message);
}

/**
 * Build grouped mapping state. The mapper completes all slots in a pad, then
 * asks for one shared pad centre.
 *
 * @param {string} profileName Active profile name.
 * @param {Array<object>} entries Slot body map entries.
 * @returns {object} Mapping state object.
*/
function buildMappingState(profileName, entries)
{
    const pads = [];
    const padByKey = new Map();

    entries
        .slice()
        .sort((a, b) => Number(a.slot) - Number(b.slot))
        .forEach((entry) =>
        {
            const key = `${entry.component || ""}::${entry.pad || ""}`;

            if (!padByKey.has(key))
            {
                const pad =
                {
                    key: key,
                    component: entry.component || "",
                    pad: entry.pad || "",
                    entries: []
                };

                padByKey.set(key, pad);
                pads.push(pad);
            }

            padByKey.get(key).entries.push(entry);
        });

    return {
        profileName: profileName,
        pads: pads,
        padIndex: 0,
        entryIndex: 0,
        stage: "body",
        pendingBodyId: "",
        pendingSensorLocation: null,
        pendingPadCentre: null
    };
}

/**
 * Handle one model click while the mapper is active.
 *
 * Left click selects a value. Right click confirms and moves to the next step.
 *
 * @param {object} selection Picked mesh and point information.
 * @param {object} intersection Three.js raycast intersection.
 * @param {number} button Mouse button number.
 * @returns {boolean} True because mapping consumes the click.
*/
function handleMappingClick(selection, intersection, button)
{
    if (!mappingState)
    {
        return false;
    }

    if (button === 0)
    {
        handleMappingLeftClick(selection, intersection);
        return true;
    }

    if (button === 2)
    {
        handleMappingRightClick();
        return true;
    }

    return true;
}

/**
 * Store the current selection for the current mapping step.
 *
 * @param {object} selection Picked mesh and point information.
 * @param {object} intersection Three.js raycast intersection.
*/
function handleMappingLeftClick(selection, intersection)
{
    if (!mappingState)
    {
        return;
    }

    if (!selection || !intersection)
    {
        showCurrentMappingPrompt("Click on the model for this step, or right-click to confirm the current selection.");
        return;
    }

    if (mappingState.stage === "body")
    {
        mappingState.pendingBodyId = selection.selected_name || selection.mesh_name || "";
        flashMappedBody(intersection);
        showCurrentMappingPrompt(`Selected body: ${mappingState.pendingBodyId}\nRight-click to confirm, or left-click another body to change it.`);
        return;
    }

    const pickedPoint = makePoint(selection.click_x, selection.click_y, selection.click_z);

    if (mappingState.stage === "sensor")
    {
        mappingState.pendingSensorLocation = pickedPoint;
        flashMappedPoint(intersection);
        showCurrentMappingPrompt(`Selected sensor location: ${formatPoint(pickedPoint)}\nRight-click to confirm, or left-click another point to change it.`);
        return;
    }

    if (mappingState.stage === "padCentre")
    {
        mappingState.pendingPadCentre = pickedPoint;
        flashMappedPoint(intersection);
        showCurrentMappingPrompt(`Selected pad centre: ${formatPoint(pickedPoint)}\nRight-click to confirm, or left-click another point to change it.`);
    }
}

/**
 * Confirm the current mapper step and advance.
*/
function handleMappingRightClick()
{
    if (!mappingState)
    {
        return;
    }

    const currentEntry = getCurrentMappingEntry();
    const currentPad = getCurrentMappingPad();

    if (mappingState.stage === "body")
    {
        if (!mappingState.pendingBodyId)
        {
            showCurrentMappingPrompt("Left-click the CAD body first, then right-click to confirm.");
            return;
        }

        currentEntry.body_id = mappingState.pendingBodyId;
        mappingState.pendingBodyId = "";
        mappingState.stage = "sensor";
        showCurrentMappingPrompt("Body confirmed. Now left-click the sensor location, then right-click to confirm.");
        return;
    }

    if (mappingState.stage === "sensor")
    {
        if (!mappingState.pendingSensorLocation)
        {
            showCurrentMappingPrompt("Left-click the sensor location first, then right-click to confirm.");
            return;
        }

        currentEntry.gradient_hotspot_world = mappingState.pendingSensorLocation;
        mappingState.pendingSensorLocation = null;
        mappingState.entryIndex++;

        if (mappingState.entryIndex >= currentPad.entries.length)
        {
            mappingState.stage = "padCentre";
            showCurrentMappingPrompt("All sensors in this pad are mapped. Now left-click the pad centre, then right-click to copy it to every slot in this pad.");
            return;
        }

        mappingState.stage = "body";
        showCurrentMappingPrompt("Sensor location confirmed. Moving to the next slot.");
        return;
    }

    if (mappingState.stage === "padCentre")
    {
        if (!mappingState.pendingPadCentre)
        {
            showCurrentMappingPrompt("Left-click the pad centre first, then right-click to confirm.");
            return;
        }

        currentPad.entries.forEach((entry) =>
        {
            entry.hybrid_hotspot_world = makePoint(
                mappingState.pendingPadCentre.x,
                mappingState.pendingPadCentre.y,
                mappingState.pendingPadCentre.z
            );
        });

        mappingState.pendingPadCentre = null;
        mappingState.padIndex++;
        mappingState.entryIndex = 0;
        mappingState.stage = "body";

        if (mappingState.padIndex >= mappingState.pads.length)
        {
            setModelClickHandler(null);
            const finishedProfile = mappingState.profileName;
            mappingState = null;
            setMappingText("Complete", `Mapping complete for '${finishedProfile}'.\nClick Download Mapped Config to save the updated ui_config.json.`);
            loadUiConfig(appConfig);
            colourModeSelect.value = getColourMode();
            return;
        }

        showCurrentMappingPrompt("Pad centre confirmed. Moving to the next pad.");
    }
}

/**
 * Show the mapper status for the current slot or pad-centre step.
 *
 * @param {string} extra Optional confirmation/help text.
*/
function showCurrentMappingPrompt(extra = "")
{
    if (!mappingState)
    {
        return;
    }

    const pad = getCurrentMappingPad();
    const entry = getCurrentMappingEntry();
    const padProgress = `${mappingState.padIndex + 1}/${mappingState.pads.length}`;

    if (mappingState.stage === "padCentre")
    {
        setMappingText(
            `Pad centre: ${pad.component} ${pad.pad}`,
            [
                `Profile: ${mappingState.profileName}`,
                `Pad: ${pad.component} / ${pad.pad} (${padProgress})`,
                "Step: click pad centre",
                "UI name: pad centre",
                "Left click: choose pad centre",
                "Right click: confirm and copy to every slot in this pad",
                extra
            ].filter(Boolean).join("\n")
        );
        return;
    }

    setMappingText(
        `Slot ${entry.slot}: ${entry.component} ${entry.pad}`,
        [
            `Profile: ${mappingState.profileName}`,
            `Pad: ${pad.component} / ${pad.pad} (${padProgress})`,
            `Slot in pad: ${mappingState.entryIndex + 1}/${pad.entries.length}`,
            `Slot: ${entry.slot}`,
            `Component: ${entry.component}`,
            `Pad: ${entry.pad}`,
            `I2C: mux ${entry.i2c_mux}, channel ${entry.i2c_channel}, address ${entry.i2c_address}`,
            `Current body_id: ${entry.body_id || "<blank>"}`,
            mappingState.stage === "body" ? "Step: click CAD body" : "Step: click sensor location",
            mappingState.stage === "body" ? "Left click: choose body" : "Left click: choose sensor location",
            "Right click: confirm and move on",
            extra
        ].filter(Boolean).join("\n")
    );
}

/**
 * Return the currently active mapping pad.
 *
 * @returns {object|null} Pad state.
*/
function getCurrentMappingPad()
{
    return mappingState?.pads?.[mappingState.padIndex] || null;
}

/**
 * Return the currently active slot entry.
 *
 * @returns {object|null} Slot entry.
*/
function getCurrentMappingEntry()
{
    const pad = getCurrentMappingPad();
    return pad?.entries?.[mappingState.entryIndex] || null;
}

/**
 * Set mapping sidebar text.
 *
 * @param {string} status Short status text.
 * @param {string} prompt Detailed prompt text.
*/
function setMappingText(status, prompt)
{
    if (mappingStatusElement)
    {
        mappingStatusElement.textContent = status;
    }

    if (mappingPromptElement)
    {
        mappingPromptElement.textContent = prompt || "";
    }
}

/**
 * Download the current in-memory config as JSON.
*/
function downloadMappedConfig()
{
    if (!appConfig)
    {
        setMappingText("Config not loaded", "No config is available to download yet.");
        return;
    }

    normaliseConfigInPlace(appConfig);

    const json = JSON.stringify(appConfig, null, 4);
    const blob = new Blob([json], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "ui_config.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setMappingText("Downloaded", "Downloaded mapped ui_config.json.");
}

/**
 * Normalise config so every slot has explicit x/y/z hotspot keys and the
 * alternate hand contains the same 51 sensor entries as the main hand.
 *
 * @param {object} config UI config object.
*/
function normaliseConfigInPlace(config)
{
    if (!config || !config.profiles)
    {
        return;
    }

    if (config.debug_mode === undefined && config.debugMode === undefined)
    {
        config.debug_mode = true;
    }

    const mainProfile = config.profiles.main_hand || Object.values(config.profiles)[0];
    const alternateProfile = config.profiles.alternate_hand;

    if (alternateProfile && mainProfile && Array.isArray(mainProfile.slot_body_map))
    {
        if (!Array.isArray(alternateProfile.slot_body_map) || alternateProfile.slot_body_map.length === 0)
        {
            alternateProfile.slot_body_map = mainProfile.slot_body_map.map((entry) =>
            {
                return cloneSlotForAlternateProfile(entry);
            });
        }
    }

    Object.values(config.profiles).forEach((profile) =>
    {
        if (!Array.isArray(profile.slot_body_map))
        {
            profile.slot_body_map = [];
        }

        profile.camera_start_view = normaliseCameraStartView(profile.camera_start_view || profile.cameraStartView || profile.camera, profile);

        profile.slot_body_map.forEach((entry) =>
        {
            entry.gradient_hotspot_world = normaliseHotspot(entry.gradient_hotspot_world || entry.gradientHotspotWorld);
            entry.hybrid_hotspot_world = normaliseHotspot(entry.hybrid_hotspot_world || entry.hybridHotspotWorld);
        });
    });
}

/**
 * Ensure profile camera config exists and has explicit flat keys.
 *
 * @param {object|null} value Existing camera config.
 * @param {object} profile Profile being normalised.
 * @returns {object} Normalised camera_start_view object.
*/
function normaliseCameraStartView(value, profile)
{
    const defaultMainView = {
        camera_x: 8.53,
        camera_y: 270.46,
        camera_z: -84.08,
        target_x: 8.53,
        target_y: 0.0,
        target_z: -84.08
    };

    const defaultAlternateView = {
        camera_x: 22.15957395302073,
        camera_y: -38.695039902170016,
        camera_z: -263.508728563301,
        target_x: 22.159574172680824,
        target_y: -38.69521933870093,
        target_z: -84.08003871700765
    };

    const profileNameHint = String(profile?.display_name || profile?.model?.obj_path || "").toLowerCase();
    const fallback = profileNameHint.includes("alternate") ? defaultAlternateView : defaultMainView;
    const source = value && typeof value === "object" ? value : {};

    return {
        camera_x: readCameraNumber(source, "camera", "x", fallback.camera_x),
        camera_y: readCameraNumber(source, "camera", "y", fallback.camera_y),
        camera_z: readCameraNumber(source, "camera", "z", fallback.camera_z),
        target_x: readCameraNumber(source, "target", "x", fallback.target_x),
        target_y: readCameraNumber(source, "target", "y", fallback.target_y),
        target_z: readCameraNumber(source, "target", "z", fallback.target_z)
    };
}

/**
 * Read a camera number from flat or nested config.
*/
function readCameraNumber(source, prefix, axis, fallback)
{
    const flat = source?.[`${prefix}_${axis}`];

    if (Number.isFinite(Number(flat)))
    {
        return Number(flat);
    }

    const nested = source?.[prefix] || source?.[`${prefix}_position`] || source?.[`${prefix}Position`] || null;
    const nestedValue = nested?.[axis];

    if (Number.isFinite(Number(nestedValue)))
    {
        return Number(nestedValue);
    }

    return fallback;
}

/**
 * Clone one main-hand slot for the alternate profile.
 *
 * @param {object} entry Main profile slot map entry.
 * @returns {object} Alternate profile slot map entry.
*/
function cloneSlotForAlternateProfile(entry)
{
    return {
        slot: entry.slot,
        component: entry.component || "",
        pad: entry.pad || "",
        i2c_mux: entry.i2c_mux || "",
        i2c_channel: entry.i2c_channel,
        i2c_address: entry.i2c_address || "",
        body_id: "",
        red_sensitivity: entry.red_sensitivity,
        gradient_sensitivity: entry.gradient_sensitivity,
        hybrid_sensitivity: entry.hybrid_sensitivity,
        gradient_hotspot_world: makeEmptyHotspot(),
        hybrid_hotspot_world: makeEmptyHotspot()
    };
}

/**
 * Ensure a hotspot has x/y/z keys. Invalid values become null.
 *
 * @param {object|null} value Hotspot object.
 * @returns {object} Normalised hotspot object.
*/
function normaliseHotspot(value)
{
    if (!value || typeof value !== "object")
    {
        return makeEmptyHotspot();
    }

    return {
        x: normaliseNumberOrNull(value.x),
        y: normaliseNumberOrNull(value.y),
        z: normaliseNumberOrNull(value.z)
    };
}

/**
 * Return a clean empty hotspot object.
 *
 * @returns {object} Empty hotspot with explicit keys.
*/
function makeEmptyHotspot()
{
    return { ...EMPTY_HOTSPOT };
}

/**
 * Create a numeric XYZ point.
 *
 * @param {number} x X coordinate.
 * @param {number} y Y coordinate.
 * @param {number} z Z coordinate.
 * @returns {object} XYZ point.
*/
function makePoint(x, y, z)
{
    return {
        x: Number(x),
        y: Number(y),
        z: Number(z)
    };
}

/**
 * Convert a value to a number or null.
 *
 * @param {number|string|null} value Input value.
 * @returns {number|null} Number or null.
*/
function normaliseNumberOrNull(value)
{
    if (value === null || value === undefined || value === "")
    {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Format a point for the prompt box.
 *
 * @param {object} point XYZ point.
 * @returns {string} Formatted point.
*/
function formatPoint(point)
{
    if (!point)
    {
        return "<none>";
    }

    return `x=${point.x.toFixed(3)}, y=${point.y.toFixed(3)}, z=${point.z.toFixed(3)}`;
}
