# 機能仕様書：舵面・位置の受信、OSC モニター、コントロールパネル

対象ブランチ：`feature/position`（`main` からの追加分）
English version: [../en/feature-spec.md](../en/feature-spec.md)

---

## 1. 概要

このブランチでは、cluster ワールド上の機体（`PlaneBody`）を OSC で動かす仕組みを、姿勢だけから次の範囲まで広げました。

| # | 機能 | 方向 |
| --- | --- | --- |
| 1 | 舵面（エルロン / エレベーター / ラダー）の回転を受信し、機体の舵面ピボットを回す | 外部 → cluster |
| 2 | 機体の位置を受信し、部屋の中で機体を移動させる | 外部 → cluster |
| 3 | 操縦者（OSC で機体を動かせる 1 人）の管理と表示 | cluster 内 |
| 4 | ワールド内の OSC モニター（数値・グラフ・軌跡・舵面プレビュー・イベントログ） | cluster 内（本人のみ） |
| 5 | コントロールパネルで設定したトリム角と PID ゲインを外部へ送信 | cluster → 外部 |
| 6 | 上記を Unity シーンに組み込む Editor メニュー | Unity Editor |
| 7 | 動作確認用の Python ツール（デモ送信・受信表示）と `send_osc.py` の位置対応 | 外部 |

### 互換性に関する変更
- `main` の README にあった cluster からの送信 `/plane/control [aileron, elevator, rudder]` は廃止し、`/plane/trim` と `/plane/pid/*` に置き換えました（§4.2）。
- `/plane/data` の形式は変わっていません。`/plane/data` だけを送る既存の送信側はそのまま動きます。

---

## 2. 全体構成

```
外部 (Python / 機体)                      cluster ワールド
──────────────────                      ───────────────────────────────────────────────
send_osc.py            ─┐
send_surfaces_demo.py  ─┼─ OSC (UDP) ─▶ OscFlightPlayer.js (PlayerScript, 操縦者の端末)
                        │                 ├─ sendTo ─▶ PlaneBody.js   (姿勢・舵面・位置, 全員に同期)
                        │                 └─ PlayerLocalUI ─▶ OSC モニター (本人のみ)
                        │
receive_osc.py  ◀── OSC (UDP) ── OscFlightPlayer.js ◀─ controlValues ─ ControlPanel.js ◀─ ControlButton.js ×70
                                                                         (値は全員で共有)
                                  OscTrigger.js (Cube_OSC_Trigger)：クリックした人に PlayerScript を渡し、操縦者にする
```

### コンポーネント一覧（`Unity/osc-flight-telemetry/Assets/Scripts/OscFlight/`）

| ファイル | 種類 | 割り当て先 | 役割 |
| --- | --- | --- | --- |
| `OscFlightPlayer.js` | PlayerScript | `Cube_OSC_Trigger` | OSC 受信、`PlaneBody` への転送、モニター描画、トリム / PID の OSC 送信 |
| `OscTrigger.js` | Scriptable Item | `Cube_OSC_Trigger` | クリックした人に PlayerScript を渡し、操縦者を切り替える。操縦者名ラベルと押しボタンのアニメーション |
| `PlaneBody.js` | Scriptable Item | `PlaneBody` | 操縦者からの姿勢・舵面・位置を反映する（全員に同期） |
| `ControlPanel.js` | Scriptable Item | `ControlPanel` | トリム角と PID ゲインを保持・表示し、操縦者の PlayerScript に渡す |
| `ControlButton.js` | Scriptable Item | パネルの各ボタン（70 個で共通） | 押されたことを `ControlPanel` に通知し、キーを押し込むアニメーションをする |

---

## 3. 受信する OSC（外部 → cluster）

送信先は cluster の OSC 受信ポートです。引数はすべて float です（int も受け付けます）。

| アドレス | 引数 | 単位 | 内容 |
| --- | --- | --- | --- |
| `/plane/data` | `roll, pitch, yaw, sv1, sv3` | deg | 機体姿勢とサーボ値（従来どおり。`sv1` / `sv3` はモニター表示のみ） |
| `/plane/aileron/quat` | `x, y, z, w` | – | エルロンの回転 |
| `/plane/elevator/quat` | `x, y, z, w` | – | エレベーターの回転 |
| `/plane/rudder/quat` | `x, y, z, w` | – | ラダーの回転 |
| `/plane/pos` | `x, y, z` | m | 機体の位置（初期位置からの相対） |

### 3.1 座標系
- Unity と同じ左手系です（X = 右、Y = 上、Z = 前）。
- `/plane/data` の姿勢は `Quaternion.setFromEulerAngles(pitch, yaw, roll)` で機体の回転にします。適用順は Unity の `Quaternion.Euler` と同じです（Z → X → Y）。

### 3.2 舵面クォータニオン
- 各舵面の**中立姿勢からの回転**を表します。
- 長さが 1 から 0.01 以上ずれていれば、受信側で正規化してモニターに警告を出します。
- 長さがほぼ 0（1e-6 未満）の場合は破棄します。
- `PlaneBody` の子孫に次の名前のピボットがあれば、`localRotation = 中立姿勢 × 受信クォータニオン` で回します。ピボットが無い舵面は無視します（エラーにはなりません）。

| 舵面 | ピボット名 |
| --- | --- |
| エルロン | `AileronPivot` |
| エレベーター | `ElevatorPivot` |
| ラダー | `RudderPivot` |

- ピボットは、ヒンジ位置に原点を置いた空オブジェクトとして作り、その子に舵面メッシュを入れます。
- 中立姿勢は、ピボットを最初に見つけたときの回転です（`$.state` に保存します）。

### 3.3 位置（`/plane/pos`）
- 値は**初期位置（シーンに置いた `PlaneBody` の位置）からの相対位置**です。
- ワールド位置は次の式で求め、各軸を `POS_MIN`〜`POS_MAX` の範囲に収めます。

  `ワールド位置 = 初期位置 + 受信値 × POS_SCALE`

- 範囲外の値は端で止まり、モニターに `CLAMPED` と表示されます。
- 部屋は 10 m 四方・高さ 10 m（X/Z −5〜5、Y 0〜10）です。
- 実機の飛行データは部屋より大きいので、`POS_SCALE` を `0.01`（100 m → 1 m）などに縮めて使います。
- 操縦者が替わったとき（`Cube_OSC_Trigger` がクリックされたとき）、機体は初期位置に戻ります。

### 3.4 不正な入力の扱い
| 状況 | 動作 |
| --- | --- |
| 未登録のアドレス | 無視し、アドレスごとに初回だけ EVENTS に表示する |
| 引数が足りない / 数値でない | そのメッセージを破棄し、EVENTS に警告する（同じ警告は 5 秒に 1 回まで） |
| クォータニオンが正規化されていない | 正規化して使い、警告する |

---

## 4. 送信する OSC（cluster → 外部）

### 4.1 前提
- cluster の「設定 > その他」で **OSC送信の有効化** をオンにし、送信先 IP / ポートを設定する必要があります。
- 送るのは**操縦者**の cluster だけです。パネルのボタンは誰が押してもかまいません。
- 外部の機体を動かす場合は、送信先を cluster 自身の OSC 受信ポートとは別のポートにしてください。

### 4.2 メッセージ
| アドレス | 引数 (float) | 範囲 | 内容 |
| --- | --- | --- | --- |
| `/plane/trim` | `aileron, elevator, rudder` | −30〜+30 deg | トリム角 |
| `/plane/pid/roll` | `kp, ki, kd` | 0〜10 | ロールの PID ゲイン |
| `/plane/pid/pitch` | `kp, ki, kd` | 0〜10 | ピッチの PID ゲイン |
| `/plane/pid/yaw` | `kp, ki, kd` | 0〜10 | ヨーの PID ゲイン |
| `/plane/{aileron,elevator,rudder}/quat` | `x, y, z, w` | – | トリム角をヒンジ軸まわりの回転にしたもの（`TX_SEND_QUATS = true` のときだけ。既定はオフ） |

### 4.3 送信のタイミング
- 値が変わったときにすぐ送ります。
- 値が変わらなくても `TX_KEEPALIVE_SEC`（0.5 秒）ごとに送り直します（UDP の取りこぼし対策）。
- 1 メッセージ = 1 パケットで送ります。OSC バンドルは使いません。
- **PID は、その軸のボタンを一度でも押すまで送りません。** 操縦者が入っただけで、機体側のゲインが初期値で上書きされないようにするためです。
- OSC 送信がオフの間は送らず、オンになったら次の送り直しのタイミングで送ります。

### 4.4 値の決まり方
- トリム：ボタンで `-10 / -1 / +1 / +10` deg ずつ増減し、`0` でその舵面を 0 に戻します。`RESET TRIM` で 3 舵面すべてを 0 に戻します（PID は変わりません）。範囲外は −30〜+30 に収めます。
- PID：ボタンで `-1 / -0.1 / -0.01 / +0.01 / +0.1 / +1` ずつ増減します。0〜10 に収め、小数第 2 位で丸めます。
- PID の初期値（押す前の表示と、最初に押したときの基準値）は `ControlPanel.js` の `PID_DEFAULTS` です（既定はすべて 0）。機体側の現在のゲインに合わせておくと安全です。
- 値はワールドの全員で共有されます。ワールドを作り直すと初期値に戻ります。

---

## 5. 操縦者（オペレーター）

- `Cube_OSC_Trigger` を**最後にクリックした 1 人**が操縦者です。
- `PlaneBody` に反映されるのは操縦者の OSC だけです。トリム / PID を外部に送るのも操縦者の cluster だけです。
- 別の人がクリックすると操縦者が切り替わります。前の操縦者の PlayerScript は、機体への転送と OSC 送信を止めますが、受信とモニター表示は続けます。
- 操縦者名は、キューブの上の `OperatorLabel`（全員に見える）と、モニターのヘッダー（`OPERATOR`）に表示します。
  - 表示フォントは英数字のみです。表示名に英数字以外が含まれる場合は、代わりにユーザー ID（`@id`）を表示します。
- 操縦者が退室すると、ラベルは `none` に戻ります（1 秒ごとに確認）。

### 5.1 切り替えの手順
1. プレイヤーが `Cube_OSC_Trigger` をクリックする。
2. `OscTrigger.js` が前の操縦者に `oscOperatorChanged` を送り、クリックした人に PlayerScript を渡す。
3. 新しい操縦者の `OscFlightPlayer.js` が起動し、`PlaneBody` に次を送る。
   - `claimOperator`：自分を操縦者として登録する
   - `updateRotation [0, 0, 0]`：姿勢をリセットする
   - `resetPosition`：位置を初期位置に戻す
4. `PlaneBody` は返事として `planeConfig`（初期位置・縮尺・範囲）を返す。モニターはこれを使って位置を表示する。
5. `OscFlightPlayer.js` が `ControlPanel` に `subscribeControl` を送り、送信役になる。`ControlPanel` はすぐに現在値を `controlValues` で返す。

---

## 6. アイテム間メッセージ

| 送り主 → 宛先 | メッセージ | 引数 | 内容 |
| --- | --- | --- | --- |
| Player → `PlaneBody` | `claimOperator` | 名前 | 操縦者になる |
| Player → `PlaneBody` | `updateRotation` | `[roll, pitch, yaw]` (deg) | 姿勢 |
| Player → `PlaneBody` | `updateSurfaces` | `{ ail, elv, rud: [x,y,z,w] }` | 舵面の回転 |
| Player → `PlaneBody` | `updatePosition` | `[x, y, z]` (m) | 位置（初期位置からの相対） |
| Player → `PlaneBody` | `resetPosition` | – | 初期位置に戻す |
| `PlaneBody` → Player | `planeConfig` | `{ home, scale, min, max }` | 位置の計算方法 |
| `OscTrigger` → 前の Player | `oscOperatorChanged` | `{ name }` | 操縦者が替わった |
| Player → `ControlPanel` | `subscribeControl` | `{ name, sendEnabled }` | 送信役になる |
| Player → `ControlPanel` | `txStatus` | `{ sendEnabled }` | OSC 送信設定が変わった |
| `ControlButton` → `ControlPanel` | `controlButton` | – | ボタンが押された（どのボタンかは送り主で判別） |
| any → `ControlPanel` | `resetControl` | – | トリムをすべて 0 にする |
| `ControlPanel` → Player | `controlValues` | `{ aileron, elevator, rudder, pid, seq }` | 現在の値（`pid` は押された軸だけ） |

- `PlaneBody` への転送は最大 `FORWARD_HZ`（20 Hz）です。変化があったチャンネルだけ送ります。
- `PlaneBody` は、最後に `claimOperator` を送ったプレイヤー以外からの `update*` / `resetPosition` を無視します。
- `ControlPanel` は、ボタンを World Item Reference List の id で判別します。

| id | 動作 |
| --- | --- |
| `btn.<aileron\|elevator\|rudder>.<m10\|m1\|zero\|p1\|p10>` | トリム −10 / −1 / 0 にする / +1 / +10 |
| `btn.reset` | トリムをすべて 0 |
| `btn.pid.<roll\|pitch\|yaw>.<kp\|ki\|kd>.<m1\|m01\|m001\|p001\|p01\|p1>` | ゲイン −1 / −0.1 / −0.01 / +0.01 / +0.1 / +1 |

合計 70 個（トリム 15 + リセット 1 + PID 54）です。

---

## 7. OSC モニター

`OscMonitor`（ワールド空間の PlayerLocalUI）に表示します。更新は**本人の画面だけ**です（同期しません）。`Cube_OSC_Trigger` をクリックすると更新が始まります。

| 欄 | 表示内容 |
| --- | --- |
| ヘッダー | `OSC RX ON/OFF`（OFF なら cluster の「OSC受信の有効化」をオンにする）。`OPERATOR` に操縦者名。自分なら `(you)`、他人なら `monitor only` |
| TX 行 | 送信状態（`ON` / `OSC SEND OFF` / `OFF (not operator)`）、送信中のトリム角、PID を送っている軸、送信回数、最後に送ってからの秒数 |
| カード（ATTITUDE / AILERON / ELEVATOR / RUDDER / POSITION） | 状態（`LIVE` / `NO SIGNAL` / `WAITING`）、受信レート (Hz)、受信数、最終受信からの秒数、直近 5 秒のグラフ（縦軸は自動スケール）、生の値 |
| 舵面カードの生の値 | クォータニオン `x y z w`、`\|q\|`、オイラー角（ZXY）、回転角と回転軸 |
| POSITION カード | 受信値 x / y / z (m) のグラフ、`PlaneBody` のワールド位置・縮尺・初期位置、範囲外なら `CLAMPED` |
| TRACK | 部屋を上から見た図。直近 20 秒の軌跡、現在位置（三角形の先端が機首方位 yaw）、`+` が初期位置、枠が `POS_MIN`〜`POS_MAX` |
| SURFACE PREVIEW | 受信クォータニオンで舵面の板を回した簡易 3D 表示（灰色は中立位置）。機体全体を `/plane/data` の姿勢で傾ける |
| EVENTS | 未登録アドレス、引数不足、正規化の警告、操縦者の交代など（最新 30 行） |

- `NO SIGNAL` は、最後の受信から `STALE_SEC`（1 秒）以上経ったときに表示します。
- TRACK の向きは、既定では既定位置のモニター（−Z 側の壁）に向かって立ったときの見え方です（画面の上 = −Z、右 = −X）。`TRACK_VIEW_FROM_SPAWN = false` で上 = +Z、右 = +X になります。
- SURFACE PREVIEW のエルロンは左右両方を描きます。左は `/plane/aileron/quat` をそのまま使い、右は左を左右対称にして逆向きに動かしたもの（クォータニオンの `x` の符号を反転）です。
- モデルに舵面を実装する前に、回転の向きや軸が合っているかを確かめるためのものです。

---

## 8. コントロールパネル

`ControlPanel` に表示します。値と表示はワールドの全員で共有されます。

| 欄 | 表示内容 |
| --- | --- |
| ヘッダー | `TX ON` / `TX OSC SEND OFF`（操縦者の cluster で OSC 送信がオフ）/ `no operator`（まだ誰も `Cube_OSC_Trigger` を押していない）と、送信している人の名前。右端に `RESET TRIM` ボタン |
| 上段：AILERON / ELEVATOR / RUDDER TRIM | 数値、−30〜+30 のゲージ（針が現在値）、`-10 / -1 / 0 / +1 / +10` ボタン |
| 下段：ROLL / PITCH / YAW PID | Kp / Ki / Kd の数値と `-1 / -.1 / -.01 / +.01 / +.1 / +1` ボタン。右上の `NOT SENT` / `SENDING` で、その軸を送っているかを表示（送る前の数値は灰色） |

- ボタンを押すと、キーが少し沈んで戻ります（全員に同期）。

---

## 9. 設定値

各スクリプト先頭の定数で変更します。

### `PlaneBody.js`
| 定数 | 既定値 | 内容 |
| --- | --- | --- |
| `POS_SCALE` | `1.0` | 受信値 1 m をワールドで何 m にするか |
| `POS_MIN` | `[-4.5, 0.3, -4.5]` | ワールド座標の下限 |
| `POS_MAX` | `[4.5, 9.5, 4.5]` | ワールド座標の上限 |

### `OscFlightPlayer.js`
| 定数 | 既定値 | 内容 |
| --- | --- | --- |
| `FORWARD_HZ` | `20` | `PlaneBody` への転送レートの上限 |
| `FORWARD_SURFACES` | `true` | 舵面を `PlaneBody` に転送するか |
| `GRAPH_SECONDS` | `5` | グラフの時間幅 (秒) |
| `SAMPLE_HZ` | `20` | グラフのサンプリング / 再描画レート |
| `TEXT_HZ` | `10` | 数値表示の更新レート |
| `STALE_SEC` | `1.0` | この秒数受信がなければ `NO SIGNAL` |
| `LOG_LINES` | `30` | EVENTS に残す行数 |
| `TRACK_SECONDS` | `20` | TRACK に残す時間 (秒) |
| `TRACK_VIEW_FROM_SPAWN` | `true` | TRACK の向き（§7） |
| `PREVIEW_ATTITUDE` | `true` | プレビューを `/plane/data` の姿勢で傾けるか |
| `PREVIEW_YAW` | `true` | 上記で yaw も反映するか |
| `TX_ENABLED` | `true` | トリム / PID を外部へ送るか |
| `TX_SEND_TRIM` | `true` | `/plane/trim` を送るか |
| `TX_SEND_PID` | `true` | `/plane/pid/*` を送るか |
| `TX_SEND_QUATS` | `false` | トリム角を `/plane/*/quat` でも送るか（ループバック確認用） |
| `TX_KEEPALIVE_SEC` | `0.5` | 送り直しの間隔（0 = 変化時のみ） |
| `TX_HINGE_AXES` | ail/elv: `[1,0,0]`、rud: `[0,1,0]` | `TX_SEND_QUATS` で使うヒンジ軸 |

### `ControlPanel.js`
| 定数 | 既定値 | 内容 |
| --- | --- | --- |
| `TRIM_MIN` / `TRIM_MAX` | `-30` / `30` | トリム角の範囲 (deg) |
| `GAIN_MIN` / `GAIN_MAX` | `0` / `10` | PID ゲインの範囲 |
| `PID_DEFAULTS` | すべて 0 | PID の初期値 |

---

## 10. Unity Editor のセットアップメニュー

`Assets/Scene/OSC_receive.unity` を開いて、メニュー **Tools > OSC Flight** から実行します。どれも再実行できます。

| メニュー | 内容 |
| --- | --- |
| **Setup All In Open Scene** | 下の Setup Monitor と Setup Control Panel をまとめて実行する |
| **Setup Monitor In Open Scene** | `OscMonitor` を生成する（初期位置 `(0, 2.1, -4.2)`。再実行しても位置は維持）。`Cube_OSC_Trigger` / `PlaneBody` / `ControlPanel` のスクリプトを差し替え、`OperatorLabel` を作り、UI 参照（`oscmon.*`）と World Item Reference（`PlaneBody`、`ControlPanel`）を登録する |
| **Setup Control Panel In Open Scene** | `ControlPanel` をモニターと同じ見た目で作り直し、70 個のボタンをシーン直下の `ControlPanelButtons` に生成して `btn.*` を登録する。位置は維持し、初回だけ表をスポーン地点に向ける（90 度単位）。旧ボタン（`Btn_AIL_*` など）と親（`Aileron` / `Elevator` / `Rudder`）は削除する。パネルを動かしたら再実行する |
| **Setup Start Button In Open Scene**（任意） | `Cube_OSC_Trigger` の見た目を、台座＋緑の押しボタン（`Cap`）＋前面ラベル（`OSC / PUSH TO RECEIVE`）に置き換え、当たり判定を合わせる。初回だけ前面をスポーン地点に向ける |

- ボタンを `ControlPanel` の子にしないのは、cluster では Item の中に Item を入れられないためです。
- パネルのマテリアルは `Assets/Materials/OscPanel_*.mat`（Unlit/Color）です。
- 実行後、シーンを保存してアップロードします。

---

## 11. Python ツール（`Python/`）

依存ライブラリ：`pandas`、`python-osc`（`Pipfile` あり）

### `send_osc.py`（変更）
- CSV に `pos_x`, `pos_y`, `pos_z` 列があれば、`/plane/data` に加えて `/plane/pos` も送ります。
- 列が無ければ従来どおり `/plane/data` だけを送ります。
- 位置の列に欠損がある行では `/plane/pos` を送りません。

### `send_surfaces_demo.py`（新規）
舵面クォータニオンのデモ送信です。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--ip` | `127.0.0.1` | 送信先 IP |
| `--port` | `9000` | 送信先ポート |
| `--hz` | `50` | 送信レート |
| `--duration` | `0` | 送信する秒数（0 = Ctrl+C まで） |
| `--mode` | `sine` | `sine`：サイン波 / `step`：0 → +最大 → 0 → −最大を 2 秒ごと / `sequence`：1 舵面ずつ 4 秒ずつ |
| `--amp` | `1.0` | 振幅の倍率（既定の振幅：エルロン 20°、エレベーター 15°、ラダー 25°） |
| `--attitude` | オフ | `/plane/data` も送る |
| `--position` | オフ | `/plane/pos` も送る（初期位置を中心に円を描き、高さは 0.2〜1.8 m で上下） |
| `--radius` | `3.0` | `--position` の半径 (m) |
| `--period` | `20.0` | `--position` の 1 周の秒数 |

- エルロンとエレベーターは X 軸まわり、ラダーは Y 軸まわりの回転を送ります。
- `--attitude` と `--position` を一緒に使うと、yaw が進行方向に合います。

### `receive_osc.py`（新規）
cluster から送られる OSC を表示するデバッグ用の受信ツールです。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--ip` | `0.0.0.0` | 待ち受け IP |
| `--port` | `9000` | 待ち受けポート |
| `--address` | なし | 指定したアドレスだけ表示する（例：`/plane/trim`） |

---

## 12. 制約と注意点

- モニターの表示は、PlayerScript を実行している本人にしか見えません。
- 表示フォントは英数字のみです（名前の表示は §5 を参照）。
- PID は軸ごとに、ボタンを一度押すまで送りません。初期値の設定は `PID_DEFAULTS` で行います。
- トリム / PID の値はワールドインスタンスの中だけで保持され、ワールドを作り直すと初期値に戻ります。
- 位置は部屋の範囲（`POS_MIN`〜`POS_MAX`）に収められます。実機データでは `POS_SCALE` の調整が必要です。
- 舵面はピボット（`AileronPivot` など）を実装するまで機体に反映されません（モニターのプレビューには出ます）。
