import Link from "next/link";

/**
 * ExpanPress brand chrome, shared by the B2B home (components/landing) and the
 * B2C buyer pages (app/books, components/storefront). Both sides render these
 * exact pieces so they read as one brand. Nothing here names a destination:
 * every link target is passed in, so the B2C/B2B confinement rule
 * (web/__tests__/b2c-confinement.test.ts) is enforced where each side calls it.
 */

/** The arrow used on every call to action on the B2B home. */
export const ArrowIcon = ({ className = "w-3.5 h-3.5" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

/** Page frame: the B2B home's padding, max width and column gap. `outerClassName` adds page-specific utilities. */
export function BrandFrame({ outerClassName = "", children }: { outerClassName?: string; children: React.ReactNode }) {
  return (
    <div className={`min-h-screen p-4 sm:p-8 md:p-12 flex flex-col overflow-x-clip ${outerClassName}`.trim()}>
      <div className="max-w-[1240px] w-full mx-auto flex flex-col gap-6 md:gap-8">{children}</div>
    </div>
  );
}

/** The wordmark {expanpress}. The caller passes the home target (the B2B root, or the B2C landing). `label` is set
 * only where the link needs an accessible name of its own; the B2B home passes none and keeps its original link. */
export function BrandWordmark({ href, label }: { href: string; label?: string }) {
  return (
    <Link href={href} aria-label={label} className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900 group">
      <span className="text-gray-600 font-light">{"{"}</span>
      <span className="text-gray-900">expanpress</span>
      <span className="text-gray-600 font-light">{"}"}</span>
    </Link>
  );
}

/** Footer rule: the copyright line on the left, the caller's links on the right. */
export function BrandFooter({ tagline, children }: { tagline?: string; children: React.ReactNode }) {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-600 px-2 pb-6 lg:pb-4">
      <div className="flex items-center gap-2">
        <span>&copy; 2026 ExpanPress</span>
        {tagline && (
          <>
            <span>&middot;</span>
            <span>{tagline}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-4">{children}</div>
    </footer>
  );
}
