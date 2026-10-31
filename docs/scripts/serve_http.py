"""Serve the app over plain HTTP and ask browsers to revalidate every file.

Service workers do not run on http://<LAN IP>, so Safari's HTTP cache decides
which code an iPhone runs. Cache-Control: no-cache makes it check for updates.
"""

import argparse
import pathlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[1]
    server = ThreadingHTTPServer((args.host, args.port), lambda *a, **k: NoCacheHandler(*a, directory=str(root), **k))
    print(f"Serving {root} on http://{args.host}:{args.port} (Cache-Control: no-cache)")
    server.serve_forever()


if __name__ == "__main__":
    main()
