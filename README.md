# Reels4K

Turn a TikTok / Instagram video into a cleaner, sharper **4K** file. Runs 100% on your PC with
[ffmpeg](https://ffmpeg.org) — nothing is uploaded anywhere. Web UI (drag & drop) or command line.

## Requirements
- Node.js 18+ and `ffmpeg` / `ffprobe` on your `PATH`. No npm packages to install.

## Use
**Web UI** (Windows: double-click `start.bat`):
```bash
node server.mjs      # then open http://localhost:4400
```
Drag a video in, pick sharpness and quality, press the button, download the result.

**Command line:**
```bash
node cli.mjs my-video.mp4 [out.mp4] [--strength soft|normal|strong] [--quality fast|balanced|best] [--force]
```
Output defaults to `<name>-4k.mp4` next to the input; the input is never overwritten.

## What it does
| Input | Output |
|---|---|
| 9:16 `1080x1920` | `2160x3840` |
| 4:5 `1080x1350` | `2160x2700` |
| 16:9 `1920x1080` | `3840x2160` |

Rule: short side becomes 2160 px, long side capped at 3840 px. Videos that are already that big are refused.

Filters: light `hqdn3d` denoise → Lanczos upscale → `cas` (Contrast Adaptive Sharpen, avoids halos on text and edges).
Phone-specific handling: rotation metadata, variable frame rate → constant (24/25/30/50/60),
HDR/HLG (iPhone) → SDR bt709 tone-mapping, AAC audio copied untouched. Output: H.264 High, yuv420p, `+faststart`.
Files are written as `*.part.mp4` and renamed only if ffmpeg succeeds, so an interrupted run never leaves a broken file.

## Honest expectations
- Upscaling **cannot add detail that was never recorded**. You get smoother edges and slightly crisper lines,
  not a true 4K camera image.
- It still helps: TikTok/Instagram give 4K uploads a higher bitrate/codec than 1080p, so the platform's
  recompression hurts less.
- It is CPU-only and heavy: on a weak laptop expect several times real-time (a 30 s clip can take minutes).
  `--quality fast` is quicker. Only one video is processed at a time.
- Output files are large (about 15 MB for 6 s of busy content at "fast"); the platforms will re-encode them anyway.
- Tested here with synthetic clips (portrait 30 fps with audio, HDR-tagged HLG, already-4K refusal); not tested on real phone footage.

The web server listens on `127.0.0.1` only. License: MIT.
