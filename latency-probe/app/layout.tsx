import type { ReactNode } from "react";

export const metadata = { title: "ExpanPress speed: live" };

// Design tokens. Light by default; dark by system preference or data-theme="dark".
// Series colours are Okabe-Ito based. Series are also told apart by dash and marker shape, not colour alone.
const dark = `--bg:#16161a; --fg:#ececf1; --muted:#b4b4bd; --line:#3a3a40; --card:#1d1d23; --ok:#8fd8a4; --bad:#ffa3a3; --warn:#ffd79c; --warnbg:#2e2412; --focus:#9dc0ff;
  --s1:#56b4e9; --s2:#ff9b5c; --s3:#3fd0a4; --s4:#f2a6cf; --s5:#ffc857; --s6:#9fb4d6; --s7:#c3a6ff; color-scheme: dark;`;
const css = `
  :root { --bg:#fbfbfd; --fg:#1d1d1f; --muted:#4a4a52; --line:#c9c9d0; --card:#ffffff; --ok:#1d6b34; --bad:#8a1c1c; --warn:#7a4200; --warnbg:#fff4e0; --focus:#0b57d0;
    --s1:#0072b2; --s2:#c24e00; --s3:#00795a; --s4:#a8497d; --s5:#8a6100; --s6:#4f6a8a; --s7:#6b4fbb; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }
  :root[data-theme="dark"] { ${dark} }
  html, body { background: var(--bg); color: var(--fg); margin: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; font-size: 16px; line-height: 1.5; box-sizing: border-box; max-width: 1100px; margin: 0 auto; padding: 0 16px 16px; }
  h1 { font-size: 1.2rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  h3 { font-size: 1rem; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  .lbl { font-size: .8rem; color: var(--muted); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  .tn, table, .cards, .stat { font-variant-numeric: tabular-nums; }

  /* Header: one always-visible line; Controls opens a panel below it (closed by default). */
  .topbar { position: sticky; top: 0; z-index: 10; margin: 0 -16px; padding: 8px 16px; background: var(--bg); border-bottom: 1px solid transparent; transition: background-color 200ms ease, backdrop-filter 200ms ease, box-shadow 200ms ease, border-color 200ms ease; }
  .topbar.scrolled { background: color-mix(in srgb, var(--bg) 70%, transparent); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); border-bottom-color: var(--line); box-shadow: 0 6px 18px -6px rgba(0, 0, 0, .45); }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; min-width: 0; }
  .bar-title { font-size: 1rem; margin: 0; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .bar-count { font-size: .85rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .bar > .btn { flex: none; }
  .btn { min-height: 44px; min-width: 44px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
  .btn.icon { width: 44px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .btn.primary, .btn[aria-pressed="true"], .btn[aria-expanded="true"] { border-color: var(--fg); font-weight: 600; }
  .panel { margin: 0 -16px; padding: 8px 16px 12px; border-bottom: 1px solid var(--line); background: var(--bg); }
  .panel[hidden] { display: none; }
  .panel-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 8px; font-size: .9rem; }
  .panel-foot { margin: 8px 0 0; font-size: .85rem; }
  .desc { margin: 0; font-size: .85rem; color: var(--muted); }
  .auto { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; }
  .auto input { width: 22px; height: 22px; margin: 0; }
  .seg { display: inline-flex; }
  .seg .btn { border-radius: 0; margin-left: -1px; }
  .seg .btn:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
  .seg .btn:last-child { border-radius: 0 6px 6px 0; }
  .pill { display: inline-flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; font-size: .85rem; font-weight: 600; }
  .pill .dot { width: 10px; height: 10px; flex: none; border-radius: 50%; border: 2px solid currentColor; }
  .pill.ok { color: var(--ok); }
  .pill.ok .dot { background: currentColor; }
  .pill.old { color: var(--warn); }
  .pill.bad { color: var(--bad); }
  .pill.bad .dot { border-radius: 2px; background: currentColor; }

  .bar .short { display: none; }
  @media (max-width: 520px) {
    .bar { gap: 6px; }
    .bar-title { font-size: .8rem; }
    .bar-count { font-size: .8rem; }
    .pill { font-size: .8rem; flex: none; }
    .bar .long { display: none; }
    .bar .short { display: inline; }
    .bar .btn { padding: 0 8px; font-size: .85rem; }
  }
  .status { font-size: .95rem; margin: 10px 0 0; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line); }
  .status.bad { color: var(--bad); border-color: var(--bad); background: var(--warnbg); }
  .errorbox { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 8px; padding: 8px 10px; border: 1px solid var(--bad); border-radius: 6px; color: var(--bad); }
  .errorbox[hidden] { display: none; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; margin-top: 8px; }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .bigs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 6px 0; }
  .big .val { display: block; font-size: 1.35rem; font-weight: 600; line-height: 1.2; white-space: nowrap; }
  .big .lbl { display: block; font-size: .8rem; color: var(--muted); }
  .small { font-size: .85rem; color: var(--muted); }
  /* Every card has the same structure: title, divider, one line of context, three figures, a footnote. */
  .stat h3 { padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px solid var(--line); }
  .stat .sub { margin: 0 0 6px; }
  .stat .foot { margin: 8px 0 0; }
  .src { margin: 0; padding: 0; border: 0; }

  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-top: 12px; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
  .legend-item { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); font: inherit; font-size: .85rem; cursor: pointer; }
  .legend-item[aria-pressed="false"] { opacity: .5; text-decoration: line-through; }
  .legend-item svg { flex: none; }
  .axis-title { font-size: .85rem; color: var(--muted); margin: 0 0 2px; }
  .chart-wrap { position: relative; width: 100%; height: 240px; }
  .chart-wrap.fade-in { animation: fadeIn .25s ease-out; }
  .chart { position: absolute; inset: 0; }
  .chart canvas { display: block; }
  .tip { position: absolute; z-index: 2; pointer-events: none; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font-size: .85rem; line-height: 1.4; white-space: nowrap; opacity: 0; transform: translateY(4px); transition: opacity 120ms ease-out, transform 120ms ease-out; }
  .tip.on { opacity: 1; transform: none; }
  .tip .tip-title { font-weight: 600; }
  .tip .tip-time { color: var(--muted); font-size: .8rem; }
  .focus-ring { position: absolute; display: none; width: 26px; height: 26px; margin: -13px 0 0 -13px; box-sizing: border-box; border: 3px solid var(--focus); border-radius: 50%; pointer-events: none; }
  .focus-ring.on { display: block; }
  .legend-item .hid-tag { color: var(--muted); }
  .chart .tick { position: absolute; left: 0; width: 60px; text-align: right; font-size: .8rem; color: var(--muted); transform: translateY(50%); pointer-events: none; }
  .chart-caption { font-size: .85rem; margin: 2px 0 8px; }
  .chart .xtick { position: absolute; transform: translateX(-50%); text-align: center; font-size: .75rem; line-height: 1.25; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; pointer-events: none; }
  .chart .xtick > span { display: block; }
  .line-label { position: absolute; transform: translate(-100%, -120%); font-size: .75rem; font-weight: 600; white-space: nowrap; pointer-events: none; }
  .note { font-size: .9rem; margin: 6px 0 0; }

  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; margin-top: 8px; }
  table { border-collapse: collapse; width: 100%; min-width: 540px; font-size: .95rem; }
  th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 8px; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  details.acc { margin-top: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  details.acc > summary { display: list-item; list-style-position: inside; min-height: 44px; padding: 10px 12px; cursor: pointer; font-weight: 600; }
  details.acc > div, details.acc > dl { padding: 0 12px 12px; }
  .defs { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; font-size: .95rem; }
  .defs dt { font-weight: 600; } .defs dd { margin: 0; }
  .foot { font-size: .85rem; color: var(--muted); margin-top: 14px; }

  /* Endpoint cards: two per row on wide screens, one on phones. */
  .ep-toolbar { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin: 0 0 4px; }
  /* Pressed means filled, not just outlined: the label flips to the page colour on a solid chip. */
  .ep-card .btn { font-size: .9rem; }
  .ep-card .btn[aria-pressed="true"], #ep-shared[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
  .ep-card .btn[aria-pressed="false"] { color: var(--muted); }
  .ep-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
  .ep-views { margin-left: auto; }
  #ep-shared[aria-pressed="false"] { color: var(--fg); }
  .ep-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 8px; }
  @media (max-width: 720px) { .ep-grid { grid-template-columns: minmax(0, 1fr); } }
  .ep-card { position: relative; min-width: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px 12px; }
  .ep-card.dragging { z-index: 5; box-shadow: 0 14px 30px -10px rgba(0, 0, 0, .45); cursor: grabbing; }
  .ep-card[data-drop="before"] { box-shadow: inset 4px 0 0 var(--focus); }
  .ep-card[data-drop="after"] { box-shadow: inset -4px 0 0 var(--focus); }
  .ep-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ep-handle { flex: none; width: 36px; height: 36px; min-width: 36px; min-height: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--muted); cursor: grab; touch-action: none; user-select: none; }
  .ep-title { font-size: .95rem; font-weight: 600; margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ep-sub { margin: 6px 0 8px; font-size: .8rem; line-height: 1.4; }
  .ep-filters { margin-bottom: 6px; }
  .ep-svg { display: block; width: 100%; height: auto; touch-action: manipulation; overflow: visible; border-radius: 4px; }
  .ep-svg:focus { outline: none; }
  .ep-svg:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  .ep-card .tip { font-size: .8rem; }
  @keyframes fadeIn { from { opacity: .35; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
  @media (max-width: 480px) {
    .refresh-group { width: 100%; justify-content: space-between; }
  }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
