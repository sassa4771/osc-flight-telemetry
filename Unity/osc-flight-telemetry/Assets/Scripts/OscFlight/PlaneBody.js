// =====================================================================
// PlaneBody.js  - Scriptable Item (PlaneBody)
//
// OscFlightPlayer.js (PlayerScript) から転送されたテレメトリを機体に反映する。
// アイテムの回転はネットワーク同期されるので、ワールドの全員に見える。
//
//   "claimOperator"   name                                     操縦者になる (OscFlightPlayer.js の起動時)
//   "updateRotation"  [roll, pitch, yaw]                 (deg)  機体の姿勢
//   "updateSurfaces"  { ail: [x,y,z,w], elv: [...], rud: [...] }  舵面の回転
//   "updatePosition"  [x, y, z]                          (m)    機体の位置 (初期位置からの相対)
//   "resetPosition"   (なし)                                    初期位置に戻す
//
// プレイヤーから届く update* / resetPosition は、最後に claimOperator を送った
// プレイヤー (= Cube_OSC_Trigger を最後にクリックした人) のものだけを反映する。
//
// 位置: ワールド座標 = 初期位置 (シーンに置いた位置) + 受信値 * POS_SCALE を
// POS_MIN..POS_MAX (部屋の内側) に収めて setPosition する。
// 操縦者には claimOperator の返事として "planeConfig" を送り、モニターが同じ計算で表示できるようにする。
//
// 舵面: PlaneBody の子孫に下記の名前のピボット (ヒンジ位置に原点を置いた空オブジェクト) を
// 作ると、その localRotation = 中立姿勢 * 受信クォータニオン で回転する。
// ピボットが無い舵面は無視される (モデル実装前でもエラーにならない)。
// =====================================================================

// ---------------- 位置の設定 ----------------
const POS_SCALE = 1.0;               // 受信値 1 m をワールドで何 m にするか (実機データなら 0.01 などに縮める)
const POS_MIN = [-4.5, 0.3, -4.5];   // ワールド座標の下限 (部屋は X/Z -5..5, Y 0..10)
const POS_MAX = [4.5, 9.5, 4.5];     // ワールド座標の上限

const SURFACE_NODES = {
  ail: "AileronPivot",
  elv: "ElevatorPivot",
  rud: "RudderPivot",
};

let surfaces = null;

function isNum(v) {
  return typeof v === "number" && isFinite(v);
}

function resolveSurfaces() {
  surfaces = {};
  const found = [];
  for (const key of Object.keys(SURFACE_NODES)) {
    const name = SURFACE_NODES[key];
    try {
      const node = $.subNode(name);
      const current = node ? node.getRotation() : null;
      if (!node || !current) continue;
      // 中立姿勢 (最初に見つけたときの回転) を保存しておく
      const stateKey = `surfaceBase_${key}`;
      let base = $.state[stateKey];
      if (!base) {
        base = current.clone();
        $.state[stateKey] = base;
      }
      surfaces[key] = { node, base };
      found.push(name);
    } catch (e) {
      // ピボット未実装
    }
  }
  $.log(`PlaneBody: surface pivots = [${found.join(", ")}]`);
}

function applySurfaces(arg) {
  if (!arg || typeof arg !== "object") return;
  if (surfaces === null) resolveSurfaces();
  for (const key of Object.keys(surfaces)) {
    const q = arg[key];
    if (!Array.isArray(q) || q.length < 4 || !q.every(isNum)) continue;
    const s = surfaces[key];
    try {
      const rot = new Quaternion(q[0], q[1], q[2], q[3]).normalize();
      s.node.setRotation(s.base.clone().multiply(rot));
    } catch (e) {
      $.log(`PlaneBody: failed to rotate ${SURFACE_NODES[key]}: ${e}`);
      delete surfaces[key];
    }
  }
}

// 初期位置 (最初に見たときの位置)。位置の原点になる
function homePosition() {
  let home = $.state.home;
  if (!home) {
    home = $.getPosition();
    $.state.home = home;
  }
  return home;
}

function applyPosition(arg) {
  if (!Array.isArray(arg) || arg.length < 3) return;
  const x = arg[0], y = arg[1], z = arg[2];
  if (!isNum(x) || !isNum(y) || !isNum(z)) return;
  const home = homePosition();
  const clampAxis = (v, i) => Math.min(POS_MAX[i], Math.max(POS_MIN[i], v));
  $.setPosition(new Vector3(
    clampAxis(home.x + x * POS_SCALE, 0),
    clampAxis(home.y + y * POS_SCALE, 1),
    clampAxis(home.z + z * POS_SCALE, 2)
  ));
}

$.onStart(() => {
  homePosition();
});

// 送り主が今の操縦者か (アイテムからのメッセージは常に受け付ける)
function fromOperator(sender) {
  if (sender instanceof ItemHandle) return true;
  const operatorId = $.state.operatorId;
  return typeof operatorId === "string" && sender && sender.id === operatorId;
}

$.onReceive((messageType, arg, sender) => {
  if (messageType === "claimOperator") {
    if (sender && !(sender instanceof ItemHandle)) {
      $.state.operatorId = sender.id;
      $.log(`PlaneBody: operator = ${typeof arg === "string" ? arg : sender.id}`);
      // モニターの位置表示用に、位置の計算方法を操縦者の PlayerScript へ返す
      try {
        const home = homePosition();
        sender.send("planeConfig", { home: [home.x, home.y, home.z], scale: POS_SCALE, min: POS_MIN, max: POS_MAX });
      } catch (e) {
        $.log(`PlaneBody: failed to send planeConfig: ${e}`);
      }
    }
    return;
  }
  if (!fromOperator(sender)) return;
  if (messageType === "updateRotation") {
    if (!Array.isArray(arg) || arg.length < 3) return;
    const roll = arg[0];
    const pitch = arg[1];
    const yaw = arg[2];
    if (!isNum(roll) || !isNum(pitch) || !isNum(yaw)) return;
    $.setRotation(new Quaternion().setFromEulerAngles(pitch, yaw, roll));
  } else if (messageType === "updateSurfaces") {
    applySurfaces(arg);
  } else if (messageType === "updatePosition") {
    applyPosition(arg);
  } else if (messageType === "resetPosition") {
    const home = homePosition();
    $.setPosition(new Vector3(home.x, home.y, home.z));
  }
}, { item: true, player: true });
