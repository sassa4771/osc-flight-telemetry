// =====================================================================
// ControlButton.js  - Scriptable Item (ControlPanel のボタン, 全ボタン共通)
//
// クリックされたら ControlPanel に "controlButton" を送る。
// どのボタン (どの舵面の +10 / -1 / 0 ...) かは ControlPanel 側が送り主のアイテムで判別するので、
// このスクリプトはボタンごとに書き分けなくてよい。
//   - WorldItemReferenceList に "ControlPanel" が必要
//   - 子の Cap (キートップ) をクリック時に少し押し込んで戻す (全員に同期)。無ければ何もしない
// ボタンは Tools > OSC Flight > Setup Control Panel In Open Scene で生成される。
// =====================================================================

const CAP_NODE = "Cap";
const PRESS_DEPTH = 0.012;     // m (アイテムのローカル +Z = パネルの奥へ)
const PRESS_HOLD_SEC = 0.08;   // 沈んだまま保つ時間
const PRESS_RETURN_SEC = 0.14; // 元の位置に戻るまでの時間

const panel = $.worldItemReference("ControlPanel");

let cap = undefined; // undefined = 未取得, null = 無い
let pressTime = -1;  // < 0 なら押されていない

function capNode() {
  if (cap !== undefined) return cap;
  cap = null;
  try {
    const node = $.subNode(CAP_NODE);
    if (node) {
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
    node.setPosition(new Vector3(rest.x, rest.y, rest.z + depth));
  } catch (e) {
    cap = null;
  }
}

$.onInteract(() => {
  if (panel) {
    panel.send("controlButton", null);
  } else {
    $.log("ControlButton: ControlPanel reference not found (WorldItemReferenceList)");
  }
  pressTime = 0;
  setCapDepth(PRESS_DEPTH);
});

$.onStart(() => {
  setCapDepth(0);
});

$.onUpdate((deltaTime) => {
  if (pressTime < 0) return;
  pressTime += deltaTime;
  const t = (pressTime - PRESS_HOLD_SEC) / PRESS_RETURN_SEC;
  if (t >= 1) {
    pressTime = -1;
    setCapDepth(0);
  } else if (t > 0) {
    setCapDepth(PRESS_DEPTH * (1 - t));
  }
});
