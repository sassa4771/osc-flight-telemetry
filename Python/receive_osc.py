import argparse
from datetime import datetime

from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import BlockingOSCUDPServer


def parse_args():
    parser = argparse.ArgumentParser(description="Simple OSC receiver for debugging.")
    parser.add_argument("--ip", default="0.0.0.0", help="Listen IP address")
    parser.add_argument("--port", type=int, default=9000, help="Listen port")
    parser.add_argument(
        "--address",
        default=None,
        help="Optional OSC address filter, for example /plane/data",
    )
    return parser.parse_args()


def make_handler(address_filter):
    def handler(address, *args):
        if address_filter and address != address_filter:
            return

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"[{timestamp}] address={address} values={list(args)}")

    return handler


def main():
    args = parse_args()

    dispatcher = Dispatcher()
    dispatcher.set_default_handler(make_handler(args.address))

    server = BlockingOSCUDPServer((args.ip, args.port), dispatcher)

    print(
        f"Listening for OSC on {args.ip}:{args.port}"
        + (f" filter={args.address}" if args.address else "")
    )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
