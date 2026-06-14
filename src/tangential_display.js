const DEFAULT_TANGENTIAL_CONFIG =
{
    enabled: true,
    svg_path: "./assets/Dots_handFDM.svg",
    max_dot_offset: 22.0,
    influence_radius: 28.0,
    influence_strength: 0.85,
    response: 0.32,
    deadband: 0.03,
    default_sensitivity: 1200.0,
    show_when_no_frame: true,
    show_dot_ids: true,
    sensor_dot_radius: 7.4,
    passive_dot_radius: 7.4,
    render_hz: 30.0,
    max_device_pixel_ratio: 1.5,
    fixed_dot_colour: "#1E90FF",
    movable_dot_colour: "#00FF11",
    marked32_dot_colour: "#F7FF00",
    mapped_dot_colour: "#FF0000",
    polygon_stroke_colour: "rgba(255,255,255,0.36)",
    polygon_fill_colour: "rgba(255,255,255,0.015)",
    label_colour: "rgba(255,255,255,0.98)",
    label_background_colour: "rgba(0,0,0,0.72)",
    label_font_size: 28.0,
    dot_cluster_distance: 40.0,
    minimum_pad_influence: 0.12,
    spring_falloff_power: 2.0
};

const COLOUR_SENSOR = "#FF0000";
const COLOUR_MOVABLE = "#00FF11";
const COLOUR_FIXED = "#1E90FF";
const COLOUR_MARKED_MOVABLE = "#F7FF00";

let panelElement = null;
let svgContainerElement = null;
let statusElement = null;

let activeConfig = {...DEFAULT_TANGENTIAL_CONFIG};
let activeProfile = null;
let canvasElement = null;
let canvasContext = null;
let resizeObserver = null;
let sourceSvgHolder = null;

let viewBox = {x: 0, y: 0, width: 322.85, height: 347.11};
let sensorDots = [];
let movableDots = [];
let marked32Dots = [];
let fixedDots = [];
let padPolygons = [];
let motionGroups = [];
let lastMappedSlotCount = 0;
let latestActiveSources = [];
let animationFrameHandle = null;
let lastRenderTimeMs = 0;
let needsRender = false;
let slotConfigBySlot = [];
let activeSourceByDotIndex = [];
let padPolygonPath = null;

/**
 * Initialise the tangential-force display DOM hooks.
 *
 * @param {object} elements DOM element references.
 */
export function initTangentialDisplay(elements)
{
    panelElement = elements?.panelElement || null;
    svgContainerElement = elements?.svgContainerElement || null;
    statusElement = elements?.statusElement || null;
}

/**
 * Load the fixed SVG dot map and prepare the canvas renderer.
 *
 * The SVG is now treated as the source of truth:
 *   red dots  = sensor dots that can be mapped by tangential_dot_index
 *   green dots = normal movable follower dots
 *   yellow dots = treated as normal movable follower dots for compatibility
 *   blue dots = fixed boundary dots
 *
 * @param {object} appConfig Full ui_config.json object.
 */
export async function loadTangentialDisplay(appConfig)
{
    if (!panelElement || !svgContainerElement)
    {
        return;
    }

    const resolvedProfile = resolveActiveProfile(appConfig);
    activeProfile = resolvedProfile.profile;

    const profileDisplayConfig = activeProfile?.tangential_display || activeProfile?.tangentialDisplay || {};
    const globalDisplayConfig = appConfig?.tangential_display || appConfig?.tangentialDisplay || {};

    activeConfig =
    {
        ...DEFAULT_TANGENTIAL_CONFIG,
        ...globalDisplayConfig,
        ...profileDisplayConfig
    };

    activeConfig.debug_mode = Boolean(appConfig?.debug_mode ?? appConfig?.debugMode ?? false);
    activeConfig.enabled = Boolean(activeConfig.enabled);
    panelElement.hidden = !activeConfig.enabled;

    clearDisplayState();

    if (!activeConfig.enabled)
    {
        return;
    }

    const svgPath = String(activeConfig.svg_path || activeConfig.svgPath || DEFAULT_TANGENTIAL_CONFIG.svg_path);

    try
    {
        const response = await fetch(svgPath);

        if (!response.ok)
        {
            throw new Error(`HTTP ${response.status}`);
        }

        const svgText = await response.text();

        buildCanvasDisplayFromSvg(svgText);
        buildMappedDotIndex();
        buildSlotConfigCache();
        requestRender(true);
        updateStatus(activeConfig.debug_mode ? `${sensorDots.length} sensors | ${movableDots.length} movable | ${fixedDots.length} fixed | ${motionGroups.length} groups` : "");
    }
    catch (err)
    {
        console.error("Could not load tangential SVG:", err);
        clearDisplayState();
        updateStatus(`Tangential display failed: ${err.message}`);
    }
}

/**
 * Update the tangential-force display from one ROS magnetic hand frame.
 *
 * @param {object} frame MagneticHandFrame message.
 * @param {Function} getBaseline Callback returning {x,y,z} for a slot.
 */
export function updateTangentialDisplay(frame, getBaseline)
{
    if (!activeConfig.enabled || !activeProfile || !Array.isArray(frame?.samples) || sensorDots.length === 0)
    {
        return;
    }

    if (!Array.isArray(slotConfigBySlot) || slotConfigBySlot.length === 0)
    {
        buildSlotConfigCache();
    }

    if (!Array.isArray(activeSourceByDotIndex) || activeSourceByDotIndex.length !== sensorDots.length)
    {
        activeSourceByDotIndex = new Array(sensorDots.length).fill(null);
    }
    else
    {
        activeSourceByDotIndex.fill(null);
    }

    const activeSources = [];
    const maxDotOffset = getPositiveNumber(activeConfig.max_dot_offset, DEFAULT_TANGENTIAL_CONFIG.max_dot_offset);
    const defaultSensitivity = getPositiveNumber(activeConfig.default_sensitivity, DEFAULT_TANGENTIAL_CONFIG.default_sensitivity);
    const deadband = activeConfig.deadband;

    frame.samples.forEach((sample) =>
    {
        const slot = Number(sample.slot);
        const entry = Number.isInteger(slot) ? slotConfigBySlot[slot] : null;

        if (!entry)
        {
            return;
        }

        const dotIndex = entry.__tangentialDotIndex;
        const sensorDot = sensorDots[dotIndex];

        if (!sensorDot)
        {
            return;
        }

        const rawX = Number(sample.raw_x);
        const rawY = Number(sample.raw_y);

        if (!Number.isFinite(rawX) || !Number.isFinite(rawY))
        {
            return;
        }

        const baseline = typeof getBaseline === "function" ? getBaseline(slot) : {x: 0.0, y: 0.0, z: 0.0};
        const dxField = (rawX - Number(baseline.x || 0.0)) * entry.__tangentialXSign;
        const dyField = (rawY - Number(baseline.y || 0.0)) * entry.__tangentialYSign;
        const magnitude = Math.sqrt((dxField * dxField) + (dyField * dyField));
        const sensitivity = entry.__tangentialSensitivity || defaultSensitivity;
        const normalisedMagnitude = applyDeadband(magnitude / Math.max(sensitivity, 1e-9), deadband);

        if (normalisedMagnitude <= 0.0001)
        {
            return;
        }

        const headingRad = Math.atan2(dyField, dxField) + entry.__tangentialHeadingOffsetRad;
        const offsetScale = normalisedMagnitude * maxDotOffset;
        const source =
        {
            dotIndex: dotIndex,
            padIndex: sensorDot.padIndex,
            dx: Math.cos(headingRad) * offsetScale,
            dy: Math.sin(headingRad) * offsetScale,
            strength: normalisedMagnitude
        };

        activeSourceByDotIndex[dotIndex] = source;
        activeSources.push(source);
    });

    latestActiveSources = activeSources;
    applySourceMotion(activeSources);
    requestRender(false);
    updateStatus(activeConfig.debug_mode ? `${activeSources.length} active | ${lastMappedSlotCount} mapped | blue fixed` : "");
}

/**
 * Reset dot positions back to their original SVG coordinates.
 */
export function resetTangentialDisplay()
{
    latestActiveSources = [];

    sensorDots.forEach((dot) => resetMovingDot(dot));
    movableDots.forEach((dot) => resetMovingDot(dot));
    marked32Dots.forEach((dot) => resetMovingDot(dot));

    requestRender(true);
}

function clearDisplayState()
{
    cancelScheduledRender();

    if (resizeObserver)
    {
        resizeObserver.disconnect();
        resizeObserver = null;
    }

    if (svgContainerElement)
    {
        svgContainerElement.innerHTML = "";
    }

    canvasElement = null;
    canvasContext = null;
    sourceSvgHolder = null;
    sensorDots = [];
    movableDots = [];
    marked32Dots = [];
    fixedDots = [];
    padPolygons = [];
    motionGroups = [];
    lastMappedSlotCount = 0;
    latestActiveSources = [];
    slotConfigBySlot = [];
    activeSourceByDotIndex = [];
    padPolygonPath = null;
    lastRenderTimeMs = 0;
    needsRender = false;
}

function buildCanvasDisplayFromSvg(svgText)
{
    svgContainerElement.innerHTML = "";

    sourceSvgHolder = document.createElement("div");
    sourceSvgHolder.style.position = "absolute";
    sourceSvgHolder.style.width = "0";
    sourceSvgHolder.style.height = "0";
    sourceSvgHolder.style.overflow = "hidden";
    sourceSvgHolder.style.opacity = "0";
    sourceSvgHolder.style.pointerEvents = "none";
    sourceSvgHolder.innerHTML = svgText;
    svgContainerElement.appendChild(sourceSvgHolder);

    const svgElement = sourceSvgHolder.querySelector("svg");

    if (!svgElement)
    {
        throw new Error("SVG file did not contain an <svg> element");
    }

    viewBox = readSvgViewBox(svgElement);
    padPolygons = collectPadPolygons(svgElement);

    const dots = collectSvgDots(svgElement);

    sensorDots = dots.filter((dot) => dot.kind === "sensor");
    movableDots = dots.filter((dot) => dot.kind === "movable");
    marked32Dots = [];
    fixedDots = dots.filter((dot) => dot.kind === "fixed");

    sensorDots.forEach((dot, index) =>
    {
        dot.index = index;
    });

    assignMotionGroupsFromDotClusters();
    buildMotionLinks();
    buildPadPolygonPath();

    if (sensorDots.length === 0)
    {
        throw new Error("No red sensor dots were found in SVG");
    }

    canvasElement = document.createElement("canvas");
    canvasElement.className = "tangential-canvas";
    canvasElement.setAttribute("aria-label", "Tangential force display");
    svgContainerElement.appendChild(canvasElement);
    canvasContext = canvasElement.getContext("2d");

    ensureCanvasSize();

    resizeObserver = new ResizeObserver(() =>
    {
        ensureCanvasSize();
        requestRender(true);
    });

    resizeObserver.observe(svgContainerElement);
}

function readSvgViewBox(svgElement)
{
    const rawViewBox = String(svgElement.getAttribute("viewBox") || "").trim();
    const parts = rawViewBox.split(/[\s,]+/).map(Number).filter(Number.isFinite);

    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0)
    {
        return {x: parts[0], y: parts[1], width: parts[2], height: parts[3]};
    }

    const width = Number(svgElement.getAttribute("width"));
    const height = Number(svgElement.getAttribute("height"));

    return {
        x: 0,
        y: 0,
        width: Number.isFinite(width) && width > 0 ? width : 322.85,
        height: Number.isFinite(height) && height > 0 ? height : 347.11
    };
}

function collectSvgDots(svgElement)
{
    const dotElements = Array.from(svgElement.querySelectorAll("circle, path, ellipse"));
    const dots = [];

    dotElements.forEach((element) =>
    {
        const fill = normaliseColour(element.getAttribute("fill"));
        const kind = getDotKindFromFill(fill);

        if (!kind)
        {
            return;
        }

        const circle = extractDotCircle(element);

        if (!circle)
        {
            return;
        }

        dots.push(
        {
            kind: kind,
            index: -1,
            originalX: circle.x,
            originalY: circle.y,
            x: circle.x,
            y: circle.y,
            radius: circle.r,
            padIndex: -1,
            mapped: false,
            explicitGroupId: getExplicitGroupId(element)
        });
    });

    return dots;
}

function getDotKindFromFill(fill)
{
    if (fill === COLOUR_SENSOR)
    {
        return "sensor";
    }

    if (fill === COLOUR_MOVABLE)
    {
        return "movable";
    }

    if (fill === COLOUR_MARKED_MOVABLE)
    {
        return "movable";
    }

    if (fill === COLOUR_FIXED)
    {
        return "fixed";
    }

    return null;
}

function getExplicitGroupId(element)
{
    const groupId = element.getAttribute("data-force-group") ||
        element.getAttribute("data-motion-group") ||
        element.getAttribute("data-pad-group") ||
        element.getAttribute("data-tangential-group") ||
        "";

    return String(groupId).trim();
}

function extractDotCircle(element)
{
    const tagName = element.tagName.toLowerCase();

    if (tagName === "circle")
    {
        const x = Number(element.getAttribute("cx"));
        const y = Number(element.getAttribute("cy"));
        const r = Number(element.getAttribute("r"));

        if (Number.isFinite(x) && Number.isFinite(y))
        {
            return {x: x, y: y, r: Number.isFinite(r) && r > 0 ? r : 4.0};
        }
    }

    if (tagName === "ellipse")
    {
        const x = Number(element.getAttribute("cx"));
        const y = Number(element.getAttribute("cy"));
        const rx = Number(element.getAttribute("rx"));
        const ry = Number(element.getAttribute("ry"));

        if (Number.isFinite(x) && Number.isFinite(y))
        {
            return {x: x, y: y, r: Math.max(1.0, ((rx || 4.0) + (ry || 4.0)) * 0.5)};
        }
    }

    if (tagName === "path")
    {
        return extractCircleLikePath(element.getAttribute("d") || "");
    }

    return null;
}

function extractCircleLikePath(pathData)
{
    const values = String(pathData).match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) || [];

    if (values.length < 4)
    {
        return null;
    }

    const xs = [];
    const ys = [];

    for (let index = 0; index < values.length - 1; index += 2)
    {
        xs.push(values[index]);
        ys.push(values[index + 1]);
    }

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
        x: (minX + maxX) * 0.5,
        y: (minY + maxY) * 0.5,
        r: Math.max(1.0, ((maxX - minX) + (maxY - minY)) * 0.25)
    };
}

function collectPadPolygons(svgElement)
{
    const polygonElements = Array.from(svgElement.querySelectorAll("path, rect, polygon"));
    const polygons = [];

    polygonElements.forEach((element) =>
    {
        const fill = normaliseColour(element.getAttribute("fill"));
        const stroke = String(element.getAttribute("stroke") || "").trim().toLowerCase();

        if (fill || stroke !== "black")
        {
            return;
        }

        const tagName = element.tagName.toLowerCase();
        let points = [];

        if (tagName === "path")
        {
            points = parseSimplePathPolygon(element.getAttribute("d") || "");
        }
        else if (tagName === "rect")
        {
            points = rectToWorldPoints(svgElement, element);
        }
        else if (tagName === "polygon")
        {
            points = polygonToWorldPoints(svgElement, element);
        }

        if (points.length >= 3)
        {
            polygons.push({points: points});
        }
    });

    return polygons;
}

function parseSimplePathPolygon(pathData)
{
    const tokens = String(pathData).match(/[MLHVZ]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || [];
    const points = [];
    let index = 0;
    let command = null;
    let x = 0.0;
    let y = 0.0;

    while (index < tokens.length)
    {
        const token = tokens[index];

        if (/^[MLHVZ]$/.test(token))
        {
            command = token;
            index++;

            if (command === "Z")
            {
                continue;
            }
        }

        if (command === "M" || command === "L")
        {
            x = Number(tokens[index]);
            y = Number(tokens[index + 1]);
            index += 2;

            if (Number.isFinite(x) && Number.isFinite(y))
            {
                points.push({x: x, y: y});
            }

            if (command === "M")
            {
                command = "L";
            }
        }
        else if (command === "H")
        {
            x = Number(tokens[index]);
            index++;

            if (Number.isFinite(x) && Number.isFinite(y))
            {
                points.push({x: x, y: y});
            }
        }
        else if (command === "V")
        {
            y = Number(tokens[index]);
            index++;

            if (Number.isFinite(x) && Number.isFinite(y))
            {
                points.push({x: x, y: y});
            }
        }
        else
        {
            index++;
        }
    }

    if (points.length > 1)
    {
        const first = points[0];
        const last = points[points.length - 1];

        if (distance2D(first.x, first.y, last.x, last.y) < 1e-6)
        {
            points.pop();
        }
    }

    return points;
}

function rectToWorldPoints(svgElement, element)
{
    const x = Number(element.getAttribute("x"));
    const y = Number(element.getAttribute("y"));
    const width = Number(element.getAttribute("width"));
    const height = Number(element.getAttribute("height"));
    const matrix = getSvgTransformMatrix(svgElement, element);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || !matrix)
    {
        return [];
    }

    return [
        applyMatrixToPoint(matrix, x, y),
        applyMatrixToPoint(matrix, x + width, y),
        applyMatrixToPoint(matrix, x + width, y + height),
        applyMatrixToPoint(matrix, x, y + height)
    ];
}

function polygonToWorldPoints(svgElement, element)
{
    const rawPoints = String(element.getAttribute("points") || "").trim();
    const matrix = getSvgTransformMatrix(svgElement, element);

    if (!rawPoints || !matrix)
    {
        return [];
    }

    return rawPoints.split(/\s+/).map((pair) =>
    {
        const [x, y] = pair.split(",").map(Number);
        return applyMatrixToPoint(matrix, x, y);
    }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function initialisePadMotionInfo()
{
    padPolygons.forEach((pad) =>
    {
        const bounds = computePolygonBounds(pad.points);
        const width = Math.max(1.0, bounds.maxX - bounds.minX);
        const height = Math.max(1.0, bounds.maxY - bounds.minY);
        const diagonal = Math.sqrt((width * width) + (height * height));

        pad.bounds = bounds;

        // The master SVG dots are spaced around 25 SVG units apart.
        // A 24-unit influence radius meant most green dots were just outside
        // the active area, so only the red sensor dot moved. Use a pad-sized
        // minimum radius so the green interior behaves like an elastic sheet.
        pad.motionInfluenceRadius = Math.max(55.0, Math.min(180.0, diagonal * 0.55));
    });
}

function computePolygonBounds(points)
{
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);

    return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys)
    };
}

function buildMappedDotIndex()
{
    lastMappedSlotCount = 0;

    sensorDots.forEach((dot) =>
    {
        dot.mapped = false;
    });

    const entries = Array.isArray(activeProfile?.slot_body_map) ? activeProfile.slot_body_map : [];

    entries.forEach((entry) =>
    {
        const dotIndex = getOptionalInteger(entry.tangential_dot_index ?? entry.tangentialDotIndex ?? entry.force_dot_index ?? entry.forceDotIndex);
        const sensorDot = sensorDots[dotIndex];

        if (!sensorDot)
        {
            return;
        }

        sensorDot.mapped = true;
        lastMappedSlotCount++;
    });
}

function buildSlotConfigCache()
{
    slotConfigBySlot = [];

    const entries = Array.isArray(activeProfile?.slot_body_map) ? activeProfile.slot_body_map : [];
    const defaultSensitivity = getPositiveNumber(activeConfig.default_sensitivity, DEFAULT_TANGENTIAL_CONFIG.default_sensitivity);

    entries.forEach((entry) =>
    {
        const slot = Number(entry.slot);

        if (!Number.isInteger(slot) || slot < 0)
        {
            return;
        }

        const dotIndex = getOptionalInteger(entry.tangential_dot_index ?? entry.tangentialDotIndex ?? entry.force_dot_index ?? entry.forceDotIndex);

        if (!sensorDots[dotIndex])
        {
            return;
        }

        entry.__tangentialDotIndex = dotIndex;
        entry.__tangentialXSign = getSign(entry.tangential_x_sign ?? entry.tangentialXSign ?? 1);
        entry.__tangentialYSign = getSign(entry.tangential_y_sign ?? entry.tangentialYSign ?? 1);
        entry.__tangentialHeadingOffsetRad = degreesToRadians(getFiniteNumber(entry.tangential_heading_offset_deg ?? entry.tangentialHeadingOffsetDeg, 0.0));
        entry.__tangentialSensitivity = getPositiveNumber(entry.tangential_sensitivity ?? entry.tangentialSensitivity, defaultSensitivity);
        slotConfigBySlot[slot] = entry;
    });
}

function buildMotionLinks()
{
    const configuredInfluenceRadius = getPositiveNumber(activeConfig.influence_radius, DEFAULT_TANGENTIAL_CONFIG.influence_radius);
    const influenceStrength = getPositiveNumber(activeConfig.influence_strength, DEFAULT_TANGENTIAL_CONFIG.influence_strength);
    const minimumPadInfluence = clamp01(getFiniteNumber(activeConfig.minimum_pad_influence, DEFAULT_TANGENTIAL_CONFIG.minimum_pad_influence));
    const springFalloffPower = getPositiveNumber(activeConfig.spring_falloff_power, DEFAULT_TANGENTIAL_CONFIG.spring_falloff_power);

    const sensorsByPad = new Map();

    sensorDots.forEach((sensorDot) =>
    {
        if (!Number.isInteger(sensorDot.padIndex) || sensorDot.padIndex < 0)
        {
            return;
        }

        if (!sensorsByPad.has(sensorDot.padIndex))
        {
            sensorsByPad.set(sensorDot.padIndex, []);
        }

        sensorsByPad.get(sensorDot.padIndex).push(sensorDot);
    });

    movableDots.forEach((dot) =>
    {
        const localSensors = sensorsByPad.get(dot.padIndex) || [];
        const group = motionGroups[dot.padIndex];
        const effectiveInfluenceRadius = Math.max(configuredInfluenceRadius, group?.motionInfluenceRadius || 0.0, 1.0);

        dot.motionLinks = localSensors.map((sensorDot) =>
        {
            const distance = distance2D(dot.originalX, dot.originalY, sensorDot.originalX, sensorDot.originalY);
            const influence = Math.max(0.0, 1.0 - (distance / effectiveInfluenceRadius));
            const shapedInfluence = Math.pow(smooth01(influence), springFalloffPower);
            const elasticInfluence = minimumPadInfluence + ((1.0 - minimumPadInfluence) * shapedInfluence);

            return {
                dotIndex: sensorDot.index,
                weight: elasticInfluence * influenceStrength
            };
        }).filter((link) => link.weight > 0.0);
    });
}

function buildPadPolygonPath()
{
    if (typeof Path2D === "undefined")
    {
        padPolygonPath = null;
        return;
    }

    const path = new Path2D();

    padPolygons.forEach((pad) =>
    {
        if (!Array.isArray(pad.points) || pad.points.length < 3)
        {
            return;
        }

        pad.points.forEach((point, index) =>
        {
            if (index === 0)
            {
                path.moveTo(point.x, point.y);
            }
            else
            {
                path.lineTo(point.x, point.y);
            }
        });

        path.closePath();
    });

    padPolygonPath = path;
}

function applySourceMotion(activeSources)
{
    const response = clamp01(getPositiveNumber(activeConfig.response, DEFAULT_TANGENTIAL_CONFIG.response));
    const maxOffset = getPositiveNumber(activeConfig.max_dot_offset, DEFAULT_TANGENTIAL_CONFIG.max_dot_offset) * 1.2;
    const hasActiveSources = activeSources.length > 0;

    sensorDots.forEach((dot) =>
    {
        const source = activeSourceByDotIndex[dot.index];
        let targetX = dot.originalX;
        let targetY = dot.originalY;

        if (source)
        {
            targetX += source.dx;
            targetY += source.dy;
        }

        dot.x += (targetX - dot.x) * response;
        dot.y += (targetY - dot.y) * response;
    });

    movableDots.forEach((dot) =>
    {
        let targetX = dot.originalX;
        let targetY = dot.originalY;

        if (hasActiveSources && Array.isArray(dot.motionLinks) && dot.motionLinks.length > 0)
        {
            let sumDx = 0.0;
            let sumDy = 0.0;

            dot.motionLinks.forEach((link) =>
            {
                const source = activeSourceByDotIndex[link.dotIndex];

                if (!source)
                {
                    return;
                }

                sumDx += source.dx * link.weight;
                sumDy += source.dy * link.weight;
            });

            targetX += clampMagnitude(sumDx, maxOffset);
            targetY += clampMagnitude(sumDy, maxOffset);
        }

        dot.x += (targetX - dot.x) * response;
        dot.y += (targetY - dot.y) * response;
    });
}

function applyMarked32FollowerMotion(sourceByDotIndex, response, influenceStrength, minimumPadInfluence, maxOffset)
{
    const source32 = sourceByDotIndex.get(32);
    const sensor32 = sensorDots[32];

    if (!source32 || !sensor32)
    {
        marked32Dots.forEach((dot) =>
        {
            dot.x += (dot.originalX - dot.x) * response;
            dot.y += (dot.originalY - dot.y) * response;
        });

        return;
    }

    const yellowBounds = computeDotBounds(marked32Dots.length > 0 ? marked32Dots : [sensor32]);
    const width = Math.max(1.0, yellowBounds.maxX - yellowBounds.minX);
    const height = Math.max(1.0, yellowBounds.maxY - yellowBounds.minY);
    const forceRadius = Math.max(45.0, Math.sqrt((width * width) + (height * height)) * 0.95);

    marked32Dots.forEach((dot) =>
    {
        const distance = distance2D(dot.originalX, dot.originalY, sensor32.originalX, sensor32.originalY);
        const influence = Math.max(0.0, 1.0 - (distance / forceRadius));
        const elasticInfluence = minimumPadInfluence + ((1.0 - minimumPadInfluence) * smooth01(influence));
        const weight = elasticInfluence * influenceStrength;
        let targetX = dot.originalX;
        let targetY = dot.originalY;

        if (weight > 0.0)
        {
            targetX += clampMagnitude(source32.dx * weight, maxOffset);
            targetY += clampMagnitude(source32.dy * weight, maxOffset);
        }

        // Do not use automatic pad grouping here. The yellow-marked points are
        // explicitly intended to follow sensor dot 32, even when the SVG polygon
        // hit-test or cluster grouping is awkward.
        dot.x += (targetX - dot.x) * response;
        dot.y += (targetY - dot.y) * response;
    });
}

function resetMovingDot(dot)
{
    dot.x = dot.originalX;
    dot.y = dot.originalY;
}

function clampToPad(padIndex, originX, originY, targetX, targetY)
{
    const group = motionGroups[padIndex];
    const boundary = group?.boundaryPolygon || null;

    if (!boundary || boundary.length < 3)
    {
        return {x: targetX, y: targetY};
    }

    if (pointInPolygon(targetX, targetY, boundary))
    {
        return {x: targetX, y: targetY};
    }

    let low = 0.0;
    let high = 1.0;
    let bestX = originX;
    let bestY = originY;

    for (let step = 0; step < 16; step++)
    {
        const mid = (low + high) * 0.5;
        const testX = originX + ((targetX - originX) * mid);
        const testY = originY + ((targetY - originY) * mid);

        if (pointInPolygon(testX, testY, boundary))
        {
            bestX = testX;
            bestY = testY;
            low = mid;
        }
        else
        {
            high = mid;
        }
    }

    return {x: bestX, y: bestY};
}

function ensureCanvasSize()
{
    if (!canvasElement || !canvasContext || !svgContainerElement)
    {
        return;
    }

    const rect = svgContainerElement.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const maxDevicePixelRatio = getPositiveNumber(activeConfig.max_device_pixel_ratio ?? activeConfig.maxDevicePixelRatio, DEFAULT_TANGENTIAL_CONFIG.max_device_pixel_ratio);
    const dpr = Math.min(window.devicePixelRatio || 1, maxDevicePixelRatio);
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (canvasElement.width !== pixelWidth || canvasElement.height !== pixelHeight)
    {
        canvasElement.width = pixelWidth;
        canvasElement.height = pixelHeight;
        canvasElement.style.width = `${cssWidth}px`;
        canvasElement.style.height = `${cssHeight}px`;
    }

    const scale = Math.min(cssWidth / viewBox.width, cssHeight / viewBox.height);
    const offsetX = ((cssWidth - (viewBox.width * scale)) * 0.5) - (viewBox.x * scale);
    const offsetY = ((cssHeight - (viewBox.height * scale)) * 0.5) - (viewBox.y * scale);

    canvasContext.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * offsetY);
}

function requestRender(forceImmediate)
{
    needsRender = true;

    if (forceImmediate)
    {
        renderNow();
        return;
    }

    if (animationFrameHandle !== null)
    {
        return;
    }

    animationFrameHandle = requestAnimationFrame((timestampMs) =>
    {
        animationFrameHandle = null;
        const renderHz = getPositiveNumber(activeConfig.render_hz, DEFAULT_TANGENTIAL_CONFIG.render_hz);
        const minimumDeltaMs = 1000.0 / Math.max(renderHz, 1.0);

        if ((timestampMs - lastRenderTimeMs) >= minimumDeltaMs)
        {
            renderNow(timestampMs);
        }
        else
        {
            requestRender(false);
        }
    });
}

function cancelScheduledRender()
{
    if (animationFrameHandle !== null)
    {
        cancelAnimationFrame(animationFrameHandle);
        animationFrameHandle = null;
    }
}

function renderNow(timestampMs = performance.now())
{
    if (!canvasContext || !canvasElement || !needsRender)
    {
        return;
    }

    needsRender = false;
    lastRenderTimeMs = timestampMs;

    canvasContext.setTransform(1, 0, 0, 1, 0, 0);
    canvasContext.clearRect(0, 0, canvasElement.width, canvasElement.height);
    ensureCanvasSize();

    canvasContext.clearRect(viewBox.x, viewBox.y, viewBox.width, viewBox.height);
    drawPadPolygons();

    const nonSensorDotColour = Boolean(activeConfig.debug_mode)
        ? null
        : "#FFFFFF";

    drawDots(
        fixedDots,
        nonSensorDotColour || String(activeConfig.fixed_dot_colour || DEFAULT_TANGENTIAL_CONFIG.fixed_dot_colour)
    );

    drawDots(
        movableDots,
        nonSensorDotColour || String(activeConfig.movable_dot_colour || DEFAULT_TANGENTIAL_CONFIG.movable_dot_colour)
    );

    drawSensorDots();
}

function drawPadPolygons()
{
    canvasContext.save();
    canvasContext.lineWidth = 1.0;
    canvasContext.strokeStyle = String(activeConfig.polygon_stroke_colour || DEFAULT_TANGENTIAL_CONFIG.polygon_stroke_colour);
    canvasContext.fillStyle = String(activeConfig.polygon_fill_colour || DEFAULT_TANGENTIAL_CONFIG.polygon_fill_colour);

    if (padPolygonPath)
    {
        canvasContext.fill(padPolygonPath);
        canvasContext.stroke(padPolygonPath);
        canvasContext.restore();
        return;
    }

    padPolygons.forEach((pad) =>
    {
        canvasContext.beginPath();

        pad.points.forEach((point, index) =>
        {
            if (index === 0)
            {
                canvasContext.moveTo(point.x, point.y);
            }
            else
            {
                canvasContext.lineTo(point.x, point.y);
            }
        });

        canvasContext.closePath();
        canvasContext.fill();
        canvasContext.stroke();
    });

    canvasContext.restore();
}

function drawDots(dots, colour)
{
    if (!Array.isArray(dots) || dots.length === 0)
    {
        return;
    }

    canvasContext.save();
    canvasContext.fillStyle = colour;
    canvasContext.strokeStyle = "rgba(0,0,0,0.85)";
    canvasContext.lineWidth = 0.35;
    canvasContext.beginPath();

    dots.forEach((dot) =>
    {
        appendCircleToCurrentPath(dot.x, dot.y, dot.radius);
    });

    canvasContext.fill();
    canvasContext.stroke();
    canvasContext.restore();
}

function drawSensorDots()
{
    const showIds = Boolean(activeConfig.debug_mode) && Boolean(activeConfig.show_dot_ids ?? DEFAULT_TANGENTIAL_CONFIG.show_dot_ids);
    const labelFontSize = getPositiveNumber(activeConfig.label_font_size, DEFAULT_TANGENTIAL_CONFIG.label_font_size);

    canvasContext.save();
    canvasContext.fillStyle = String(activeConfig.mapped_dot_colour || DEFAULT_TANGENTIAL_CONFIG.mapped_dot_colour);
    canvasContext.strokeStyle = "rgba(0,0,0,0.95)";
    canvasContext.lineWidth = 0.8;
    canvasContext.beginPath();

    sensorDots.forEach((dot) =>
    {
        appendCircleToCurrentPath(dot.x, dot.y, dot.radius);
    });

    canvasContext.fill();
    canvasContext.stroke();

    if (!showIds)
    {
        canvasContext.restore();
        return;
    }

    canvasContext.textAlign = "left";
    canvasContext.textBaseline = "middle";
    canvasContext.font = `bold ${labelFontSize}px Arial, sans-serif`;

    sensorDots.forEach((dot) =>
    {
        const label = String(dot.index);
        const labelX = dot.x + dot.radius + 5.0;
        const labelY = dot.y;
        const metrics = canvasContext.measureText(label);
        const padX = 4.0;
        const padY = 3.0;
        const boxWidth = metrics.width + (padX * 2.0);
        const boxHeight = labelFontSize + (padY * 2.0);

        canvasContext.fillStyle = String(activeConfig.label_background_colour || DEFAULT_TANGENTIAL_CONFIG.label_background_colour);
        canvasContext.fillRect(labelX - padX, labelY - (boxHeight * 0.5), boxWidth, boxHeight);

        canvasContext.fillStyle = String(activeConfig.label_colour || DEFAULT_TANGENTIAL_CONFIG.label_colour);
        canvasContext.fillText(label, labelX, labelY);
    });

    canvasContext.restore();
}

function appendCircleToCurrentPath(x, y, radius)
{
    canvasContext.moveTo(x + Math.max(1.0, radius), y);
    canvasContext.arc(x, y, Math.max(1.0, radius), 0, Math.PI * 2.0);
}

function drawCircle(x, y, radius)
{
    canvasContext.beginPath();
    appendCircleToCurrentPath(x, y, radius);
    canvasContext.fill();
}


function assignMotionGroupsFromDotClusters()
{
    const allDots = [...sensorDots, ...movableDots, ...marked32Dots, ...fixedDots];
    const clusterDistance = getPositiveNumber(activeConfig.dot_cluster_distance, DEFAULT_TANGENTIAL_CONFIG.dot_cluster_distance);
    const parent = allDots.map((_, index) => index);

    function find(index)
    {
        while (parent[index] !== index)
        {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }

        return index;
    }

    function unite(a, b)
    {
        const rootA = find(a);
        const rootB = find(b);

        if (rootA !== rootB)
        {
            parent[rootB] = rootA;
        }
    }

    const explicitGroups = new Map();

    allDots.forEach((dot, index) =>
    {
        if (!dot.explicitGroupId)
        {
            return;
        }

        if (!explicitGroups.has(dot.explicitGroupId))
        {
            explicitGroups.set(dot.explicitGroupId, []);
        }

        explicitGroups.get(dot.explicitGroupId).push(index);
    });

    explicitGroups.forEach((indices) =>
    {
        for (let index = 1; index < indices.length; index++)
        {
            unite(indices[0], indices[index]);
        }
    });

    const grid = new Map();
    const cellSize = clusterDistance;

    allDots.forEach((dot, index) =>
    {
        const cellX = Math.floor(dot.originalX / cellSize);
        const cellY = Math.floor(dot.originalY / cellSize);

        for (let y = cellY - 1; y <= cellY + 1; y++)
        {
            for (let x = cellX - 1; x <= cellX + 1; x++)
            {
                const key = `${x}:${y}`;
                const candidates = grid.get(key) || [];

                candidates.forEach((candidateIndex) =>
                {
                    const candidate = allDots[candidateIndex];
                    const distance = distance2D(dot.originalX, dot.originalY, candidate.originalX, candidate.originalY);

                    if (distance <= clusterDistance)
                    {
                        unite(index, candidateIndex);
                    }
                });
            }
        }

        const ownKey = `${cellX}:${cellY}`;

        if (!grid.has(ownKey))
        {
            grid.set(ownKey, []);
        }

        grid.get(ownKey).push(index);
    });

    const groupsByRoot = new Map();

    allDots.forEach((dot, index) =>
    {
        const root = find(index);

        if (!groupsByRoot.has(root))
        {
            groupsByRoot.set(root, []);
        }

        groupsByRoot.get(root).push(dot);
    });

    motionGroups = Array.from(groupsByRoot.values())
        .filter((groupDots) => groupDots.some((dot) => dot.kind === "sensor"))
        .sort((a, b) => getDotGroupSortValue(a) - getDotGroupSortValue(b))
        .map((groupDots, groupIndex) => makeMotionGroup(groupDots, groupIndex));

    motionGroups.forEach((group, groupIndex) =>
    {
        group.dots.forEach((dot) =>
        {
            dot.padIndex = groupIndex;
        });
    });

    [...sensorDots, ...movableDots, ...marked32Dots, ...fixedDots].forEach((dot) =>
    {
        if (!Number.isInteger(dot.padIndex) || dot.padIndex < 0)
        {
            const nearestGroupIndex = findNearestMotionGroupIndex(dot);
            dot.padIndex = nearestGroupIndex >= 0
                ? nearestGroupIndex
                : findContainingPadIndex(dot.originalX, dot.originalY);
        }
    });
}

function findNearestMotionGroupIndex(dot)
{
    let bestGroupIndex = -1;
    let bestDistance = Infinity;

    motionGroups.forEach((group, groupIndex) =>
    {
        group.dots.forEach((groupDot) =>
        {
            if (groupDot.kind !== "sensor")
            {
                return;
            }

            const distance = distance2D(dot.originalX, dot.originalY, groupDot.originalX, groupDot.originalY);

            if (distance < bestDistance)
            {
                bestDistance = distance;
                bestGroupIndex = groupIndex;
            }
        });
    });

    return bestGroupIndex;
}

function getDotGroupSortValue(groupDots)
{
    const bounds = computeDotBounds(groupDots);
    return (bounds.minY * 100000.0) + bounds.minX;
}

function makeMotionGroup(groupDots, groupIndex)
{
    const fixedGroupDots = groupDots.filter((dot) => dot.kind === "fixed");
    const hullSourceDots = fixedGroupDots.length >= 3 ? fixedGroupDots : groupDots;
    const boundaryPolygon = convexHull(hullSourceDots.map((dot) => ({x: dot.originalX, y: dot.originalY})));
    const bounds = computeDotBounds(groupDots);
    const width = Math.max(1.0, bounds.maxX - bounds.minX);
    const height = Math.max(1.0, bounds.maxY - bounds.minY);
    const diagonal = Math.sqrt((width * width) + (height * height));

    return {
        index: groupIndex,
        dots: groupDots,
        bounds: bounds,
        boundaryPolygon: boundaryPolygon,
        motionInfluenceRadius: Math.max(55.0, Math.min(220.0, diagonal * 0.75))
    };
}

function computeDotBounds(dots)
{
    const xs = dots.map((dot) => dot.originalX);
    const ys = dots.map((dot) => dot.originalY);

    return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys)
    };
}

function convexHull(points)
{
    const uniquePoints = [];
    const seen = new Set();

    points.forEach((point) =>
    {
        const key = `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}`;

        if (!seen.has(key))
        {
            seen.add(key);
            uniquePoints.push(point);
        }
    });

    if (uniquePoints.length <= 3)
    {
        return uniquePoints;
    }

    uniquePoints.sort((a, b) => (a.x === b.x) ? (a.y - b.y) : (a.x - b.x));

    const lower = [];

    uniquePoints.forEach((point) =>
    {
        while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], point) <= 0.0)
        {
            lower.pop();
        }

        lower.push(point);
    });

    const upper = [];

    for (let index = uniquePoints.length - 1; index >= 0; index--)
    {
        const point = uniquePoints[index];

        while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], point) <= 0.0)
        {
            upper.pop();
        }

        upper.push(point);
    }

    lower.pop();
    upper.pop();

    return lower.concat(upper);
}

function crossProduct(origin, a, b)
{
    return ((a.x - origin.x) * (b.y - origin.y)) - ((a.y - origin.y) * (b.x - origin.x));
}

function findContainingPadIndex(x, y)
{
    return padPolygons.findIndex((pad) => pointInPolygon(x, y, pad.points));
}

function resolveActiveProfile(config)
{
    const profiles = config?.profiles || {};
    const activeProfileName = config?.active_profile || Object.keys(profiles)[0] || "";
    const profile = profiles[activeProfileName] || {};

    return {name: activeProfileName, profile: profile};
}

function updateStatus(message)
{
    if (statusElement)
    {
        statusElement.textContent = message;
    }
}

function normaliseColour(value)
{
    const colour = String(value || "").trim().toUpperCase();

    if (!colour || colour === "NONE")
    {
        return null;
    }

    return colour;
}

function getSvgTransformMatrix(svgElement, element)
{
    const consolidated = element.transform?.baseVal?.consolidate?.();

    if (consolidated?.matrix)
    {
        return consolidated.matrix;
    }

    if (svgElement?.createSVGMatrix)
    {
        return svgElement.createSVGMatrix();
    }

    return null;
}

function applyMatrixToPoint(matrix, x, y)
{
    return {
        x: (matrix.a * x) + (matrix.c * y) + matrix.e,
        y: (matrix.b * x) + (matrix.d * y) + matrix.f
    };
}

function pointInPolygon(x, y, polygon)
{
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++)
    {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;
        const intersects = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi) / Math.max(yj - yi, 1e-9)) + xi);

        if (intersects)
        {
            inside = !inside;
        }
    }

    return inside;
}

function distance2D(ax, ay, bx, by)
{
    const dx = ax - bx;
    const dy = ay - by;

    return Math.sqrt((dx * dx) + (dy * dy));
}

function clampMagnitude(value, maxMagnitude)
{
    const limit = Math.max(0.0, Number(maxMagnitude) || 0.0);

    if (Math.abs(value) <= limit)
    {
        return value;
    }

    return Math.sign(value) * limit;
}

function getOptionalInteger(value)
{
    if (value === null || value === undefined || value === "")
    {
        return null;
    }

    const number = Number(value);

    return Number.isInteger(number) ? number : null;
}

function getFiniteNumber(value, fallback)
{
    const number = Number(value);

    return Number.isFinite(number) ? number : fallback;
}

function getPositiveNumber(value, fallback)
{
    const number = Number(value);

    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getSign(value)
{
    const number = Number(value);

    return number < 0 ? -1 : 1;
}

function clamp01(value)
{
    return Math.min(1.0, Math.max(0.0, Number(value) || 0.0));
}

function smooth01(value)
{
    const t = clamp01(value);
    return t * t * (3.0 - (2.0 * t));
}

function applyDeadband(value, deadband)
{
    const clampedValue = clamp01(value);
    const clampedDeadband = clamp01(Number(deadband) || 0.0);

    if (clampedValue <= clampedDeadband)
    {
        return 0.0;
    }

    return clamp01((clampedValue - clampedDeadband) / Math.max(1.0 - clampedDeadband, 1e-9));
}

function degreesToRadians(degrees)
{
    return (Number(degrees) || 0.0) * Math.PI / 180.0;
}
