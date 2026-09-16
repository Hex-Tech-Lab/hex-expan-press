// ============================================================
// PROTOTYPE v3 — "The Morning Reset" — illustrated trade build
// Keeps v2's typographic foundation (Fraunces Display + Libre
// Caslon Text, cream/ink/oxblood) and adds what round 2 lacked,
// benchmarked against the Synthesize.ai reference:
//   1. front cover w/ full-bleed warm photo (bottom two-thirds)
//   2. dedication + preface with real copy
//   3. dotted-leader contents w/ page numbers
//   4. two chapter openers w/ warm photos (ch1 full-bleed)
//   5. pure-Typst vertical timeline w/ amber tag chips
//   6. two thin-border callout boxes
//   7. back cover: photo panel, blurb, fake barcode block
//   8. folios + running heads as in v2
// Images: Openverse API (keyless), credits in img_v3/CREDITS.md.
//
// Typst 0.10 traps honored: no par(spacing:)/text(line-height:)/
// grid(align:); spacing via block(above:); no leading #page();
// fonts verified with `typst fonts` (0.10 silently falls back).
// All author/publisher/quotes/ISBN are invented; sample copy.
// ============================================================

#let paper  = rgb("#F7F1E3") // warm cream stock
#let wash   = rgb("#EFE6D0") // paper-tone shade
#let ink    = rgb("#262019") // warm near-black
#let wine   = rgb("#6E2434") // oxblood accent
#let quiet  = rgb("#8A7761") // muted warm gray
#let amber  = rgb("#DCA23E") // benchmark tag-chip amber
#let amberink = rgb("#4A3113")
#let callbg = rgb("#ECE4D2") // callout fill: light warm gray
#let callln = rgb("#A5937B") // callout hairline
#let leaderc = rgb("#B7A789") // dotted-leader dots

#let display = "Fraunces Display"
#let bodyf   = "Libre Caslon Text"
#let labelf  = "Inter"

// Letter-spaced capitals label (even optical spacing, per Tschichold)
#let caps(body, size: 8pt, fill: quiet, weight: 500, track: 0.24em, font: labelf) = text(font: font, size: size, fill: fill, weight: weight, tracking: track, upper(body))

// Publisher device: dawn — open sun tangent on the horizon line
#let sunrise(width: 64pt, r: 7pt, linec: ink, sunc: wine) = box(width: width, height: 2.2 * r + 1pt)[
  #let mid = width / 2
  #place(top + left, dy: 2 * r)[#line(length: mid - r, stroke: 0.55pt + linec)]
  #place(top + left, dx: mid + r, dy: 2 * r)[#line(length: mid - r, stroke: 0.55pt + linec)]
  #place(top + center, dy: 0pt)[#circle(radius: r, fill: none, stroke: 0.9pt + sunc)]
]

// Hanging drop cap: two-row-tall initial, first line wraps beside it
#let dropcap(letter) = {
  box(width: 30pt, height: 33.5pt, place(top + left, dx: -1.5pt,
    text(font: display, weight: 600, size: 47pt, fill: wine)[#letter]))
  h(4.5pt)
}

// Page furniture
#let runhead(body) = caps(body, size: 7.3pt, weight: 500, track: 0.22em)
#let folio = text(font: bodyf, size: 9pt, fill: quiet)[#counter(page).display("1")]
#let folior(num) = text(font: bodyf, size: 9pt, fill: quiet)[#num]

// Chapter kicker + underlined Fraunces title (benchmark opener style)
#let chaphead(kick, ttl) = {
  caps(kick, size: 8.5pt, fill: wine, weight: 600, track: 0.28em)
  v(7pt)
  text(font: display, weight: 600, size: 19.5pt, fill: ink)[#ttl]
  v(7pt)
  line(length: 48pt, stroke: 1pt + wine)
}

// Section head in body: maroon serif, benchmark subhead style
#let sechead(ttl) = {
  text(font: display, weight: 600, size: 13.5pt, fill: wine)[#ttl]
}

// Amber tag chip (benchmark "LOCKED IN" / "DECISION POINT" / ...)
#let chip(label) = box(fill: amber, radius: 2.5pt, inset: (x: 5.5pt, y: 2.5pt),
  outset: (right: 2pt))[
  #text(font: labelf, size: 6.6pt, weight: 700, tracking: 0.14em, fill: amberink, upper(label))
]

// Thin-border callout box (benchmark "Sorting Check" treatment)
#let callout(label, body) = block(width: 100%, above: 12pt, below: 12pt,
  fill: callbg, radius: 3.5pt, stroke: 0.7pt + callln, inset: (x: 15pt, y: 12pt))[
  #set par(justify: false, first-line-indent: 0pt, leading: 0.55em)
  #caps(label, size: 7.8pt, fill: ink, weight: 600, track: 0.26em)
  #v(6pt)
  #text(size: 9.8pt)[#body]
]

// Dotted-leader TOC row: a bare inline dotted line in a 1fr grid cell
// (box+place wrapper resolved to the wrong region and overflowed in 0.10)
#let tocentry(ttl, num, indent: 0pt, strong: false) = grid(
  columns: (auto, 1fr, 26pt), column-gutter: 6pt,
)[
  #box(inset: (left: indent))[
    #text(font: bodyf, size: 10.3pt, weight: if strong { 600 } else { 400 }, fill: ink)[#ttl]
  ]
][
  #line(length: 100%, stroke: (thickness: 0.55pt, paint: leaderc, dash: "dotted"))
][
  #text(font: bodyf, size: 10.3pt, fill: ink)[#num]
]

// Timeline row: dot + connector of FIXED length (a height:100% cell in an
// auto grid row is unsatisfiable in 0.10 and balloons rows to page height)
#let tl-row(H, timelabel, headr, tag, desc, last: false) = grid(
  columns: (13pt, 72pt, 1fr), column-gutter: 8pt,
)[
  #box(width: 13pt, height: if not last { H } else { 26pt })[
    #if not last [#place(top + left)[#line(start: (5pt, 10pt), end: (5pt, H), stroke: 1.1pt + leaderc)]]
    #place(top + left, dx: 2.6pt, dy: 3.2pt)[#circle(radius: 2.4pt, fill: wine)]
  ]
][
  #v(3pt)
  #box[#caps(timelabel, size: 7.4pt, fill: ink, weight: 600, track: 0.12em)]
][
  #block(above: 0pt, below: if last { 0pt } else { 0pt })[
    #text(font: display, weight: 600, size: 11.5pt, fill: ink)[#headr]
    #v(4pt)
    #chip(tag)
    #v(5pt)
    #text(size: 9.6pt)[#desc]
  ]
]

#set document(
  title: "The Morning Reset",
  author: "Kelly B.",
)
#set page(width: 6in, height: 9in, margin: 0pt, fill: paper)
#set text(font: bodyf, size: 10.6pt, fill: ink, lang: "en")
#set par(justify: true, leading: 0.62em, first-line-indent: 14pt)
#set block(above: 0.62em, below: 0pt)
#show footnote.entry: set text(size: 8pt)

// ------------------------------------------------------------
// PAGE 1 — FRONT COVER. Cream top third: ruled imprint cartouche,
// Fraunces display title, sun device, subtitle. Bottom two-thirds:
// full-bleed golden-sunrise photo; oxblood author band overlay.
// ------------------------------------------------------------
#place(top + left, dx: 46pt, dy: 38pt)[
  #box(width: 340pt)[
    #align(center)[
      #line(length: 100%, stroke: 0.8pt + ink)
      #v(5pt)
      #caps("Meridian Books", size: 8.5pt, fill: ink, weight: 600, track: 0.34em)
      #v(5pt)
      #line(length: 100%, stroke: 0.8pt + ink)
    ]
  ]
]

#place(top + left, dx: 46pt, dy: 92pt)[
  #box(width: 340pt)[
    #align(center)[
      #text(font: display, weight: 600, size: 31pt, fill: ink, tracking: 0.05em)[THE MORNING RESET]
      #v(11pt)
      #sunrise(width: 70pt, r: 7.5pt)
      #v(11pt)
      #text(font: display, weight: 400, style: "italic", size: 12.5pt, fill: ink)[
        A Field Guide to the First Hour of Your Day
      ]
    ]
  ]
]

#place(top + left, dy: 216pt)[
  #box(width: 432pt, height: 432pt)[
    #image("img_v3/cover_sunrise.jpg", width: 100%, height: 100%, fit: "cover")
  ]
]

#place(bottom + left)[#rect(width: 432pt, height: 64pt, fill: wine)]
#place(bottom + left, dy: -32pt)[
  #box(width: 432pt)[
    #align(center)[
      #text(font: display, weight: 600, size: 13pt, fill: paper, tracking: 0.3em)[JUNE CALLOWAY]
    ]
  ]
]

// ------------------------------------------------------------
// PAGE 2 — DEDICATION. Centered italic, no folio (counts as i).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 66pt), fill: paper)[
  #v(1fr)
  #align(center)[#sunrise(width: 56pt, r: 6pt, sunc: wine)]
  #v(18pt)
  #align(center)[
    #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
      For Biscuit, the cat who kept every morning as her own.
    ]
    #v(10pt)
    #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
      And for everyone who has ever lost one to the snooze button.
    ]
  ]
  #v(1fr)
]

// ------------------------------------------------------------
// PAGE 3 — PREFACE. Kicker + underlined title, real copy, roman folio.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 60pt), fill: paper,
  footer: align(center)[#folior("ii")]
)[
  #chaphead("Preface", "Why This Book Exists")
  #v(18pt)
  #block(above: 0pt)[
    This book began with a small, humiliating discovery: I could not remember a
    single morning from the previous year. Not one. Three hundred and sixty-five
    first hours, spent the way we spend most of ours — negotiated away in
    ten-minute installments — and nothing to show for them but a habit of arriving
    late to my own life.
  ]
  The morning is where a day is decided. Not in the calendar, not in the
  resolution, but in the quiet, unglamorous hour before anyone can ask you for
  anything. What you do there is what your day is made of. Most of us treat that
  hour like a lobby: a place to wait, half-dressed, for the day to begin. This
  book argues that it is the day.
  You will not find a four a.m. club in these pages, or a cold plunge, or a
  promise that you can become a different person by Thursday. The Morning Reset
  takes the side of the person you already are at 6:47 — tired, needed, and
  entitled to one hour that belongs to nobody else. It is a book about small
  mechanical arrangements: where the phone sleeps, where the glass stands, what
  the first sentence of the day says. You cannot will yourself into a different
  day. You can arrange the room so that one happens to you.
  It is written for anyone who has ever looked up around ten a.m. and realized
  the day is already happening to them. It is short on purpose. Read it in an
  hour; keep the hour.
  #v(10pt)
  #align(right)[#text(font: display, style: "italic", size: 10.5pt, fill: ink)[— J.C.]]
]

// ------------------------------------------------------------
// PAGE 4 — CONTENTS. Dotted leaders, hardcoded folios matching
// the layout below (front matter roman, chapters arabic).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 60pt), fill: paper,
  footer: align(center)[#folior("iii")]
)[
  #text(font: display, weight: 600, size: 21pt, fill: wine)[Contents]
  #v(20pt)
  #set par(justify: false, first-line-indent: 0pt)
  #block(above: 0pt)[
    #set block(above: 0pt, below: 0pt)
    #tocentry("Preface", "ii", strong: true)
    #v(11pt)
    #tocentry("One · The Hour Before the World Wakes", "1", strong: true)
    #tocentry("The Snooze Is a Small, Patient Lie", "2", indent: 15pt)
    #v(11pt)
    #tocentry("Two · The Reset Is Plumbing", "3", strong: true)
    #tocentry("The Reset Sequence", "4", indent: 15pt)
    #tocentry("What the Reset Is Not", "5", indent: 15pt)
  ]
  #v(1fr)
  #line(length: 100%, stroke: 0.5pt + quiet)
  #v(8pt)
  #caps("Meridian Books · New York · MMXXVI", size: 7.5pt, fill: quiet, track: 0.22em)
]

// ------------------------------------------------------------
// PAGE 5 — CHAPTER ONE OPENER. Full-bleed photo top (dark kitchen,
// first light through the slats), kicker + underlined title, drop
// cap. Folio restarts at 1; no running head on openers.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #counter(page).update(1)
  #place(top + left, dx: -68pt, dy: -78pt)[
    #box(width: 432pt, height: 300pt)[
      #image("img_v3/ch1_kitchenlight.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #v(226pt)
  #block(above: 0pt)[#chaphead("Chapter One", "The Hour Before the World Wakes")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("T")here is a particular minute — most of us meet it somewhere
    between 6:47 and 7:15 — when the day changes hands. The alarm has done its
    damage. The phone, face-down on the nightstand, holds everything that will
    be asked of you for the next sixteen hours. For one breath you lie still in
    the gray light and feel it happen: the day is not yet yours, and it is
    about to stop being yours at all.
  ]
  I spent a decade losing that minute in increments — to the snooze, to the
  blue glow, to a feed that took five years of mornings. You cannot will
  yourself into a different day. You can arrange the room so that one happens
  to you.
]

// ------------------------------------------------------------
// PAGE 6 — SPREAD, VERSO (folio 2). Running head outside. Section,
// body with footnote, framed pull-quote, callout box, end ornament.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Morning Reset")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("The Snooze Is a Small, Patient Lie")]
  #v(10pt)
  #block(above: 0pt)[
    Consider the snooze button, which I mention only because I know it
    intimately.#footnote[
      The nine-minute snooze is a mechanical fossil. Early alarm clocks divided
      time into gear-tooth increments, and nine minutes was the coarsest
      division that still felt precise. We did not design that button; we
      inherited it, the way we inherit most of our mornings.
    ] It sells nine more minutes of half-sleep at the price of the one hour
    that was yours, and it collects in a currency you notice only at noon:
    attention. Fragmented waking is not rest; it is three appetizers
    and no meal. You wake three times and arrive rested never.
  ]

  #block(above: 14pt, below: 14pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(9pt)
      #text(font: display, weight: 400, style: "italic", size: 14.5pt, fill: ink)[
        You will never control the whole day. You can control the first hour —
        and the first hour decides who shows up for all the rest.
      ]
      #v(9pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
  ]

  The reset asks three things of you, and none of them is five a.m. Before you
  speak to anyone: stand at a window for two
  minutes of daylight; drink a full glass of water; write one sentence about
  what today is for. On a good morning this takes ninety seconds. On a bad
  morning, it is the reason you keep the day.
  #callout("Room Check")[
    If the first hour keeps disappearing, fix the room, not your willpower. The
    repeat offender is almost always furniture: where the phone slept, where the
    glass stood, which way the curtains faced. Move the object and the morning
    follows.
  ]

  This is the quiet secret of every working morning I have studied:
  discipline is mostly a story we tell about furniture. Pilots run a
  checklist, not a pep talk.
  #v(10pt)
  #align(center)[
    #box(width: 40pt)[
      #place(top + left, dx: 17pt)[#circle(radius: 1.6pt, fill: wine)]
      #place(bottom + left, dy: -3.5pt, dx: 11pt)[#circle(radius: 1.6pt, fill: wine)]
      #place(bottom + left, dy: -3.5pt, dx: 24.5pt)[#circle(radius: 1.6pt, fill: wine)]
    ]
  ]
]

// ------------------------------------------------------------
// PAGE 7 — CHAPTER TWO OPENER (folio 3). Kicker + title + drop-cap
// body at top; full-width warm photo (reading, kitchen light) at the
// foot of the page, benchmark chapter-two treatment.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #counter(page).update(3)
  #place(bottom + center, dy: 0pt)[
    #box(width: 314pt, height: 196pt)[
      #image("img_v3/ch2_reading.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #block(above: 0pt)[#chaphead("Chapter Two", "The Reset Is Plumbing")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("I") call the result a reset rather than a routine, because
    routine is the wrong metaphor for mornings. A routine is a performance, and
    performances invite judgment. A reset is simpler and kinder: the short
    sequence of small acts that returns you to your own default settings before
    the world starts overwriting them.
  ]
  Nothing in it is five a.m., and nothing in it requires talent, money, or a
  personality transplant. It requires geography. The glass lives beside the
  kettle, so the water happens while the kettle boils. The notebook lies open
  to a blank page, so the sentence gets written before the doubt arrives. The
  sequence has an order, and the order is the method — the next page shows it
  as the day actually unfolds.
]

// ------------------------------------------------------------
// PAGE 8 — SPREAD, RECTO (folio 4). "The Reset Sequence" — vertical
// timeline in pure Typst: dots + connectors down the left, bold
// labels, amber tag chips (benchmark "Weekly Release Order" form).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(right)[#runhead("The Reset Is Plumbing")],
  footer: align(right)[#folio]
)[
  #block(above: 0pt)[#sechead("The Reset Sequence")]
  #v(4pt)
  #caps("The first sixty minutes, in release order", size: 8pt, fill: quiet, weight: 500, track: 0.16em)
  #v(14pt)
  #block(above: 0pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #tl-row(88pt, "Before light", [Protect the first hour], "Locked in",
      [The phone sleeps in the kitchen; the alarm lives across the room. The
      night before wins the morning.])
    #tl-row(88pt, "Minutes 0–3", [Run the reset], "Decision point",
      [Window. Water. One sentence about what today is for. Decide while the
      mind is quiet.])
    #tl-row(88pt, "Minutes 3–20", [Wake the room], "Flexible",
      [Kettle, coffee, daylight, breakfast if the day allows. The order inside
      the block can move; the block cannot.])
    #tl-row(0pt, "Minutes 20–60", [The first real thing], "Control point",
      [Forty minutes on the one task that matters before the world gets a vote.
      Track the window; guard it like the bills.], last: true)
  ]
  #v(10pt)
  The sequence is deliberately unheroic. Nothing in it requires a better self —
  only a room arranged so the better hour happens to you. On a bad morning the
  sequence shrinks; it does not disappear.
]

// ------------------------------------------------------------
// PAGE 9 — SPREAD, VERSO (folio 5). Closing section, second callout,
// end ornament.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Morning Reset")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("What the Reset Is Not")]
  #v(10pt)
  #block(above: 0pt)[
    The reset is not a productivity system; systems ask for outputs, and the
    first hour owes nobody anything. It is not a personality upgrade, and it is
    not an aspiration. It is plumbing: the quiet, repeatable machinery that
    carries water to the day — and plumbing works at 6:47 in the dark, on a
    Tuesday in February, when nobody is watching and nobody is inspired.
  ]
  Aspirations wait for a better self. Plumbing does not. The difference between
  a morning that works and a morning that collapses is rarely courage; it is
  almost always geography, decided the night before by a person who was thinking
  kindly of the person who would wake up in it.

  #callout("Sunday Review")[
    Grade the week on windows kept, not mornings perfected. Four kept hours out
    of seven is a working system, not a failure. The reset is a sequence, and
    sequences survive contact with Tuesday.
  ]

  The hour before the world wakes is the only real estate you hold outright.
  Nothing in it has been promised, scheduled, or negotiated away — the day will
  make its claims soon enough, and loudly. The reset is not a productivity
  system and it is not a personality upgrade. It is the deed to that first
  hour, signed at first light, one ordinary morning at a time.
  #v(12pt)
  #align(center)[
    #box(width: 40pt)[
      #place(top + left, dx: 17pt)[#circle(radius: 1.6pt, fill: wine)]
      #place(bottom + left, dy: -3.5pt, dx: 11pt)[#circle(radius: 1.6pt, fill: wine)]
      #place(bottom + left, dy: -3.5pt, dx: 24.5pt)[#circle(radius: 1.6pt, fill: wine)]
    ]
  ]
]

// ------------------------------------------------------------
// PAGE 10 — BACK COVER. Full-bleed warm photo top, deep oxblood
// panel below: blurb, invented-review quotes, author line, fake
// barcode imprint chip, prototype note.
// ------------------------------------------------------------
#page(margin: 0pt, fill: paper)[
  #place(top + left)[
    #box(width: 432pt, height: 330pt)[
      #image("img_v3/back_bedroom.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #place(top + left, dy: 330pt)[#rect(width: 432pt, height: 318pt, fill: wine)]
  #place(top + left, dy: 350pt, dx: 46pt)[
    #box(width: 340pt)[
      #set par(justify: false, first-line-indent: 0pt, leading: 0.55em)
      #text(font: display, weight: 400, style: "italic", size: 12.5pt, fill: paper)[
        The morning does not need a new you. It needs a room arranged in your favor.
      ]
      #v(9pt)
      #text(size: 9.2pt, fill: paper)[
        A field guide to the first, deciding hour — written for the person you
        already are at 6:47, tired and entitled to one hour that belongs to
        nobody else. Small mechanical arrangements: where the phone sleeps,
        where the glass stands, what the first sentence says. Read it in an
        hour; keep the hour.
      ]
      #v(9pt)
      #text(size: 8.5pt, style: "italic", fill: rgb("#E8D9BC"))[
        “Calloway writes about furniture the way poets write about weather.”
        — The Ordinary Review
      ]
      #v(5pt)
      #text(size: 8.5pt, style: "italic", fill: rgb("#E8D9BC"))[
        “Finally, a morning book that does not ask you to become a different
        person by Thursday.” — Housemate Quarterly
      ]
      #v(10pt)
      #align(center)[
        #text(font: display, weight: 600, size: 11pt, fill: paper, tracking: 0.28em)[JUNE CALLOWAY]
      ]
      #v(10pt)
      #let barcode = {
        for p in ((2, 1), (1, 2), (3, 1), (1, 1), (2, 2), (1, 1), (3, 1), (2, 1), (1, 2), (2, 1), (1, 1), (3, 1), (2, 2), (1, 1), (2, 1), (3, 1), (1, 1), (2, 1)) {
          box(width: p.at(0) * 1.35pt, height: 26pt, fill: ink)
          h(p.at(1) * 1.35pt)
        }
      }
      #box(inset: (x: 10pt, y: 6pt), fill: rgb("#F5F1E6"), radius: 1.5pt)[
        #set align(center)
        #box(barcode)
        #v(3pt)
        #caps("ISBN 978-0-00-000000-0 · US $19.99", size: 6.3pt, fill: ink, weight: 600, track: 0.12em)
      ]
      #v(6pt)
      #align(center)[
        #text(size: 6.4pt, fill: rgb("#D9C8A8"), style: "italic")[
          Design prototype · author, publisher, reviews, and ISBN are invented · sample copy, not advice
        ]
      ]
    ]
  ]
]
