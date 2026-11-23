"""Render a duel report as a narrow PNG for mobile QQ."""

import os
import re
import sys
import json

from PIL import Image, ImageDraw, ImageFont


WIDTH = 780
MARGIN = 36
FONT_PATH = os.environ.get(
    "QQBOT_REPORT_FONT", "C:/Windows/Fonts/msyh.ttc" if os.name == "nt" else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
)


def wrap(text, font, width):
    line = ""
    for char in text:
        if line and font.getlength(line + char) > width:
            yield line
            line = ""
        line += char
    if line:
        yield line


def render(report, players=None):
    if isinstance(report, dict):
        from duel_record_adapter import to_report
        report = to_report(report, players)
    title_font = ImageFont.truetype(FONT_PATH, 34)
    body_font = ImageFont.truetype(FONT_PATH, 26)
    sections = []
    report = re.sub(r"^(【(?:三轮)?交锋对战】)", r"\1\n", report, count=1)
    for raw in report.splitlines():
        text = raw.strip()
        if not text:
            continue
        heading = text.startswith("【") or re.fullmatch(r"第\d+(?:轮|回合)", text)
        font = title_font if heading else body_font
        color = "#86e5ff" if heading else "#eff5fb"
        if text.startswith("同时结算"):
            color = "#a5f3c4"
        line_height = 51 if heading else 40
        sections.append((list(wrap(text, font, WIDTH - 2 * MARGIN)), font, color, line_height, heading))

    height = 2 * MARGIN + sum(len(lines) * line_height + (16 if heading else 0)
                              for lines, _, _, line_height, heading in sections)
    image = Image.new("RGB", (WIDTH, height), "#121c2a")
    draw = ImageDraw.Draw(image)
    y = MARGIN
    for lines, font, color, line_height, heading in sections:
        if heading:
            draw.line((MARGIN, y, WIDTH - MARGIN, y), fill="#355369", width=2)
            y += 16
        for line in lines:
            draw.text((MARGIN, y), line, font=font, fill=color, anchor="lt")
            y += line_height
    return image


if __name__ == "__main__":
    if sys.argv[1] == '--json':
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument('--json', required=True)
        parser.add_argument('--players')
        parser.add_argument('--output')
        args = parser.parse_args()
        with open(args.json, encoding='utf-8-sig') as source:
            record = json.load(source)
        players = None
        if args.players:
            with open(args.players, encoding='utf-8-sig') as source:
                players = json.load(source)
        render(record, players).save(args.output or sys.stdout.buffer, format='PNG')
    else:
        render(sys.argv[1]).save(sys.stdout.buffer, format="PNG")
