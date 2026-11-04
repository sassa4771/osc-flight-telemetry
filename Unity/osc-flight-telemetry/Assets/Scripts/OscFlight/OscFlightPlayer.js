// =====================================================================
// OscFlightPlayer.js  - PlayerScript (Cube_OSC_Trigger)
//
// 受信する OSC
//   /plane/data           [roll, pitch, yaw, sv1, sv3]  機体姿勢 (deg) とサーボ値
//   /plane/aileron/quat   [x, y, z, w]                  エルロンの回転
//   /plane/elevator/quat  [x, y, z, w]                  エレベーターの回転
//   /plane/rudder/quat    [x, y, z, w]                  ラダーの回転
//   /plane/pos            [x, y, z]                     機体の位置 (m, 初期位置からの相対, Unity 座標系)
//   クォータニオンは Unity 座標系 (左手系 X=右 Y=上 Z=前) で、各舵面の中立姿勢からの回転。
//
// やること
//   1. 機体姿勢を PlaneBody へ "updateRotation" で転送 (アイテム経由で全員に同期)
//   2. 舵面クォータニオンを PlaneBody へ "updateSurfaces" で転送
//      (PlaneBody にピボットが実装されたら回る。PlaneBody.js 参照)
//   2b. 位置を PlaneBody へ "updatePosition" で転送 (縮尺と部屋の範囲は PlaneBody.js の POS_* で決まる)
//   3. ワールド内の OSC モニター (PlayerLocalUI) に数値・グラフ・姿勢と舵面のプレビューを表示
//      ※ モニターの更新はこのスクリプトを実行しているプレイヤーにだけ見える (同期しない)
//   4. ControlPanel のボタンで設定したトリム角と PID ゲインを OSC で外部へ送信 (操縦者のときだけ)
//
// 送信する OSC (cluster の「設定 > その他 > OSC送信の有効化」と送信先の設定が必要)
//   /plane/trim           [aileron, elevator, rudder]   トリム角 (deg, -30..+30)
//   /plane/pid/roll       [kp, ki, kd]                  ロールの PID ゲイン (0..10)
//   /plane/pid/pitch      [kp, ki, kd]                  ピッチの PID ゲイン
//   /plane/pid/yaw        [kp, ki, kd]                  ヨーの PID ゲイン
//     PID は、その軸のボタンが一度でも押されるまで送らない (機体側のゲインを初期値で上書きしないため)
//   /plane/aileron/quat など  [x, y, z, w]              トリム角をヒンジ軸まわりの回転にしたもの (TX_SEND_QUATS = true のときだけ)
//   値が変わったときにすぐ送り、変わらなくても TX_KEEPALIVE_SEC ごとに送り直す (UDP なので取りこぼし対策)。
//
// 操縦者 (オペレーター)
//   Cube_OSC_Trigger を最後にクリックした 1 人だけが PlaneBody を動かせる。
//   起動時に PlaneBody へ "claimOperator" を送って操縦者になり、
//   別の人がクリックすると OscTrigger.js から "oscOperatorChanged" が届いて転送を止める
//   (受信とモニター表示は続ける)。
//
// モニターの UI は Unity メニュー「Tools > OSC Flight > Setup Monitor In Open Scene」で生成され、
// Cube_OSC_Trigger の Player Local Object Reference List に "oscmon.*" の id で登録される。
// =====================================================================

// ---------------- 設定 ----------------
const FORWARD_HZ = 20;          // PlaneBody への転送レート上限 (sendTo の回数を抑える)
const FORWARD_SURFACES = true;  // 舵面クォータニオンを PlaneBody に転送するか
const GRAPH_SECONDS = 5;        // グラフに表示する時間幅 (秒)
const SAMPLE_HZ = 20;           // グラフのサンプリング / 再描画レート
const TEXT_HZ = 10;             // 数値表示の更新レート
const STALE_SEC = 1.0;          // この秒数以上受信がなければ NO SIGNAL 表示
const LOG_LINES = 30;           // EVENTS 欄に残す行数
const TRACK_SECONDS = 20;       // TRACK (上から見た軌跡) に残す時間 (秒)
// TRACK の向き。true: 既定位置のモニター (-Z 側の壁) に向かって立ったときの見え方 (画面の上 = -Z, 右 = -X)
//              false: 画面の上 = +Z, 右 = +X
const TRACK_VIEW_FROM_SPAWN = true;
const PREVIEW_ATTITUDE = true;  // プレビューの機体を /plane/data の姿勢で傾けるか
const PREVIEW_YAW = true;       // 上記で yaw (機首方位) も反映するか (false なら roll / pitch のみ)
const TX_ENABLED = true;        // ControlPanel の値を OSC で外部へ送るか
const TX_SEND_TRIM = true;      // /plane/trim [ail, elv, rud] (deg) を送るか
const TX_SEND_PID = true;       // /plane/pid/<axis> [kp, ki, kd] を送るか
const TX_SEND_QUATS = false;    // トリム角を /plane/*/quat [x, y, z, w] でも送るか (ループバック確認用)
const TX_KEEPALIVE_SEC = 0.5;   // 値が変わらなくてもこの間隔で送り直す (0 = 変化時のみ)
// トリム角 -> クォータニオンのヒンジ軸 (機体ローカル, Unity 座標系)。send_surfaces_demo.py と同じ
const TX_HINGE_AXES = {
  aileron: [1, 0, 0],
  elevator: [1, 0, 0],
  rudder: [0, 1, 0],
};

// ---------------- 定数 ----------------
const R2D = 180 / Math.PI;
const SAMPLES = Math.max(2, Math.round(GRAPH_SECONDS * SAMPLE_HZ));
const RANGE_STEPS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 360];
const POS_RANGE_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 100000, 1000000];
const SERIES_RGB = [[1.0, 0.35, 0.35], [0.35, 1.0, 0.45], [0.35, 0.6, 1.0]];
const SERIES_WIDTH = 0.005;
const SERIES_HEX = ["#ff5959", "#59ff73", "#5999ff"];
const COLOR_OK = "#59ff73";
const COLOR_NG = "#ff5959";
const COLOR_DIM = "#8c8c94";

const CHANNELS = [
  { key: "att", address: "/plane/data", kind: "attitude", series: ["roll", "pitch", "yaw"], minRange: 30 },
  { key: "ail", address: "/plane/aileron/quat", kind: "quat", series: ["X", "Y", "Z"], minRange: 30 },
  { key: "elv", address: "/plane/elevator/quat", kind: "quat", series: ["X", "Y", "Z"], minRange: 30 },
  { key: "rud", address: "/plane/rudder/quat", kind: "quat", series: ["X", "Y", "Z"], minRange: 30 },
  { key: "pos", address: "/plane/pos", kind: "position", series: ["x", "y", "z"], minRange: 1, rangeSteps: POS_RANGE_STEPS },
];

const channelByAddress = {};
const channelByKey = {};
for (const ch of CHANNELS) {
  ch.count = 0;
  ch.windowCount = 0;
  ch.hz = 0;
  ch.lastTime = -1;
  ch.raw = [];
  ch.plotValues = [0, 0, 0];
  ch.quat = null;
  ch.norm = 0;
  ch.hist = [[], [], []];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < SAMPLES; i++) ch.hist[s].push(0);
  }
  ch.head = 0;
  ch.filled = 0;
  ch.range = ch.minRange;
  ch.lastWarn = "";
  ch.lastWarnTime = -999;
  ch.ui = null;
  ch.plot = null;
  channelByAddress[ch.address] = ch;
  channelByKey[ch.key] = ch;
}

// ---------------- 状態 ----------------
let now = 0;
let totalCount = 0;
let attForwardDirty = false;
let surfForwardDirty = false;
let posForwardDirty = false;
let previewDirty = false;
let sendErrorTime = -999;
const unknownAddresses = {};
const logLines = [];

// ---------------- ユーティリティ ----------------
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function isNum(v) {
  return typeof v === "number" && isFinite(v);
}

// OscValue -> number | null  (float でも int でも受け付ける)
function oscNumber(value) {
  if (!value) return null;
  let n = null;
  try {
    n = value.getFloat();
    if (!isNum(n)) n = value.getInt();
  } catch (e) {
    n = null;
  }
  return isNum(n) ? n : null;
}

function fmt(v, digits, width) {
  if (!isNum(v)) return "-".padStart(width);
  const s = (v >= 0 ? "+" : "") + v.toFixed(digits);
  return s.padStart(width);
}

function pushLog(text) {
  logLines.push(`<color=${COLOR_DIM}>${now.toFixed(1).padStart(6)}s</color> ${text}`);
  while (logLines.length > LOG_LINES) logLines.shift();
  _.log(`[OscFlight] ${text}`);
}

function warnChannel(ch, text) {
  // 同じ警告は 5 秒に 1 回まで
  if (ch.lastWarn === text && now - ch.lastWarnTime < 5) return;
  ch.lastWarn = text;
  ch.lastWarnTime = now;
  pushLog(`<color=${COLOR_NG}>${text}</color>`);
}

// Unity と同じ ZXY 順のオイラー角 (deg)。q は正規化済み {x,y,z,w}
function quatToEulerDeg(q) {
  const ex = Math.asin(clamp(2 * (q.w * q.x - q.y * q.z), -1, 1));
  const ey = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  const ez = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.x * q.x + q.z * q.z));
  return [ex * R2D, ey * R2D, ez * R2D];
}

// 回転角 (0..180 deg) と回転軸
function quatToAxisAngle(q) {
  const s = q.w < 0 ? -1 : 1;
  const w = clamp(q.w * s, -1, 1);
  const angle = 2 * Math.acos(w) * R2D;
  const k = Math.sqrt(Math.max(0, 1 - w * w));
  if (k < 1e-6) return { angle: 0, axis: [1, 0, 0] };
  return { angle, axis: [(q.x * s) / k, (q.y * s) / k, (q.z * s) / k] };
}

// a * b (b を先に適用)
function quatMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// Unity の Quaternion.Euler / cluster の setFromEulerAngles と同じ (Z → X → Y の順に適用)
function eulerDegToQuat(xDeg, yDeg, zDeg) {
  const hx = (xDeg / R2D) * 0.5, hy = (yDeg / R2D) * 0.5, hz = (zDeg / R2D) * 0.5;
  const qx = { x: Math.sin(hx), y: 0, z: 0, w: Math.cos(hx) };
  const qy = { x: 0, y: Math.sin(hy), z: 0, w: Math.cos(hy) };
  const qz = { x: 0, y: 0, z: Math.sin(hz), w: Math.cos(hz) };
  return quatMul(quatMul(qy, qx), qz);
}

// TMP のリッチテキストとして解釈されないようにする (ユーザー名用)
function plain(text) {
  return `<noparse>${String(text).replace(/<\/?noparse>/gi, "")}</noparse>`;
}

// ベクトル (x,y,z) をクォータニオン q で回転
function rotate(q, x, y, z) {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return [
    x + q.w * tx + (q.y * tz - q.z * ty),
    y + q.w * ty + (q.z * tx - q.x * tz),
    z + q.w * tz + (q.x * ty - q.y * tx),
  ];
}

// ---------------- OSC 受信 ----------------
function handleMessage(message) {
  if (!message) return;
  const address = message.address;
  totalCount++;

  const ch = channelByAddress[address];
  const values = message.values || [];
  if (!ch) {
    if (!(address in unknownAddresses)) {
      unknownAddresses[address] = 0;
      pushLog(`unknown address <color=#ffd24d>${address}</color> (${values.length} args)`);
    }
    unknownAddresses[address]++;
    return;
  }

  const nums = [];
  for (const v of values) nums.push(oscNumber(v));

  if (ch.kind === "attitude") {
    if (nums.length < 3 || !isNum(nums[0]) || !isNum(nums[1]) || !isNum(nums[2])) {
      warnChannel(ch, `${address}: expected [roll, pitch, yaw, sv1, sv3], got ${values.length} args`);
      return;
    }
    ch.raw = nums;
    ch.plotValues = [nums[0], nums[1], nums[2]];
    attForwardDirty = true;
    if (PREVIEW_ATTITUDE) previewDirty = true;
  } else if (ch.kind === "position") {
    if (nums.length < 3 || !isNum(nums[0]) || !isNum(nums[1]) || !isNum(nums[2])) {
      warnChannel(ch, `${address}: expected [x, y, z] (m), got ${values.length} args`);
      return;
    }
    ch.raw = nums;
    ch.plotValues = [nums[0], nums[1], nums[2]];
    posForwardDirty = true;
  } else {
    if (nums.length < 4 || !isNum(nums[0]) || !isNum(nums[1]) || !isNum(nums[2]) || !isNum(nums[3])) {
      warnChannel(ch, `${address}: expected [x, y, z, w] (4 floats), got ${values.length} args`);
      return;
    }
    const x = nums[0], y = nums[1], z = nums[2], w = nums[3];
    const n = Math.sqrt(x * x + y * y + z * z + w * w);
    if (n < 1e-6) {
      warnChannel(ch, `${address}: zero-length quaternion`);
      return;
    }
    if (Math.abs(n - 1) > 0.01) {
      warnChannel(ch, `${address}: |q| = ${n.toFixed(3)} (normalized on receive)`);
    }
    ch.raw = nums;
    ch.norm = n;
    ch.quat = { x: x / n, y: y / n, z: z / n, w: w / n };
    ch.plotValues = quatToEulerDeg(ch.quat);
    surfForwardDirty = true;
    previewDirty = true;
  }

  ch.count++;
  ch.windowCount++;
  ch.lastTime = now;
}

_.oscHandle.onReceive((messages) => {
  for (const message of messages) {
    try {
      handleMessage(message);
    } catch (e) {
      pushLog(`<color=${COLOR_NG}>error: ${e}</color>`);
    }
  }
});

// ---------------- PlaneBody への転送 ----------------
const planeBody = _.worldItemReference("PlaneBody");

function send(type, arg) {
  try {
    _.sendTo(planeBody, type, arg);
  } catch (e) {
    if (now - sendErrorTime > 5) {
      sendErrorTime = now;
      pushLog(`<color=${COLOR_NG}>sendTo ${type} failed: ${e}</color>`);
    }
  }
}

// ---------------- 操縦者 (オペレーター) ----------------
// モニターのフォントは英数字のみなので、表示名に英数字以外が含まれる場合はユーザー ID を表示する
function displayName(name, userId) {
  if (typeof name === "string" && /^[\x20-\x7e]+$/.test(name)) return name;
  if (typeof userId === "string" && userId.length > 0) return `@${userId}`;
  return "unknown";
}

let myName = "unknown";
try {
  myName = displayName(_.getUserDisplayName(_.playerId), _.getUserId(_.playerId));
} catch (e) {
  myName = "unknown";
}
// クリックで起動した直後は自分が操縦者
const operator = { isMe: true, name: myName };

_.onReceive((messageType, arg) => {
  if (messageType === "oscOperatorChanged") {
    operator.isMe = false;
    operator.name = arg && typeof arg.name === "string" ? arg.name : "unknown";
    pushLog(`<color=#ffd24d>operator changed to ${plain(operator.name)} - forwarding / OSC send stopped</color>`);
  } else if (messageType === "controlValues") {
    receiveControl(arg);
  } else if (messageType === "planeConfig") {
    receivePlaneConfig(arg);
  }
}, { item: true, player: false });

function forward() {
  if (!planeBody || !operator.isMe) return;
  if (attForwardDirty) {
    attForwardDirty = false;
    const v = channelByKey.att.plotValues;
    send("updateRotation", [v[0], v[1], v[2]]);
  }
  if (FORWARD_SURFACES && surfForwardDirty) {
    surfForwardDirty = false;
    const payload = {};
    for (const key of ["ail", "elv", "rud"]) {
      const q = channelByKey[key].quat;
      if (q) payload[key] = [q.x, q.y, q.z, q.w];
    }
    send("updateSurfaces", payload);
  }
  if (posForwardDirty) {
    posForwardDirty = false;
    const v = channelByKey.pos.plotValues;
    send("updatePosition", [v[0], v[1], v[2]]);
  }
}

// ---------------- 位置 (PlaneBody と同じ計算) ----------------
// PlaneBody から planeConfig が届くまでは PlaneBody.js の既定値を仮に使う
const planeConfig = { received: false, home: [0, 1.5, 0], scale: 1, min: [-4.5, 0.3, -4.5], max: [4.5, 9.5, 4.5] };

function isVec3(v) {
  return Array.isArray(v) && v.length >= 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]);
}

function receivePlaneConfig(arg) {
  if (!arg || !isVec3(arg.home) || !isNum(arg.scale) || !isVec3(arg.min) || !isVec3(arg.max)) return;
  planeConfig.home = arg.home.slice(0, 3);
  planeConfig.scale = arg.scale;
  planeConfig.min = arg.min.slice(0, 3);
  planeConfig.max = arg.max.slice(0, 3);
  planeConfig.received = true;
  trackDirty = true;
  if (track) drawTrackStatic();
  pushLog(`plane config: home (${planeConfig.home.map((v) => v.toFixed(2)).join(", ")}) scale x${planeConfig.scale}`);
}

// 受信値 (m) -> PlaneBody のワールド座標。clamped = 部屋の範囲で切り詰めたか
function worldPosition(raw) {
  const world = [];
  let clamped = false;
  for (let i = 0; i < 3; i++) {
    const v = planeConfig.home[i] + raw[i] * planeConfig.scale;
    const c = clamp(v, planeConfig.min[i], planeConfig.max[i]);
    if (c !== v) clamped = true;
    world.push(c);
  }
  return { world, clamped };
}

// ---------------- OSC 送信 (ControlPanel -> 外部) ----------------
const controlPanel = _.worldItemReference("ControlPanel");
const TX_AXES = ["aileron", "elevator", "rudder"];
const TX_PID_AXES = ["roll", "pitch", "yaw"];
const tx = {
  values: null,      // { aileron, elevator, rudder } (deg)。ControlPanel から届くまで null
  pid: {},           // { roll: [kp, ki, kd], ... }。ボタンが押された軸だけ入る
  seq: 0,
  dirty: false,
  timer: 0,
  sent: 0,           // 送信した回数 (1 回 = /plane/trim + /plane/pid/*)
  lastSendTime: -1,
  enabled: null,     // isSendEnabled() の最後の値
  errorTime: -999,
};

function receiveControl(arg) {
  if (!arg || typeof arg !== "object") return;
  const values = {};
  for (const axis of TX_AXES) {
    if (!isNum(arg[axis])) return;
    values[axis] = arg[axis];
  }
  const pid = {};
  const src = arg.pid && typeof arg.pid === "object" ? arg.pid : {};
  for (const axis of TX_PID_AXES) {
    const g = src[axis];
    if (Array.isArray(g) && g.length === 3 && g.every(isNum)) pid[axis] = g.slice();
  }
  tx.values = values;
  tx.pid = pid;
  tx.seq = isNum(arg.seq) ? arg.seq : tx.seq + 1;
  tx.dirty = true;
}

function axisAngleQuat(axis, degrees) {
  const n = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]) || 1;
  const half = (degrees / R2D) * 0.5;
  const s = Math.sin(half) / n;
  return { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(half) };
}

function floats(list) {
  return list.map((v) => OscValue.float(v));
}

function oscSendEnabled() {
  let enabled = null;
  try {
    enabled = _.oscHandle.isSendEnabled();
  } catch (e) {
    enabled = null;
  }
  if (enabled !== tx.enabled) {
    if (enabled === false) {
      pushLog(`<color=${COLOR_NG}>OSC send is OFF - enable OSC send in cluster Settings > Other</color>`);
    } else if (enabled === true && tx.enabled === false) {
      pushLog(`<color=${COLOR_OK}>OSC send is ON</color>`);
    }
    tx.enabled = enabled;
    notifyTxStatus();
  }
  return enabled === true;
}

// ControlPanel の表示 (TX 状態) 用。操縦者のときだけ、変化したときに送る
function notifyTxStatus() {
  if (!TX_ENABLED || !controlPanel || !operator.isMe) return;
  try {
    _.sendTo(controlPanel, "txStatus", { sendEnabled: tx.enabled });
  } catch (e) {
    // 表示のためだけなので無視
  }
}

function sendControl() {
  const v = tx.values;
  const messages = [];
  if (TX_SEND_TRIM) {
    messages.push(new OscMessage("/plane/trim", floats([v.aileron, v.elevator, v.rudder])));
  }
  if (TX_SEND_PID) {
    for (const axis of TX_PID_AXES) {
      const g = tx.pid[axis];
      if (g) messages.push(new OscMessage(`/plane/pid/${axis}`, floats(g)));
    }
  }
  if (TX_SEND_QUATS) {
    for (const axis of TX_AXES) {
      const q = axisAngleQuat(TX_HINGE_AXES[axis], v[axis]);
      messages.push(new OscMessage(`/plane/${axis}/quat`, floats([q.x, q.y, q.z, q.w])));
    }
  }
  // 1 メッセージ = 1 パケットで送る (受信側が OSC バンドルに対応していなくても読めるように)
  for (const m of messages) _.oscHandle.send(m);
  tx.sent++;
  tx.lastSendTime = now;
}

function txTick(dt) {
  if (!TX_ENABLED || !operator.isMe || !tx.values) return;
  tx.timer += dt;
  const keepalive = TX_KEEPALIVE_SEC > 0 && tx.timer >= TX_KEEPALIVE_SEC;
  if (!tx.dirty && !keepalive) return;
  if (!oscSendEnabled()) return; // ON になったら次の keepalive で送る (dirty は残す)
  tx.dirty = false;
  tx.timer = 0;
  try {
    sendControl();
  } catch (e) {
    if (now - tx.errorTime > 5) {
      tx.errorTime = now;
      pushLog(`<color=${COLOR_NG}>OSC send failed: ${e}</color>`);
    }
  }
}

function txText() {
  if (!TX_ENABLED) return `TX <color=${COLOR_DIM}>disabled</color>`;
  if (!controlPanel) return `TX <color=${COLOR_NG}>ControlPanel not linked</color>`;
  const state = !operator.isMe
    ? `<color=${COLOR_DIM}>OFF (not operator)</color>`
    : tx.enabled === false
      ? `<color=${COLOR_NG}>OSC SEND OFF</color>`
      : tx.values
        ? `<color=${COLOR_OK}>ON</color>`
        : `<color=${COLOR_DIM}>waiting for ControlPanel</color>`;
  if (!tx.values) return `TX ${state}`;
  const v = tx.values;
  const age = tx.lastSendTime < 0 ? "-" : `${(now - tx.lastSendTime).toFixed(1)}s`;
  // PID は送っている軸だけ明るく表示する
  const pid = TX_PID_AXES.map((a) => (tx.pid[a] ? a[0].toUpperCase() : `<color=${COLOR_DIM}>${a[0]}</color>`)).join("");
  return `TX ${state}  <mspace=0.56em>TRIM A${fmt(v.aileron, 1, 5)} E${fmt(v.elevator, 1, 5)} R${fmt(v.rudder, 1, 5)}</mspace>` +
    `  PID ${pid}  <color=${COLOR_DIM}>n ${tx.sent}  ${age}</color>`;
}

// ---------------- モニター UI ----------------
function textHandle(id) {
  const obj = _.playerLocalObject(id);
  if (!obj) return null;
  let comp = null;
  try {
    comp = obj.getUnityComponent("TextMeshProUGUI");
  } catch (e) {
    comp = null;
  }
  return comp ? { comp, last: null } : null;
}

function setText(handle, text) {
  if (!handle || handle.last === text) return;
  handle.last = text;
  try {
    handle.comp.unityProp.text = text;
  } catch (e) {
    // UI が壊れていても受信・転送は止めない
  }
}

function polyline(obj, id, rgb, width) {
  const p = obj.polyline(id);
  p.setColor(rgb[0], rgb[1], rgb[2]);
  p.setWidth(width);
  return p;
}

function toVectors(points) {
  return points.map((p) => new Vector3(p[0], p[1], p[2]));
}

// グラフ: ローカル座標は m 単位 (Setup で lossyScale = 1 にしてある)。原点 = 左下
function setupPlot(id, ch) {
  const obj = _.playerLocalObject(id);
  if (!obj) return null;
  let w = 0.78, h = 0.28;
  try {
    const rt = obj.getUnityComponent("RectTransform");
    const size = rt ? rt.unityProp.sizeDelta : null;
    if (size && size.x > 0 && size.y > 0) {
      w = size.x;
      h = size.y;
    }
  } catch (e) {
    // 既定サイズのまま
  }
  const gridRgb = [0.28, 0.3, 0.35];
  polyline(obj, "frame", gridRgb, 0.002).setPoints(toVectors([[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0], [0, 0, 0]]));
  polyline(obj, "zero", [0.5, 0.52, 0.58], 0.002).setPoints(toVectors([[0, h / 2, 0], [w, h / 2, 0]]));
  polyline(obj, "upper", gridRgb, 0.0015).setPoints(toVectors([[0, h * 0.75, 0], [w, h * 0.75, 0]]));
  polyline(obj, "lower", gridRgb, 0.0015).setPoints(toVectors([[0, h * 0.25, 0], [w, h * 0.25, 0]]));

  const lines = [];
  const points = [];
  for (let s = 0; s < 3; s++) {
    lines.push(polyline(obj, `series${s}`, SERIES_RGB[s], SERIES_WIDTH));
    const arr = [];
    for (let i = 0; i < SAMPLES; i++) arr.push(new Vector3(0, 0, 0));
    points.push(arr);
  }
  return { w, h, lines, points };
}

function pickRange(ch, maxAbs) {
  const steps = ch.rangeSteps || RANGE_STEPS;
  const need = Math.max(ch.minRange, maxAbs * 1.05);
  let target = steps[steps.length - 1];
  for (const r of steps) {
    if (r >= need) {
      target = r;
      break;
    }
  }
  if (target > ch.range) return target;                         // 拡大はすぐ
  if (target < ch.range && maxAbs < ch.range * 0.6) return target; // 縮小は余裕があるときだけ
  return ch.range;
}

function sampleChannel(ch) {
  if (ch.lastTime < 0) return; // まだ一度も受信していない
  for (let s = 0; s < 3; s++) ch.hist[s][ch.head] = ch.plotValues[s];
  ch.head = (ch.head + 1) % SAMPLES;
  if (ch.filled < SAMPLES) ch.filled++;
}

function drawGraph(ch) {
  const plot = ch.plot;
  if (!plot) return;
  const n = ch.filled;
  // filled は減らないので clear() は不要。clear() すると色が既定の白に戻るため呼ばない
  if (n < 2) return;
  const start = (ch.head - n + SAMPLES) % SAMPLES;
  let maxAbs = 0;
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < n; i++) {
      const v = Math.abs(ch.hist[s][(start + i) % SAMPLES]);
      if (v > maxAbs) maxAbs = v;
    }
  }
  ch.range = pickRange(ch, maxAbs);

  const dx = plot.w / (SAMPLES - 1);
  const x0 = (SAMPLES - n) * dx; // 新しいサンプルが右端
  const half = plot.h * 0.5;
  for (let s = 0; s < 3; s++) {
    const arr = n === SAMPLES ? plot.points[s] : plot.points[s].slice(0, n);
    for (let i = 0; i < n; i++) {
      const v = ch.hist[s][(start + i) % SAMPLES];
      arr[i].set(x0 + i * dx, half + clamp(v / ch.range, -1, 1) * half, 0);
    }
    plot.lines[s].setPoints(arr);
  }
  // 点が無い状態で設定した色は反映されないことがあるので、最初に点を入れた後にもう一度設定する
  if (!plot.styled) {
    plot.styled = true;
    for (let s = 0; s < 3; s++) {
      plot.lines[s].setColor(SERIES_RGB[s][0], SERIES_RGB[s][1], SERIES_RGB[s][2]);
      plot.lines[s].setWidth(SERIES_WIDTH);
    }
  }
}

// 右エルロン用: 左の受信値を左右対称 (YZ 平面で鏡映) にしたうえで逆回転させる。
// ヒンジ軸 (X) まわりの角度は左と反対になり、Y/Z 成分は左右対称になる。
function opposite(q) {
  return { x: -q.x, y: q.y, z: q.z, w: q.w };
}

// 舵面プレビュー: ローカル座標は m 単位、機体座標 (X=右 Y=上 Z=前)
// hinge: ヒンジ中心, plate: ヒンジ中心からの相対座標 (後縁側が -Z)
// source: どのチャンネルのクォータニオンを使うか, transform: 表示前に掛ける変換
const AILERON_PLATE = [[-0.055, 0, 0], [0.055, 0, 0], [0.055, 0, -0.04], [-0.055, 0, -0.04]];
const SURFACE_GEOMETRY = {
  ailL: { source: "ail", hinge: [-0.17, 0, 0], plate: AILERON_PLATE, rgb: [1.0, 0.65, 0.2] },
  ailR: { source: "ail", transform: opposite, hinge: [0.17, 0, 0], plate: AILERON_PLATE, rgb: [1.0, 0.65, 0.2] },
  elv: { source: "elv", hinge: [0, 0, -0.22], plate: [[-0.09, 0, 0], [0.09, 0, 0], [0.09, 0, -0.035], [-0.09, 0, -0.035]], rgb: [0.2, 0.85, 1.0] },
  rud: { source: "rud", hinge: [0, 0.055, -0.22], plate: [[0, -0.045, 0], [0, 0.045, 0], [0, 0.045, -0.035], [0, -0.045, -0.035]], rgb: [1.0, 0.4, 0.8] },
};

// 機体の線画 (機体座標, m)。axis* は機体ローカル軸の表示
const BODY_RGB = [0.7, 0.72, 0.78];
const AXIS_O = [0.17, 0, -0.2];
const AXIS_L = 0.06;
const BODY_SHAPES = [
  { id: "fuselage", rgb: BODY_RGB, width: 0.004, points: [[0, 0, 0.22], [0, 0, -0.26]] },
  { id: "wing", rgb: BODY_RGB, width: 0.003, points: [[-0.24, 0, 0], [0.24, 0, 0], [0.24, 0, 0.07], [-0.24, 0, 0.07], [-0.24, 0, 0]] },
  { id: "hstab", rgb: BODY_RGB, width: 0.003, points: [[-0.1, 0, -0.18], [0.1, 0, -0.18], [0.1, 0, -0.22], [-0.1, 0, -0.22], [-0.1, 0, -0.18]] },
  { id: "vfin", rgb: BODY_RGB, width: 0.003, points: [[0, 0, -0.15], [0, 0.1, -0.2], [0, 0.1, -0.22], [0, 0, -0.22], [0, 0, -0.15]] },
  { id: "axisX", rgb: SERIES_RGB[0], width: 0.003, points: [AXIS_O, [AXIS_O[0] + AXIS_L, AXIS_O[1], AXIS_O[2]]] },
  { id: "axisY", rgb: SERIES_RGB[1], width: 0.003, points: [AXIS_O, [AXIS_O[0], AXIS_O[1] + AXIS_L, AXIS_O[2]]] },
  { id: "axisZ", rgb: SERIES_RGB[2], width: 0.003, points: [AXIS_O, [AXIS_O[0], AXIS_O[1], AXIS_O[2] + AXIS_L]] },
];

// 機体座標の点 p に姿勢 att (null = 水平) を掛けて out に書き込む
function setPoint(out, att, x, y, z) {
  if (att) {
    const r = rotate(att, x, y, z);
    out.set(r[0], r[1], r[2]);
  } else {
    out.set(x, y, z);
  }
}

// 舵面の板: ヒンジまわりに q (null = 中立) で回し、さらに機体姿勢 att を掛ける
function platePoints(geom, q, att, out) {
  for (let i = 0; i < 5; i++) {
    const c = geom.plate[i % 4];
    const r = q ? rotate(q, c[0], c[1], c[2]) : c;
    setPoint(out[i], att, geom.hinge[0] + r[0], geom.hinge[1] + r[1], geom.hinge[2] + r[2]);
  }
  return out;
}

function bodyPoints(shape, att, out) {
  for (let i = 0; i < shape.points.length; i++) {
    const p = shape.points[i];
    setPoint(out[i], att, p[0], p[1], p[2]);
  }
  return out;
}

function vectors(n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(new Vector3(0, 0, 0));
  return arr;
}

// プレビューに掛ける機体姿勢。PlaneBody.js と同じく Euler(pitch, yaw, roll)
function previewAttitude() {
  if (!PREVIEW_ATTITUDE) return null;
  const ch = channelByKey.att;
  if (ch.lastTime < 0) return null;
  const v = ch.plotValues; // [roll, pitch, yaw]
  return eulerDegToQuat(v[1], PREVIEW_YAW ? v[2] : 0, v[0]);
}

function setupPreview(id) {
  const obj = _.playerLocalObject(id);
  if (!obj) return null;
  const body = [];
  for (const shape of BODY_SHAPES) {
    const line = polyline(obj, shape.id, shape.rgb, shape.width);
    const out = vectors(shape.points.length);
    line.setPoints(bodyPoints(shape, null, out));
    body.push({ shape, line, out });
  }
  const surfaces = [];
  for (const key of Object.keys(SURFACE_GEOMETRY)) {
    const geom = SURFACE_GEOMETRY[key];
    const neutralLine = polyline(obj, `${key}Neutral`, [0.42, 0.42, 0.48], 0.002);
    const neutral = vectors(5);
    neutralLine.setPoints(platePoints(geom, null, null, neutral));
    const line = polyline(obj, key, geom.rgb, 0.006);
    const live = vectors(5);
    line.setPoints(platePoints(geom, null, null, live));
    surfaces.push({ geom, line, live, neutralLine, neutral });
  }
  return { body, surfaces };
}

function drawPreview() {
  if (!preview || !previewDirty) return;
  previewDirty = false;
  const att = previewAttitude();
  if (att) {
    for (const b of preview.body) b.line.setPoints(bodyPoints(b.shape, att, b.out));
  }
  for (const s of preview.surfaces) {
    if (att) s.neutralLine.setPoints(platePoints(s.geom, null, att, s.neutral));
    const q = channelByKey[s.geom.source].quat;
    if (q || att) {
      const sq = q && s.geom.transform ? s.geom.transform(q) : q;
      s.line.setPoints(platePoints(s.geom, sq, att, s.live));
    }
  }
}

// ---------------- TRACK (上から見た軌跡) ----------------
// 部屋 (PlaneBody の POS_MIN..MAX) を上から見た図に、機体のワールド位置の軌跡と現在位置 (機首方位つき) を描く
const TRACK_SAMPLES = Math.max(2, Math.round(TRACK_SECONDS * SAMPLE_HZ));
const TRACK_RGB = [1.0, 0.82, 0.3];
const MARKER_RGB = [1.0, 1.0, 1.0];
let track = null;
let trackDirty = false;
const trackHist = [];
for (let i = 0; i < TRACK_SAMPLES; i++) trackHist.push([0, 0]);
let trackHead = 0;
let trackFilled = 0;
let trackLastCount = -1;

// ワールド (x, z) -> TRACK のローカル座標 (m)
function trackMap(x, z, out) {
  const t = track;
  const sign = TRACK_VIEW_FROM_SPAWN ? -1 : 1;
  out.set(t.w / 2 + sign * (x - t.cx) * t.s, t.h / 2 + sign * (z - t.cz) * t.s, 0);
  return out;
}

function setupTrack(id) {
  const obj = _.playerLocalObject(id);
  if (!obj) return null;
  let w = 0.78, h = 0.42;
  try {
    const rt = obj.getUnityComponent("RectTransform");
    const size = rt ? rt.unityProp.sizeDelta : null;
    if (size && size.x > 0 && size.y > 0) {
      w = size.x;
      h = size.y;
    }
  } catch (e) {
    // 既定サイズのまま
  }
  track = {
    w, h, cx: 0, cz: 0, s: 1, styled: false,
    room: polyline(obj, "room", [0.45, 0.47, 0.53], 0.002),
    homeX: polyline(obj, "homeX", [0.5, 0.52, 0.58], 0.0015),
    homeZ: polyline(obj, "homeZ", [0.5, 0.52, 0.58], 0.0015),
    trail: polyline(obj, "trail", TRACK_RGB, 0.004),
    marker: polyline(obj, "marker", MARKER_RGB, 0.004),
    trailPts: vectors(TRACK_SAMPLES),
    markerPts: vectors(4),
  };
  drawTrackStatic();
  return track;
}

// 部屋の枠と初期位置 (planeConfig が変わったら描き直す)
function drawTrackStatic() {
  const t = track;
  const mn = planeConfig.min, mx = planeConfig.max;
  const spanX = Math.max(1e-3, mx[0] - mn[0]);
  const spanZ = Math.max(1e-3, mx[2] - mn[2]);
  t.s = Math.min(t.w / spanX, t.h / spanZ) * 0.94;
  t.cx = (mn[0] + mx[0]) / 2;
  t.cz = (mn[2] + mx[2]) / 2;
  const corners = [[mn[0], mn[2]], [mx[0], mn[2]], [mx[0], mx[2]], [mn[0], mx[2]], [mn[0], mn[2]]];
  t.room.setPoints(corners.map((c) => trackMap(c[0], c[1], new Vector3(0, 0, 0))));
  const hm = planeConfig.home;
  const k = 0.2; // 十字の大きさ (ワールド m)
  t.homeX.setPoints([trackMap(hm[0] - k, hm[2], new Vector3(0, 0, 0)), trackMap(hm[0] + k, hm[2], new Vector3(0, 0, 0))]);
  t.homeZ.setPoints([trackMap(hm[0], hm[2] - k, new Vector3(0, 0, 0)), trackMap(hm[0], hm[2] + k, new Vector3(0, 0, 0))]);
}

// 新しい位置を受信していたら軌跡に 1 点足す
function sampleTrack() {
  const ch = channelByKey.pos;
  if (ch.lastTime < 0 || ch.count === trackLastCount) return false;
  trackLastCount = ch.count;
  const w = worldPosition(ch.raw).world;
  trackHist[trackHead][0] = w[0];
  trackHist[trackHead][1] = w[2];
  trackHead = (trackHead + 1) % TRACK_SAMPLES;
  if (trackFilled < TRACK_SAMPLES) trackFilled++;
  return true;
}

function drawTrack(changed) {
  if (!track || (!changed && !trackDirty)) return;
  trackDirty = false;
  const n = trackFilled;
  if (n < 1) return;
  const t = track;
  const start = (trackHead - n + TRACK_SAMPLES) % TRACK_SAMPLES;
  if (n >= 2) {
    const arr = n === TRACK_SAMPLES ? t.trailPts : t.trailPts.slice(0, n);
    for (let i = 0; i < n; i++) {
      const p = trackHist[(start + i) % TRACK_SAMPLES];
      trackMap(p[0], p[1], arr[i]);
    }
    t.trail.setPoints(arr);
  }
  // 現在位置: 機首方位 (yaw) を向いた三角形。姿勢が無ければ +Z 向き
  const cur = trackHist[(trackHead - 1 + TRACK_SAMPLES) % TRACK_SAMPLES];
  const att = channelByKey.att;
  const yaw = att.lastTime >= 0 ? att.plotValues[2] / R2D : 0;
  const fx = Math.sin(yaw), fz = Math.cos(yaw); // 前
  const rx = fz, rz = -fx;                      // 右
  const L = 0.35;                               // ワールド m
  const m = t.markerPts;
  trackMap(cur[0] + fx * L, cur[1] + fz * L, m[0]);
  trackMap(cur[0] - fx * L * 0.6 + rx * L * 0.5, cur[1] - fz * L * 0.6 + rz * L * 0.5, m[1]);
  trackMap(cur[0] - fx * L * 0.6 - rx * L * 0.5, cur[1] - fz * L * 0.6 - rz * L * 0.5, m[2]);
  trackMap(cur[0] + fx * L, cur[1] + fz * L, m[3]);
  t.marker.setPoints(m);
  // 点が無い状態で設定した色は反映されないことがあるので、最初に点を入れた後にもう一度設定する
  if (!t.styled && n >= 2) {
    t.styled = true;
    t.trail.setColor(TRACK_RGB[0], TRACK_RGB[1], TRACK_RGB[2]);
    t.trail.setWidth(0.004);
    t.marker.setColor(MARKER_RGB[0], MARKER_RGB[1], MARKER_RGB[2]);
    t.marker.setWidth(0.004);
  }
}

function trackInfoText() {
  const ch = channelByKey.pos;
  const view = TRACK_VIEW_FROM_SPAWN ? "up = -Z, right = -X (as seen facing this board)" : "up = +Z, right = +X";
  if (ch.lastTime < 0) return `<color=${COLOR_DIM}>waiting for /plane/pos   ${view}</color>`;
  const w = worldPosition(ch.raw);
  return `world (${w.world.map((v) => v.toFixed(2)).join(", ")}) m` +
    (w.clamped ? `  <color=${COLOR_NG}>CLAMPED</color>` : "") +
    `   <color=${COLOR_DIM}>${view}</color>`;
}

function signalState(ch) {
  if (ch.lastTime < 0) return { label: `<color=${COLOR_DIM}>WAITING</color>`, age: null };
  const age = now - ch.lastTime;
  if (age >= STALE_SEC) return { label: `<color=${COLOR_NG}>NO SIGNAL</color>`, age };
  return { label: `<color=${COLOR_OK}>LIVE</color>`, age };
}

function valuesText(ch) {
  if (ch.lastTime < 0) return `<color=${COLOR_DIM}>no data yet - waiting for ${ch.address}</color>`;
  if (ch.kind === "attitude") {
    const r = ch.raw;
    return "<mspace=0.56em>" +
      `roll ${fmt(r[0], 2, 8)}  pitch ${fmt(r[1], 2, 8)}  yaw ${fmt(r[2], 2, 8)} deg\n` +
      `sv1  ${fmt(r[3], 2, 8)}  sv3   ${fmt(r[4], 2, 8)}  args ${r.length}` +
      "</mspace>";
  }
  if (ch.kind === "position") {
    const r = ch.raw;
    const wp = worldPosition(r);
    const w = wp.world;
    const cfg = planeConfig.received ? "" : `  <color=${COLOR_DIM}>(default config)</color>`;
    return "<mspace=0.56em>" +
      `recv  x ${fmt(r[0], 2, 9)} y ${fmt(r[1], 2, 9)} z ${fmt(r[2], 2, 9)} m
` +
      `world x ${fmt(w[0], 2, 9)} y ${fmt(w[1], 2, 9)} z ${fmt(w[2], 2, 9)} m
` +
      "</mspace>" +
      `scale x${planeConfig.scale}  home (${planeConfig.home.map((v) => v.toFixed(2)).join(", ")})` +
      (wp.clamped ? `  <color=${COLOR_NG}>CLAMPED (out of room)</color>` : "") + cfg;
  }
  const r = ch.raw;
  const e = ch.plotValues;
  const aa = quatToAxisAngle(ch.quat);
  return "<mspace=0.56em>" +
    `q  x ${fmt(r[0], 4, 7)} y ${fmt(r[1], 4, 7)} z ${fmt(r[2], 4, 7)} w ${fmt(r[3], 4, 7)} |q| ${ch.norm.toFixed(3)}\n` +
    `euler  X ${fmt(e[0], 2, 7)}  Y ${fmt(e[1], 2, 7)}  Z ${fmt(e[2], 2, 7)} deg\n` +
    `angle ${aa.angle.toFixed(2).padStart(6)} deg  axis (${fmt(aa.axis[0], 2, 5)},${fmt(aa.axis[1], 2, 5)},${fmt(aa.axis[2], 2, 5)})` +
    "</mspace>";
}

function updateTexts() {
  let rx = null;
  try {
    rx = _.oscHandle.isReceiveEnabled();
  } catch (e) {
    rx = null;
  }
  const rxText = rx === true
    ? `<color=${COLOR_OK}>OSC RX ON</color>`
    : rx === false
      ? `<color=${COLOR_NG}>OSC RX OFF - enable OSC receive in cluster Settings > Other</color>`
      : `<color=${COLOR_DIM}>OSC RX ?</color>`;
  setText(ui.status, `${rxText}   msgs ${totalCount}   t ${now.toFixed(0)} s`);
  setText(ui.tx, txText());
  setText(ui.operator, operator.isMe
    ? `OPERATOR <color=${COLOR_OK}>${plain(operator.name)} (you)</color>   <color=${COLOR_DIM}>your OSC drives PlaneBody</color>`
    : `OPERATOR <color=#ffd24d>${plain(operator.name)}</color>   <color=${COLOR_NG}>monitor only - click Cube_OSC_Trigger to take control</color>`);

  for (const ch of CHANNELS) {
    if (!ch.ui) continue;
    const st = signalState(ch);
    const age = st.age === null ? "-" : `${st.age.toFixed(2)} s`;
    setText(ch.ui.info, `${st.label}   ${ch.hz.toFixed(1)} Hz   n ${ch.count}   age ${age}`);
    const legend = ch.series.map((name, i) => `<color=${SERIES_HEX[i]}>${name}</color>`).join("  ");
    const unit = ch.kind === "attitude" ? "deg" : ch.kind === "position" ? "m" : "deg (euler)";
    setText(ch.ui.range, `range +/-${ch.range} ${unit}   last ${GRAPH_SECONDS}s   ${legend}`);
    setText(ch.ui.values, valuesText(ch));
  }

  const unknown = Object.keys(unknownAddresses);
  let log = logLines.length > 0 ? logLines.join("\n") : `<color=${COLOR_DIM}>no events</color>`;
  if (unknown.length > 0) {
    log += `\n<color=${COLOR_DIM}>unknown: ${unknown.map((a) => `${a} x${unknownAddresses[a]}`).join(", ")}</color>`;
  }
  setText(ui.log, log);
  setText(ui.track, trackInfoText());
}

// ---------------- 初期化 ----------------
const ui = { status: null, operator: null, tx: null, log: null, track: null };
let preview = null;
try {
  ui.status = textHandle("oscmon.status");
  ui.tx = textHandle("oscmon.tx");
  ui.operator = textHandle("oscmon.operator");
  ui.log = textHandle("oscmon.log");
  for (const ch of CHANNELS) {
    ch.ui = {
      info: textHandle(`oscmon.${ch.key}.info`),
      values: textHandle(`oscmon.${ch.key}.values`),
      range: textHandle(`oscmon.${ch.key}.range`),
    };
    ch.plot = setupPlot(`oscmon.${ch.key}.plot`, ch);
  }
  preview = setupPreview("oscmon.preview");
  ui.track = textHandle("oscmon.track.info");
  setupTrack("oscmon.track.plot");
  if (!ui.status) {
    _.log("[OscFlight] monitor UI not found. Run Tools > OSC Flight > Setup Monitor In Open Scene in Unity.");
  }
} catch (e) {
  _.log(`[OscFlight] monitor setup failed: ${e}`);
}

if (planeBody) {
  // PlaneBody はこの後 claimOperator を送ったプレイヤーの更新だけを受け付ける
  send("claimOperator", myName);
  send("updateRotation", [0, 0, 0]);
  send("resetPosition", true);
} else {
  pushLog(`<color=${COLOR_NG}>PlaneBody reference not found (WorldItemReferenceList)</color>`);
}
if (TX_ENABLED) {
  if (controlPanel) {
    // ControlPanel はこの後、舵角が変わるたびに "controlValues" をこのスクリプトへ送ってくる
    try {
      oscSendEnabled();
      _.sendTo(controlPanel, "subscribeControl", { name: myName, sendEnabled: tx.enabled });
    } catch (e) {
      pushLog(`<color=${COLOR_NG}>sendTo subscribeControl failed: ${e}</color>`);
    }
  } else {
    pushLog(`<color=${COLOR_NG}>ControlPanel reference not found (WorldItemReferenceList) - OSC send disabled</color>`);
    oscSendEnabled();
  }
}
pushLog(`player script started - operator: ${plain(myName)}`);
updateTexts();

// ---------------- フレーム処理 ----------------
let rateTimer = 0;
let forwardTimer = 0;
let sampleTimer = 0;
let textTimer = 0;

_.onFrame((dt) => {
  now += dt;

  rateTimer += dt;
  if (rateTimer >= 1) {
    for (const ch of CHANNELS) {
      ch.hz = ch.windowCount / rateTimer;
      ch.windowCount = 0;
    }
    rateTimer = 0;
    // 設定で OSC 送信を切り替えたときに TX 表示 (モニター / ControlPanel) を追従させる
    if (TX_ENABLED && operator.isMe) oscSendEnabled();
  }

  forwardTimer += dt;
  if (forwardTimer >= 1 / FORWARD_HZ) {
    forwardTimer = 0;
    forward();
  }

  txTick(dt);

  sampleTimer += dt;
  if (sampleTimer >= 1 / SAMPLE_HZ) {
    sampleTimer = sampleTimer >= 2 / SAMPLE_HZ ? 0 : sampleTimer - 1 / SAMPLE_HZ;
    try {
      for (const ch of CHANNELS) {
        sampleChannel(ch);
        drawGraph(ch);
      }
      drawPreview();
      drawTrack(sampleTrack());
    } catch (e) {
      _.log(`[OscFlight] draw error: ${e}`);
    }
  }

  textTimer += dt;
  if (textTimer >= 1 / TEXT_HZ) {
    textTimer = 0;
    updateTexts();
  }
});
