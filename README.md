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
        "z_full_scale": 4000.0,
        "slot_body_map": []
    },
    "alternate_hand": {
        "display_name": "Alternate CAD model",
        "model": {
            "obj_path": "./models/alternate_hand.obj",
            "mtl_path": "./models/alternate_hand.mtl",
            "scale": 1.0
        },
        "z_full_scale": 4000.0,
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
    "z_full_scale": 4000.0
}
```

Fill `body_id` with the OBJ mesh name, parent name, material name, or mesh UUID that should be coloured for that sensor slot.

Multiple slots can use the same `body_id`. The UI normalises each slot using its own `z_full_scale`, then averages the normalised values for all slots mapped to the same body.

## Per-slot colour scaling

Each slot can have its own maximum Z value:

```json
"z_full_scale": 1000.0
```

A larger value makes that slot less sensitive. A smaller value makes that slot more sensitive.

If a slot does not include `z_full_scale`, the profile-level value is used instead.

The code also accepts these aliases if you prefer them:

```text
zFullScale
z_max
max_z
max_value
```

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
