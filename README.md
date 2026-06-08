# osc-flight-telemetry

Unity 上の機体モデルへ CSV のフライトデータを OSC でストリーミングするためのプロジェクトです。  
Python スクリプトでテレメトリを送信し、`Unity/osc-flight-telemetry` で受信・可視化します。

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
