// ============================================================
// PROTOTYPE — S1 "authority nonfiction" skeleton × Self-improvement
// style config: "Warm Reset" — Fraunces (display) + Inter (body)
// Sample content only. Invented narrative, not real claims/advice.
// ============================================================

#let cream  = rgb("#FAF5EE") // base
#let ink    = rgb("#2B2520") // ink
#let orange = rgb("#E8622C") // accent
#let green  = rgb("#2E7D5B") // secondary
#let amber  = rgb("#F2C14E") // highlight
#let blush  = rgb("#CBB3A7") // muted
#let quiet  = rgb("#6E5F53") // derived quiet text

#let serif = "Fraunces"
#let sans  = "Inter"

#let kicker(body, fill: orange, size: 8pt) = text(
  font: sans, fill: fill, size: size, weight: 600, tracking: 0.26em, upper(body))

// Page defaults = the cover page (full-bleed cream).
#set page(width: 6in, height: 9in, margin: 0pt, fill: cream)
#set text(font: sans, size: 10.5pt, fill: ink, lang: "en")
#set par(justify: true, leading: 0.62em)

// ------------------------------------------------------------
// PAGE 1 — COVER (full-bleed cream, gradient blob + swirl geometry)
// ------------------------------------------------------------
// organic gradient blob bleeding off the lower-right edge
#place(bottom + right, dx: 1.05in, dy: -1.5in)[
  #box(width: 4.4in, height: 4.4in)[
    #path(
      closed: true,
      fill: gradient.linear(angle: 150deg, orange, amber),
      (55%, 7%),
      ((82%, 20%), (-11%, -10%)),
      ((96%, 42%), (-3%, -14%)),
      ((94%, 70%), (5%, -14%)),
      ((78%, 93%), (11%, -8%)),
      ((55%, 100%), (13%, 1%)),
      ((32%, 91%), (11%, 9%)),
      ((16%, 68%), (4%, 14%)),
      ((18%, 40%), (-3%, 15%)),
      ((28%, 16%), (-10%, 9%)),
    )
  ]
]

// soft green counter-blob, top-left, heavily lightened
#place(top + left, dx: -0.85in, dy: 0.75in)[
  #box(width: 2.6in, height: 2.6in)[
    #path(
      closed: true,
      fill: green.lighten(74%),
      (48%, 12%),
      ((77%, 27%), (-11%, -14%)),
      ((85%, 60%), (3%, -18%)),
      ((66%, 87%), (16%, -9%)),
      ((33%, 89%), (16%, 8%)),
      ((11%, 61%), (5%, 18%)),
      ((17%, 29%), (-11%, 15%)),
    )
  ]
]

// thin amber arc — quiet geometry accent
#place(top + right, dx: -0.95in, dy: 0.62in)[
  #box(width: 1.6in, height: 1.6in)[
    #circle(radius: 0.8in, stroke: 1.4pt + amber, fill: none)
  ]
]

#place(top + left, dx: 52pt, dy: 46pt)[
  #kicker("A Morning-Reset Guide", fill: quiet)
]

#place(top + left, dx: 50pt, dy: 1.95in)[
  #text(font: serif, weight: 600, size: 47pt, fill: ink, tracking: 0.002em)[
    The Warm #text(fill: orange)[Reset]
  ]
]

#place(top + left, dx: 52pt, dy: 2.9in)[
  #text(font: sans, weight: 300, size: 10.5pt, fill: ink, tracking: 0.02em)[
    Six small rituals to rebuild the first \
    hour of your day — gently, then firmly.
  ]
]

#place(bottom + left, dx: 52pt, dy: -1.15in)[
  #rect(width: 34pt, height: 2.6pt, fill: orange, radius: 1pt)
  #v(7pt)
  #text(font: sans, weight: 600, size: 9.5pt, fill: ink, tracking: 0.3em)[
    JUNE CALLOWAY
  ]
  #v(4pt)
  #text(font: sans, weight: 400, size: 7.5pt, fill: quiet, tracking: 0.16em)[
    SAMPLE AUTHOR · PROTOTYPE LAYOUT
  ]
]

// ------------------------------------------------------------
// PAGE 2 — INNER SPREAD (S1: section opener + hierarchy + pull-quote)
// ------------------------------------------------------------
#page(
  margin: (x: 62pt, top: 52pt, bottom: 46pt),
  fill: cream,
  footer: align(center, text(font: sans, size: 7.5pt, weight: 500, fill: blush,
    counter(page).display("1"))),
)[

  // ---- section opener: ghost numeral + kicker + title ----
  #place(top + right, dy: -0.06in)[
    #text(font: serif, weight: 600, size: 96pt, fill: orange.lighten(76%))[03]
  ]

  #kicker("Section 03")
  #v(10pt)
  #text(font: serif, weight: 600, size: 25pt, fill: ink)[The First-Light Protocol]
  #v(9pt)
  #rect(width: 100%, height: 0.7pt, fill: blush)
  #v(9pt)
  #text(font: sans, style: "italic", weight: 400, size: 10.5pt, fill: quiet)[
    Before goals, before caffeine: light. The one move that quietly decides
    whether the rest of your morning belongs to you.
  ]

  #v(16pt)

  // ---- body hierarchy ----
  The claim of this sample chapter is deliberately modest: you do not need to
  rebuild your life at sunrise. You only need to win a single hour, and the
  cheapest place to win it is at the window. In our invented sample narrative,
  the narrator stops snoozing not through discipline but through geography —
  the glass of water and the lamp switch now live on the other side of the room.

  #block(above: 16pt, below: 7pt)[
    #grid(columns: (auto, 1fr), column-gutter: 7pt,
      rect(width: 6pt, height: 6pt, fill: green, radius: 1.5pt),
      text(font: sans, weight: 600, size: 11pt, fill: ink)[Why light beats willpower],
    )
  ]

  Sample-copy goes here in earnest. Morning light is treated in this guide as
  a lever, not a virtue: it sets a timer you can feel, and it makes the first
  decision of the day (stand up, drink water, look outside) almost automatic.
  The protocol asks for three minutes of daylight before any screen, any feed,
  any verdict on how you slept. Everything after that is negotiable, and the
  negotiability is the point — a reset that survives real mornings has to be
  small enough to survive a bad one. The six rituals that close this section
  are each capped at five minutes and built to fail gracefully: skip the
  journaling and the water still counts; skip the water and the daylight
  still counts.

  // ---- pull-quote: the page's one decoration device ----
  #block(
    width: 100%,
    inset: (left: 16pt, top: 10pt, bottom: 10pt, right: 8pt),
    above: 13pt,
    stroke: (left: 3pt + orange),
  )[
    #text(font: serif, style: "italic", weight: 400, size: 15pt, fill: ink)[
      You don't need a five a.m. club. You need one honest hour, claimed
      before the world claims you.
    ]
    #v(6pt)
    #kicker("Pull-quote · Sample", fill: quiet, size: 7pt)
  ]
]
