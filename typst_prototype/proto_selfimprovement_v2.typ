// ============================================================
// PROTOTYPE v2 — "The Morning Reset" — trade-book anatomy build
// Direction: Penguin-Press-grade book design. Typography-led
// cover on the horizontal-band grid, restrained cream/oxblood
// palette, Fraunces (display) + Libre Caslon Text (body).
// Front matter → chapter opener w/ drop cap → spread w/ pull
// quote, sidebar, footnote → about-the-author + colophon.
// Sample content only: invented author/publisher, no real claims.
//
// Typst 0.10 traps honored: no par(spacing:)/text(line-height:)/
// grid(align:); paragraph gaps via block(above:); no leading
// #page() call (cover uses set page defaults); fonts verified
// with `typst fonts` (0.10 silently falls back).
// ============================================================

#let paper  = rgb("#F7F1E3") // warm cream stock
#let wash   = rgb("#EFE6D0") // paper-tone shade (sidebar)
#let ink    = rgb("#262019") // warm near-black
#let wine   = rgb("#6E2434") // oxblood accent
#let quiet  = rgb("#8A7761") // muted warm gray

#let display = "Fraunces Display"   // opsz 144 cut — all display tier
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

#set page(width: 6in, height: 9in, margin: 0pt, fill: paper)
#set text(font: bodyf, size: 10.6pt, fill: ink, lang: "en")
#set par(justify: true, leading: 0.62em, first-line-indent: 14pt)
#set block(above: 0.62em, below: 0pt)
#show footnote.entry: set text(size: 8pt)

// ------------------------------------------------------------
// PAGE 1 — COVER. Horizontal-band grid: ruled imprint cartouche,
// centered Fraunces display, sun device, oxblood author band.
// ------------------------------------------------------------
#place(top + left, dx: 46pt, dy: 42pt)[
  #box(width: 340pt)[
    #align(center)[
      #line(length: 100%, stroke: 0.8pt + ink)
      #v(5.5pt)
      #caps("Meridian Books", size: 8.5pt, fill: ink, weight: 600, track: 0.34em)
      #v(5.5pt)
      #line(length: 100%, stroke: 0.8pt + ink)
    ]
  ]
]

#place(top + left, dx: 46pt, dy: 158pt)[
  #box(width: 340pt)[
    #align(center)[
      #text(font: display, weight: 600, size: 42pt, fill: ink, tracking: 0.035em)[THE MORNING]
      #linebreak()
      #text(font: display, weight: 600, size: 42pt, fill: ink, tracking: 0.035em)[RESET]
      #v(22pt)
      #sunrise(width: 78pt, r: 8.5pt)
      #v(20pt)
      #text(font: display, weight: 400, style: "italic", size: 13.5pt, fill: ink)[
        A Field Guide to the First Hour of Your Day
      ]
    ]
  ]
]

#place(bottom + left, dy: 0pt)[#rect(width: 432pt, height: 76pt, fill: wine)]
#place(bottom + left, dy: -29pt)[
  #box(width: 432pt)[
    #align(center)[
      #text(font: display, weight: 600, size: 13.5pt, fill: paper, tracking: 0.3em)[JUNE CALLOWAY]
    ]
  ]
]

// ------------------------------------------------------------
// PAGE 2 — HALF-TITLE. Bare title, publisher device. No folio.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 60pt, bottom: 56pt), fill: paper)[
  #v(172pt)
  #align(center)[
    #text(font: display, weight: 600, size: 24pt, fill: ink, tracking: 0.02em)[The Morning Reset]
    #v(16pt)
    #sunrise(width: 46pt, r: 5.5pt)
  ]
]

// ------------------------------------------------------------
// PAGE 3 — FULL TITLE PAGE. Device, title, subtitle, author,
// imprint at the foot. No folio.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 60pt, bottom: 56pt), fill: paper)[
  #v(118pt)
  #align(center)[
    #sunrise(width: 58pt, r: 7pt)
    #v(30pt)
    #text(font: display, weight: 600, size: 27pt, fill: ink, tracking: 0.045em)[THE MORNING RESET]
    #v(13pt)
    #line(length: 92pt, stroke: 0.7pt + wine)
    #v(12pt)
    #text(font: display, weight: 400, style: "italic", size: 13pt, fill: ink)[
      A Field Guide to the First Hour of Your Day
    ]
    #v(34pt)
    #caps("June Calloway", size: 11pt, fill: ink, weight: 600, track: 0.32em)
  ]
  #place(bottom + center, dy: -88pt)[
    #align(center)[
      #caps("Meridian Books", size: 9pt, fill: quiet, weight: 600, track: 0.3em)
      #v(4pt)
      #text(font: display, weight: 400, style: "italic", size: 9.5pt, fill: quiet)[New York]
    ]
  ]
]

// ------------------------------------------------------------
// PAGE 4 — COPYRIGHT / COLOPHON. Small measure, bottom third,
// left-set at the inside margin. Printer's key, design credit,
// prototype note. No folio.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 60pt, bottom: 56pt), fill: paper)[
  #v(1fr)
  #block(above: 0pt)[
    #set par(justify: false, first-line-indent: 0pt, leading: 0.68em)
    #set text(size: 8.8pt)
    The Morning Reset: A Field Guide to the First Hour of Your Day
    #linebreak()
    Copyright © 2026 by June Calloway
    #linebreak()
    All rights reserved. No part of this book may be reproduced in any form or by any
    electronic or mechanical means, including information storage and retrieval systems,
    without permission in writing from the publisher, except by a reviewer, who may quote
    brief passages in a review.
    #linebreak()
    Published by Meridian Books, an imprint of Lantern House Publishing, LLC, New York.
    #linebreak()
    First edition. ISBN 978-0-00-000000-0 (pbk.)
    #linebreak()
    Printed and bound in the United States of America
    #v(3pt)
    10 9 8 7 6 5 4 3 2 1
    #v(12pt)
    Book design by the Meridian Art Department. Set in Fraunces and Libre Caslon Text;
    composed with Typst.
    #v(12pt)
    #text(style: "italic", fill: quiet)[
      Prototype note. This volume is a design prototype. The author, publisher, and ISBN
      are invented, and the text is sample copy written for layout; nothing here is
      professional advice.
    ]
  ]
]

// ------------------------------------------------------------
// PAGE 5 — CHAPTER OPENER. Centered numeral treatment, epigraph,
// drop cap. Folio "1" restarts the text block; no running head.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 68pt), fill: paper,
  footer: align(center)[#folio]
)[
  #counter(page).update(1)
  #align(center)[
    #caps("One", size: 26pt, fill: wine, weight: 600, track: 0.24em, font: display)
    #v(8pt)
    #sunrise(width: 54pt, r: 6.5pt)
    #v(14pt)
    #text(font: display, weight: 600, size: 20.5pt, fill: ink)[
      The Hour Before the World Wakes
    ]
  ]
  #v(20pt)
  #block(above: 0pt, inset: (left: 44pt, right: 22pt))[
    #set par(justify: false, first-line-indent: 0pt)
    #align(right)[
      #text(style: "italic", size: 10.2pt, fill: ink)[
        It is not that we have a short time to live, but that we waste a great deal of it.
      ]
      #v(4pt)
      #caps("Seneca · On the Shortness of Life", size: 7.5pt, track: 0.2em)
    ]
  ]
  #v(26pt)
  #block(above: 0pt)[
    #dropcap("T")here is a particular minute — most of us meet it somewhere between 6:47
    and 7:15 — when the day changes hands. The alarm has done its damage. The phone,
    face-down on the nightstand, holds everything that will be asked of you for the next
    sixteen hours. For one breath you lie still in the gray light and feel it happen: the
    day is not yet yours, and it is about to stop being yours at all.
  ]
  I spent a decade losing that minute — not to anything dramatic, nothing so honest as a
  catastrophe, but in increments: to the snooze button, to the blue glow, to a feed that
  promised five more minutes of entertainment and quietly took five years of mornings. By
  nine I was at my desk, technically present and actually somewhere else, already behind,
  already apologizing.
  It took me embarrassingly long to learn this: the first hour is not a slot on the
  schedule. It is a mood, and moods are set by small mechanical things — where the phone
  sleeps, whether the glass is full, which way the curtains face. You cannot will
  yourself into a different day; you can arrange the room so that one happens to you.
]

// ------------------------------------------------------------
// PAGE 6 — SPREAD, VERSO (folio 2). Running head outside. Body,
// framed pull-quote, protocol sidebar on paper-tone wash.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 66pt), fill: paper,
  header: align(left)[#runhead("The Morning Reset")],
  footer: align(left)[#folio]
)[
  I call the result a reset rather than a routine, because routine is the wrong metaphor
  for mornings. A routine is a performance, and performances invite judgment. A reset is
  simpler and kinder: the short sequence of small acts that returns you to your own
  default settings before the world starts overwriting them. When pilots take off, they
  run a checklist, not a pep talk. The checklist has never once asked how they feel about
  flying.

  #block(above: 15pt, below: 15pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(10pt)
      #text(font: display, weight: 400, style: "italic", size: 15pt, fill: ink)[
        You will never control the whole day. You can control the first hour — and the
        first hour decides who shows up for all the rest.
      ]
      #v(10pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
  ]

  The reset asks three things of you, and none of them is five a.m.

  #block(above: 13pt, below: 13pt, fill: wash, inset: 16pt, width: 100%)[
    #set par(justify: false, first-line-indent: 0pt, leading: 0.55em)
    #caps("The Three-Minute Reset", size: 8pt, fill: wine, weight: 600, track: 0.26em)
    #v(8pt)
    #text(size: 9.7pt)[
      Before you speak to anyone, before you look at a screen:
    ]
    #v(7pt)
    #grid(columns: (16pt, 1fr), row-gutter: 7pt, column-gutter: 2pt,
      text(font: display, weight: 600, size: 12pt, fill: wine, style: "italic")[1],
      text(size: 9.7pt)[Stand at a window. Two minutes of daylight, eyes soft, hands empty.],
      text(font: display, weight: 600, size: 12pt, fill: wine, style: "italic")[2],
      text(size: 9.7pt)[Drink a full glass of water. The body wakes from the inside; the mind follows it out.],
      text(font: display, weight: 600, size: 12pt, fill: wine, style: "italic")[3],
      text(size: 9.7pt)[Write one sentence about what today is for. One. If it is wrong, tomorrow you are allowed a better one.],
    )
    #v(8pt)
    #text(size: 9.7pt, style: "italic")[
      On a good morning this takes ninety seconds. On a bad morning, it is the reason you
      keep the day.
    ]
  ]

  The reset, in other words, is not an aspiration. It is plumbing. Aspirations wait for a
  better self; plumbing works at 6:47 in the morning, in the dark, on a Tuesday in
  February, when nobody is watching and nobody is inspired.
]

// ------------------------------------------------------------
// PAGE 7 — SPREAD, RECTO (folio 3). Running head outside. Body
// with footnote treatment and end-of-chapter ornament.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 66pt), fill: paper,
  header: align(right)[#runhead("The Hour Before the World Wakes")],
  footer: align(right)[#folio]
)[
  Consider the snooze button, which I mention only because I know it
  intimately.#footnote[
    The nine-minute snooze is a mechanical fossil. Early alarm clocks divided time into
    gear-tooth increments, and nine minutes was the coarsest division that still felt
    precise. Every upgrade since — electric, digital, atomic — has faithfully reproduced
    the error. We did not design that button; we inherited it, the way we inherit most of
    our mornings.
  ] The button is a small, patient lie. It sells you nine more minutes of half-sleep at
  the price of the one hour that was actually yours, and it collects in a currency you
  will not notice until noon: attention. Fragmented waking is not rest; it is three
  appetizers and no meal. You wake three times and arrive rested never.
  Now notice what the reset is actually made of. Nothing in the three-minute protocol
  requires talent, money, or a personality transplant. It requires geography. The glass
  lives beside the kettle, so the water happens while the kettle boils. The phone spends
  the night in the kitchen, so the day reaches you at the window instead of in your palm.
  The notebook lies open to a blank page, so the sentence gets written before the doubt
  arrives. This is the quiet secret of every working morning I have ever studied:
  discipline is mostly a story we tell about furniture.
  The hour before the world wakes is the only real estate you hold outright. Nothing in
  it has been promised, scheduled, or negotiated away — the day will make its claims soon
  enough, and loudly. The reset is not a productivity system and it is not a personality
  upgrade. It is the deed to that first hour, signed at first light, one ordinary morning
  at a time.
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
// PAGE 8 — BACK MATTER. About the author, then colophon. Folio 4.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 66pt), fill: paper,
  header: align(left)[#runhead("The Morning Reset")],
  footer: align(center)[#folio]
)[
  #v(14pt)
  #align(center)[
    #caps("About the Author", size: 8.5pt, fill: wine, weight: 600, track: 0.28em)
    #v(9pt)
    #line(length: 44pt, stroke: 0.8pt + wine)
  ]
  #v(20pt)
  June Calloway writes about attention, habit, and the small mechanics of a well-used
  day. Her essays on mornings, money, and memory have appeared in national magazines and
  been anthologized twice. For fifteen years she has kept a standing appointment with
  nurses, bakers, pilots, poets, and one extremely reliable lighthouse keeper, all of
  whom were asked the same question: what do you do before anyone can ask you for
  anything?
  She lives in Portland, Oregon, with her family and a fiercely opinionated cat named
  Biscuit, who has never once permitted a snooze.
  #v(1fr)
  #line(length: 100%, stroke: 0.5pt + quiet)
  #v(16pt)
  #block(above: 0pt)[
    #set par(justify: false, first-line-indent: 0pt, leading: 0.68em)
    #set text(size: 8.8pt)
    #caps("Colophon", size: 7.5pt, fill: quiet, track: 0.26em)
    #v(7pt)
    This edition of The Morning Reset is set in Fraunces and Libre Caslon Text. The body
    text is 10.6 points, justified on a 314-point measure, with indented paragraphs set
    solid; display type, epigraphs, and pull-quotes are Fraunces. Composed with Typst.
    #v(9pt)
    #caps("Meridian Books · New York · MMXXVI", size: 8pt, fill: quiet, track: 0.22em)
    #v(9pt)
    #text(style: "italic", fill: quiet)[
      Prototype note. Author, publisher, and ISBN are invented; the text is sample copy
      written for layout and is not professional advice.
    ]
  ]
]
