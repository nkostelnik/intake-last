"""Draw docs/social-preview.png (1280x640), the GitHub social preview image.

    pip install pillow   # only needed to regenerate the image; not a project dependency
    python docs/make_social_preview.py

Same style as the nda-triage and ai-governance-kit previews. Uses Windows fonts.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
BG, FG, MUTED, LINE = "#0f172a", "#f8fafc", "#94a3b8", "#334155"
ACCENT, DIM = "#60a5fa", "#475569"
FONTS = Path("C:/Windows/Fonts")
OUT = Path(__file__).with_name("social-preview.png")


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def centered(draw: ImageDraw.ImageDraw, y: int, text: str, f, fill) -> None:
    w = draw.textlength(text, font=f)
    draw.text(((W - w) / 2, y), text, font=f, fill=fill)


def flow(draw: ImageDraw.ImageDraw, y: int, label: str, steps: list[str], color: str, text_color: str, strike: bool) -> None:
    """One row: a label, then steps as pills joined by arrows, centered as a group."""
    label_font, pill_font = font("segoeuib.ttf", 20), font("segoeuib.ttf", 26)
    pad, arrow, gap = 30, "\u2192", 18
    widths = [draw.textlength(s, font=pill_font) + pad * 2 for s in steps]
    arrow_w = draw.textlength(arrow, font=pill_font)
    label_w = 230
    total = label_w + sum(widths) + (arrow_w + gap * 2) * (len(steps) - 1)
    x = (W - total) / 2
    draw.text((x, y + 13), label, font=label_font, fill=text_color if not strike else DIM)
    x += label_w
    start = x
    for i, (s, w) in enumerate(zip(steps, widths)):
        if strike:
            draw.rounded_rectangle([x, y, x + w, y + 52], radius=26, outline=DIM, width=2)
        else:
            draw.rounded_rectangle([x, y, x + w, y + 52], radius=26, fill=color)
        draw.text((x + pad, y + 9), s, font=pill_font, fill=DIM if strike else BG)
        x += w
        if i < len(steps) - 1:
            draw.text((x + gap, y + 9), arrow, font=pill_font, fill=DIM if strike else MUTED)
            x += arrow_w + gap * 2
    if strike:
        draw.line([start - 8, y + 26, x + 8, y + 26], fill="#ef4444", width=4)


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

centered(d, 70, "Intake Last", font("segoeuib.ttf", 92), FG)
centered(d, 190, "Review the contract first. Ask the intake questions at download.", font("segoeui.ttf", 34), MUTED)

flow(d, 300, "USUAL INTAKE", ["Questions", "Review", "Redline"], DIM, MUTED, strike=True)
flow(d, 390, "INTAKE LAST", ["Review", "Questions", "Redline"], ACCENT, ACCENT, strike=False)

d.line([160, 500, W - 160, 500], fill=LINE, width=2)
centered(d, 525, "Every answer path pre-reviewed by Claude  \u00b7  YAML playbook  \u00b7  tracked changes in your own .docx",
         font("segoeui.ttf", 24), MUTED)

img.save(OUT)
print(f"Wrote {OUT}")
