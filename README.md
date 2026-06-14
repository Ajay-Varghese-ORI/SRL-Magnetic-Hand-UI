# SRL Magnetic Hand UI

Electron and Three.js interface for visualising the SRL magnetic hand ROS 2 stream.

The UI connects to ROS 2 through `rosbridge_websocket` and subscribes to:

- `/srl_magnetic_hand/frame`
- `/srl_magnetic_hand/metadata`


## Main controls

- `Connect ROS`: connects to rosbridge and subscribes to the configured topics.
- `Calibrate Untouched`: records the current X, Y and Z readings as the baseline.
- `Reset View`: resets the camera to the active profile's configured start view.
- `Clear Log`: clears the message display.
- Colour mode selector: switches the 3D pressure display between red, gradient and hybrid modes.

Mouse controls:

- Left drag: orbit.
- Right drag: pan.
- Scroll wheel: zoom.

Debug controls:

- `L`: log the camera position.
- Left/right click on the model: inspect and map CAD bodies when debug tools are enabled.

## Configuration

The main configuration file is:

```text
config/ui_config.json
```

Top-level connection settings:

```json
{
    "rosbridge_url": "ws://localhost:9090",
    "frame_topic": "/srl_magnetic_hand/frame",
    "metadata_topic": "/srl_magnetic_hand/metadata",
    "frame_throttle_ms": 16,
    "active_profile": "main_hand"
}
```

## Model profiles

Each profile defines a CAD model, display settings and a `slot_body_map`:

```json
"profiles": {
    "main_hand": {
        "display_name": "Main hand CAD model",
        "model": {
            "obj_path": "./models/hand.obj",
            "mtl_path": "./models/hand.mtl",
            "scale": 1.0
        },
        "colour_mode": "gradient",
        "slot_body_map": []
    }
}
```

Change `active_profile` to switch the displayed CAD model.

## Slot mapping

Each sensor slot can map to a CAD body and a tangential movement dot:

```json
{
    "slot": 0,
    "component": "Thumb",
    "pad": "Tip",
    "i2c_mux": "0x70",
    "i2c_channel": 0,
    "i2c_address": "0x0C",
    "body_id": "Body12:3",
    "red_sensitivity": 1000.0,
    "gradient_sensitivity": 1000.0,
    "hybrid_sensitivity": 1000.0,
    "gradient_hotspot_world": {
        "x": null,
        "y": null,
        "z": null
    },
    "hybrid_hotspot_world": {
        "x": null,
        "y": null,
        "z": null
    },
    "tangential_dot_index": 0,
    "tangential_x_sign": 1,
    "tangential_y_sign": -1,
    "tangential_heading_offset_deg": 0.0,
    "tangential_sensitivity": 1200.0
}
```

`body_id` can be an OBJ mesh name, parent name, material name or mesh UUID. Multiple slots can share the same body ID.

## Calibration

Calibration stores the untouched X, Y and Z readings for each slot in browser localStorage.

The 3D pressure display uses calibrated Z magnitude:

```text
abs(current_raw_z - calibrated_raw_z)
```

The tangential movement display uses calibrated X/Y deltas:

```text
x = (raw_x - calibrated_x) * tangential_x_sign
y = (raw_y - calibrated_y) * tangential_y_sign
heading = atan2(y, x) + tangential_heading_offset_deg
```

## Sensitivity

The pressure colour modes use these fields:

```json
"red_sensitivity": 4000.0,
"gradient_sensitivity": 4000.0,
"hybrid_sensitivity": 4000.0
```

The value is the calibrated Z magnitude that gives full intensity. Larger values reduce sensitivity. Smaller values increase sensitivity.

The tangential movement display uses:

```json
"tangential_sensitivity": 1200.0
```

This value normalises the calibrated X/Y magnitude before converting it into dot movement.

## Tangential Movement display

The right-side display reads `assets/tangent.svg` and renders it to a canvas.

SVG colour roles:

- Red: sensor dots, indexed by `tangential_dot_index`.
- Green: movable follower dots.
- Blue: fixed reference dots.

Follower dots use a spring-style falloff from active red sensor dots. Dots near the active sensor move strongly. Dots farther away move less and ease back to their original positions when the sensor is released.

Display settings:

```json
"tangential_display": {
    "enabled": true,
    "svg_path": "./assets/tangent.svg",
    "max_dot_offset": 22.0,
    "influence_strength": 0.85,
    "response": 0.32,
    "deadband": 0.03,
    "default_sensitivity": 1200.0,
    "render_hz": 30.0,
    "minimum_pad_influence": 0.12,
    "spring_falloff_power": 2.0,
    "max_device_pixel_ratio": 1.5
}
```

Tuning notes:

- Increase `max_dot_offset` for larger on-screen movement.
- Increase `response` for faster dot motion.
- Increase `minimum_pad_influence` for more whole-pad movement.
- Increase `spring_falloff_power` for a tighter local spring effect.
- Lower `max_device_pixel_ratio` to reduce canvas rendering cost.