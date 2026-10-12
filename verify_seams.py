# -*- coding: utf-8 -*-
"""B5 自动核验：生成视频的首/末帧 vs 输入关键帧相似度（SSIM）
用法：python verify_seams.py  （在 mm_biolum.py 之后）
判定：每段首帧 vs first 关键帧、末帧 vs last 关键帧 SSIM ≥ 0.55 = PASS（AI 重绘允许风格差异，只拦"完全跑偏"）
"""
import os, subprocess, re

ROOT = os.path.dirname(os.path.abspath(__file__))
KEYS = os.path.join(ROOT, "biolum", "assets", "keys")
SEGS = [
    {"seg": "seg1", "first": "k1.png", "last": "k2.png"},
    {"seg": "seg2", "first": "k2.png", "last": "k3.png"},
    {"seg": "seg3", "first": "k3.png", "last": "k4.png"},
]
TMP = os.path.join(ROOT, "_seamcheck")
os.makedirs(TMP, exist_ok=True)

def extract_frame(video, which, out):
    # which: 'first' | 'last'
    vf = "select=eq(n\\,0)" if which == "first" else "select='eq(n,*)'"
    if which == "last":
        # 取最后一帧：reverse 一帧
        subprocess.run(["ffmpeg", "-y", "-i", video, "-vf", "reverse,select=eq(n\\,0)", "-frames:v", "1", out],
                       capture_output=True)
    else:
        subprocess.run(["ffmpeg", "-y", "-i", video, "-vf", "select=eq(n\\,0)", "-frames:v", "1", out],
                       capture_output=True)
    return os.path.exists(out) and os.path.getsize(out) > 1000

def ssim(a, b):
    r = subprocess.run(["ffmpeg", "-i", a, "-i", b, "-lavfi",
                        "[0:v]scale=640:-2[a];[1:v]scale=640:-2[b];[a][b]ssim", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"All:([\d.]+)", r.stderr)
    return float(m.group(1)) if m else 0.0

all_pass = True
for s in SEGS:
    seg_path = os.path.join(ROOT, "biolum", "assets", s["seg"] + ".mp4")
    if not os.path.exists(seg_path):
        print(f"{s['seg']}: MISSING"); all_pass = False; continue
    for which, key in [("first", s["first"]), ("last", s["last"])]:
        frame = os.path.join(TMP, f"{s['seg']}_{which}.png")
        if not extract_frame(seg_path, which, frame):
            print(f"{s['seg']} {which}: 抽帧失败"); all_pass = False; continue
        score = ssim(frame, os.path.join(KEYS, key))
        ok = score >= 0.55
        all_pass = all_pass and ok
        print(f"{s['seg']} {which}帧 vs {key}: SSIM={score:.3f} {'PASS' if ok else 'FAIL'}")
print("\n=== " + ("全部通过 ✅" if all_pass else "存在不合格段，按 1.3 冗余预算重试对应段 ❌") + " ===")
