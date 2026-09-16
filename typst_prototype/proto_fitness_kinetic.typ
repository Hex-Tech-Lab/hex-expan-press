// ============================================================
// PROTOTYPE — S3 "visual/infographic" skeleton × Fitness
// style config: "Kinetic" (dark) — Bebas Neue + Inter
// Sample content only. Invented plan, not real claims/advice.
// ============================================================

#let ink    = rgb("#0E1013") // base
#let paper  = rgb("#F5F7F5") // ink-on-dark
#let volt   = rgb("#D7FF3E") // accent
#let red    = rgb("#FF5340") // secondary
#let steel  = rgb("#8A94A6") // metadata
#let panel  = rgb("#161B22") // derived card surface
#let hairln = rgb("#272E38") // derived hairline
#let dim    = rgb("#3A424E") // derived quiet text

#let disp = "Bebas Neue"
#let ui   = "Inter"

#let label(body, fill: steel, size: 7.5pt, weight: 600, trk: 0.18em) = text(
  font: ui, fill: fill, size: size, weight: weight, tracking: trk, upper(body))

#let chip(body, accent: false) = box(
  fill: panel,
  radius: 4pt,
  stroke: 0.6pt + (if accent { volt } else { hairln }),
  inset: (x: 8pt, y: 5pt),
  text(font: ui, size: 7.5pt, weight: 600, tracking: 0.14em,
    fill: (if accent { volt } else { steel }), upper(body)),
)

#let exrow(n, name, reps, tempo) = block(
  width: 100%,
  inset: (y: 5pt),
  stroke: (bottom: 0.5pt + hairln),
)[
  #grid(
    columns: (20pt, 1fr, 54pt, 58pt),
    text(font: ui, fill: steel, weight: 600, size: 8pt)[#n],
    text(font: ui, fill: paper, weight: 600, size: 8.5pt, tracking: 0.04em)[#upper(name)],
    align(right, text(font: ui, fill: volt, weight: 700, size: 8.5pt)[#reps]),
    align(right, text(font: ui, fill: steel, weight: 500, size: 8pt)[#tempo]),
  )
]

#let statcard(value, unit, lab, accent) = block(
  width: 100%,
  fill: panel,
  radius: 6pt,
  stroke: (top: 2.5pt + accent),
  inset: (x: 10pt, y: 8pt),
)[
  #text(font: disp, size: 25pt, fill: paper)[#value #h(2pt)]
  #text(font: ui, size: 8pt, weight: 600, fill: accent, tracking: 0.1em)[#unit]
  #v(1pt)
  #label(lab, fill: steel, size: 6.5pt)
]

// Page defaults = the cover page (full-bleed dark).
#set page(width: 6in, height: 9in, margin: 0pt, fill: ink)
#set text(font: ui, size: 9.5pt, fill: paper, lang: "en")
#set par(leading: 0.6em)

// ------------------------------------------------------------
// PAGE 1 — COVER (full-bleed dark, conic ring + gradient type + hatch)
// ------------------------------------------------------------
// conic-gradient progress ring, cropped off the right edge
#place(top + right, dx: 1.15in, dy: 0.95in)[
  #box(circle(radius: 1.5in, fill: gradient.conic(angle: 20deg,
    volt, rgb("#4A5A12"), ink, red, ink, rgb("#4A5A12"), volt)))
]
#place(top + right, dx: 1.15in, dy: 0.95in)[
  #box(circle(radius: 1.06in, fill: ink))
]

// diagonal volt slash crossing the ring, right of the title zone
#place(top + left, dx: 1.5in, dy: 2.45in)[
  #rotate(-13deg, box(width: 5.2in, height: 11pt, fill: volt))
]
#place(top + left, dx: 1.5in, dy: 2.72in)[
  #rotate(-13deg, box(width: 5.2in, height: 2.5pt, fill: red))
]

// hatch band above footer
#place(bottom + left, dy: -0.62in)[
  #rect(width: 6in, height: 0.5in, fill: pattern(size: (9pt, 9pt))[
    #line(start: (0pt, 9pt), end: (9pt, 0pt), stroke: 0.8pt + rgb("#232A34"))
  ])
]

#place(top + left, dx: 34pt, dy: 38pt)[
  #label("Kinetic Labs · Training Series", fill: steel, size: 8pt, trk: 0.24em)
]

#place(top + left, dx: 32pt, dy: 1.55in)[
  #set par(leading: 0.24em)
  #text(font: disp, size: 88pt, fill: paper, tracking: 0.015em)[
    MOBILITY \
    #text(fill: gradient.linear(angle: 90deg, volt, rgb("#9FCB1F")))[RESET]
  ]
]

#place(top + left, dx: 34pt, dy: 3.78in)[
  #text(font: ui, size: 9.5pt, weight: 300, fill: paper, tracking: 0.06em)[
    A 14-DAY BODYWEIGHT PRIMER TO WAKE UP YOUR CHAIN
  ]
]

// mid-page method preview strip
#place(top + left, dx: 34pt, dy: 4.62in)[
  #box(width: 5.06in)[
    #grid(columns: (1fr, 1fr, 1fr), column-gutter: 12pt,
      block(inset: (top: 7pt), width: 100%, stroke: (top: 0.6pt + hairln))[
        #text(font: disp, size: 30pt, fill: volt)[12]
        #h(3pt)
        #text(font: ui, size: 8pt, weight: 600, fill: steel, tracking: 0.14em)[MIN / DAY]
      ],
      block(inset: (top: 7pt), width: 100%, stroke: (top: 0.6pt + hairln))[
        #text(font: disp, size: 30pt, fill: red)[4]
        #h(3pt)
        #text(font: ui, size: 8pt, weight: 600, fill: steel, tracking: 0.14em)[ROUNDS]
      ],
      block(inset: (top: 7pt), width: 100%, stroke: (top: 0.6pt + hairln))[
        #text(font: disp, size: 30pt, fill: paper)[±180]
        #h(3pt)
        #text(font: ui, size: 8pt, weight: 600, fill: steel, tracking: 0.14em)[KCAL EST.]
      ],
    )
  ]
]

#place(top + left, dx: 34pt, dy: 5.75in)[
  #box(width: 5.06in)[
    #text(font: ui, size: 8.5pt, weight: 300, fill: steel)[
      Every session is one full-body circuit: pull, hinge, squat, push, rotate, brace.
    ]
  ]
]

#place(bottom + left, dx: 34pt, dy: -0.52in)[
  #box(width: 100%, inset: (y: 5pt), stroke: (top: 0.6pt + hairln))[]
]
#place(bottom + left, dx: 34pt, dy: -0.34in)[
  #grid(columns: (auto, auto, auto), column-gutter: 6pt,
    chip("Level 2 · Intermediate"),
    chip("12 Min", accent: true),
    chip("Band + Mat"),
  )
]
#place(bottom + right, dx: -34pt, dy: -0.62in)[
  #label("Sample Prototype · Vol 01", fill: dim, size: 6.5pt, trk: 0.2em)
]

// ------------------------------------------------------------
// PAGE 2 — INNER SPREAD (S3: art block + chips + workout + stats)
// ------------------------------------------------------------
#page(
  margin: (top: 0pt, x: 0pt, bottom: 30pt),
  fill: ink,
  footer: align(center, text(font: ui, size: 7pt, weight: 600, fill: dim,
    tracking: 0.22em, counter(page).display("1"))),
)[

  // ---- full-bleed art block (carries the visual weight) ----
  #block(width: 100%, height: 3.32in, clip: true,
    fill: gradient.linear(angle: 115deg, rgb("#12161D"), rgb("#1B222B")))[

    // intensity bars (abstract load curve), bottom-left of panel
    #place(bottom + left, dx: 26pt, dy: -16pt)[
      #grid(columns: (auto,) * 7, column-gutter: 7pt,
        align(bottom, rect(width: 11pt, height: 0.35in, fill: rgb("#2A3340"), radius: 2pt)),
        align(bottom, rect(width: 11pt, height: 0.55in, fill: rgb("#2A3340"), radius: 2pt)),
        align(bottom, rect(width: 11pt, height: 0.85in, fill: steel, radius: 2pt)),
        align(bottom, rect(width: 11pt, height: 0.62in, fill: rgb("#2A3340"), radius: 2pt)),
        align(bottom, rect(width: 11pt, height: 1.15in, fill: red, radius: 2pt)),
        align(bottom, rect(width: 11pt, height: 0.95in, fill: steel, radius: 2pt)),
        align(bottom, rect(width: 11pt, height: 1.5in, fill: volt, radius: 2pt)),
      )
    ]

    // ring marker echoing the cover
    #place(top + right, dx: -0.42in, dy: -0.55in)[
      #box(circle(radius: 1.05in, fill: gradient.conic(angle: 200deg,
        volt, ink, red, ink, volt)))
    ]
    #place(top + right, dx: -0.42in, dy: -0.55in)[
      #box(circle(radius: 0.72in, fill: rgb("#131820")))
    ]

    // hatch footer strip inside panel
    #place(bottom + left)[
      #rect(width: 6in, height: 0.16in, fill: pattern(size: (9pt, 9pt))[
        #line(start: (0pt, 9pt), end: (9pt, 0pt), stroke: 0.7pt + rgb("#232A34"))
      ])
    ]

    // overlay titles
    #place(top + left, dx: 26pt, dy: 22pt)[
      #text(font: ui, size: 8pt, weight: 600, fill: steel, tracking: 0.24em)[
        DAY 07 · MOBILITY + POWER PRIMER
      ]
    ]
    #place(top + left, dx: 24pt, dy: 40pt)[
      #set par(leading: 0.2em)
      #text(font: disp, size: 58pt, fill: paper, tracking: 0.02em)[
        FULL-BODY \
        #text(fill: volt)[IGNITION]
      ]
    ]
    #place(bottom + left, dx: 2.35in, dy: -0.5in)[
      #box(width: 3.2in)[
        #text(font: ui, size: 8pt, weight: 400, fill: steel)[
          Load curve peaks at the final round — the volt bar is where the day is won.
        ]
      ]
    ]
  ]

  // ---- everything below sits inside the 30pt side gutter ----
  #pad(x: 30pt)[
    // metadata strip (Darebee infobox grammar)
    #v(10pt)
    #grid(columns: (auto, auto, auto, auto), column-gutter: 5.5pt,
      chip("Level 2 · Intermediate"),
      chip("12 Min", accent: true),
      chip("4 Rounds"),
      chip("Band + Mat"),
    )

    // workout block
    #v(10pt)
    #grid(columns: (auto, 1fr), column-gutter: 10pt)[
      #text(font: disp, size: 17pt, fill: paper, tracking: 0.03em)[THE BLOCK]
    ][
      #align(right, text(font: ui, size: 7.5pt, weight: 600, fill: steel, tracking: 0.16em)[6 MOVES · ROUND × 4])
    ]
    #v(6pt)

    #exrow("01", "Band pull-apart", "2 × 20", "Iso 2s")
    #exrow("02", "World's greatest stretch", "6 / side", "Flow")
    #exrow("03", "Slow-tempo squat", "3 × 10", "3-1-1")
    #exrow("04", "Push-up plus", "3 × 12", "2-0-2")
    #exrow("05", "Hip airplane", "2 × 8 / side", "Slow")
    #exrow("06", "Dead bug crawl", "3 × 10 / side", "Control")

    // stat callouts
    #v(9pt)
    #grid(columns: (1fr, 1fr, 1fr), column-gutter: 8pt,
      statcard("12", "MIN", "Total circuit time", volt),
      statcard("4", "RDS", "Rounds, no rest at top", red),
      statcard("±180", "KCAL", [Estimated burn#super[\*]], steel),
    )

    #v(8pt)
    #text(font: ui, style: "italic", size: 8.5pt, fill: steel)[
      Move with control — the tempo is the workout, not the clock.
    ]

    #v(4pt)
    #text(font: ui, size: 6.5pt, fill: dim)[
      \*Sample layout demo: figures are invented for typography review — not training or medical advice.
    ]
  ]
]
