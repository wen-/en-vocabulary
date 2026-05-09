from __future__ import annotations

import argparse
import pathlib
import ssl
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve a static directory over HTTPS.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=4443, type=int)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    directory = pathlib.Path(args.directory).resolve()
    cert = pathlib.Path(args.cert).resolve()
    key = pathlib.Path(args.key).resolve()

    handler = lambda *handler_args, **handler_kwargs: SimpleHTTPRequestHandler(  # noqa: E731
        *handler_args,
        directory=str(directory),
        **handler_kwargs,
    )

    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert), keyfile=str(key))
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    print(f"Serving HTTPS on https://{args.host}:{args.port}")
    print(f"Directory: {directory}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()