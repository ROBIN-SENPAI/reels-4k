# Reels4K

Turn a TikTok / Instagram video into a cleaner, sharper **4K** file. Runs 100% on your PC with
[FFmpeg](https://ffmpeg.org) — nothing is uploaded anywhere. Drag-and-drop web UI, or command line.
Uses your GPU's hardware video encoder when it works (Intel Quick Sync, NVIDIA NVENC, AMD AMF).

By **SENPAI ACADEMY - ROBIN**.

## Download (Windows)
`Reels4K-windows-x64.zip` → `Reels4K.exe` (single file, no Node needed). FFmpeg is **not** bundled:
put `ffmpeg.exe` + `ffprobe.exe` next to the exe, or install them (`winget install Gyan.FFmpeg`).
Double-click the exe → the app opens in your browser. The exe is not code-signed, so Windows SmartScreen may warn.

## From source
Node.js 18+ and FFmpeg on `PATH`; no npm packages.
```bash
node main.mjs                      # web app at http://localhost:4400  (Windows: start.bat)
node main.mjs video.mp4            # command line
node build-exe.mjs                 # builds dist/Reels4K.exe (needs Node 25.5+ for --build-sea)
```
CLI options: `[out.mp4] [--strength soft|normal|strong] [--speed turbo|balanced|max] [--no-gpu] [--force]`.
Output defaults to `<name>-4k.mp4` next to the input; the input is never overwritten.

## What it does
| Input | Output |
|---|---|
| 9:16 `1080x1920` | `2160x3840` |
| 4:5 `1080x1350` | `2160x2700` |
| 16:9 `1920x1080` | `3840x2160` |

Short side → 2160 px, long side capped at 3840 px. Already-4K videos are refused.

Pipeline: (optional light `hqdn3d` denoise) → Lanczos upscale → luma-only `unsharp` → copyright mark → H.264 High yuv420p.
Also handles rotation metadata, variable frame rate → constant (24/25/30/50/60), HDR/HLG (iPhone) → SDR bt709,
AAC audio copied untouched. Files are written as `*.part.mp4` and renamed only after ffmpeg succeeds.

**Speed modes:** *Turbo* = verified GPU encoder (falls back to x264 veryfast), *Balanced* = x264 medium CRF 19,
*Max* = x264 slow CRF 17. A GPU encoder is only offered after a real 4K test encode succeeds
(e.g. NVENC is compiled into many FFmpeg builds but fails without a recent driver).

## Measured speed and quality (honest numbers)
Test PC: Intel i7-4810MQ (2014 laptop), Intel HD 4600 (Quick Sync works), Quadro K1100M (NVENC fails with this FFmpeg).
- 1080p 60 fps → 4K, 6 s clip: **25 s with Quick Sync** (about 4 s of work per second of video).
- 6 s portrait 30 fps clip: 13 s with Quick Sync vs 23 s with x264 balanced. Quick Sync files were ~10 % larger here
  (17.1 vs 15.7 MiB) and were ~30 % larger in an earlier test.
- The `cas` sharpener was the bottleneck at 4K (10 s vs 1 s for scaling alone, per 2 s of video), so it was replaced
  by a luma-only `unsharp`, about 3× cheaper.

Quality test: a 6 s clip of rendered footage was downscaled to 540p and heavily compressed (CRF 30), upscaled 2× with
each filter chain, and compared with the true original (edge energy = mean Sobel gradient, original = 17.47):

| Chain | SSIM | PSNR (dB) | Edge energy |
|---|---|---|---|
| bicubic | 0.9429 | 33.37 | — |
| Lanczos only | 0.9430 | 33.56 | 14.95 |
| Lanczos + CAS 0.4 | 0.9383 | 33.59 | 16.13 |
| denoise + Lanczos + unsharp 0.6 | 0.9422 | 33.75 | 15.33 |
| Lanczos + unsharp 1.0 | — | — | 16.22 |

What this means: **no filter recovers real detail** (SSIM/PSNR differences are tiny: ±0.005 / ±0.3 dB, and
denoising did not help on this footage). Sharpening restores roughly half of the edge contrast lost by upscaling,
so the result *looks* crisper at a very small fidelity cost. That is the real strength of this tool. AI upscalers
(Real-ESRGAN etc.) can invent plausible detail, but need a download and a strong GPU; they are not included.
These numbers come from rendered game footage, not real phone video.

## Copyright mark
Every output gets the credit **SENPAI ACADEMY - ROBIN** burned into the pixels (top-left, plus a faint copy bottom-right)
and written into the file metadata. The credit is also shown in the app. It is checked in several places: the program
refuses to run if the credit text is edited, and after encoding it verifies that the mark is really present in the video
and discards the output if not.
Be aware: nothing is *impossible* to remove. A burned-in mark can be cropped or painted over, metadata can be stripped,
and anyone with the source can edit the code (the exe makes that much harder, but not impossible). The license forbids
removing it. Use the exe release if you want maximum protection.

## Limits
- Upscaling cannot add detail that was never recorded; it gives smoother edges and crisper lines, and TikTok/Instagram
  recompress 4K uploads with more bitrate than 1080p.
- Heavy on weak PCs; only one video is processed at a time. Output files are large.
- The mark can cover small things in the top-left corner of the picture.
- Tested with synthetic and rendered clips (portrait/landscape/4:5, HDR-tagged, with/without audio), not real phone footage.

The web server listens on `127.0.0.1` only. See `LICENSE`.
