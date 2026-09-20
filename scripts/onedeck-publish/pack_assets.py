#!/usr/bin/env python3
"""Package oversized JSON/WASM artifacts as pre-gzipped static Pages files.

Cloudflare Pages rejects individual uploaded files above its size limit. For
large browser-readable JSON and WASM artifacts, store deterministic gzip bytes
under the original public filename and emit _headers rules declaring the
content encoding and media type. Browsers and standards-compliant fetch clients
then decode the response transparently without a Pages Function/Worker.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

LIMIT = 25 * 1024 * 1024


def package(root: Path, threshold: int = 20 * 1024 * 1024) -> dict:
    root = root.resolve()
    if not (root / 'index.html').is_file():
        raise ValueError('Not a web build: index.html missing')

    # This packaging mode deliberately stays static. Refuse to mix it with a
    # pre-existing Worker/routes/header policy whose precedence could change
    # how the encoded bytes are served.
    for name in ['_worker.js', '_routes.json', '_headers', 'encoded-assets.json']:
        if (root / name).exists():
            raise ValueError('Refusing to overwrite existing ' + name)

    entries = {}
    pending = []
    for p in sorted(root.rglob('*')):
        if p.is_symlink():
            raise ValueError('Symlink not permitted in published build')
        if not p.is_file() or p.suffix in {'.gz', '.br'}:
            continue
        if p.stat().st_size <= threshold:
            continue
        if p.suffix not in {'.json', '.wasm'}:
            if p.stat().st_size > LIMIT:
                raise ValueError('Asset needs external storage: ' + str(p.relative_to(root)))
            continue

        raw = p.read_bytes()
        packed = gzip.compress(raw, compresslevel=9, mtime=0)
        if len(packed) > LIMIT:
            raise ValueError('Compressed asset still exceeds Pages limit: ' + p.name)
        if gzip.decompress(packed) != raw:
            raise ValueError('Compression round-trip failure')

        sha = hashlib.sha256(raw).hexdigest()
        rel = '/' + p.relative_to(root).as_posix()
        media_type = 'application/wasm' if p.suffix == '.wasm' else 'application/json'
        immutable = sha[:16] in p.stem or p.suffix == '.wasm'
        entry = {
            'path': rel,
            'type': media_type,
            'sha256': sha,
            'decoded_bytes': len(raw),
            'uploaded_bytes': len(packed),
            'immutable': immutable,
        }
        entries[rel] = entry
        pending.append((p, packed, entry))

    if len(entries) > 90:
        raise ValueError('Encoded route count exceeds bounded limit')

    # Remove build-time compression siblings only when their original exists.
    # The original itself is then replaced in place with deterministic gzip
    # bytes, retaining the URL already referenced by the built application.
    for p in list(root.rglob('*')):
        if p.is_file() and p.suffix in {'.gz', '.br'} and p.with_suffix('').is_file():
            p.unlink()

    for p, packed, _entry in pending:
        p.write_bytes(packed)

    if entries:
        header_lines = []
        for rel, entry in entries.items():
            cache_control = (
                'public, max-age=31536000, immutable'
                if entry['immutable']
                else 'public, max-age=0, must-revalidate'
            )
            header_lines.extend([
                rel,
                '  Content-Encoding: gzip',
                '  Content-Type: ' + entry['type'],
                '  Cache-Control: ' + cache_control,
                '  X-Content-Type-Options: nosniff',
                '  Access-Control-Allow-Origin: *',
                '',
            ])
        (root / '_headers').write_text('\n'.join(header_lines), encoding='utf-8')

    (root / 'encoded-assets.json').write_text(json.dumps(entries, indent=2) + '\n')

    for p in root.rglob('*'):
        if p.is_file() and p.stat().st_size > LIMIT:
            raise ValueError('Unpackaged oversized asset: ' + str(p.relative_to(root)))

    print(json.dumps(entries, indent=2))
    return entries


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('directory', type=Path)
    ap.add_argument('--threshold', type=int, default=20 * 1024 * 1024)
    args = ap.parse_args()
    if args.threshold < 1 or args.threshold > LIMIT:
        ap.error('threshold must be between 1 byte and 25 MiB')
    package(args.directory, args.threshold)
