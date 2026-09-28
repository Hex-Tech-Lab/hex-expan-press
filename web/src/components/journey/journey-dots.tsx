"use client";

/**
 * JourneyDots — the shared pressable station track (extracted from the
 * landing bento during Wave 4's duplication review; both the landing art and
 * the creator dashboard tracker render this). Three connected stations:
 * past = filled, active = lit + breathing ring, upcoming = hollow.
 * Press wobble is the Wave 3.4 paper physics (spring 320/12).
 */
import { motion } from "framer-motion";

export interface JourneyDotsProps {
  active: number;
  total?: number;
  reduced?: boolean;
  onSelect?: (i: number) => void;
  className?: string;
}

export default function JourneyDots({ active, total = 3, reduced = false, onSelect, className }: JourneyDotsProps) {
  return (
    <div className={`relative flex items-center gap-1.5 ${className ?? ""}`} role="list" aria-label="Journey stations">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className="flex items-center gap-1.5" role="listitem">
          {i > 0 && <span className="w-4 h-px bg-gray-300" />}
          {i === active ? (
            <motion.button
              type="button"
              aria-label={`Step ${i + 1} — you are here`}
              aria-current="step"
              onClick={onSelect ? () => onSelect(i) : undefined}
              className="w-3.5 h-3.5 rounded-full bg-[#E8622C] ring-4 ring-[#E8622C]/15 cursor-pointer"
              animate={reduced ? undefined : { scale: [1, 1.25, 1] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            />
          ) : (
            <button
              type="button"
              aria-label={`Step ${i + 1}`}
              onClick={onSelect ? () => onSelect(i) : undefined}
              className={`w-2.5 h-2.5 rounded-full cursor-pointer transition-colors ${
                i < active
                  ? "bg-[#E8622C]/50 border-2 border-[#E8622C]/40"
                  : "border-2 border-gray-300 bg-white hover:border-gray-400"
              }`}
            />
          )}
        </span>
      ))}
      {!reduced && (
        <motion.span
          aria-hidden
          className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-peach"
          animate={{ left: ["6%", "94%"], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", times: [0, 0.15, 0.85, 1] }}
        />
      )}
    </div>
  );
}
