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

/** Compact {ep} brand mark matching app/icon.svg, used inside navigation docks and compact chrome. */
export function BrandCompactMark({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center font-bold tracking-tight whitespace-nowrap leading-none ${className}`.trim()}
    >
      <span className="text-gray-600 font-light">{"{"}</span>
      <span className="text-gray-900">ep</span>
      <span className="text-gray-600 font-light">{"}"}</span>
    </span>
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

export type BrandButtonVariant = "primary" | "secondary";

const BRAND_BUTTON_BASE =
  "inline-flex items-center justify-center gap-3 rounded-full text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]";

const BRAND_BUTTON_VARIANT: Record<BrandButtonVariant, string> = {
  primary:
    "self-start bg-[#2A2A2A] hover:bg-[#383838] disabled:bg-[#9a9a9a] disabled:cursor-not-allowed text-white px-6 py-3.5",
  secondary:
    "border border-[#dcc7b4] bg-white hover:bg-[#fff2e4] disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed text-gray-900 px-3 py-1",
};

type BrandButtonAsButton = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  href?: undefined;
  variant?: BrandButtonVariant;
};

type BrandButtonAsLink = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: BrandButtonVariant;
};

/** Shared brand CTA / secondary button (one source for focus ring, disabled, and hover states across product and checkout). */
export function BrandButton(props: BrandButtonAsButton | BrandButtonAsLink) {
  const { variant = "primary", className = "", children, ...rest } = props;
  const cls = `${BRAND_BUTTON_BASE} ${BRAND_BUTTON_VARIANT[variant]}${className ? ` ${className}` : ""}`;
  if ("href" in props && props.href !== undefined) {
    const anchorProps = rest as React.AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a className={cls} {...anchorProps}>
        {children}
      </a>
    );
  }
  const { type = "button", ...buttonProps } = rest as React.ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button type={type} className={cls} {...buttonProps}>
      {children}
    </button>
  );
}

const BRAND_FIELD_CLASS =
  "w-full rounded-2xl border border-[#dcc7b4] bg-white px-4 py-3 text-base text-gray-900 placeholder:text-gray-500 hover:border-[#bfa48b] disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]";

/** Shared text input primitive (one source for border, hover, disabled, and focus ring). */
export function BrandField({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${BRAND_FIELD_CLASS}${className ? ` ${className}` : ""}`} {...props} />;
}
