"""Screenshot of the primary monitor, downscaled and JPEG-encoded for Claude vision."""

import base64
import io

MAX_SIDE = 1568  # Claude resizes anything larger anyway; sending less is faster.


def capture_screen_b64() -> str:
    import mss
    from PIL import Image

    with mss.mss() as sct:
        shot = sct.grab(sct.monitors[1])
        img = Image.frombytes("RGB", shot.size, shot.rgb)
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")
