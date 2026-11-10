// =====================================================================
// OscTrigger.js  - Scriptable Item (Cube_OSC_Trigger)
//
// クリックしたプレイヤーに PlayerScript (OscFlightPlayer.js) を渡し、その人を「操縦者」にする。
//   - 操縦者の名前を子の OperatorLabel (TextMeshPro) に表示する。
//     Scriptable Item からの unityProp 変更は同期されるので、ワールドの全員に見える。
//   - 前の操縦者の PlayerScript には "oscOperatorChanged" を送り、PlaneBody への転送を止めさせる。
//   - 操縦者が退室したら表示を none に戻す。
//   - クリックされたら子の Cap (押しボタン) を少し沈ませて戻す (全員に同期)。
//     Cap は Tools > OSC Flight > Setup Start Button In Open Scene で作られる。無ければ何もしない。
// PlaneBody 側は OscFlightPlayer.js が起動時に送る "claimOperator" で操縦者を切り替える。
// =====================================================================

const LABEL_NODE = "OperatorLabel";
const CHECK_SEC = 1.0;
const CAP_NODE = "Cap";
const PRESS_DEPTH = 0.025; // m
const PRESS_HOLD_SEC = 0.12; // 沈んだまま保つ時間
const PRESS_RETURN_SEC = 0.18; // 元の高さに戻るまでの時間

// ---------------- 押しボタンのアニメーション ----------------
let cap = undefined; // undefined = 未取得, null = 無い
let pressTime = -1; // < 0 なら押されていない

function capNode() {
  if (cap !== undefined) return cap;
  cap = null;
  try {
    const node = $.subNode(CAP_NODE);
    if (node) {
      // 元の高さは state に残す (オーナーが変わって押し込み途中から再開しても高さがずれないように)
      if (!$.state.capRest) $.state.capRest = node.getPosition();
      if ($.state.capRest) cap = node;
    }
  } catch (e) {
    cap = null;
  }
  return cap;
}

function setCapDepth(depth) {
  const node = capNode();
  if (!node) return;
  const rest = $.state.capRest;
  try {
    node.setPosition(new Vector3(rest.x, rest.y - depth, rest.z));
  } catch (e) {
    $.log(`OscTrigger: failed to move ${CAP_NODE}: ${e}`);
    cap = null;
  }
}

function updatePress(deltaTime) {
  if (pressTime < 0) return;
  pressTime += deltaTime;
  const t = (pressTime - PRESS_HOLD_SEC) / PRESS_RETURN_SEC;
  if (t >= 1) {
    pressTime = -1;
    setCapDepth(0);
  } else if (t > 0) {
    setCapDepth(PRESS_DEPTH * (1 - t));
  }
}

// ラベルのフォントは英数字のみなので、表示名に英数字以外が含まれる場合はユーザー ID を表示する
function displayName(player) {
  const name = player.userDisplayName;
  if (typeof name === "string" && /^[\x20-\x7e]+$/.test(name)) return name;
  const userId = player.userId;
  if (typeof userId === "string" && userId.length > 0) return `@${userId}`;
  return "unknown";
}

function plain(text) {
  return `<noparse>${String(text).replace(/<\/?noparse>/gi, "")}</noparse>`;
}

let label = undefined; // undefined = 未取得, null = 無い

function labelComponent() {
  if (label !== undefined) return label;
  label = null;
  try {
    const node = $.subNode(LABEL_NODE);
    if (node) label = node.getUnityComponent("TextMeshPro");
  } catch (e) {
    label = null;
  }
  if (!label) $.log(`OscTrigger: ${LABEL_NODE} (TextMeshPro) not found - operator name is not shown`);
  return label;
}

function currentOperator() {
  const p = $.state.operator;
  try {
    return p && p.exists() ? p : null;
  } catch (e) {
    return null;
  }
}

function refreshLabel() {
  const p = currentOperator();
  const text = p
    ? `<size=55%><color=#8c8c94>OSC OPERATOR</color></size>\n${plain(displayName(p))}`
    : `<size=55%><color=#8c8c94>OSC OPERATOR</color></size>\n<color=#8c8c94>none - click to take control</color>`;
  if ($.state.labelText === text) return;
  const comp = labelComponent();
  if (!comp) return;
  try {
    comp.unityProp.text = text;
    $.state.labelText = text;
  } catch (e) {
    $.log(`OscTrigger: failed to set label: ${e}`);
  }
}

$.onInteract((player) => {
  const previous = currentOperator();
  if (previous && previous.id !== player.id) {
    try {
      previous.send("oscOperatorChanged", { name: displayName(player) });
    } catch (e) {
      $.log(`OscTrigger: failed to notify previous operator: ${e}`);
    }
  }
  $.state.operator = player;
  $.setPlayerScript(player);
  refreshLabel();
  pressTime = 0;
  setCapDepth(PRESS_DEPTH);
});

$.onStart(() => {
  $.state.labelText = null; // 起動時は必ず書き直す
  refreshLabel();
  setCapDepth(0); // 押し込み途中でオーナーが変わった場合に戻す
});

let timer = 0;
$.onUpdate((deltaTime) => {
  updatePress(deltaTime);
  timer += deltaTime;
  if (timer < CHECK_SEC) return;
  timer = 0;
  if ($.state.operator && !currentOperator()) {
    $.state.operator = null;
  }
  refreshLabel();
});
