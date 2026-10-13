#!/usr/bin/env python3
"""Generate solid red placeholder PNG icons for the extension (no PIL needed)."""
import struct, zlib, os

def create_png(size: int, r: int, g: int, b: int) -> bytes:
    def chunk(ctype: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + ctype + data + struct.pack('>I', zlib.crc32(ctype + data) & 0xFFFFFFFF)

    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    raw = b''
    for _ in range(size):
        raw += b'\x00' + bytes([r, g, b]) * size
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    return header + ihdr + idat + iend

os.makedirs('public/icons', exist_ok=True)
for size in (16, 48, 128):
    path = f'public/icons/icon{size}.png'
    with open(path, 'wb') as f:
        f.write(create_png(size, 0xEF, 0x44, 0x44))
    print(f'Created {path}')
