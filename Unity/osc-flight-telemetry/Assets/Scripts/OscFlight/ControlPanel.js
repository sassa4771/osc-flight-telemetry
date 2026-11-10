// =====================================================================
// ControlPanel.js  - Scriptable Item (ControlPanel)
//
// トリム角 (エルロン / エレベーター / ラダー, deg) と PID ゲイン (roll / pitch / yaw の Kp, Ki, Kd) を
// 保持・表示し、OSC 送信役の PlayerScript に渡す。
// パネルの見た目は Unity メニュー「Tools > OSC Flight > Setup Control Panel In Open Scene」で生成する。
//
//   受信 (アイテムから)
//     "controlButton"     (なし)  ControlButton.js のボタンが押された。どのボタンかは sender で判別する
//                                 (このアイテムの WorldItemReferenceList の id。下の「ボタンの id」参照)
//     "buttonPress"       { axis, dir }  旧ボタン用。トリム角を dir だけ変える
//     "resetControl"      (なし)  トリム角をすべて 0 に戻す
//   受信 (PlayerScript から)
//     "subscribeControl"  { name, sendEnabled }  送信役になる (OscFlightPlayer.js の起動時に送られる)
//     "txStatus"          { sendEnabled }        送信役の OSC 送信設定が変わった
//     "resetControl"      (なし)  トリム角をすべて 0 に戻す
//   送信 (送信役の PlayerScript へ)
//     "controlValues"     { aileron, elevator, rudder, pid: { roll: [kp, ki, kd], ... }, seq }
//                         変更のたびに送る。pid にはボタンが一度でも押された軸だけ入る
//                         (機体側のゲインを PID_DEFAULTS で勝手に上書きしないため)
//
// ボタンの id (WorldItemReferenceList)
//   btn.<aileron|elevator|rudder>.<m10|m1|zero|p1|p10>     トリム -10 / -1 / 0 にする / +1 / +10
//   btn.reset                                              トリムをすべて 0
//   btn.pid.<roll|pitch|yaw>.<kp|ki|kd>.<m1|m01|m001|p001|p01|p1>   ゲイン -1 / -0.1 / -0.01 / +0.01 / +0.1 / +1
//
// 送信役 = 最後に Cube_OSC_Trigger をクリックした人 (= OSC 操縦者)。
// ボタンは誰が押してもよい (値は全員で共有され、送信は操縦者の cluster から行われる)。
//
// 表示用のサブノード (すべてこのアイテムの直下)
//   Status                         TextMeshPro  送信状態
//   <axis>_value                   TextMeshPro  トリム角
//   <axis>_indicator               ゲージの針 (setPosition で動かす)
//   <axis>_gaugeMin / _gaugeMax    ゲージの両端 (TRIM_MIN / TRIM_MAX の位置)
//   pid_<axis>_<param>_value       TextMeshPro  ゲイン
//   pid_<axis>_state               TextMeshPro  その軸を送っているか
//   旧レイアウトの Aileron_Text / Elevator_Text / Rudder_Text にも対応
// =====================================================================

// ---------------- 設定 ----------------
const TRIM_MIN = -30.0;
const TRIM_MAX = 30.0;
const GAIN_MIN = 0.0;
const GAIN_MAX = 10.0;
// ボタンを押す前の表示と、最初に押したときの基準値。機体側の現在のゲインに合わせておくとよい
const PID_DEFAULTS = {
  roll: { kp: 0, ki: 0, kd: 0 },
  pitch: { kp: 0, ki: 0, kd: 0 },
  yaw: { kp: 0, ki: 0, kd: 0 },
};

// ---------------- 定数 ----------------
const AXES = ["aileron", "elevator", "rudder"];
const PID_AXES = ["roll", "pitch", "yaw"];
const PID_PARAMS = ["kp", "ki", "kd"];
const TRIM_STEPS = { m10: -10, m1: -1, zero: 0, p1: 1, p10: 10 }; // "zero" は 0 にセット
const GAIN_STEPS = { m1: -1, m01: -0.1, m001: -0.01, p001: 0.01, p01: 0.1, p1: 1 };
const ACCENT = { aileron: "#ffa633", elevator: "#33d9ff", rudder: "#ff66cc" };
const LEGACY_TEXT = { aileron: "Aileron_Text", elevator: "Elevator_Text", rudder: "Rudder_Text" };
const LEGACY_LABEL = { aileron: "AIL", elevator: "ELV", rudder: "RUD" };
const COLOR_OK = "#59ff73";
const COLOR_NG = "#ff5959";
const COLOR_DIM = "#8c8c94";
const CHECK_SEC = 1.0;

function isNum(v) {
  return typeof v === "number" && isFinite(v);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v) {
  return Math.round(v * 100) / 100; // 0.1 + 0.2 のような誤差を残さない
}

function signed(v) {
  return (v >= 0 ? "+" : "") + v.toFixed(1);
}

function plain(text) {
  return `<noparse>${String(text).replace(/<\/?noparse>/gi, "")}</noparse>`;
}

// ---------------- 値 ----------------
function trim(axis) {
  const v = $.state[axis];
  return isNum(v) ? v : 0;
}

function setTrim(axis, v) {
  $.state[axis] = clamp(v, TRIM_MIN, TRIM_MAX);
}

function gainKey(axis, param) {
  return `pid_${axis}_${param}`;
}

function gain(axis, param) {
  const v = $.state[gainKey(axis, param)];
  if (isNum(v)) return v;
  const d = PID_DEFAULTS[axis] && PID_DEFAULTS[axis][param];
  return isNum(d) ? clamp(d, GAIN_MIN, GAIN_MAX) : 0;
}

function setGain(axis, param, v) {
  $.state[gainKey(axis, param)] = round2(clamp(v, GAIN_MIN, GAIN_MAX));
  $.state[`pidSet_${axis}`] = true;
}

function pidSet(axis) {
  return $.state[`pidSet_${axis}`] === true;
}

// ---------------- サブノード ----------------
function node(name) {
  try {
    return $.subNode(name) || null;
  } catch (e) {
    return null;
  }
}

function tmp(name) {
  const n = node(name);
  if (!n) return null;
  try {
    return n.getUnityComponent("TextMeshPro");
  } catch (e) {
    return null;
  }
}

let ui = null;

function resolveUi() {
  if (ui) return ui;
  ui = { status: tmp("Status"), axes: {}, pid: {} };
  for (const axis of AXES) {
    const a = {
      value: tmp(`${axis}_value`),
      legacy: null,
      indicator: node(`${axis}_indicator`),
      min: null,
      max: null,
    };
    if (!a.value) a.legacy = tmp(LEGACY_TEXT[axis]);
    const minNode = node(`${axis}_gaugeMin`);
    const maxNode = node(`${axis}_gaugeMax`);
    try {
      a.min = minNode ? minNode.getPosition() : null;
      a.max = maxNode ? maxNode.getPosition() : null;
    } catch (e) {
      a.min = a.max = null;
    }
    if (!a.min || !a.max) a.indicator = null;
    ui.axes[axis] = a;
  }
  for (const axis of PID_AXES) {
    const p = { state: tmp(`pid_${axis}_state`), values: {} };
    for (const param of PID_PARAMS) p.values[param] = tmp(`pid_${axis}_${param}_value`);
    ui.pid[axis] = p;
  }
  return ui;
}

function setTmp(comp, text) {
  if (!comp) return;
  try {
    comp.unityProp.text = text;
  } catch (e) {
    $.log(`ControlPanel: failed to set text: ${e}`);
  }
}

// ---------------- 表示 ----------------
function updateTrim(axis) {
  const a = resolveUi().axes[axis];
  const v = trim(axis);
  if (a.value) {
    setTmp(a.value, `<color=${ACCENT[axis]}>${signed(v)}</color><size=38%><color=${COLOR_DIM}> deg</color></size>`);
  } else if (a.legacy) {
    setTmp(a.legacy, `${LEGACY_LABEL[axis]}: ${signed(v)}`);
  }
  if (a.indicator) {
    const t = (v - TRIM_MIN) / (TRIM_MAX - TRIM_MIN);
    try {
      a.indicator.setPosition(new Vector3(
        a.min.x + (a.max.x - a.min.x) * t,
        a.min.y + (a.max.y - a.min.y) * t,
        a.min.z + (a.max.z - a.min.z) * t,
      ));
    } catch (e) {
      $.log(`ControlPanel: failed to move ${axis}_indicator: ${e}`);
      a.indicator = null;
    }
  }
}

function updatePid(axis) {
  const p = resolveUi().pid[axis];
  const set = pidSet(axis);
  for (const param of PID_PARAMS) {
    const v = gain(axis, param).toFixed(2);
    setTmp(p.values[param], set ? v : `<color=${COLOR_DIM}>${v}</color>`);
  }
  setTmp(p.state, set
    ? `<color=${COLOR_OK}>SENDING</color>`
    : `<color=${COLOR_DIM}>NOT SENT</color>`);
}

function updateStatus() {
  const comp = resolveUi().status;
  if (!comp) return;
  const p = subscriber();
  let text;
  if (!p) {
    text = `TX  <color=${COLOR_DIM}>no operator - click the OSC button to start sending</color>`;
  } else {
    const name = plain($.state.subscriberName || p.id);
    const enabled = $.state.sendEnabled;
    text = enabled === true
      ? `TX <color=${COLOR_OK}>ON</color>  ${name}  <color=${COLOR_DIM}>/plane/trim + /plane/pid/*</color>`
      : enabled === false
        ? `TX <color=${COLOR_NG}>OSC SEND OFF</color>  ${name}  <color=${COLOR_DIM}>enable OSC send in cluster Settings > Other</color>`
        : `TX  ${name}`;
  }
  if ($.state.statusText === text) return;
  $.state.statusText = text;
  setTmp(comp, text);
}

function updateAll() {
  for (const axis of AXES) updateTrim(axis);
  for (const axis of PID_AXES) updatePid(axis);
  updateStatus();
}

// ---------------- 送信役 (PlayerScript) ----------------
function subscriber() {
  const p = $.state.subscriber;
  try {
    return p && p.exists() ? p : null;
  } catch (e) {
    return null;
  }
}

function isSubscriber(sender) {
  const p = subscriber();
  return !!(p && sender && sender.id === p.id);
}

function publish() {
  const seq = (isNum($.state.seq) ? $.state.seq : 0) + 1;
  $.state.seq = seq;
  const p = subscriber();
  if (!p) return;
  const pid = {};
  for (const axis of PID_AXES) {
    if (pidSet(axis)) pid[axis] = PID_PARAMS.map((param) => gain(axis, param));
  }
  try {
    p.send("controlValues", {
      aileron: trim("aileron"),
      elevator: trim("elevator"),
      rudder: trim("rudder"),
      pid,
      seq,
    });
  } catch (e) {
    $.log(`ControlPanel: failed to send controlValues: ${e}`);
  }
}

// ---------------- ボタン ----------------
// ボタン (ItemHandle) の id -> 動作
let buttons = null;

function resolveButtons() {
  buttons = {};
  let count = 0;
  const add = (refId, action) => {
    let handle = null;
    try {
      handle = $.worldItemReference(refId);
    } catch (e) {
      handle = null;
    }
    if (handle) {
      buttons[handle.id] = action;
      count++;
    }
  };
  for (const axis of AXES) {
    for (const key of Object.keys(TRIM_STEPS)) add(`btn.${axis}.${key}`, { kind: "trim", axis, key });
  }
  add("btn.reset", { kind: "reset" });
  for (const axis of PID_AXES) {
    for (const param of PID_PARAMS) {
      for (const key of Object.keys(GAIN_STEPS)) add(`btn.pid.${axis}.${param}.${key}`, { kind: "pid", axis, param, key });
    }
  }
  $.log(`ControlPanel: ${count} buttons linked`);
}

function applyAction(action) {
  if (action.kind === "reset") {
    for (const axis of AXES) setTrim(axis, 0);
    for (const axis of AXES) updateTrim(axis);
  } else if (action.kind === "trim") {
    setTrim(action.axis, action.key === "zero" ? 0 : trim(action.axis) + TRIM_STEPS[action.key]);
    updateTrim(action.axis);
  } else if (action.kind === "pid") {
    setGain(action.axis, action.param, gain(action.axis, action.param) + GAIN_STEPS[action.key]);
    updatePid(action.axis);
  }
  publish();
}

function onControlButton(sender) {
  if (!sender) return;
  if (!buttons) resolveButtons();
  let action = buttons[sender.id];
  if (!action) {
    resolveButtons(); // 参照が後から有効になった場合に備えて 1 回だけ引き直す
    action = buttons[sender.id];
  }
  if (!action) {
    $.log(`ControlPanel: unknown button ${sender.id} (not in WorldItemReferenceList)`);
    return;
  }
  applyAction(action);
}

// ---------------- イベント ----------------
$.onStart(() => {
  for (const axis of AXES) $.state[axis] = 0;
  for (const axis of PID_AXES) {
    $.state[`pidSet_${axis}`] = false;
    for (const param of PID_PARAMS) $.state[gainKey(axis, param)] = null; // PID_DEFAULTS を使う
  }
  $.state.seq = 0;
  $.state.subscriber = null;
  $.state.subscriberName = null;
  $.state.sendEnabled = null;
  $.state.statusText = null;
  updateAll();
});

$.onReceive((messageType, arg, sender) => {
  if (messageType === "controlButton") {
    onControlButton(sender);
  } else if (messageType === "buttonPress") {
    const axis = arg && arg.axis;
    const dir = arg && arg.dir;
    if (AXES.indexOf(axis) < 0 || !isNum(dir)) {
      $.log(`ControlPanel: invalid buttonPress ${JSON.stringify(arg)}`);
      return;
    }
    setTrim(axis, trim(axis) + dir);
    updateTrim(axis);
    publish();
  } else if (messageType === "resetControl") {
    applyAction({ kind: "reset" });
  } else if (messageType === "subscribeControl") {
    if (!sender || sender instanceof ItemHandle) return;
    $.state.subscriber = sender;
    // 旧形式 (名前の文字列だけ) にも対応
    const name = typeof arg === "string" ? arg : arg && typeof arg.name === "string" ? arg.name : null;
    $.state.subscriberName = name;
    $.state.sendEnabled = arg && typeof arg.sendEnabled === "boolean" ? arg.sendEnabled : null;
    $.log(`ControlPanel: OSC sender = ${name || sender.id}`);
    updateStatus();
    publish(); // 今の値をすぐに渡す
  } else if (messageType === "txStatus") {
    if (!isSubscriber(sender)) return;
    $.state.sendEnabled = arg && typeof arg.sendEnabled === "boolean" ? arg.sendEnabled : null;
    updateStatus();
  }
}, { item: true, player: true });

// 送信役が退室したら外す
let timer = 0;
$.onUpdate((deltaTime) => {
  timer += deltaTime;
  if (timer < CHECK_SEC) return;
  timer = 0;
  if ($.state.subscriber && !subscriber()) {
    $.state.subscriber = null;
    $.state.subscriberName = null;
    $.state.sendEnabled = null;
  }
  updateStatus();
});
