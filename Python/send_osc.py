import pandas as pd
from pythonosc import udp_client
import time
import sys

CSV_FILE = 'flight_data.csv' 
IP = "127.0.0.1"
PORT = 9000
FPS = 50
INTERVAL = 1.0 / FPS

client = udp_client.SimpleUDPClient(IP, PORT)

def load_csv():
    encodings = ['utf-8', 'cp932', 'utf-8-sig']
    for enc in encodings:
        try:
            df = pd.read_csv(CSV_FILE, encoding=enc, header=0)
            df.columns = df.columns.str.strip().str.lower()
            
            cols = ['roll', 'pitch', 'yaw', 'sv1', 'sv3']
            for col in cols:
                df[col] = pd.to_numeric(df[col], errors='coerce')
            
            df = df.dropna(subset=cols)
            return df
        except Exception as e:
            continue
    return None

df = load_csv()

if df is None:
    print(f"エラー: CSVファイル '{CSV_FILE}' を読み込めませんでした。")
    sys.exit()

print(f"送信開始: {len(df)} 件のデータを送信します。")

start_perf = time.perf_counter()
try:
    for index, row in df.iterrows():
        target_time = start_perf + (index * INTERVAL)
        
        data = [
            float(row['roll']), 
            float(row['pitch']), 
            float(row['yaw']),
            float(row['sv1']),
            float(row['sv3'])
        ]
        
        client.send_message("/plane/data", data)
        
        wait_time = target_time - time.perf_counter()
        if wait_time > 0:
            time.sleep(wait_time)
            
    print("送信完了")
except KeyboardInterrupt:
    print("\n停止しました。")