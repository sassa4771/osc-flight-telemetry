# Feature Specification: Control Surface and Position Input, OSC Monitor, Control Panel

Branch: `feature/position` (additions on top of `main`)
日本語版: [../ja/feature-spec.md](../ja/feature-spec.md)

---

## 1. Overview

Before this branch, OSC could only set the attitude of the aircraft (`PlaneBody`) in the cluster world. This branch extends it with the following:

| # | Feature | Direction |
| --- | --- | --- |
| 1 | Receive control surface rotations (aileron / elevator / rudder) and rotate the surface pivots on the aircraft | external → cluster |
| 2 | Receive the aircraft position and move the aircraft inside the room | external → cluster |
| 3 | Track and display the operator (the one person whose OSC moves the aircraft) | inside cluster |
| 4 | In-world OSC monitor (values, graphs, track, surface preview, event log) | inside cluster (local player only) |
| 5 | Send trim angles and PID gains set on the control panel to an external receiver | cluster → external |
| 6 | Unity Editor menus that build all of the above into the scene | Unity Editor |
| 7 | Python test tools (demo sender, receiver) and position support in `send_osc.py` | external |

### Compatibility changes
- The cluster output `/plane/control [aileron, elevator, rudder]` listed in the `main` README is removed. It is replaced by `/plane/trim` and `/plane/pid/*` (§4.2).
- The `/plane/data` format is unchanged. Existing senders that only send `/plane/data` keep working.

---

## 2. Architecture

```
External (Python / aircraft)              cluster world
────────────────────────────              ───────────────────────────────────────────────
send_osc.py            ─┐
send_surfaces_demo.py  ─┼─ OSC (UDP) ─▶ OscFlightPlayer.js (PlayerScript, on the operator's client)
                        │                 ├─ sendTo ─▶ PlaneBody.js   (attitude, surfaces, position; synced to everyone)
                        │                 └─ PlayerLocalUI ─▶ OSC monitor (local player only)
                        │
receive_osc.py  ◀── OSC (UDP) ── OscFlightPlayer.js ◀─ controlValues ─ ControlPanel.js ◀─ ControlButton.js ×70
                                                                         (values shared by everyone)
                                  OscTrigger.js (Cube_OSC_Trigger): gives the PlayerScript to whoever clicks it and makes them the operator
```

### Components (`Unity/osc-flight-telemetry/Assets/Scripts/OscFlight/`)

| File | Type | Attached to | Role |
| --- | --- | --- | --- |
| `OscFlightPlayer.js` | PlayerScript | `Cube_OSC_Trigger` | Receives OSC, forwards to `PlaneBody`, draws the monitor, sends trim / PID over OSC |
| `OscTrigger.js` | Scriptable Item | `Cube_OSC_Trigger` | Gives the PlayerScript to the clicking player and switches the operator. Shows the operator label and animates the push button |
| `PlaneBody.js` | Scriptable Item | `PlaneBody` | Applies attitude, surfaces and position from the operator (synced to everyone) |
| `ControlPanel.js` | Scriptable Item | `ControlPanel` | Holds and displays trim angles and PID gains, and passes them to the operator's PlayerScript |
| `ControlButton.js` | Scriptable Item | Every panel button (shared by all 70) | Notifies `ControlPanel` when pressed and animates the key press |

---

## 3. Incoming OSC (external → cluster)

Send to cluster's OSC receive port. All arguments are floats (ints are also accepted).

| Address | Arguments | Unit | Meaning |
| --- | --- | --- | --- |
| `/plane/data` | `roll, pitch, yaw, sv1, sv3` | deg | Aircraft attitude and servo values (unchanged; `sv1` / `sv3` are only shown on the monitor) |
| `/plane/aileron/quat` | `x, y, z, w` | – | Aileron rotation |
| `/plane/elevator/quat` | `x, y, z, w` | – | Elevator rotation |
| `/plane/rudder/quat` | `x, y, z, w` | – | Rudder rotation |
| `/plane/pos` | `x, y, z` | m | Aircraft position, relative to the home position |

### 3.1 Coordinate system
- Same left-handed system as Unity (X = right, Y = up, Z = forward).
- The `/plane/data` attitude becomes the aircraft rotation via `Quaternion.setFromEulerAngles(pitch, yaw, roll)`. The rotation order matches Unity's `Quaternion.Euler` (Z → X → Y).

### 3.2 Control surface quaternions
- Each quaternion is the **rotation from that surface's neutral pose**.
- If the length differs from 1 by more than 0.01, the receiver normalizes it and shows a warning on the monitor.
- Quaternions with near-zero length (below 1e-6) are dropped.
- If `PlaneBody` has a descendant pivot with one of the names below, it is rotated as `localRotation = neutral × received quaternion`. Surfaces without a pivot are ignored (no error).

| Surface | Pivot name |
| --- | --- |
| Aileron | `AileronPivot` |
| Elevator | `ElevatorPivot` |
| Rudder | `RudderPivot` |

- Create each pivot as an empty object with its origin at the hinge, and put the surface mesh under it.
- The neutral pose is the pivot's rotation when it is first found (stored in `$.state`).

### 3.3 Position (`/plane/pos`)
- Values are **relative to the home position** (where `PlaneBody` is placed in the scene).
- The world position is computed as follows, then each axis is clamped to `POS_MIN`…`POS_MAX`:

  `world position = home + received value × POS_SCALE`

- Out-of-range values stop at the edge, and the monitor shows `CLAMPED`.
- The room is 10 m × 10 m and 10 m high (X/Z −5…5, Y 0…10).
- Real flight data covers far more than the room, so lower `POS_SCALE`, for example to `0.01` (100 m → 1 m).
- When the operator changes (someone clicks `Cube_OSC_Trigger`), the aircraft returns to the home position.

### 3.4 Invalid input
| Case | Behavior |
| --- | --- |
| Unknown address | Ignored; shown in EVENTS once per address |
| Too few arguments / non-numeric | Message dropped; warning in EVENTS (same warning at most once per 5 s) |
| Non-normalized quaternion | Normalized and used; warning shown |

---

## 4. Outgoing OSC (cluster → external)

### 4.1 Requirements
- In cluster, turn on **Enable OSC send** under Settings > Other and set the destination IP / port.
- Only the **operator's** cluster client sends. Anyone may press the panel buttons.
- When driving an external aircraft, use a destination port different from cluster's own OSC receive port.

### 4.2 Messages
| Address | Arguments (float) | Range | Meaning |
| --- | --- | --- | --- |
| `/plane/trim` | `aileron, elevator, rudder` | −30…+30 deg | Trim angles |
| `/plane/pid/roll` | `kp, ki, kd` | 0…10 | Roll PID gains |
| `/plane/pid/pitch` | `kp, ki, kd` | 0…10 | Pitch PID gains |
| `/plane/pid/yaw` | `kp, ki, kd` | 0…10 | Yaw PID gains |
| `/plane/{aileron,elevator,rudder}/quat` | `x, y, z, w` | – | Trim angle as a rotation around the hinge axis (only when `TX_SEND_QUATS = true`; off by default) |

### 4.3 Timing
- Values are sent immediately when they change.
- Even without changes, they are resent every `TX_KEEPALIVE_SEC` (0.5 s), since UDP can drop packets.
- One message per packet. OSC bundles are not used.
- **PID gains for an axis are not sent until one of that axis's buttons has been pressed at least once.** This keeps a newly joined operator from overwriting the aircraft's gains with default values.
- Nothing is sent while OSC send is off. Once it is turned on, values go out at the next resend.

### 4.4 How values change
- Trim: buttons step by `-10 / -1 / +1 / +10` deg; `0` resets that surface to 0. `RESET TRIM` resets all three surfaces to 0 (PID is unchanged). Values are clamped to −30…+30.
- PID: buttons step by `-1 / -0.1 / -0.01 / +0.01 / +0.1 / +1`. Values are clamped to 0…10 and rounded to 2 decimal places.
- PID starting values (shown before any press, and used as the base for the first press) come from `PID_DEFAULTS` in `ControlPanel.js` (all 0 by default). Setting them to the aircraft's current gains is the safe choice.
- Values are shared by everyone in the world. They reset to defaults when the world instance is recreated.

---

## 5. Operator

- The operator is **the last person who clicked `Cube_OSC_Trigger`**.
- Only the operator's OSC moves `PlaneBody`, and only the operator's cluster client sends trim / PID out.
- When someone else clicks, the operator switches. The previous operator's PlayerScript stops forwarding to the aircraft and stops sending OSC, but keeps receiving and updating its monitor.
- The operator name is shown on `OperatorLabel` above the cube (visible to everyone) and in the monitor header (`OPERATOR`).
  - The display font only has ASCII characters. If a display name contains anything else, the user ID (`@id`) is shown instead.
- When the operator leaves, the label returns to `none` (checked every second).

### 5.1 Switching sequence
1. A player clicks `Cube_OSC_Trigger`.
2. `OscTrigger.js` sends `oscOperatorChanged` to the previous operator and gives the PlayerScript to the clicking player.
3. The new operator's `OscFlightPlayer.js` starts and sends to `PlaneBody`:
   - `claimOperator`: registers itself as operator
   - `updateRotation [0, 0, 0]`: resets attitude
   - `resetPosition`: returns to the home position
4. `PlaneBody` replies with `planeConfig` (home, scale, range). The monitor uses it to display the position.
5. `OscFlightPlayer.js` sends `subscribeControl` to `ControlPanel` and becomes the sender. `ControlPanel` immediately replies with the current values as `controlValues`.

---

## 6. Messages between items

| From → To | Message | Argument | Meaning |
| --- | --- | --- | --- |
| Player → `PlaneBody` | `claimOperator` | name | Become operator |
| Player → `PlaneBody` | `updateRotation` | `[roll, pitch, yaw]` (deg) | Attitude |
| Player → `PlaneBody` | `updateSurfaces` | `{ ail, elv, rud: [x,y,z,w] }` | Surface rotations |
| Player → `PlaneBody` | `updatePosition` | `[x, y, z]` (m) | Position relative to home |
| Player → `PlaneBody` | `resetPosition` | – | Return to home |
| `PlaneBody` → Player | `planeConfig` | `{ home, scale, min, max }` | How position is computed |
| `OscTrigger` → previous Player | `oscOperatorChanged` | `{ name }` | Operator changed |
| Player → `ControlPanel` | `subscribeControl` | `{ name, sendEnabled }` | Become sender |
| Player → `ControlPanel` | `txStatus` | `{ sendEnabled }` | OSC send setting changed |
| `ControlButton` → `ControlPanel` | `controlButton` | – | Button pressed (identified by sender) |
| any → `ControlPanel` | `resetControl` | – | Reset all trims to 0 |
| `ControlPanel` → Player | `controlValues` | `{ aileron, elevator, rudder, pid, seq }` | Current values (`pid` only contains pressed axes) |

- Forwarding to `PlaneBody` runs at up to `FORWARD_HZ` (20 Hz), and only for channels that changed.
- `PlaneBody` ignores `update*` / `resetPosition` from anyone other than the last player who sent `claimOperator`.
- `ControlPanel` identifies buttons by their World Item Reference List id:

| id | Action |
| --- | --- |
| `btn.<aileron\|elevator\|rudder>.<m10\|m1\|zero\|p1\|p10>` | Trim −10 / −1 / set to 0 / +1 / +10 |
| `btn.reset` | Reset all trims to 0 |
| `btn.pid.<roll\|pitch\|yaw>.<kp\|ki\|kd>.<m1\|m01\|m001\|p001\|p01\|p1>` | Gain −1 / −0.1 / −0.01 / +0.01 / +0.1 / +1 |

70 buttons in total (15 trim + 1 reset + 54 PID).

---

## 7. OSC monitor

Shown on `OscMonitor` (a world-space PlayerLocalUI). Updates are **visible only to the local player** (not synced). Updates start when the player clicks `Cube_OSC_Trigger`.

| Section | Contents |
| --- | --- |
| Header | `OSC RX ON/OFF` (if OFF, turn on "Enable OSC receive" in cluster). `OPERATOR` shows the operator: `(you)` if it is you, `monitor only` if it is someone else |
| TX line | Send state (`ON` / `OSC SEND OFF` / `OFF (not operator)`), trim angles being sent, axes whose PID is being sent, send count, seconds since last send |
| Cards (ATTITUDE / AILERON / ELEVATOR / RUDDER / POSITION) | State (`LIVE` / `NO SIGNAL` / `WAITING`), receive rate (Hz), message count, seconds since last message, graph of the last 5 s (auto-scaled), raw values |
| Raw values on surface cards | Quaternion `x y z w`, `\|q\|`, Euler angles (ZXY), rotation angle and axis |
| POSITION card | Graph of received x / y / z (m), `PlaneBody` world position, scale and home; `CLAMPED` when out of range |
| TRACK | Top-down view of the room: path over the last 20 s, current position (triangle tip = heading/yaw), `+` = home, frame = `POS_MIN`…`POS_MAX` |
| SURFACE PREVIEW | Simple 3D view that rotates surface plates by the received quaternions (gray = neutral). The whole aircraft is tilted by the `/plane/data` attitude |
| EVENTS | Unknown addresses, missing arguments, normalization warnings, operator changes, etc. (latest 30 lines) |

- `NO SIGNAL` appears when nothing has been received for `STALE_SEC` (1 s).
- By default, TRACK is drawn as seen when facing the monitor at its default position (the −Z wall): screen up = −Z, right = −X. With `TRACK_VIEW_FROM_SPAWN = false`, up = +Z and right = +X.
- SURFACE PREVIEW draws both ailerons. The left one uses `/plane/aileron/quat` as is; the right one mirrors it and moves the opposite way (the sign of the quaternion's `x` is flipped).
- The preview is for checking rotation directions and axes before the surfaces are built into the model.

---

## 8. Control panel

Shown on `ControlPanel`. Values and display are shared by everyone in the world.

| Section | Contents |
| --- | --- |
| Header | `TX ON` / `TX OSC SEND OFF` (OSC send is off on the operator's client) / `no operator` (nobody has pressed `Cube_OSC_Trigger` yet), plus the sender's name. `RESET TRIM` button at the right end |
| Top row: AILERON / ELEVATOR / RUDDER TRIM | Value, −30…+30 gauge (needle = current value), `-10 / -1 / 0 / +1 / +10` buttons |
| Bottom row: ROLL / PITCH / YAW PID | Kp / Ki / Kd values and `-1 / -.1 / -.01 / +.01 / +.1 / +1` buttons. `NOT SENT` / `SENDING` at the top right shows whether that axis is being sent (values are gray before sending) |

- Pressed keys sink slightly and return (synced to everyone).

---

## 9. Settings

Change these constants at the top of each script.

### `PlaneBody.js`
| Constant | Default | Meaning |
| --- | --- | --- |
| `POS_SCALE` | `1.0` | World meters per received meter |
| `POS_MIN` | `[-4.5, 0.3, -4.5]` | Lower bound in world coordinates |
| `POS_MAX` | `[4.5, 9.5, 4.5]` | Upper bound in world coordinates |

### `OscFlightPlayer.js`
| Constant | Default | Meaning |
| --- | --- | --- |
| `FORWARD_HZ` | `20` | Max forwarding rate to `PlaneBody` |
| `FORWARD_SURFACES` | `true` | Forward surfaces to `PlaneBody` |
| `GRAPH_SECONDS` | `5` | Graph time window (s) |
| `SAMPLE_HZ` | `20` | Graph sampling / redraw rate |
| `TEXT_HZ` | `10` | Text update rate |
| `STALE_SEC` | `1.0` | Seconds without data before `NO SIGNAL` |
| `LOG_LINES` | `30` | Lines kept in EVENTS |
| `TRACK_SECONDS` | `20` | Time kept in TRACK (s) |
| `TRACK_VIEW_FROM_SPAWN` | `true` | TRACK orientation (§7) |
| `PREVIEW_ATTITUDE` | `true` | Tilt the preview by the `/plane/data` attitude |
| `PREVIEW_YAW` | `true` | Include yaw in the above |
| `TX_ENABLED` | `true` | Send trim / PID out |
| `TX_SEND_TRIM` | `true` | Send `/plane/trim` |
| `TX_SEND_PID` | `true` | Send `/plane/pid/*` |
| `TX_SEND_QUATS` | `false` | Also send trims as `/plane/*/quat` (loopback testing) |
| `TX_KEEPALIVE_SEC` | `0.5` | Resend interval (0 = only on change) |
| `TX_HINGE_AXES` | ail/elv: `[1,0,0]`, rud: `[0,1,0]` | Hinge axes used by `TX_SEND_QUATS` |

### `ControlPanel.js`
| Constant | Default | Meaning |
| --- | --- | --- |
| `TRIM_MIN` / `TRIM_MAX` | `-30` / `30` | Trim range (deg) |
| `GAIN_MIN` / `GAIN_MAX` | `0` / `10` | PID gain range |
| `PID_DEFAULTS` | all 0 | PID starting values |

---

## 10. Unity Editor setup menus

Open `Assets/Scene/OSC_receive.unity` and run these from **Tools > OSC Flight**. All of them can be run again.

| Menu | What it does |
| --- | --- |
| **Setup All In Open Scene** | Runs Setup Monitor and Setup Control Panel together |
| **Setup Monitor In Open Scene** | Creates `OscMonitor` (initial position `(0, 2.1, -4.2)`; kept on re-run). Swaps the scripts on `Cube_OSC_Trigger` / `PlaneBody` / `ControlPanel`, creates `OperatorLabel`, and registers UI references (`oscmon.*`) and World Item References (`PlaneBody`, `ControlPanel`) |
| **Setup Control Panel In Open Scene** | Rebuilds `ControlPanel` in the same style as the monitor, generates the 70 buttons under `ControlPanelButtons` at the scene root, and registers `btn.*`. Keeps the position; on the first run only, turns the front toward the spawn point (in 90° steps). Deletes old buttons (`Btn_AIL_*` etc.) and their parents (`Aileron` / `Elevator` / `Rudder`). Run again after moving the panel |
| **Setup Start Button In Open Scene** (optional) | Replaces the look of `Cube_OSC_Trigger` with a pedestal, a green push button (`Cap`) and a front label (`OSC / PUSH TO RECEIVE`), and fits the collider. On the first run only, turns the front toward the spawn point |

- Buttons are not children of `ControlPanel` because cluster does not allow an Item inside another Item.
- Panel materials are `Assets/Materials/OscPanel_*.mat` (Unlit/Color).
- Save the scene and upload after running the menus.

---

## 11. Python tools (`Python/`)

Dependencies: `pandas`, `python-osc` (a `Pipfile` is included).

### `send_osc.py` (changed)
- If the CSV has `pos_x`, `pos_y`, `pos_z` columns, it sends `/plane/pos` in addition to `/plane/data`.
- Without those columns, it sends only `/plane/data`, as before.
- Rows with missing position values do not send `/plane/pos`.

### `send_surfaces_demo.py` (new)
Sends demo control surface quaternions.

| Option | Default | Meaning |
| --- | --- | --- |
| `--ip` | `127.0.0.1` | Destination IP |
| `--port` | `9000` | Destination port |
| `--hz` | `50` | Send rate |
| `--duration` | `0` | Seconds to send (0 = until Ctrl+C) |
| `--mode` | `sine` | `sine`: sine waves / `step`: 0 → +max → 0 → −max every 2 s / `sequence`: one surface at a time, 4 s each |
| `--amp` | `1.0` | Amplitude multiplier (base: aileron 20°, elevator 15°, rudder 25°) |
| `--attitude` | off | Also send `/plane/data` |
| `--position` | off | Also send `/plane/pos` (circles around home; height moves between 0.2 and 1.8 m) |
| `--radius` | `3.0` | Circle radius for `--position` (m) |
| `--period` | `20.0` | Seconds per lap for `--position` |

- Ailerons and elevator rotate around the X axis; the rudder rotates around the Y axis.
- With `--attitude` and `--position` together, yaw follows the direction of travel.

### `receive_osc.py` (new)
Debug receiver that prints OSC sent from cluster.

| Option | Default | Meaning |
| --- | --- | --- |
| `--ip` | `0.0.0.0` | Listen IP |
| `--port` | `9000` | Listen port |
| `--address` | none | Only print this address (e.g. `/plane/trim`) |

---

## 12. Limitations and notes

- Monitor updates are visible only to the player running the PlayerScript.
- The display font only has ASCII characters (see §5 for how names are shown).
- PID gains are sent per axis only after a button for that axis has been pressed once. Set starting values with `PID_DEFAULTS`.
- Trim / PID values live only in the world instance and reset when it is recreated.
- Position is clamped to the room (`POS_MIN`…`POS_MAX`). Real flight data needs a smaller `POS_SCALE`.
- Control surfaces do not move on the aircraft until the pivots (`AileronPivot` etc.) are built into the model. They still appear in the monitor preview.
