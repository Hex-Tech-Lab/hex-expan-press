#!/usr/bin/env python3
"""Opt-in model router hook for Claude Code (T36-J8, plan point 10). NOT installed by default.

On every user prompt (UserPromptSubmit event), asks Jev choice {tiny, everyday, large, hardest}
how heavy the task looks and prints a one-line suggestion to stderr. Never blocks: any error
exits 0 silently; with Jev down prints nothing.

Enable it by adding to .claude/settings.local.json (do NOT commit real keys):
  {"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command",
      "command": "python3 <repo>/scripts/model_router_hook.py"}]}]}}

stdin JSON (Claude Code hook contract): {"prompt": "<user text>", ...} — the hook prints e.g.
  [model_router] suggestion: tiny  (p=0.62)  light/quick task
"""
import json
import sys

LABELS = {"tiny": "light/quick task", "everyday": "normal coding task",
          "large": "multi-step work; consider a bigger model",
          "hardest": "hardest reasoning; consider the strongest model + extended thinking"}
Q = {"weight": {"type": "choice",
                "instructions": "How cognitively heavy is this user prompt for a coding agent?",
                "criteria": {"tiny": "trivial: one-word answer, echo, tiny edit",
                             "everyday": "normal: a function, fix, or file inspection",
                             "large": "multi-file or multi-step task needing sustained work",
                             "hardest": "hard architecture/algorithm/debugging or high-stakes review"}}}


def main():
    try:
        prompt = (json.load(sys.stdin) or {}).get("prompt", "")
        if not prompt.strip():
            return
        sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
        from jev import decide
        a = decide({"prompt": prompt[:2000]}, Q, timeout=5.0)
        if not a:
            return
        pick = a["weight"].get("choice")
        p = max((a["weight"].get("probabilities") or {}).values())
        if pick:
            print(f"[model_router] suggestion: {pick}  (p={p:.2f})  {LABELS.get(pick, '')}", file=sys.stderr)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
