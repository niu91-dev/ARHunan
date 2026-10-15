#!/usr/bin/env python3
"""Serve a folder over HTTPS on the LAN, so a phone/tablet can open it.

Why HTTPS is mandatory
----------------------
Chrome only exposes DeviceOrientationEvent / DeviceMotionEvent and getUserMedia
in a SECURE CONTEXT.  http://192.168.x.x  is NOT a secure context, so on plain
HTTP both the sensors AND the camera are silently unavailable.  A self-signed
HTTPS cert (which you click through once) IS a secure context, so everything works.

Usage
-----
    python serve-lan.py [directory] [--port 8443] [--ip 192.168.31.180]

Defaults to ./public on port 8443.  Generates cert.pem / key.pem on first run.

Notes
-----
* Windows Firewall may block the first inbound connection -- allow it when asked.
* The cert is self-signed: the tablet will show "Not secure" once.  Tap
  Advanced -> Proceed.  After that the page is a full secure context.
* If you cannot click through, alternative: on the tablet open
  chrome://flags/#unsafely-treat-insecure-origin-as-secure , add
  http://<ip>:<port> , relaunch, and use plain HTTP instead.
"""

import http.server
import os
import re
import socket
import ssl
import subprocess
import sys
from pathlib import Path


def detect_lan_ip():
    """Return the private IPv4 that has a default gateway (skips proxy adapters)."""
    try:
        raw = subprocess.run(["ipconfig", "/all"], capture_output=True).stdout
    except Exception:
        raw = b""
    txt = ""
    for enc in ("gbk", "cp936", "utf-8"):
        try:
            txt = raw.decode(enc)
            break
        except Exception:
            continue
    for block in re.split(r"\r?\n\r?\n", txt):
        ips = re.findall(r"IPv4[^:]*:\s*([0-9.]+)", block)
        gw = re.findall(r"(?:Default Gateway|默认网关)[^:]*:\s*([0-9.]+)", block)
        if not ips or not gw:
            continue
        ip = ips[0]
        if ip.startswith(("192.168.", "10.", "172.16.", "172.17.", "172.18.",
                          "172.19.", "172.2", "172.3")):
            return ip
    # fallback: UDP trick
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(here, ip):
    cert, key = here / "cert.pem", here / "key.pem"
    if cert.exists() and key.exists():
        return cert, key
    print("生成自签名证书（含 IP SAN）…")
    san = "subjectAltName=IP:%s,IP:127.0.0.1,DNS:localhost" % ip
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", str(key), "-out", str(cert),
        "-days", "825", "-nodes",
        "-subj", "/CN=%s" % ip,
        "-addext", san,
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        print(r.stderr.decode("utf-8", "replace"))
        raise SystemExit("证书生成失败：请确认 openssl 可用")
    print("证书已生成：", cert.name, "/", key.name)
    return cert, key


def write_qr_png(path, matrix, scale=8):
    """Encode a boolean QR matrix as a grayscale PNG using only the stdlib.

    qrcode's own PNG writer needs the third-party `pypng` package, which is
    often unavailable offline -- so we emit the PNG ourselves (zlib + struct).
    """
    import struct
    import zlib

    n = len(matrix)
    size = n * scale

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type: None
        my = matrix[y // scale]
        for x in range(size):
            raw.append(0 if my[x // scale] else 255)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 0, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def try_qr(url, out_png):
    """Print an ASCII QR in the console and save a PNG next to this script."""
    try:
        import qrcode
    except Exception:
        return False
    try:
        qr = qrcode.QRCode(border=4)
        qr.add_data(url)
        qr.make()
        qr.print_ascii(invert=True)
        write_qr_png(out_png, qr.get_matrix())
        print("  二维码图片 : %s" % out_png.name)
        return True
    except Exception as exc:  # pragma: no cover - best effort
        print("  (二维码生成失败：%s)" % exc)
        return False


def main():
    args = sys.argv[1:]
    directory = "public"
    port = 8443
    ip = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
            i += 2
            continue
        if a == "--ip" and i + 1 < len(args):
            ip = args[i + 1]
            i += 2
            continue
        if not a.startswith("--"):
            directory = a
        i += 1

    here = Path(__file__).resolve().parent
    root = (here / directory).resolve()
    if not root.is_dir():
        raise SystemExit("目录不存在：%s" % root)

    ip = ip or detect_lan_ip()
    cert, key = ensure_cert(here, ip)

    class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()

    handler = lambda *a, **k: NoCacheHandler(*a, directory=str(root), **k)  # noqa: E731
    try:
        httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    except OSError as exc:
        raise SystemExit(
            "端口 %d 已被占用（%s）。换个端口：--port 8444" % (port, exc)
        )

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert), keyfile=str(key))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    url = "https://%s:%d/" % (ip, port)
    print()
    print("=" * 58)
    print("  局域网 HTTPS 已启动")
    print("=" * 58)
    print("  服务目录 : %s" % root)
    print("  平板访问 : %s" % url)
    print("  本机自测 : https://127.0.0.1:%d/" % port)
    print()
    print("  首次打开会提示「不安全」→ 点 高级 → 继续前往")
    print("  之后即为安全上下文，传感器与摄像头均可用")
    print("  如连不上，检查 Windows 防火墙是否放行该端口")
    print("  Ctrl+C 停止")
    print("=" * 58)
    if not try_qr(url, here / "qr-access.png"):
        print("  (未安装 qrcode，跳过二维码。pip install qrcode 可显示)")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
