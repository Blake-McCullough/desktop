#!/usr/bin/env python3
"""
Regenerate the app's icons from the SVG sources in app/static/logos.

  logo-source.svg      production icons
  logo-source-dev.svg  development build icons (amber, so they stand out)

Needs rsvg-convert (librsvg) and Pillow:  python3 script/generate-logos.py

The macOS Assets.car / .icns made from the .icon bundles still need Xcode,
see script/build-icon-assets.sh; this script updates the bundles' artwork.
"""
import io
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / 'app' / 'static'
LOGOS = STATIC / 'logos'
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


# At 32px and below the thin lines blur away, so small sizes use bolder
# strokes and bigger nodes (same artwork otherwise).
SMALL_SIZE = 32
BOLD = [
    ('stroke-width="24"', 'stroke-width="44"'),
    ('stroke-width="20"', 'stroke-width="40"'),
    ('r="26"', 'r="42"'),
]


def render(svg: Path, size: int) -> Image.Image:
    source = svg.read_text()
    if size <= SMALL_SIZE:
        for old, new in BOLD:
            source = source.replace(old, new)
    png = subprocess.run(
        ['rsvg-convert', '-w', str(size), '-h', str(size)],
        input=source.encode(),
        check=True,
        capture_output=True,
    ).stdout
    return Image.open(io.BytesIO(png)).convert('RGBA')


def write_ico(svg: Path, out: Path):
    # Render each size separately so small sizes stay crisp.
    images = [render(svg, s) for s in ICO_SIZES]
    images[-1].save(out, format='ICO', sizes=[(s, s) for s in ICO_SIZES],
                    append_images=images[:-1])


def write_icns(svg: Path, out: Path):
    render(svg, 1024).save(out, format='ICNS')


SPLASH_FRAMES = 16
SPLASH_FRAME_MS = 90


def splash_frame(logo_svg: str, t: float) -> str:
    """One frame of the Windows installer splash; t goes 0 → 1 per loop."""
    import math

    # A ring pulses out of the logo's green node; three dots step along.
    ring_r = 26 + 46 * t
    ring_opacity = 0.75 * (1 - t)
    dots = []
    for i in range(3):
        phase = (t * 3 - i) % 3
        opacity = 1.0 if phase < 1 else 0.3
        dots.append(
            f'<circle cx="{184 + i * 16}" cy="352" r="4" '
            f'fill="#34D399" fill-opacity="{opacity:.2f}"/>'
        )
    # The logo artwork without its own background square.
    inner = logo_svg.split('<rect', 1)[1].split('/>', 1)[1].rsplit('</svg>', 1)[0]
    defs = logo_svg.split('<defs>', 1)[1].split('</defs>', 1)[0]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<defs>{defs}</defs>
<rect width="400" height="400" fill="#0B1220"/>
<g transform="translate(110 40) scale(0.35)">
  <circle cx="316" cy="196" r="{ring_r:.1f}" fill="none" stroke="#34D399"
          stroke-width="8" stroke-opacity="{ring_opacity:.2f}"/>
  {inner}
</g>
<text x="200" y="252" text-anchor="middle" font-family="Inter, Segoe UI, sans-serif"
      font-size="22" font-weight="600" fill="#F5F7FF">GitHub Desktop Custom</text>
<text x="200" y="280" text-anchor="middle" font-family="Inter, Segoe UI, sans-serif"
      font-size="22" font-weight="600" fill="#34D399">GitLab CI</text>
<text x="200" y="318" text-anchor="middle" font-family="Inter, Segoe UI, sans-serif"
      font-size="13" fill="#9AA4B8">Installing… it'll open once it's done.</text>
{''.join(dots)}
</svg>"""


def write_splash(logo: Path, out: Path):
    source = logo.read_text()
    frames = []
    for i in range(SPLASH_FRAMES):
        svg = splash_frame(source, i / SPLASH_FRAMES)
        png = subprocess.run(['rsvg-convert'], input=svg.encode(),
                             check=True, capture_output=True).stdout
        frames.append(Image.open(io.BytesIO(png)).convert('RGB')
                      .quantize(colors=128, method=Image.Quantize.MEDIANCUT))
    frames[0].save(out, save_all=True, append_images=frames[1:],
                   duration=SPLASH_FRAME_MS, loop=0, optimize=True)


def main():
    if shutil.which('rsvg-convert') is None:
        sys.exit('rsvg-convert (librsvg) is required')

    prod = LOGOS / 'logo-source.svg'
    dev = LOGOS / 'logo-source-dev.svg'

    render(prod, 128).save(STATIC / 'common' / 'logo-64x64@2x.png')
    render(prod, 128).save(STATIC / 'common' / 'windows-logo-64x64@2x.png')
    render(prod, 512).save(STATIC / 'linux' / 'icon-logo.png')
    # Windows title bar: shown at 16px, drawn at 2x with the bold artwork.
    render(prod, 32).save(STATIC / 'common' / 'title-bar-logo-16x16@2x.png')

    for svg, kind in [(prod, 'prod'), (dev, 'dev')]:
        write_ico(svg, LOGOS / kind / 'icon-logo.ico')
        write_icns(svg, LOGOS / kind / 'icon-logo-legacy.icns')

    write_splash(prod, LOGOS / 'win32-installer-splash.gif')

    print('Icons regenerated from', prod.name, 'and', dev.name)


if __name__ == '__main__':
    main()
