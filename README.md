# osc-flight-telemetry

Unity 上の機体モデルへ CSV のフライトデータを OSC でストリーミングするためのプロジェクトです。  
Python スクリプトでテレメトリを送信し、`Unity/osc-flight-telemetry` で受信・可視化します。

## 対応ワールド
https://cluster.mu/e/36d967fc-7f3d-427c-9bcb-dc1a54c6d753

## リポジトリ構成
- `Python/` : CSV を読み込み OSC 送信するスクリプトとサンプルデータ
- `Unity/osc-flight-telemetry/` : Cluster Creator Kit テンプレートをベースにした Unity プロジェクト

## 前提
- Python 3.10 以降推奨
- 依存ライブラリ  
  ```bash
  pip install pandas python-osc
  ```
- Unity で受信する場合は `Unity/osc-flight-telemetry` を Unity 6000.2.6f2 で開いてください（詳細は同ディレクトリ内の README を参照）。

## CSV フォーマット
`Python/flight_data.csv` のようなテーブルを想定しています。列名は大小文字や前後空白を無視して扱われます。
- 必須列: `roll`, `pitch`, `yaw`, `sv1`, `sv3`
- 数値以外や欠損は送信前に除外されます。

## 送信スクリプトの設定
`Python/send_osc.py` 先頭の定数を環境に合わせて変更してください。
```
CSV_FILE = 'flight_data.csv'   # 読み込む CSV
IP = "10.227.81.102"           # 送信先ホスト
PORT = 9000                    # 送信先ポート
FPS = 50                       # 送信レート（回/秒）
```
- 送信先の OSC アドレスは `/plane/data` で、`[roll, pitch, yaw, sv1, sv3]` を配列で送ります。
- FPS に応じて 1/FPS 秒間隔で送信し、処理時間は高精度タイマーで補正します。
- CSV の文字コードは `utf-8`, `cp932`, `utf-8-sig` の順で自動判定します。

## 実行方法
1. 送信端末側で Python 環境と依存ライブラリを準備
2. `Python` ディレクトリに移動
3. 必要なら定数 `IP`, `PORT`, `CSV_FILE`, `FPS` を編集
4. 実行  
   ```bash
   cd Python
   python send_osc.py
   ```
5. コンソールに「送信開始」「送信完了」が表示されれば正常終了です。`Ctrl+C` で途中停止できます。

## 受信する際の設定
- Cluster から送信される OSC アドレスは `/plane/control` で、`[aileron, elevator, rudder]` を配列で受け取ります。
- 受信確認用コード
```python
from pythonosc import dispatcher, osc_server

def handler(address, *args):
    print(f"{address}: {args}")

d = dispatcher.Dispatcher()
d.set_default_handler(handler)

server = osc_server.ThreadingOSCUDPServer(("0.0.0.0", 9001), d)
print("受信待機中... 0.0.0.0:9001")
server.serve_forever()
```
- 受信する際にはCluster側で送信の有効化と送信先を指定してください
   
## Unity 連携メモ
- Unity 側で OSC を受信できる状態にし、上記 IP/PORT を一致させてください。
- Cluster Creator Kit 環境の説明は `Unity/osc-flight-telemetry/README.md` を参照してください。

## 舵面（エルロン / エレベーター / ラダー）の受信

### OSC アドレス
| アドレス | 引数 (float) | 内容 |
| --- | --- | --- |
| `/plane/data` | `roll, pitch, yaw, sv1, sv3` | 機体姿勢 (deg) とサーボ値（従来どおり） |
| `/plane/aileron/quat` | `x, y, z, w` | エルロンの回転 |
| `/plane/elevator/quat` | `x, y, z, w` | エレベーターの回転 |
| `/plane/rudder/quat` | `x, y, z, w` | ラダーの回転 |
| `/plane/pos` | `x, y, z` | 機体の位置 (m)。下記「機体の位置」を参照 |

- クォータニオンは Unity の座標系（左手系、X=右 / Y=上 / Z=前）で、各舵面の**中立姿勢からの回転**です。
- 正規化されていない値は受信側で正規化します（モニターの EVENTS 欄に警告が出ます）。
- 送信側と cluster 側のアドレスは同じ並びです（cluster の `ControlPanel` は `TX_SEND_QUATS = true` のとき、トリム角を同じ形式で送ります）。

### 機体の位置（`/plane/pos`）
- 値は**初期位置（シーンに置いた `PlaneBody` の位置）からの相対位置**で、単位は m、座標系は Unity と同じ（X=右 / Y=上 / Z=前）です。
- cluster 側では次の式で `PlaneBody` を動かします（全員に同期）。設定は `PlaneBody.js` 先頭の定数です。
  - ワールド位置 = 初期位置 + 受信値 × `POS_SCALE`（既定 1.0）
  - `POS_MIN` / `POS_MAX`（既定 X/Z ±4.5 m、Y 0.3〜9.5 m）の範囲に収めます。部屋は 10 m 四方・高さ 10 m です。範囲外の値は端で止まり、モニターに `CLAMPED` と表示されます。
- 実機の飛行データは部屋より大きいので、`POS_SCALE` を `0.01`（100 m → 1 m）などに縮めてください。
- `Cube_OSC_Trigger` をクリックしたとき（操縦者が替わったとき）、機体は初期位置に戻ります。
- `send_osc.py` は、CSV に `pos_x`, `pos_y`, `pos_z` 列があれば `/plane/pos` も送ります。列が無ければ従来どおり `/plane/data` だけです。

### cluster 側の構成（`Assets/Scripts/OscFlight/`）
- `OscFlightPlayer.js`：`Cube_OSC_Trigger` の PlayerScript。OSC を受信し、次の3つを行います。
  - `PlaneBody` へ姿勢（`updateRotation`）と舵面（`updateSurfaces`）を最大 20 Hz で転送（アイテム経由なので全員に同期）
  - ワールド内の **OSC モニター**に数値・グラフ・舵面プレビューを表示（本人の画面だけ、同期なし）
  - `ControlPanel` で設定したトリム角と PID ゲインを OSC で外部へ送信（下記「トリム角と PID ゲインの送信」）
- `OscTrigger.js`：`Cube_OSC_Trigger` の Scriptable Item。クリックした人に PlayerScript を渡して**操縦者**にし、キューブの上の `OperatorLabel` に名前を表示します（全員に同期）。
- `ControlPanel.js`：`ControlPanel` の Scriptable Item。ボタンから受け取ったトリム角と PID ゲインを保持・表示（全員に同期）し、操縦者の PlayerScript に渡します。
- `ControlButton.js`：ControlPanel のボタン（全 70 個で共通）の Scriptable Item。押されたら ControlPanel に通知し、キーを押し込むアニメーションをします。どのボタンかは ControlPanel が World Item Reference List（`btn.*`）で判別します。
- `PlaneBody.js`：`PlaneBody` の Scriptable Item。操縦者からの更新だけを受け付けて姿勢を反映し、子孫に `AileronPivot` / `ElevatorPivot` / `RudderPivot` があれば `localRotation = 中立姿勢 × 受信クォータニオン` で回します。ピボットが無い舵面は無視されます。
  - モデルに舵面を実装するときは、ヒンジ位置に原点を置いた空オブジェクトを上記の名前で作り、その子に舵面メッシュを入れてください。

### 操縦者（OSC で機体を動かせる人）
- `Cube_OSC_Trigger` を**最後にクリックした 1 人**が操縦者です。機体（`PlaneBody`）に反映されるのはその人の OSC だけです。
- 別の人がクリックすると操縦者が切り替わります。前の操縦者の PlayerScript は機体への転送を止めますが、受信とモニター表示は続けます。
- 操縦者の名前は、キューブの上のラベル（全員に見える）と、モニターのヘッダー（`OPERATOR`）に表示されます。
- 表示フォントは英数字のみです。表示名に英数字以外が含まれる場合は、代わりにユーザー ID（`@id`）を表示します。
- 操縦者が退室すると、ラベルは `none` に戻ります。

### セットアップ（初回のみ）
1. Unity で `Assets/Scene/OSC_receive.unity` を開く
2. メニュー **Tools > OSC Flight > Setup All In Open Scene** を実行（下の「Setup Monitor」と「Setup Control Panel」をまとめて実行します。個別に実行してもかまいません）

**Setup Monitor In Open Scene**
   - シーン直下に `OscMonitor`（ワールド空間の PlayerLocalUI）を生成します。初期位置は `(0, 2.1, -4.2)` で、スポーン地点の正面の壁際です。位置は自由に動かしてかまいません（再実行しても位置は維持されます）。
   - `Cube_OSC_Trigger` の PlayerScript / Scriptable Item と `PlaneBody` / `ControlPanel` の Scriptable Item を上記 `.js` に差し替え、キューブの上に `OperatorLabel` を作り、UI 参照（`oscmon.*`）を Player Local Object Reference List に、`PlaneBody` と `ControlPanel` を `Cube_OSC_Trigger` の World Item Reference List に登録します。

**Setup Control Panel In Open Scene**
   - `ControlPanel` を OSC モニターと同じ見た目（ボード / カード / ゲージ）で作り直します。位置は維持し、初回だけ表をスポーン地点（原点）側に向けます（90 度単位）。
   - 上段にトリム（舵面ごとに `-10 / -1 / 0 / +1 / +10`）、下段に PID（軸ごとに Kp / Ki / Kd × `-1 / -.1 / -.01 / +.01 / +.1 / +1`）、ヘッダーに `RESET TRIM` のボタンを生成します（シーン直下の `ControlPanelButtons` の下。Item の中に Item は入れられないため）。旧ボタン（`Btn_AIL_*` など）とその親（`Aileron` / `Elevator` / `Rudder`）は削除します。
   - `ControlPanel` → `ControlPanel.js`、各ボタン → `ControlButton.js` に設定し、参照を登録します。マテリアルは `Assets/Materials/OscPanel_*.mat`（Unlit/Color）です。
   - パネルを動かしたら再実行してください（ボタンがパネルの位置に合わせて作り直されます）。

3. メニュー **Tools > OSC Flight > Setup Start Button In Open Scene** を実行（任意）
   - `Cube_OSC_Trigger` の見た目を、台座＋緑に光る押しボタン＋前面ラベル（`OSC / PUSH TO RECEIVE`）に置き換えます。当たり判定もボタンの大きさに合わせます。
   - 初回だけ、ボタンの前面をスポーン地点（原点）に向けます。再実行しても向きと位置は維持されます。
   - クリックすると押しボタン（子の `Cap`）が沈んで戻ります（`OscTrigger.js` が動かし、全員に同期）。
4. シーンを保存してアップロード

### OSC モニターの見方
- cluster で `Cube_OSC_Trigger` をクリックすると、PlayerScript が起動してモニターの更新が始まります。
- **ヘッダー**：`OSC RX ON/OFF`。OFF なら cluster の「設定 > その他 > OSC受信の有効化」をオンにしてください。
  - その下の `OPERATOR` に操縦者を表示します。自分なら `(you)`、別の人なら `monitor only`（自分の OSC は機体に反映されない）です。
- **各カード**（ATTITUDE / AILERON / ELEVATOR / RUDDER / POSITION）
  - `LIVE / NO SIGNAL / WAITING`、受信レート (Hz)、受信数、最終受信からの経過秒
  - 直近 5 秒のグラフ。姿勢は roll / pitch / yaw、舵面はオイラー角 X / Y / Z (deg)。縦軸は自動スケールです。
  - 受信した生の値（クォータニオン `x y z w`、`|q|`、オイラー角、回転角と回転軸）
  - POSITION は受信値 x / y / z (m) のグラフと、`PlaneBody` のワールド位置・縮尺・初期位置を表示します。
- **TRACK**：部屋を上から見た図に、機体の軌跡（直近 20 秒）と現在位置（三角形の先端が機首方位 yaw）を描きます。`+` が初期位置、枠が `POS_MIN` / `POS_MAX` の範囲です。
  - 既定では、既定位置のモニター（-Z 側の壁）に向かって立ったときの見え方です（画面の上 = -Z、右 = -X）。`OscFlightPlayer.js` の `TRACK_VIEW_FROM_SPAWN = false` で、上 = +Z、右 = +X になります。
- **SURFACE PREVIEW**：受信したクォータニオンで舵面の板を回した簡易 3D 表示（灰色は中立位置）。モデル実装前に、回転の向きや軸が合っているかを確かめるためのものです。
  - 機体全体を `/plane/data` の姿勢（roll / pitch / yaw）で傾けます。`OscFlightPlayer.js` の `PREVIEW_ATTITUDE` / `PREVIEW_YAW` で無効にできます。
  - エルロンは左右両方を表示します。左は `/plane/aileron/quat` をそのまま、右は左を左右対称にして逆向きに動かしたもの（クォータニオンの `x` の符号を反転）です。
- **TX 行**（タイトルの下）：送信状態（`ON` / `OSC SEND OFF` / `OFF (not operator)`）、送信中のトリム角、PID を送っている軸（`RPY` のうち明るい文字）、送信回数、最後に送ってからの秒数。
- **EVENTS**：未登録アドレスの受信や、引数の数が足りないといった問題を表示します。

## トリム角と PID ゲインの送信（cluster → 外部）

cluster 内の `ControlPanel` で設定した**トリム角**（エルロン / エレベーター / ラダー）と **PID ゲイン**（roll / pitch / yaw の Kp・Ki・Kd）を、cluster の OSC 送信機能で外部へ送ります。

### 送信される OSC
| アドレス | 引数 (float) | 内容 |
| --- | --- | --- |
| `/plane/trim` | `aileron, elevator, rudder` | トリム角 (deg, -30〜+30) |
| `/plane/pid/roll` | `kp, ki, kd` | ロールの PID ゲイン (0〜10) |
| `/plane/pid/pitch` | `kp, ki, kd` | ピッチの PID ゲイン (0〜10) |
| `/plane/pid/yaw` | `kp, ki, kd` | ヨーの PID ゲイン (0〜10) |

- **PID は、その軸のボタンを一度でも押すまで送りません。** 操縦者が入っただけで機体側のゲインが初期値で上書きされないようにするためです。押す前に表示される初期値（最初に押したときの基準値）は、`ControlPanel.js` 冒頭の `PID_DEFAULTS` で設定できます。機体側の現在のゲインに合わせておくと安全です。
- 値が変わったときにすぐ送り、変わらなくても 0.5 秒ごとに送り直します（UDP の取りこぼし対策）。1 メッセージ = 1 パケットで、OSC バンドルは使いません。
- 送るのは**操縦者**（最後に `Cube_OSC_Trigger` をクリックした人）の cluster だけです。ボタンは誰が押してもかまいません。
- 送信の有無・間隔は `OscFlightPlayer.js` 冒頭の `TX_*` 定数で変更できます。`TX_SEND_QUATS = true` にすると、トリム角を `/plane/aileron/quat` などのクォータニオン（受信側と同じ形式）でも送ります（ループバック確認用。既定はオフ）。

### コントロールパネルの見方
- **ヘッダー**：`TX ON` / `TX OSC SEND OFF`（操縦者の cluster で OSC 送信がオフ）/ `no operator`（まだ誰も `Cube_OSC_Trigger` を押していない）と、送信している人の名前。右端の `RESET TRIM` でトリム角をすべて 0 に戻します（PID は変わりません）。
- **上段：トリム**（AILERON / ELEVATOR / RUDDER TRIM）：数値、-30〜+30 のゲージ（針が現在値）、`-10 / -1 / 0 / +1 / +10` ボタン（`0` はその舵面だけ 0 に戻す）。
- **下段：PID**（ROLL / PITCH / YAW PID）：Kp / Ki / Kd の数値と `-1 / -.1 / -.01 / +.01 / +.1 / +1` ボタン。右上の `NOT SENT` / `SENDING` で、その軸を送っているかが分かります（送る前の数値は灰色）。
- 値と表示はワールドの全員で共有されます。ワールドを作り直すと初期値に戻ります。

### 流れ
`ControlButton.js`（各ボタン, 70 個で共通）→ `controlButton` → `ControlPanel.js`（値を保持・表示）→ `controlValues` → 操縦者の `OscFlightPlayer.js`（PlayerScript）→ `_.oscHandle.send()` → 外部
（PlayerScript は送信設定の ON/OFF を `txStatus` で ControlPanel に知らせ、ヘッダーに表示されます）

### 使い方
1. cluster の「設定 > その他」で **OSC送信の有効化** をオンにし、送信先 IP / ポートを設定する
2. ワールドで `Cube_OSC_Trigger` をクリックして操縦者になる
3. `ControlPanel` のボタンを押す
4. 受信側で確認する（例）
   ```bash
   cd Python
   python receive_osc.py --port 9001                             # すべて表示
   python receive_osc.py --port 9001 --address /plane/trim       # トリム角だけ
   python receive_osc.py --port 9001 --address /plane/pid/pitch  # ピッチの PID だけ
   ```
- 外部の機体を動かすときは、送信先を cluster 自身の OSC 受信ポートと別のポートにしてください。

### デモ送信（Python）
```bash
cd Python
python send_surfaces_demo.py                   # サイン波で 3 舵面を動かす
python send_surfaces_demo.py --mode step       # 0 → +最大 → 0 → -最大（向きの確認）
python send_surfaces_demo.py --mode sequence   # 1 舵面ずつ順番に動かす（割り当ての確認）
python send_surfaces_demo.py --attitude        # 機体姿勢 /plane/data も一緒に送る
python send_surfaces_demo.py --attitude --position   # 位置 /plane/pos も送り、部屋の中を周回させる
python send_surfaces_demo.py --attitude --position --radius 2 --period 30   # 半径 2 m、1 周 30 秒
python send_surfaces_demo.py --ip 192.168.0.10 --port 9000 --hz 50 --duration 30
```
- 既定の送信先は `127.0.0.1:9000` です。cluster を別の PC で動かしている場合は `--ip` を指定してください。
- エルロンとエレベーターは X 軸まわり、ラダーは Y 軸まわりに回転させたクォータニオンを送ります。
- `--position` は初期位置を中心に半径 3 m の円を 20 秒で 1 周し、高さを 0.2〜1.8 m 上下させます。`--attitude` と一緒に使うと、yaw が進行方向に合います。
