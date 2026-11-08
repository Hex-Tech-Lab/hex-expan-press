#!/usr/bin/env python3
import os
import glob
import re
import subprocess

LIVE_DIR = os.path.abspath("downloads/live_20261108")
OUT_MP4 = os.path.abspath("downloads/gadzhi_live_video.mp4")
TMP_V = os.path.join(LIVE_DIR, ".assembled_video_track.mp4")
TMP_A = os.path.join(LIVE_DIR, ".assembled_audio_track.m4a")

def get_max_contiguous(pattern):
    frags = glob.glob(pattern)
    nums = set()
    for f in frags:
        m = re.search(r'-Frag(\d+)$', f)
        if m:
            nums.add(int(m.group(1)))
    max_c = 0
    for i in range(1, len(nums) + 100):
        if i in nums:
            max_c = i
        else:
            break
    return max_c

def main():
    print("[video_assembler] starting muxing pipeline...", flush=True)
    v_max = get_max_contiguous(os.path.join(LIVE_DIR, "gadzhi_live_video.f299.mp4.part-Frag*"))
    a_max = get_max_contiguous(os.path.join(LIVE_DIR, "gadzhi_live_audio.m4a.part-Frag*"))
    limit = min(v_max, a_max)

    print(f"[video_assembler] assembling {limit} fragments (~{limit*5/60:.1f} minutes of 1080p video+audio)...", flush=True)

    with open(TMP_V, "wb") as vf, open(TMP_A, "wb") as af:
        for i in range(1, limit + 1):
            vf_path = os.path.join(LIVE_DIR, f"gadzhi_live_video.f299.mp4.part-Frag{i}")
            af_path = os.path.join(LIVE_DIR, f"gadzhi_live_audio.m4a.part-Frag{i}")
            with open(vf_path, "rb") as f:
                vf.write(f.read())
            with open(af_path, "rb") as f:
                af.write(f.read())

    print(f"[video_assembler] fragment concatenation complete. Muxing to {OUT_MP4}...", flush=True)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", TMP_V,
        "-i", TMP_A,
        "-c", "copy",
        "-movflags", "+faststart",
        OUT_MP4
    ]
    subprocess.run(cmd, check=True)
    print(f"[video_assembler] DONE: {OUT_MP4} created successfully.", flush=True)

if __name__ == "__main__":
    main()
