#!/usr/bin/env python3
import os
import time
import glob
import re
import sys

FRAG_DIR = os.path.abspath("downloads/live_20261108")
OUT_FILE = os.path.join(FRAG_DIR, "gadzhi_live_audio_assembled.m4a")
STATE_FILE = os.path.join(FRAG_DIR, "assembler_state.txt")
WATCHDOG_DONE = os.path.join(FRAG_DIR, "DONE_gadzhi_live_audio")

def get_contiguous_fragments():
    frags = glob.glob(os.path.join(FRAG_DIR, "gadzhi_live_audio.m4a.part-Frag*"))
    nums = set()
    for f in frags:
        m = re.search(r'-Frag(\d+)$', f)
        if m:
            nums.add(int(m.group(1)))
    max_contig = 0
    for i in range(1, len(nums) + 100):
        if i in nums:
            max_contig = i
        else:
            break
    return max_contig

def main():
    last_frag = 0
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                last_frag = int(f.read().strip())
        except Exception:
            last_frag = 0

    mode = "ab" if last_frag > 0 and os.path.exists(OUT_FILE) else "wb"
    if mode == "wb":
        last_frag = 0

    print(f"[assembler] starting from frag {last_frag + 1}, output: {OUT_FILE}", flush=True)

    with open(OUT_FILE, mode) as out_f:
        while True:
            max_contig = get_contiguous_fragments()
            stream_done = os.path.exists(WATCHDOG_DONE)
            # If still live, don't read the very last fragment to avoid reading mid-write
            limit = max_contig if stream_done else max(0, max_contig - 1)

            if limit > last_frag:
                batch_count = 0
                for frag_num in range(last_frag + 1, limit + 1):
                    frag_path = os.path.join(FRAG_DIR, f"gadzhi_live_audio.m4a.part-Frag{frag_num}")
                    try:
                        with open(frag_path, "rb") as in_f:
                            data = in_f.read()
                            out_f.write(data)
                        last_frag = frag_num
                        batch_count += 1
                    except Exception as e:
                        print(f"[assembler] error reading {frag_path}: {e}", flush=True)
                        break
                out_f.flush()
                with open(STATE_FILE, "w") as sf:
                    sf.write(str(last_frag))
                print(f"[assembler] appended {batch_count} fragments (up to Frag{last_frag}, ~{last_frag*5/60:.1f}m)", flush=True)

            if stream_done and last_frag >= max_contig:
                print(f"[assembler] stream finished and all {last_frag} fragments assembled.", flush=True)
                break

            time.sleep(5)

if __name__ == "__main__":
    main()
