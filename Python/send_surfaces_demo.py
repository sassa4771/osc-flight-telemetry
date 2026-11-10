"""舵面 (エルロン / エレベーター / ラダー) のクォータニオンを OSC で送るデモ。

cluster 側 (Cube_OSC_Trigger の PlayerScript = OscFlightPlayer.js) が受信し、
ワールド内の OSC モニターに数値・グラフ・舵面プレビューを表示します。

送信する OSC メッセージ (すべて float)
    /plane/aileron/quat   [x, y, z, w]
    /plane/elevator/quat  [x, y, z, w]
    /plane/rudder/quat    [x, y, z, w]
    /plane/data           [roll, pitch, yaw, sv1, sv3]   (--attitude を付けたときだけ)
    /plane/pos            [x, y, z]  (m)                 (--position を付けたときだけ)

クォータニオンは Unity の座標系 (左手系, X=右, Y=上, Z=前) で、
各舵面の「中立姿勢からの回転」を表します。デモではヒンジ軸まわりの回転を
axis-angle から作っています (エルロン/エレベーター: X 軸, ラダー: Y 軸)。

使い方
    python send_surfaces_demo.py                      # サイン波で 3 舵面を動かす
    python send_surfaces_demo.py --mode step          # 0 → +最大 → 0 → -最大 を 2 秒ごと
    python send_surfaces_demo.py --mode sequence      # 1 舵面ずつ順番に動かす (割り当て確認用)
    python send_surfaces_demo.py --attitude           # 機体姿勢 /plane/data も一緒に送る
    python send_surfaces_demo.py --attitude --position  # 位置 /plane/pos も送って部屋の中を周回させる
    python send_surfaces_demo.py --ip 192.168.0.10 --port 9000 --hz 50 --duration 30
"""

import argparse
import math
import sys
import time

from pythonosc import udp_client

# name: (OSC アドレス, ヒンジ軸 (Unity ローカル), 振幅 deg, 周波数 Hz, 位相 rad)
SURFACES = {
    "aileron": ("/plane/aileron/quat", (1.0, 0.0, 0.0), 20.0, 0.50, 0.0),
    "elevator": ("/plane/elevator/quat", (1.0, 0.0, 0.0), 15.0, 0.30, math.pi / 2),
    "rudder": ("/plane/rudder/quat", (0.0, 1.0, 0.0), 25.0, 0.20, math.pi),
}

STEP_PATTERN = (0.0, 1.0, 0.0, -1.0)  # step モードで振幅に掛ける係数
STEP_SECONDS = 2.0
SEQUENCE_SECONDS = 4.0  # sequence モードで 1 舵面を動かす時間


def axis_angle_to_quat(axis, degrees):
    """回転軸と角度 (deg) から Unity と同じ並び (x, y, z, w) のクォータニオンを作る。"""
    ax, ay, az = axis
    norm = math.sqrt(ax * ax + ay * ay + az * az)
    ax, ay, az = ax / norm, ay / norm, az / norm
    half = math.radians(degrees) * 0.5
    s = math.sin(half)
    return (ax * s, ay * s, az * s, math.cos(half))


def surface_angle(mode, name, t, amp_scale):
    """時刻 t (秒) における舵面の角度 (deg)。"""
    _, _, amplitude, frequency, phase = SURFACES[name]
    amplitude *= amp_scale
    if mode == "sine":
        return amplitude * math.sin(2 * math.pi * frequency * t + phase)
    if mode == "step":
        index = int(t // STEP_SECONDS) % len(STEP_PATTERN)
        return amplitude * STEP_PATTERN[index]
    if mode == "sequence":
        names = list(SURFACES)
        active = names[int(t // SEQUENCE_SECONDS) % len(names)]
        if name != active:
            return 0.0
        local_t = t % SEQUENCE_SECONDS
        return amplitude * math.sin(2 * math.pi * local_t / SEQUENCE_SECONDS)
    raise ValueError(f"unknown mode: {mode}")


def position(t, radius, period):
    """デモ用の位置 (m, 初期位置からの相対)。初期位置を中心に水平な円を描き、高さは上下させる。

    戻り値: ([x, y, z], 機首方位 yaw deg)。yaw は進行方向 (Unity: +Z が 0 度, +X が 90 度)。
    """
    theta = 2 * math.pi * t / period
    x = radius * math.sin(theta)
    z = radius * math.cos(theta)
    y = 1.0 + 0.8 * math.sin(2 * theta)
    yaw = math.degrees(math.atan2(math.cos(theta), -math.sin(theta))) % 360.0
    return [x, y, z], yaw


def attitude(t, angles, heading=None):
    """デモ用の機体姿勢。舵面の動きにゆるく連動させる。heading があれば yaw はそれに合わせる。"""
    roll = 0.8 * angles["aileron"]
    pitch = 5.0 + 0.6 * angles["elevator"]
    yaw = heading if heading is not None else (20.0 * t) % 360.0
    sv1 = 90.0 + angles["aileron"]
    sv3 = 90.0 + angles["elevator"]
    return [roll, pitch, yaw, sv1, sv3]


def parse_args():
    parser = argparse.ArgumentParser(description="Send demo control-surface quaternions over OSC.")
    parser.add_argument("--ip", default="127.0.0.1", help="送信先 IP (cluster を動かしている PC)")
    parser.add_argument("--port", type=int, default=9000, help="送信先ポート (cluster の OSC 受信ポート)")
    parser.add_argument("--hz", type=float, default=50.0, help="送信レート (回/秒)")
    parser.add_argument("--duration", type=float, default=0.0, help="送信する秒数 (0 = Ctrl+C まで)")
    parser.add_argument("--mode", choices=["sine", "step", "sequence"], default="sine", help="動かし方")
    parser.add_argument("--amp", type=float, default=1.0, help="振幅の倍率 (1.0 = 既定の振幅)")
    parser.add_argument("--attitude", action="store_true", help="/plane/data (機体姿勢) も送る")
    parser.add_argument("--position", action="store_true", help="/plane/pos (位置, m) も送る")
    parser.add_argument("--radius", type=float, default=3.0, help="--position の周回半径 (m)")
    parser.add_argument("--period", type=float, default=20.0, help="--position の 1 周の秒数")
    return parser.parse_args()


def main():
    args = parse_args()
    if args.hz <= 0:
        sys.exit("--hz must be positive")
    if args.position and args.period <= 0:
        sys.exit("--period must be positive")

    client = udp_client.SimpleUDPClient(args.ip, args.port)
    interval = 1.0 / args.hz

    print(f"送信開始: {args.ip}:{args.port}  {args.hz:g} Hz  mode={args.mode}"
          + ("  +attitude" if args.attitude else "")
          + (f"  +position (r={args.radius:g} m, {args.period:g} s/lap)" if args.position else ""))
    print("Ctrl+C で停止")

    start = time.perf_counter()
    count = 0
    last_print = -1.0
    try:
        while True:
            target = start + count * interval
            wait = target - time.perf_counter()
            if wait > 0:
                time.sleep(wait)
            t = time.perf_counter() - start
            if args.duration > 0 and t >= args.duration:
                break

            angles = {}
            for name, (address, axis, *_rest) in SURFACES.items():
                angle = surface_angle(args.mode, name, t, args.amp)
                angles[name] = angle
                client.send_message(address, [float(v) for v in axis_angle_to_quat(axis, angle)])
            heading = None
            if args.position:
                pos, heading = position(t, args.radius, args.period)
                client.send_message("/plane/pos", [float(v) for v in pos])
            if args.attitude:
                client.send_message("/plane/data", [float(v) for v in attitude(t, angles, heading)])
            count += 1

            if t - last_print >= 0.2:
                last_print = t
                print(f"\r t={t:6.1f}s  AIL {angles['aileron']:+6.1f}°  ELV {angles['elevator']:+6.1f}°"
                      f"  RUD {angles['rudder']:+6.1f}°  sent={count}", end="", flush=True)
    except KeyboardInterrupt:
        print("\n停止しました。")
        return
    print(f"\n送信完了 ({count} フレーム)")


if __name__ == "__main__":
    main()
