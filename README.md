# SRL Magnetic Hand UI

Electron / Three.js UI for visualising the SRL magnetic hand ROS 2 stream.

This version no longer reads the Pico serial port directly. It connects to ROS 2 through `rosbridge_websocket` and subscribes to:

- `/srl_magnetic_hand/frame`
- `/srl_magnetic_hand/metadata`

## Run the ROS side in WSL

In one WSL terminal, run the magnetic hand ROS node:

```bash
source /opt/ros/jazzy/setup.bash
source /path/to/SRL_Magnetic_Hand_ROS2_Publisher/install/setup.bash
ros2 launch srl_magnetic_hand_driver magnetic_hand.launch.py serial_port:=/dev/ttyACM0
```

In a second WSL terminal, run rosbridge:

```bash
source /opt/ros/jazzy/setup.bash
sudo apt install ros-jazzy-rosbridge-server
ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:=9090
```

## Run the UI

You can run the UI on Windows. It does not need to run inside WSL as long as it can reach the rosbridge websocket.

```powershell
npm install
npm start
```

The default websocket URL is:

```text
ws://localhost:9090
```

If Windows cannot reach WSL through localhost, get the WSL IP address:

```bash
hostname -I
```

Then use:

```text
ws://<WSL_IP>:9090
```

## Model profiles

Edit:

```text
config/ui_config.json
```

The UI now supports multiple CAD-model profiles. The selected profile is controlled by:

```json
"active_profile": "main_hand"
```

Each profile has its own model paths and its own `slot_body_map`:

```json
"profiles": {
    "main_hand": {
        "display_name": "Main hand CAD model",
        "model": {
            "obj_path": "./models/hand.obj",
            "mtl_path": "./models/hand.mtl",
            "scale": 1.0
        },
        "red_sensitivity": 4000.0,
        "gradient_sensitivity": 4000.0,
        "hybrid_sensitivity": 4000.0,
        "slot_body_map": []
    },
    "alternate_hand": {
        "display_name": "Alternate CAD model",
        "model": {
            "obj_path": "./models/alternate_hand.obj",
            "mtl_path": "./models/alternate_hand.mtl",
            "scale": 1.0
        },
        "red_sensitivity": 4000.0,
        "gradient_sensitivity": 4000.0,
        "hybrid_sensitivity": 4000.0,
        "slot_body_map": []
    }
}
```

To switch model, change `active_profile` to the profile name you want.

## Slot to body mapping

Each slot mapping has:

```json
{
    "slot": 0,
    "component": "Thumb",
    "pad": "Tip",
    "i2c_mux": "0x70",
    "i2c_channel": 0,
    "i2c_address": "0x0C",
    "body_id": "Body2:4",
    "red_sensitivity": 4000.0,
    "gradient_sensitivity": 4000.0,
    "hybrid_sensitivity": 4000.0
}
```

Fill `body_id` with the OBJ mesh name, parent name, material name, or mesh UUID that should be coloured for that sensor slot.

Multiple slots can use the same `body_id`. The UI normalises each slot using the sensitivity value for the selected colour mode.

## Per-mode sensitivity

Each profile and each slot can have separate sensitivities for the three colour modes:

```json
"red_sensitivity": 1000.0,
"gradient_sensitivity": 1500.0,
"hybrid_sensitivity": 2000.0
```

The value is the calibrated Z magnitude that gives full colour intensity. A larger value makes that mode less sensitive. A smaller value makes that mode more sensitive.

If a slot does not include one of these fields, the profile-level value is used instead.

Old `z_full_scale`, `zFullScale`, `z_max`, `max_z`, and `max_value` fields are still accepted as fallbacks, but the new config uses the three explicit sensitivity fields.

## Calibration

Click `Calibrate Untouched` while the hand is untouched.

The UI stores the current `raw_z` value for every slot and then colours pads using:

```text
abs(current_raw_z - calibrated_raw_z)
```

The calibration is saved in browser localStorage, so it remains available after restarting the UI.

## Controls

- Connect ROS: connects to rosbridge and subscribes to the ROS topics.
- Calibrate Untouched: records the current readings as the untouched baseline.
- Reset View: resets the camera.
- Clear Log: clears the last message and console.
- Left mouse drag: orbit.
- Scroll wheel: zoom.
- Right mouse drag: pan.
- L key: log camera position.
- R key: reset camera.


## Colour modes

Each profile in `config/ui_config.json` can set:

```json
"colour_mode": "red"
```

or:

```json
"colour_mode": "gradient"
```

or:

```json
"colour_mode": "hybrid"
```

The sidebar dropdown can also switch between these modes live without restarting the app.

### Red mode

Sensors are grouped by `component` and `pad`. The calibrated Z magnitudes for all
sensors in that pad are averaged, and their `red_sensitivity` values are averaged.
Every mapped body in that pad is then coloured with the same fading red value.

### Gradient mode

Each sensor is treated independently. Its own body is coloured from that slot's
calibrated Z magnitude and its own `gradient_sensitivity`. The body uses a radial
false-colour gradient with a red centre, then orange, yellow, and blue toward
the edge. A larger reading gives a larger red centre.

### Hybrid mode

Sensors are grouped by `component` and `pad`, just like red mode. The calibrated
Z magnitudes and `hybrid_sensitivity` values are averaged across that pad. The
pad is then drawn using one shared gradient centre/radius across all of its
individual bodies, as if they were one larger mesh.

## Performance notes

The colour update path is throttled so the UI does not recolour the CAD model for every ROS websocket packet.

Top-level config option:

```json
"frame_throttle_ms": 16
```

Use larger values if the model is heavy:

```json
"frame_throttle_ms": 33
```

That limits rosbridge frame delivery to about 30 Hz. The UI also only applies the latest received frame during the render loop, so intermediate stale frames are dropped rather than queued.

Gradient mode now caches per-mesh vertex distances and updates colour buffers directly. Red mode remains the fastest option.


## Hybrid colour mode

Set `"colour_mode": "hybrid"` to use pad-level averaging like red mode, but draw the result using the gradient colour treatment across every body in that pad.


The sidebar now includes a live colour mode selector so you can switch between `red`, `gradient`, and `hybrid` without editing the config file or restarting the app.


Hybrid mode update: the gradient is now calculated using a shared centre and radius for the whole pad group. This means separate OBJ bodies that share the same `component` + `pad` are treated as one larger imaginary pad for the gradient.


## Per-mode sensitivity

`z_full_scale` has been replaced by mode-specific sensitivity fields:

```json
{
    "slot": 0,
    "component": "Thumb",
    "pad": "Tip",
    "body_id": "Body12:3",
    "red_sensitivity": 1000.0,
    "gradient_sensitivity": 1500.0,
    "hybrid_sensitivity": 2000.0
}
```

The sensitivity value is still the calibrated Z magnitude that gives full colour intensity. Lower values make that mode more sensitive.

For pad-level modes:

- `red` averages the `red_sensitivity` values for all sensors in the pad.
- `hybrid` averages the `hybrid_sensitivity` values for all sensors in the pad.

For individual-body mode:

- `gradient` uses each sensor body's own `gradient_sensitivity`.

Old `z_full_scale` configs are still accepted as a fallback, but the new config uses the three explicit fields.


Hybrid mode note: the hybrid gradient now uses a much wider red core than the individual gradient mode. When the pad intensity reaches 1.0 the combined pad should become fully red, instead of staying mostly yellow/orange at the edges.


## Continuous gradient mode and hotspot offsets

Gradient mode now treats all bodies with the same `component` and `pad` as one continuous field with multiple sensor hotspots. Each sensor still has its own reading and `gradient_sensitivity`, but every vertex in the pad is evaluated against every hotspot in that pad. This avoids hard colour breaks between sectioned CAD bodies.

Each slot can optionally move its hotspot centre using `gradient_offset`:

```json
"gradient_offset": {
    "x": 0.0,
    "y": 0.0,
    "z": 0.0
}
```

The offset is relative to the mapped body's local bounding box half-size. `x: 1.0` moves to the positive local X edge, `x: -1.0` moves to the negative local X edge, and `0.0` stays at the centre. The same applies to Y and Z. For flat pad sections, X and Y will usually be enough, but Z is available if the hotspot needs moving through the thickness or along the model's local depth axis.


## Continuous gradient performance fix

The continuous gradient mode now keeps one cached distance field per pad/body and no longer parses or applies per-slot hotspot offsets. Hotspots are currently placed at the centre of their mapped sensor body. The previous multi-hotspot cache was also fixed so unchanged quantised sensor values do not repaint every vertex every frame.

Offsets can be added back later once the continuous field is stable.


## Optional world hotspot overrides

Each slot entry in `config/ui_config.json` now includes two optional world-space hotspot fields:

- `gradient_hotspot_world`
- `hybrid_hotspot_world`

Leave them as empty objects (`{}`) when unused. The viewer will then fall back to the calculated geometric centre.

In hybrid mode, if one or more slots in the same pad define `hybrid_hotspot_world`, the viewer averages the provided world points and uses that average as the shared hybrid hotspot centre for the whole pad. If none are provided, the viewer uses the mathematical centre of the combined pad geometry.


## Profile camera start view

Each profile can define its own reset/start camera pose:

```json
"camera_start_view": {
    "camera_x": 22.15957395302073,
    "camera_y": -38.695039902170016,
    "camera_z": -263.508728563301,
    "target_x": 22.159574172680824,
    "target_y": -38.69521933870093,
    "target_z": -84.08003871700765
}
```

The Reset View button and automatic model load reset both use the active profile's camera start view.

## Debug mode

Set `debug_mode` in `config/ui_config.json`:

```json
"debug_mode": true
```

When true, the mapper, L hotkey, and left/right-click visual debug tools are enabled. The sidebar starts open.

When false, the mapper is hidden, click debug/highlight tools are disabled, and the sidebar starts hidden. The small side tab can still be used to open the controls for ROS, colour mode and calibration.

## Sidebar

The sidebar is now an overlay. It does not shrink or resize the 3D viewer. Use the small tab on the left edge to slide it in or out.
