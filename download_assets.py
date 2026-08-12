from pathlib import Path
from urllib.request import Request, urlopen
import base64
import html


ROOT = Path("war_chest_pnp")
BOARD = ROOT / "board"
SOURCES = BOARD / "sources"

SOURCES.mkdir(parents=True, exist_ok=True)


FILES = {
    SOURCES / "control_base.svg":
        "https://warchestonline.com/static/control_base-BDfeMat5.svg",

    SOURCES / "control_marker_white.png":
        "https://warchestonline.com/static/control_marker_white-C6coipIl.png",

    SOURCES / "control_marker_black.png":
        "https://warchestonline.com/static/control_marker_black-BQzoJwKh.png",
}


def download(path: Path, url: str):
    if path.exists() and path.stat().st_size:
        print(f"[SKIP] {path}")
        return

    req = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://warchestonline.com/how-to-play",
        },
    )

    with urlopen(req, timeout=30) as r:
        data = r.read()

    path.write_bytes(data)

    print(f"[OK]   {path} ({len(data):,} bytes)")


def data_uri(path: Path, mime: str) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode()
    return f"data:{mime};base64,{encoded}"


def make_hex(
    output: Path,
    marker: Path | None = None,
    neutral_base: Path | None = None,
):
    """
    Создаёт самостоятельный SVG.
    Все PNG/SVG встраиваются внутрь через data URI,
    поэтому готовый файл не зависит от sources/.
    """

    # Геометрия pointy-top hex.
    # 600x520 удобно масштабировать потом как угодно.
    polygon = (
        "150,0 "
        "450,0 "
        "600,260 "
        "450,520 "
        "150,520 "
        "0,260"
    )

    layers = []

    # Базовая клетка.
    layers.append(f"""
      <polygon
        points="{polygon}"
        fill="#c6aa82"
        stroke="#8f7657"
        stroke-width="10"
      />
    """)

    # Небольшая внутренняя рамка.
    inner = (
        "165,26 "
        "435,26 "
        "566,260 "
        "435,494 "
        "165,494 "
        "34,260"
    )

    layers.append(f"""
      <polygon
        points="{inner}"
        fill="none"
        stroke="#b39770"
        stroke-width="5"
        opacity="0.65"
      />
    """)

    if neutral_base is not None:
        svg_text = neutral_base.read_text(
            encoding="utf-8",
            errors="replace",
        )

        encoded = base64.b64encode(
            svg_text.encode("utf-8")
        ).decode()

        uri = f"data:image/svg+xml;base64,{encoded}"

        # Значок нейтральной location.
        layers.append(f"""
          <image
            href="{uri}"
            x="145"
            y="105"
            width="310"
            height="310"
            preserveAspectRatio="xMidYMid meet"
          />
        """)

    if marker is not None:
        uri = data_uri(marker, "image/png")

        # Control marker поверх location.
        layers.append(f"""
          <image
            href="{uri}"
            x="145"
            y="105"
            width="310"
            height="310"
            preserveAspectRatio="xMidYMid meet"
          />
        """)

    svg = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg
    xmlns="http://www.w3.org/2000/svg"
    xmlns:xlink="http://www.w3.org/1999/xlink"
    width="600"
    height="520"
    viewBox="0 0 600 520"
>
    {''.join(layers)}
</svg>
"""

    output.write_text(svg, encoding="utf-8")

    print(f"[GEN]  {output}")


def main():
    print("Downloading board assets...")
    print()

    for path, url in FILES.items():
        download(path, url)

    print()
    print("Generating board hexes...")
    print()

    neutral = SOURCES / "control_base.svg"
    white = SOURCES / "control_marker_white.png"
    black = SOURCES / "control_marker_black.png"

    # 1. Обычная клетка
    make_hex(
        BOARD / "hex_empty.svg",
    )

    # 2. Нейтральная база
    make_hex(
        BOARD / "hex_neutral.svg",
        neutral_base=neutral,
    )

    # 3. База белой стороны
    make_hex(
        BOARD / "hex_white.svg",
        marker=white,
    )

    # 4. База чёрной стороны
    make_hex(
        BOARD / "hex_black.svg",
        marker=black,
    )

    print()
    print("Done.")
    print(f"Result: {BOARD.resolve()}")


if __name__ == "__main__":
    main()
