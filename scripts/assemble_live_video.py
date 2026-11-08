#!/usr/bin/env python3
import os
import glob
import re
import time

LIVE_DIR = os.path.abspath("downloads/live_20261108")
OUT_MP4 = os.path.abspath("downloads/gadzhi_live_video.mp4")
TMP_V = os.path.join(LIVE_DIR, ".assembled_video_track.mp4")
STATE_V = os.path.join(LIVE_DIR, "video_assembler_state.txt")
WATCHDOG_DONE = os.path.join(LIVE_DIR, "DONE_gadzhi_live_video")


def get_max_contiguous(pattern):
    frags = glob.glob(pattern)
    nums = set()
    for f in frags:
        m = re.search(r"-Frag(\d+)$", f)
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
    last_v = 0
    if os.path.exists(STATE_V):
        try:
            with open(STATE_V, "r") as f:
                last_v = int(f.read().strip())
        except Exception:
            last_v = 0
    elif os.path.exists(TMP_V) and os.path.getsize(TMP_V) > 0:
        # Initial contiguous count already present in TMP_V (Frag 2126)
        last_v = 2126

    mode = "ab" if last_v > 0 and os.path.exists(TMP_V) else "wb"
    if mode == "wb":
        last_v = 0

    print(
        f"[live_video_streamer] continuous append active from Frag{last_v + 1} -> {TMP_V}",
        flush=True,
    )

    with open(TMP_V, mode) as vf:
        while True:
            v_max = get_max_contiguous(
                os.path.join(LIVE_DIR, "gadzhi_live_video.f299.mp4.part-Frag*")
            )
            stream_done = os.path.exists(WATCHDOG_DONE)
            limit = v_max if stream_done else max(0, v_max - 1)

            if limit > last_v:
                batch = 0
                for i in range(last_v + 1, limit + 1):
                    vf_path = os.path.join(
                        LIVE_DIR, f"gadzhi_live_video.f299.mp4.part-Frag{i}"
                    )
                    try:
                        with open(vf_path, "rb") as in_f:
                            data = in_f.read()
                            vf.write(data)
                        last_v = i
                        batch += 1
                    except Exception as e:
                        print(
                            f"[live_video_streamer] error reading {vf_path}: {e}",
                            flush=True,
                        )
                        break

                vf.flush()
                try:
                    os.fsync(vf.fileno())
                except OSError:
                    pass

                with open(STATE_V, "w") as sf:
                    sf.write(str(last_v))
                print(
                    f"[live_video_streamer] appended {batch} frags -> Frag{last_v} (~{last_v*5/60:.1f}m, size={os.path.getsize(TMP_V)/1024/1024:.1f}MB)",
                    flush=True,
                )

            if stream_done and last_v >= v_max:
                print(
                    f"[live_video_streamer] stream finished. All {last_v} fragments appended.",
                    flush=True,
                )
                break

            time.sleep(3)


if __name__ == "__main__":
    main()
