#!/usr/bin/env bash
set -euo pipefail

promo_regular=${PROMO_FONT_REGULAR:-/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc}
promo_bold=${PROMO_FONT_BOLD:-/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc}
promo_output=${1:-dist/media}
promo_preview=${2:-/tmp/gpu-timeline-promo}

test -f "$promo_regular"
test -f "$promo_bold"
python3 scripts/render_promo_v118.py --regular "$promo_regular" --bold "$promo_bold" --output "$promo_output"
python3 scripts/render_promo_v118.py --regular "$promo_regular" --bold "$promo_bold" --output "$promo_preview" --preview
python3 scripts/verify_promo.py "$promo_output"
python3 scripts/render_promo_v120.py --regular "$promo_regular" --bold "$promo_bold" --output "$promo_output"
python3 scripts/render_promo_v120.py --regular "$promo_regular" --bold "$promo_bold" --output "$promo_preview" --preview
python3 scripts/verify_promo.py "$promo_output" 1.2.0

# Preserve published preview URLs for cached pages and existing download links.
cp "$promo_output/CVML-GPU-Timeline-v1.2.0-60s.mp4" "$promo_output/CVML-GPU-Timeline-v1.2.0-preview-60s.mp4"
cp "$promo_output/CVML-GPU-Timeline-v1.2.0-60s.gif" "$promo_output/CVML-GPU-Timeline-v1.2.0-preview-60s.gif"
cp "$promo_output/poster-v1.2.0.jpg" "$promo_output/poster-v1.2.0-preview.jpg"
