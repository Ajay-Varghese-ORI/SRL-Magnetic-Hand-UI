import { connectRosBridge } from "./rosbridge.js";
import {
    applyMagneticHandFrame,
    captureCalibrationFromFrame,
    getCalibrationSummary,
    initViewer,
    loadUiConfig,
    resetCamera
} from "./viewer.js";

const viewerElement = document.getElementById("viewer");
const connectRosButton = document.getElementById("connectRosButton");
const calibrateButton = document.getElementById("calibrateButton");
const resetViewButton = document.getElementById("resetViewButton");
const clearLogButton = document.getElementById("clearLogButton");
const rosbridgeUrlInput = document.getElementById("rosbridgeUrlInput");
const statusElement = document.getElementById("status");
const frameRateElement = document.getElementById("frameRate");
const calibrationElement = document.getElementById("calibrationStatus");
const lastMessageElement = document.getElementById("lastMessage");

let appConfig = null;
let receivedFrameCount = 0;
let lastRateUpdateTime = performance.now();
let framesSinceRateUpdate = 0;

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

        loadUiConfig(appConfig);

        rosbridgeUrlInput.value = appConfig.rosbridge_url || "ws://localhost:9090";
        calibrationElement.textContent = getCalibrationSummary();
        statusElement.textContent = "Ready";
    }
    catch (err)
    {
        console.error(err);
        statusElement.textContent = "Config load failed: " + err.message;
    }
}

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
