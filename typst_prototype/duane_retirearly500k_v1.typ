// ============================================================
// "You Don't Need a Million Dollars to Retire" — Duane (retirearly500k)
// ADR-0036 Track 1 real-content build. Design = warm-cream v3/v4
// canonical (Fraunces Display + Libre Caslon Text + Inter; cream/ink/
// oxblood), callout pattern verbatim from proto_selfimprovement_v4.
//
// FACT DISCIPLINE (ADR-0036): every number, name and event traces to
// data/db/samples/duane_retirearly500/corroboration/track1_fact_ledger.md
// (53-line verified ledger) + corroboration_raw.json (external stats).
// Nothing invented. Voice facts from the same transcripts.
//
// Junction-collapse discipline (2026-09-16 certification fix): body
// flow lives inside `block(above: 0pt)` containers; explicit #v() at
// every block junction; TOC rows separated by >=8pt.
// Built for Typst 0.15.1.
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

// Inset drop cap: initial sits flush inside the text column (left edge
// aligned to body text, not hanging outside it), first line wraps beside it
#let dropcap(letter) = {
  box(width: 30pt, height: 33.5pt, place(top + left, dx: 0pt,
    text(font: display, weight: 600, size: 47pt, fill: wine)[#letter]))
  h(5.5pt)
}

// Page furniture
#let runhead(body) = caps(body, size: 7.3pt, weight: 500, track: 0.22em)
#let folio = context text(font: bodyf, size: 9pt, fill: quiet)[#counter(page).display("1")]
#let folior(num) = text(font: bodyf, size: 9pt, fill: quiet)[#num]

// Chapter kicker + underlined Fraunces title (benchmark opener style)
#let chaphead(kick, ttl) = {
  caps(kick, size: 9.5pt, fill: wine, weight: 600, track: 0.28em)
  v(8pt)
  text(font: display, weight: 600, size: 21pt, fill: ink)[#ttl]
  v(8pt)
  line(length: 48pt, stroke: 1pt + wine)
}

// Section head in body: maroon serif, benchmark subhead style
#let sechead(ttl) = {
  text(font: display, weight: 600, size: 13.5pt, fill: wine)[#ttl]
}

// Amber tag chip
#let chip(label) = box(fill: amber, radius: 2.5pt, inset: (x: 5.5pt, y: 2.5pt),
  outset: (right: 2pt))[
  #text(font: labelf, size: 6.6pt, weight: 700, tracking: 0.14em, fill: amberink, upper(label))
]

// Thin-border callout box (pattern verbatim from proto_selfimprovement_v4;
// used here for the four CORROBORATION boxes — external-source reality checks)
#let callout(label, body) = block(width: 100%, above: 12pt, below: 12pt,
  fill: callbg, radius: 3.5pt, stroke: 0.7pt + callln, inset: (x: 15pt, y: 12pt))[
  #set par(justify: false, first-line-indent: 0pt, leading: 0.55em)
  #caps(label, size: 7.8pt, fill: ink, weight: 600, track: 0.26em)
  #v(6pt)
  #text(size: 9.8pt)[#body]
]

// End-of-chapter ornament: three oxblood dots, in a single true-centered
// row (stack, not manually-placed triangle) so it is always vertically
// symmetric regardless of surrounding content.
#let orn = align(center)[
  #stack(dir: ltr, spacing: 7pt,
    circle(radius: 1.6pt, fill: wine),
    circle(radius: 1.6pt, fill: wine),
    circle(radius: 1.6pt, fill: wine),
  )
]

// Flat one-level TOC row (v4 round 4): no leader dots, generous gaps
#let tocentry(ttl, num, indent: 0pt, strong: false) = grid(
  columns: (auto, 1fr, 26pt), column-gutter: 6pt,
)[
  #box(inset: (left: indent))[
    #text(font: bodyf, size: 11pt, weight: if strong { 600 } else { 400 }, fill: ink)[#ttl]
  ]
][
][
  #text(font: bodyf, size: 11pt, fill: ink)[#num]
]

// Timeline row: dot + connector of FIXED length (a height:100% cell in an
// auto grid row is unsatisfiable in 0.10 and balloons rows to page height)
#let numrow(datel, totall, notel, last: false) = grid(
  columns: (52pt, 64pt, 1fr), column-gutter: 8pt,
  stroke: (bottom: if not last { 0.5pt + leaderc } else { none }),
  inset: (y: 6pt),
)[
  #box[#caps(datel, size: 7.2pt, fill: ink, weight: 600, track: 0.08em)]
][
  #text(font: display, weight: 600, size: 10.5pt, fill: wine)[#totall]
][
  #text(size: 9.4pt)[#notel]
]

#set document(
  title: "You Don't Need a Million Dollars to Retire",
  author: "Duane",
)
#set page(width: 6in, height: 9in, margin: 0pt, fill: paper)
#set text(font: bodyf, size: 10.6pt, fill: ink, lang: "en")
#set par(justify: true, leading: 0.62em, first-line-indent: 14pt)
#set block(above: 0.62em, below: 0pt)
#show footnote.entry: set text(size: 8pt)

// ------------------------------------------------------------
// FRONT COVER. Cream top: ExpanPress cartouche, Fraunces display
// title, sun device, subtitle. Bottom: full-bleed photo band;
// oxblood author band overlay. (Photo: CC BY 2.0, see img_v3/CREDITS.md)
// ------------------------------------------------------------
#place(top + left, dx: 46pt, dy: 36pt)[
  #box(width: 340pt)[
    #align(center)[
      #line(length: 100%, stroke: 0.8pt + ink)
      #v(5pt)
      #caps("ExpanPress", size: 8.5pt, fill: ink, weight: 600, track: 0.34em)
      #v(5pt)
      #line(length: 100%, stroke: 0.8pt + ink)
    ]
  ]
]

#place(top + left, dx: 46pt, dy: 84pt)[
  #box(width: 340pt)[
    #align(center)[
      #text(font: display, weight: 600, size: 25pt, fill: ink, tracking: 0.04em)[
        YOU DON'T NEED A \
        MILLION DOLLARS \
        TO RETIRE
      ]
      #v(11pt)
      #sunrise(width: 70pt, r: 7.5pt)
      #v(11pt)
      #text(font: display, weight: 400, style: "italic", size: 12pt, fill: ink)[
        How I Retired at 59 on \$548,000 — \
        My Real Numbers, Five Years In
      ]
    ]
  ]
]

#place(top + left, dy: 246pt)[
  #box(width: 432pt, height: 402pt)[
    #image("img_v3/cover_sunrise.jpg", width: 100%, height: 100%, fit: "cover")
  ]
]

#place(bottom + left)[#rect(width: 432pt, height: 64pt, fill: wine)]
#place(bottom + left, dy: -32pt)[
  #box(width: 432pt)[
    #align(center)[
      #text(font: display, weight: 600, size: 13pt, fill: paper, tracking: 0.3em)[DUANE]
    ]
  ]
]

// ------------------------------------------------------------
// COPYRIGHT PAGE (folio ii). Imprint, copyright, provenance of the
// numbers, and the disclaimer Duane already gives his own audience.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 66pt), fill: paper,
  footer: align(center)[#folior("ii")]
)[
  #v(1fr)
  #block(above: 0pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
      #text(font: display, weight: 600, size: 13.5pt, fill: ink, tracking: 0.06em)[
        You Don't Need a Million Dollars to Retire
      ]
      #v(6pt)
      #text(font: display, weight: 400, style: "italic", size: 10.5pt, fill: ink)[
        How I Retired at 59 on \$548,000 — My Real Numbers, Five Years In
      ]
      #v(24pt)
      #text(size: 9pt)[
        Copyright © 2026 Duane. All rights reserved.
      ]
      #v(8pt)
      #text(size: 9pt)[
        Published by ExpanPress.
      ]
      #v(24pt)
      #line(length: 56pt, stroke: 0.7pt + quiet)
      #v(24pt)
      #text(size: 9pt)[
        Every number in this book comes from Duane's own accounts, exactly as he
        reported them in five years of public monthly updates on his YouTube
        channel (\@retirearly500k59) and Instagram (\@retirearly500). No figure has
        been rounded up, prettied, or invented.
      ]
      #v(14pt)
      #text(size: 9pt)[
        This book is a case study, not advice. Duane is not a licensed financial
        advisor, and nothing here is a recommendation to buy, sell, or hold
        anything. His portfolio is one portfolio — one person, one set of choices,
        one five-year stretch of markets. Past performance is no guarantee of
        future results. Your numbers will be your own.
      ]
    ]
  ]
  #v(1fr)
]

// ------------------------------------------------------------
// CONTENTS (folio iii). Flat one-level list; rows separated by
// explicit 8pt gaps (junction-collapse discipline, 2026-09-16 fix).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 60pt), fill: paper,
  footer: align(center)[#folior("iii")]
)[
  #text(font: display, weight: 600, size: 21pt, fill: wine)[Contents]
  #v(26pt)
  #set par(justify: false, first-line-indent: 0pt)
  #block(above: 0pt)[
    #set block(above: 0pt, below: 0pt)
    #tocentry("One · You Don't Need a Million Dollars", "1", strong: true)
    #v(8pt)
    #tocentry("Two · Twenty Years of Boring", "5", strong: true)
    #v(8pt)
    #tocentry("Three · August 2021", "8", strong: true)
    #v(8pt)
    #tocentry("Four · The Crash Year", "13", strong: true)
    #v(8pt)
    #tocentry("Five · The Quiet Recovery", "18", strong: true)
    #v(8pt)
    #tocentry("Six · The Other Income", "21", strong: true)
    #v(8pt)
    #tocentry("Seven · Five Years In", "24", strong: true)
  ]
  #v(1fr)
  #line(length: 100%, stroke: 0.5pt + quiet)
  #v(8pt)
  #caps("ExpanPress · MMXXVI", size: 7.5pt, fill: quiet, track: 0.22em)
]

// ------------------------------------------------------------
// PAGE 1 — CHAPTER ONE OPENER (folio 1). Full-bleed photo top,
// kicker + underlined title, drop cap.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #counter(page).update(1)
  #place(top + left, dx: -68pt, dy: -78pt)[
    #box(width: 432pt, height: 285pt)[
      #image("img_v3/ch1_kitchenlight.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #v(211pt)
  #block(above: 0pt)[#chaphead("Chapter One", "You Don't Need a Million Dollars")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("T")here is a sentence I say at the start of almost every video I
    upload, and it has become the shortest version of everything I believe: you
    don't need a million dollars to retire. I know, because I did it. August
    2021, on my fifty-ninth birthday, I walked out of my last job with a
    retirement portfolio worth \$548,000 — a 401(k) holding \$323,000, an IRA
    holding \$150,000, and \$75,000 sitting in cash. That was the grand gaudy
    total, as I like to call it: half a million dollars and change, aimed at
    the rest of my life.

  It has now carried me five full years — through a crash that cut it by
  \$110,000, through a recovery nobody at my old office would have predicted —
  and it stands today at an all-time high of \$595,000. No pension, no
  windfall, no inheritance. A middle-class salary, boring funds, and a date
  on the calendar.
  ]
]

// ------------------------------------------------------------
// PAGE 2 — CHAPTER ONE (folio 2). Who this is for; what's ahead;
// chapter-close takeaway.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("You Don't Need a Million Dollars to Retire")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("Who This Book Is For")]
  #v(10pt)
  #block(above: 0pt)[
    Not the millionaires, mostly. The people I hear from every week hold
    between \$250,000 and \$750,000, right around \$500,000 at the center. I
    think of us as moderate maniacs: moderate portfolios, maniacal attention
    to the numbers. If that is you, you already know the problem — almost
    every retirement book assumes seven figures, and the half-million-dollar
    question gets waved away with \u{201C}just save more.\u{201D}
  So here is the deal, the same one my channel makes: my real numbers, every
  month since I retired — every balance, every withdrawal, nothing rounded
  up. You will see the month my 401(k) lost \$52,000, and the January the
  whole thing sat at \$438,000 and I did not sell. Numbers are the only
  thing I have that you cannot argue with.
  ]
  #v(20pt)
  #block(above: 0pt)[#sechead("What's Ahead")]
  #v(10pt)
  #block(above: 0pt)[
    Seven chapters, five years, one portfolio — from the last job to this
    morning's balance, with every year-end figure gathered into one table
    along the way. This is the only chapter without a number in it.

  Two warnings, the same two I give on every video. I am not a licensed
  financial advisor, and this is not financial advice — one portfolio, one
  person, five years of markets, told honestly. And past performance
  guarantees nothing. What I can promise is that every number really
  happened. We got this.
  ]
  #v(10pt)
  #block(above: 26pt, below: 10pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
    #box(width: 76%)[
      #caps("The takeaway", size: 7.6pt, fill: wine, weight: 600, track: 0.26em)
      #v(6pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(9pt)
      #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
        You don't need a million dollars. You need your real number, your
        real budget, and the nerve to look at both every month.
      ]
      #v(9pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
    ]
  ]
  #v(18pt)
  #orn
]

// ------------------------------------------------------------
// PAGE 3 — CHAPTER TWO OPENER (folio 3).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #place(top + left, dx: -68pt, dy: -78pt)[
    #box(width: 432pt, height: 240pt)[
      #image("img_v3/ch2_reading.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #v(182pt)
  #block(above: 0pt)[#chaphead("Chapter Two", "Twenty Years of Boring")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("T")his chapter covers the twenty-six years before retirement,
    and I will warn you up front: it is boring. Good. Boring is the entire
    trick. There was a drafting-instructor job that peaked at \$27,000, an
    assistant's desk in the publicity department of a major record label at
    \$28,000 a year — and a savings rate that went up a little bit every time
    the salary did, for twenty years, until it was doing most of the work.

  I got there the long way: six months at Cal Poly San Luis Obispo produced
  straight C's and a phone call from my mother suggesting technical school —
  excellent advice, as it turned out. Two years teaching drafting followed,
  then UCLA in 1987, an MBA from Berkeley in 1992, and one unpaid internship
  at a Capitol Records subsidiary that sold me on the music business for
  twenty years.
  ]
]

// ------------------------------------------------------------
// PAGE 4 — CHAPTER TWO (folio 4). The savings-rate ladder; the
// promotion I turned down; takeaway.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("Twenty Years of Boring")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("The Savings-Rate Ladder")]
  #v(10pt)
  #block(above: 0pt)[
    At twenty-six I was saving exactly nothing. Not because the math was
    hopeless — because nobody had ever shown me the math. Here is the ladder,
    salary first, savings rate second, straight from my own records:
    \$45,000 and 5 percent in 1997 (and the 5 percent was all employer match —
    I put in zero); \$55,000 and 7 percent at forty, in 2002; \$65,000 and
    11 percent by 2004; and through 2008 to 2012, \$75,000 — the biggest
    salary of my entire life — with the rate at 18 to 20 percent.

  Notice what did not happen: the salary never made me comfortable enough to
  stop. Every raise got divided — some to life, most to future me — and the
  rate ratcheted up and stayed up. That single habit, repeated for two
  decades, built a \$548,000 portfolio on a salary that topped out at
  \$75,000. Not genius. Arithmetic, applied patiently.
  The promotion I turned down fits here, because it is the same arithmetic
  aimed at a different account. Around thirty-five, the company offered me a
  senior-director job — the predecessor worked sixty-five to seventy hours a
  week. I accepted on a Friday and un-accepted on a Monday: a smaller raise,
  traded for the only resource I could never save more of.
  ]
  #v(10pt)
  #block(above: 26pt, below: 10pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
    #box(width: 76%)[
      #caps("The takeaway", size: 7.6pt, fill: wine, weight: 600, track: 0.26em)
      #v(6pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(9pt)
      #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
        Nobody gets rich on \$75,000. Plenty of people retire on it — if the
        savings rate climbs every time the salary does.
      ]
      #v(9pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
    ]
  ]
]

// ------------------------------------------------------------
// PAGE 5 — CHAPTER TWO (folio 5). The two boring decisions;
// corroboration box (real-world withdrawal behavior); close.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("Twenty Years of Boring")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("Two Boring Decisions")]
  #v(10pt)
  #block(above: 0pt)[
    Two more boring decisions did the rest. At thirty-five I tried picking
    individual stocks, lost my butt — a couple of thousand dollars, gone —
    and quit picking forever. And at forty I moved everything into
    target-date funds and never looked at an allocation chart again: one
    fund, automatic rebalancing, gradually getting more conservative as the
    calendar moved. My portfolio today is two-thirds in a 2025 target-date
    fund and one-third, in the IRA, in a 2035 — a blend that lands around
    60/40 stocks and bonds, drifted to roughly 56/44 by now. I have never
    once regretted the boring.
  ]
  #callout("Corroborated · Do retirees really withdraw 4%?")[Most never get
  near it. Vanguard's How America Retires study followed roughly 70,000 new
  retirees and found about a quarter withdrew nothing at all in their first
  years, with most incremental withdrawals running well below the famous 4%
  ceiling. A 2025 study in Financial Planning Review by David Blanchett and
  Michael Finke put actual withdrawals even lower: married retirees with
  \$100,000-plus in savings averaged about 2.1% a year, singles about 1.9%.
  Retirees, as a group, spend far more cautiously than the rules assume —
  which is exactly the moderate-maniac pattern.]
  #block(above: 0pt)[
    Which is the quiet point of this whole chapter. The financial industry
    plans retirement around a rate almost nobody spends, for a balance almost
    nobody has. The moderate maniacs — the people actually living this, on
    four and five and six figures of savings — are out here withdrawing 2
    percent and loving it. The boring arithmetic works. It just works more
    modestly than the brochures say.
  ]
  #v(18pt)
  #orn
]

// ------------------------------------------------------------
// PAGE 5 — CHAPTER THREE OPENER (folio 5).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #place(top + left, dx: -68pt, dy: -78pt)[
    #box(width: 432pt, height: 260pt)[
      #image("img_v3/ch1_kitchenlight.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #v(202pt)
  #block(above: 0pt)[#chaphead("Chapter Three", "August 2021")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("T")he end of my first career arrived in pieces. In 2012, after
    twenty years in the music business, the company eliminated my job and
    handed me a year of severance, which I treated like the precious,
    non-renewable resource it was. What followed were three successively
    lower positions — the résumé kept going further than the face did. By the
    last one I was back down to \$65,000, saving 22 percent of it, and every
    interview after my fiftieth birthday taught the same blunt lesson:
    ageism is real, and it is not subtle.

  So I stopped interviewing the market and started interviewing myself. The
  numbers said I could leave; the budget said I could stay gone. I picked my
  retirement date the way other people pick a wedding date — my fifty-ninth
  birthday, August 2021 — and gave my employer two months' notice, which I
  now believe is about two months too much.
  ]
]

// ------------------------------------------------------------
// PAGE 6 — CHAPTER THREE (folio 6). The goodbye; the landing plan.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("August 2021")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("Two Months of Goodbye")]
  #v(10pt)
  #block(above: 0pt)[
    Here is what two months of notice actually buys you, in case you are
    planning one: in the first week, my projects were reassigned and my
    calendar emptied. Within a month, the work friends drifted — not from
    meanness, but because the shared problem that made us friends was gone.
    On my last day I sent a goodbye note to roughly two hundred colleagues
    and received three or four replies. I am not bitter about it; I am
    reporting it, because it is data. The office was a structure, and when I
    stepped out of the structure, the structure did not come with me.

  I tell every pre-retiree the same thing: plan the after the way you plan
  the money. I had the cheap-house plan, the girlfriend plan, and the
  budget, and those three held up better than any farewell lunch.
  ]
  #v(20pt)
  #block(above: 0pt)[#sechead("The Landing Plan")]
  #v(10pt)
  #block(above: 0pt)[
    The house came first. Six months into retirement I bought one in the
    high desert east of Los Angeles — a town of two or three thousand people,
    a house in the hills with what I call a million-dollar view, for \$245,000
    cash-money cheap. It is high-fire country, so home insurance plus fire
    insurance is a real line in the budget, and I pay it happily. The whole
    setup costs about half of what I used to pay in rent in LA.

  The rest of the plan is people. My girlfriend of twenty-five years has a
  union pension and a paid-off house in the city, and she is retiring around
  mid-2026; until then we trade two weeks in the high desert, two weeks in
  LA. On advice: I have paid a fee-only fiduciary exactly once, for one
  hour, decades ago, and I run no ongoing advisor — the 1%-of-assets crowd
  would cost more per year than I withdraw in some years. And there is one
  small annuity coming from the old music-industry employer plan, maybe a
  couple of hundred dollars a month starting around sixty-seven. It will not
  change my life; it is ballast. If you ever buy annuities, keep them under
  10 or 15 percent of the portfolio, the way I keep everything: boring.
  ]
]

// ------------------------------------------------------------
// PAGE 7 — CHAPTER THREE (folio 7). The first balance sheet; the
// ceiling math; takeaway.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("August 2021")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("The First Balance Sheet")]
  #v(10pt)
  #block(above: 0pt)[
    Retirement day, August 2021. The grand gaudy total: \$548,000. The
    401(k): \$323,000. The IRA: \$150,000. Cash: \$75,000. Allocation: 65
    percent stocks, 35 percent bonds — conservative enough to sleep, growthy
    enough to outlast me. Against it: expenses of about \$2,800 a month,
    which I could recite from memory the way some people recite a batting
    average.

  Run the famous rule on that and you get the number I treated as a
  ceiling, never a target: 4 percent of \$548,000 is \$21,920. My plan was
  to withdraw about \$22,000 that first year — 4.2 percent, close enough to
  the rule to be legal, and I said so on camera with a wink — and to leave
  the ceiling where it was until the portfolio or the expenses gave me a
  reason to move it. Most years, as you will see, I moved it down.
  That is the whole secret hiding inside the number you came here for. A
  \$548,000 portfolio is not small because \$548,000 is small. It is small
  only if your life is expensive. Mine costs \$2,800 a month plus fire
  insurance, and every planning book in America is written for people whose
  number starts with a different digit.
  ]
  #v(10pt)
  #block(above: 26pt, below: 10pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
    #box(width: 76%)[
      #caps("The takeaway", size: 7.6pt, fill: wine, weight: 600, track: 0.26em)
      #v(6pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(9pt)
      #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
        Retirement day is a Tuesday. Plan the Tuesday — the quiet morning
        after — and the party takes care of itself.
      ]
      #v(9pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
    ]
  ]
  #v(18pt)
  #orn
]

// ------------------------------------------------------------
// PAGE 9 — CHAPTER FOUR OPENER (folio 9).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #place(top + left, dx: -68pt, dy: -78pt)[
    #box(width: 432pt, height: 240pt)[
      #image("img_v3/back_bedroom.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #v(182pt)
  #block(above: 0pt)[#chaphead("Chapter Four", "The Crash Year")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("F")or my first six months of retirement, the markets said
    congratulations. Then they said: not so fast. Between August 2021 and
    February 2022 the portfolio dropped roughly \$52,000 — from \$548,000 to
    about \$496,000 — while I was still unpacking boxes in the high desert.
    By the one-year mark it read about \$457,000, and it kept sliding.

  I want to be precise about what this chapter is, because it is the reason
  the channel exists. In November 2022, from the middle of this slide, I
  turned on a camera and started reporting my real numbers every month. Not
  because I had a strategy to share. Because nobody on the internet was
  showing their actual account during a crash, and I figured someone
  sensible should.
  ]
]

// ------------------------------------------------------------
// PAGE 10 — CHAPTER FOUR (folio 10). The low; zero-withdrawal year;
// what the cash was for.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Crash Year")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("January 2023")]
  #v(10pt)
  #block(above: 0pt)[
    The low came in January 2023, and I have never forgotten the arithmetic
    of that month. Total: \$438,000. The 401(k): \$269,000. The IRA: \$116,000.
    Cash: \$53,000. Down \$110,000 from retirement day — call it 20 percent of
    everything I had saved across a working life — with the 401(k) down 17
    percent and the IRA down 23. One and a half years in, and a fifth of the
    nest egg was simply gone.

  And here is the number I am proudest of in this whole book: withdrawals
  in 2023 were zero. Not reduced. Zero. The \$75,000 cash bucket stocked on
  retirement day covered every bill for more than two years, so I never
  sold a share at the bottom to buy groceries. That is the whole trick,
  and it is not a trick: it is a calendar — two years of spending parked
  somewhere the market cannot reach.
  ]
  #v(20pt)
  #block(above: 0pt)[#sechead("Bonds Stopped Being Bonds")]
  #v(10pt)
  #block(above: 0pt)[
    The uncomfortable discovery of 2022 was that the bond half of my 65/35
    portfolio fell too. For forty years the deal was simple: stocks down,
    bonds up. That year both fell together, and my target-date funds —
    designed precisely to cushion this — cushioned nothing. I reported it
    on camera with the retirement vodka within reach and said the only
    thing left to say: stay the course.
  ]
  #callout("Corroborated · 2022, the year both halves fell")[The S&P 500
  lost about 18% in 2022 and the Bloomberg US Aggregate Bond Index about
  13% — its worst calendar year on record — the first time in four decades
  that stocks and bonds fell hard together. It is sequence-of-returns risk
  in miniature: withdrawals that begin in the wrong five years can
  permanently shrink a portfolio even when the long-run average is fine.
  The standard defense is Duane's: cash on hand, so nothing gets sold
  into the downturn.]
  #v(18pt)
  #orn
]

// ------------------------------------------------------------
// PAGE 11 — CHAPTER FOUR (folio 11). The whole five-year ledger,
// one table. (Withdrawal legend at foot.)
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Crash Year")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("The Whole Ledger, Five Years In")]
  #v(10pt)
  #caps("Every milestone balance since retirement day, as reported monthly", size: 8pt, fill: quiet, weight: 500, track: 0.16em)
  #v(14pt)
  #block(above: 0pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #set text(size: 9.6pt)
    #grid(columns: (52pt, 64pt, 1fr), column-gutter: 8pt,
      stroke: (bottom: 1pt + ink), inset: (y: 6pt))[
      #caps("Date", size: 7.2pt, fill: ink, weight: 700, track: 0.12em)
    ][
      #caps("Total", size: 7.2pt, fill: ink, weight: 700, track: 0.12em)
    ][
      #caps("What was happening — and what came out", size: 7.2pt, fill: ink, weight: 700, track: 0.12em)
    ]
  ]
  #block(above: 0pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #set text(size: 9.6pt)
    #numrow("Aug 2021", [\$548,000], [Day one: 401(k) \$323K · IRA \$150K · cash \$75K · 65/35 — first-year withdrawal ~\$22K])
    #numrow("EOY 2021", [\$525,000], [First months of retirement, on plan])
    #numrow("Feb 2022", [≈ \$496,000], [Down ~\$52K; house bought in the high desert])
    #numrow("EOY 2022", [\$458,000], [Stocks and bonds falling together])
    #numrow("Jan 2023", [\$438,000], [The low: down \$110K; 401(k) −17% · IRA −23% · 2023 withdrawal \$0])
    #numrow("Jul 2024", [≈ \$548,000], [Back to even — day one, three years on · 2024 withdrawal \$0])
    #numrow("EOY 2024", [\$516,000], [Above water and building again])
    #numrow("EOY 2025", [\$565,000], [Budget ~\$3,000/mo; withdrawals resumed · 2025 ~\$12K (2%)])
    #numrow("Jun 2026", [\$594,000], [New high water · 2026: \$15K withdrawn in April])
    #numrow("Aug 2026", [\$595,000], [All-time high — accounts +17% and +30% from the low], last: true)
  ]
  #v(8pt)
  #block(above: 0pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #text(size: 8.6pt, fill: quiet)[
      Withdrawals in full: year one ~\$22,000 (4.2%, treated as a ceiling);
      2023 \$0; 2024 \$0; 2025 ~\$12,000 (2%); April 2026 \$15,000 — the biggest
      since the channel began.
    ]
  ]
]

// ------------------------------------------------------------
// PAGE 12 — CHAPTER FOUR (folio 12). Reading the ledger; takeaway.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Crash Year")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("Reading the Ledger")]
  #v(10pt)
  #block(above: 0pt)[
    Read that table the way I read it on camera each month: not as a stock
    chart, but as a diary. The first year and a half is a bear market with
    no permission to stop. The middle is the part nobody photographs — two
    years of round-trip, where the only job is to keep spending \$2,800 a
    month and keep reporting the same boring zeros. And the last stretch is
    compounding doing quietly what panic never does: July 2024 back to even,
    three full years after the ride started; then a new high water mark
    every few months, until August 2026 printed the number that made the
    whole story legible — \$595,000, up from \$438,000 at the bottom.

  Nothing in the right-hand column of that table is clever. It is one
  moderate maniac refusing to sell good funds at bad prices, twice a month,
  for five years. The market did the rest, the way it always does — for the
  people who let it.
  ]
  #v(10pt)
  #block(above: 26pt, below: 10pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
    #box(width: 76%)[
      #caps("The takeaway", size: 7.6pt, fill: wine, weight: 600, track: 0.26em)
      #v(6pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(9pt)
      #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
        You survive a crash with cash and a calendar — not with courage.
      ]
      #v(9pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
    ]
  ]
  #v(18pt)
  #orn
]

// ------------------------------------------------------------
// PAGE 13 — CHAPTER FIVE OPENER (folio 13).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 96pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #block(above: 0pt)[#chaphead("Chapter Five", "The Quiet Recovery")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("N")obody films a recovery. It is the one part of every market
    story with no drama in it at all: dividends land, funds drift upward, and
    one day the portfolio equals what it was before the fall. For me that day
    was July 2024 — three years after retirement day, back to even, with
    nothing clever done in between. I had not sold in the crash. I had not
    bought anything exotic in the recovery. I had simply let the boring funds
    be boring in both directions.

  There was a little housekeeping. Around 2024 I rolled the old 401(k) into
  an IRA, so today the mix is two target-date funds: the 2025 fund holding
  about two-thirds of the money, the 2035 holding the rest. Blend it and you
  get roughly 60/40 stocks to bonds — drifted, by now, to about 56/44, which
  is the market's business, not mine.
  ]
]

// ------------------------------------------------------------
// PAGE 14 — CHAPTER FIVE (folio 14). Taking money again; the
// Bengen corroboration box.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Quiet Recovery")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("Learning to Take Money Again")]
  #v(10pt)
  #block(above: 0pt)[
    The strange part of a recovery is deciding you are allowed to enjoy it.
    I took nothing in 2023. Nothing in 2024. In 2025, with the portfolio back
    over half a million and the budget nudging from \$2,800 to about \$3,000
    a month, I resumed withdrawals — about \$12,000 for the year, right
    around 2 percent. Then in April 2026 I made the biggest single move
    since the channel began: a \$15,000 withdrawal, announced on camera with
    the usual spreadsheet and a certain amount of trembling.

  That is the whole rhythm of it, five years in: withdraw what the year
  needs, skip years when the market is ugly, and treat the famous rule as a
  ceiling over the whole enterprise — never a target to hit.
  ]
  #callout("Corroborated · The man who invented 4% raised it")[The 4% rule
  came from Bill Bengen's 1994 research, and Bengen himself has since moved
  the goalposts — upward. His updated work puts the worst-case safe
  withdrawal rate for a 30-year retirement at 4.7%, and his recent book
  argues most retirees can reasonably plan around 5.25% to 5.5%. Duane's
  first-year rate — 4.2% — sat under even the old ceiling, and his five-year
  average has landed far below it. The lesson is not \u{201C}spend more.\u{201D} It is
  that the rule was always a floor-planning tool for worst cases, not a
  spending quota.]
  #block(above: 0pt)[
    Which is why a 2 percent year is not timidity. The headroom between what
    I withdraw and what the research says is survivable — that gap is the
    asset. It is what let me skip 2023 and 2024 entirely without touching a
    single share at the bottom.
  ]
]

// ------------------------------------------------------------
// PAGE 15 — CHAPTER FIVE (folio 15). The rate is a dial; takeaway.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Quiet Recovery")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("The Rate Is a Dial")]
  #v(10pt)
  #block(above: 0pt)[
    Here is the arithmetic I actually run, and it fits in one breath. Take
    your annual budget and divide it by your portfolio. That is your rate.
    Mine has run 4.2 percent, then zero, then zero, then 2 percent, then 2
    and change — a dial, not a switch. The published rule tells you the
    highest that dial should ever need to go in a normal lifetime of
    markets. Your budget tells you where it actually sits. The space between
    the two numbers is every bad market year you never have to notice.

  Moderate maniacs run this math from the other side, too: the less the
  dial needs to turn, the smaller the portfolio has to be. My \$2,800-a-month
  life — later \$3,000 — needed about \$34,000 a year from every source, and
  the portfolio only ever covered part of it. The million-dollar question
  everyone asks is really a budget question wearing a disguise. Answer the
  budget honestly — the real rent, the real fire insurance, the real
  groceries — and the portfolio number walks itself out of the division.
  ]
  #v(10pt)
  #block(above: 26pt, below: 10pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
    #box(width: 76%)[
      #caps("The takeaway", size: 7.6pt, fill: wine, weight: 600, track: 0.26em)
      #v(6pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(9pt)
      #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
        The withdrawal rate is a dial you set once a year. The gap between
        it and the ceiling is your safety.
      ]
      #v(9pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
    ]
  ]
  #v(18pt)
  #orn
]

// ------------------------------------------------------------
// PAGE 16 — CHAPTER SIX OPENER (folio 16).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #place(top + left, dx: -68pt, dy: -78pt)[
    #box(width: 432pt, height: 240pt)[
      #image("img_v3/ch2_reading.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #v(182pt)
  #block(above: 0pt)[#chaphead("Chapter Six", "The Other Income")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("I")n November 2022, from the middle of the crash, I started a
    YouTube channel. The plan, to the extent there was one: show my real
    numbers every month while the market fell, because nobody else seemed
    willing to do it. The channel was monetized within thirty days, and the
    audience that gathered — moderate maniacs, moderating each other — has
    become the second income of my retirement and, honestly, the better half
    of my social life.

  I still find that funny. I spent twenty years in the music business
  chasing plays, and the thing that finally pays me by the view is a
  spreadsheet and a bottle of retirement vodka on a desk in the high desert.
  ]
]

// ------------------------------------------------------------
// PAGE 17 — CHAPTER SIX (folio 17). What the channel actually
// pays; when the camera money fades.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Other Income")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("What the Channel Actually Pays")]
  #v(10pt)
  #block(above: 0pt)[
    Let me do what I do every month and simply read you the ledger. 2023:
    \$24,000. 2024: \$27,000. 2025: \$23,000. 2026 through May: about \$9,000,
    because the algorithm cooled off. Best month ever was November 2024,
    just under \$4,000. A typical month runs \$1,800 to \$2,250. YouTube keeps
    about 45 percent of the advertising money, which is their prerogative
    and my overhead.

  Instagram — where I am at 88,000 followers — pays nothing, literally
  zero. Facebook, at about 56,000, once paid me \$300 to \$400 on a video
  with 4.2 million views. At that exchange rate, going viral is a nice
  compliment, not a paycheck. The channel pays real money the way a good
  part-time job does: enough to matter, not enough to live on, and never
  on a schedule I control.
  ]
  #v(20pt)
  #block(above: 0pt)[#sechead("When the Camera Money Fades")]
  #v(10pt)
  #block(above: 0pt)[
    Which is the point of this chapter. There was a season when the channel
    covered about \$1,000 a month of my budget and the portfolio could rest.
    In mid-2026 the algorithm went cold and the dial came back into use —
    withdrawals now run around \$2,000 a month. Nothing about the plan
    changed. Other income rises and falls; the withdrawal dial absorbs the
    difference; the ceiling sits where it always sat. If you take one
    mechanical lesson from my five years, take that one: build the plan so
    that no single income — market, camera, or otherwise — is load-bearing.
  ]
]

// ------------------------------------------------------------
// PAGE 18 — CHAPTER SIX (folio 18). Social Security and the gap
// years; corroboration box; takeaway.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("The Other Income")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("The Gap Years")]
  #v(10pt)
  #block(above: 0pt)[
    The other income stream is the one the government owes me. My original
    plan was to claim Social Security at sixty-two; the channel income
    pushed that out, and as of this writing — sixty-four — the plan of
    record is sixty-five, with Medicare right behind it. Why wait? Because
    every year of delay adds roughly 8 percent to the check for life, and
    my own estimate runs \$2,200 to \$2,400 a month depending on the claim
    age. Between now and then, the ACA marketplace is the wild card: the
    premium rides on your income on paper, so I keep reported income low,
    and one careless withdrawal could send those premiums into the sky.
  ]
  #callout("Corroborated · The math of waiting")[The 8% figure is not a
  folk belief — it is the Social Security Administration's delayed
  retirement credit, 8% per year for anyone born 1943 or later, with full
  retirement age at 67 for those born 1960 or later. Delay from 62 to 70
  adds up to roughly 77% to the monthly check. Yet only about 20% of
  Americans claim at 62, and fewer than 10% wait until 70; average monthly
  checks run about \$1,424 at 62, \$2,016 at 67, and \$2,275 at 70.]
  #v(10pt)
  #block(above: 26pt, below: 10pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
    #box(width: 76%)[
      #caps("The takeaway", size: 7.6pt, fill: wine, weight: 600, track: 0.26em)
      #v(6pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(9pt)
      #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
        Withdrawals bridge the gap years. Social Security closes them.
      ]
      #v(9pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
    ]
  ]
  #v(18pt)
  #orn
]

// ------------------------------------------------------------
// PAGE 19 — CHAPTER SEVEN OPENER (folio 19).
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  footer: align(center)[#folio]
)[
  #place(top + left, dx: -68pt, dy: -78pt)[
    #box(width: 432pt, height: 240pt)[
      #image("img_v3/cover_sunrise.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #v(182pt)
  #block(above: 0pt)[#chaphead("Chapter Seven", "Five Years In")]
  #v(16pt)
  #block(above: 0pt)[
    #dropcap("S")o what did \$548,000 actually buy? A house in the hills of a
    town of two or three thousand people, with the million-dollar view
    thrown in for free. A budget I can recite from memory. My girlfriend of
    twenty-five years retiring around now — we trade two weeks in the high
    desert, two weeks in the city. And a calendar with almost nothing on it,
    which is the point: I am a homebody, and retirement finally made that a
    feature instead of a flaw.

  I sleep better than I have in decades. I have managed depression and
  anxiety, on and off, since I was fifteen; retirement has not cured them —
  nothing does — but this is the best mental stretch of my life. The
  little shelf above my desk holds my honey and my little buddy Bono, who
  have now supervised five years of monthly videos. We have made it to
  Hawaii and Banff, and my old boss Gene did Asia, Bali, and Russia at
  sixty-three — while, as he put it, he was still healthy enough. That
  sentence stays taped to my brain.
  ]
]

// ------------------------------------------------------------
// PAGE 20 — CHAPTER SEVEN (folio 20). The mistakes column; the
// longevity math; the close.
// ------------------------------------------------------------
#page(margin: (left: 68pt, right: 50pt, top: 78pt, bottom: 62pt), fill: paper,
  header: align(left)[#runhead("Five Years In")],
  footer: align(left)[#folio]
)[
  #block(above: 0pt)[#sechead("The Mistakes Column")]
  #v(10pt)
  #block(above: 0pt)[
    Every number in this book has a mistakes column, and it would be a con
    to leave mine out. Two months before I started the channel, I bought a
    2001 RV for about \$10,000 with hookups, planning to rent it out — and
    later found a roof hole patched over with tape. I hope to get about
    half of it back. After the 2022 crash rattled the budget, I tried the
    honest fallbacks — copywriting, part-time applications, some fifty
    feelers — and heard back from exactly nobody. Ageism at fifty-five is
    not a feeling; it is a market condition, and it is one more reason the
    channel mattered so much.

  The mistakes column is also why the longevity math matters. Mom had a
  stroke before COVID, and I spent nine months caretaking in Reno; she
  lived to ninety-one, Dad made eighty-eight, and the actuarial tables say
  a man who reaches sixty-five can expect, on average, to see eighty-four.
  One writer I read calls the stretch after sixty the twelve good years.
  So spend the good years on purpose — the money is only the calendar's
  co-author.
  And because a retirement with no projects is a hobby, not a life: I
  wrote a novel. The Monster Who Loves Me — dark comedy, light horror,
  all mine.
  ]
  #v(10pt)
  #block(above: 26pt, below: 10pt)[
    #set par(justify: false, first-line-indent: 0pt)
    #align(center)[
    #box(width: 76%)[
      #caps("The takeaway", size: 7.6pt, fill: wine, weight: 600, track: 0.26em)
      #v(6pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
      #v(9pt)
      #text(font: display, weight: 400, style: "italic", size: 14pt, fill: ink)[
        Five years in, on half a million dollars, I am a genuinely
        happy camper. We got this.
      ]
      #v(9pt)
      #line(length: 58pt, stroke: 0.8pt + wine)
    ]
    ]
  ]
  #v(18pt)
  #orn
]

// ------------------------------------------------------------
// BACK COVER. Full-bleed photo top, deep oxblood panel below:
// hook, blurb, author line, disclaimers, imprint. No ISBN, no
// invented reviews.
// ------------------------------------------------------------
#page(margin: 0pt, fill: paper)[
  #place(top + left)[
    #box(width: 432pt, height: 290pt)[
      #image("img_v3/back_bedroom.jpg", width: 100%, height: 100%, fit: "cover")
    ]
  ]
  #place(top + left, dy: 290pt)[#rect(width: 432pt, height: 358pt, fill: wine)]
  #place(top + left, dy: 306pt, dx: 46pt)[
    #box(width: 340pt)[
      #set par(justify: false, first-line-indent: 0pt, leading: 0.55em)
      #text(font: display, weight: 400, style: "italic", size: 12.5pt, fill: paper)[
        Half a million dollars. Five years. Zero catastrophes — the receipts, monthly, on camera.
      ]
      #v(9pt)
      #text(size: 9.2pt, fill: paper)[
        Duane retired at fifty-nine on \$548,000 — a 401(k), an IRA, and a cash
        bucket, built on a salary that never topped \$75,000. Since that August
        morning he has published his real balances every month: the crash that
        cut \$110,000, the two zero-withdrawal years, the slow climb to an
        all-time high, the YouTube money, the Social Security plan, and the
        \$2,800-a-month life in the high desert. This is what retirement on a
        middle-class number actually looks like, told by the one person who can
        prove every figure.
      ]
      #v(8pt)
      #align(center)[
        #text(font: display, weight: 600, size: 11pt, fill: paper, tracking: 0.28em)[DUANE]
      ]
      #v(9pt)
      #text(size: 6.8pt, fill: rgb("#E8D9BC"))[
        #set par(justify: true, first-line-indent: 0pt, leading: 0.42em)
        You Don't Need a Million Dollars to Retire is one retiree's case study.
        It is not financial advice, and nothing in it is a recommendation to
        buy or sell anything. Duane is not a licensed financial advisor. Past
        performance — his or anyone's — is no guarantee of future results.
        Every figure in this book comes from Duane's public monthly updates:
        YouTube \@retirearly500k59, Instagram \@retirearly500.
      ]
      #v(8pt)
      #align(center)[
        #line(length: 90pt, stroke: 0.6pt + rgb("#D9C8A8"))
        #v(4pt)
        #caps("ExpanPress", size: 7.5pt, fill: rgb("#E8D9BC"), weight: 600, track: 0.3em)
      ]
    ]
  ]
]
