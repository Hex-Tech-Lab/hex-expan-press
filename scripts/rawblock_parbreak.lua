-- Pandoc filter: follow every raw Typst block with an explicit #parbreak().
-- Pandoc joins a raw block and the next paragraph with a single newline; when the block ends in plain
-- text (not a #box(...)[...] call) Typst glues the next paragraph onto it (found in Ch3, 2026-09-24).
-- A parbreak between blocks is a no-op, so this only changes the broken joins.
function RawBlock(el)
  if el.format == "typst" then
    return { el, pandoc.RawBlock("typst", "#parbreak()") }
  end
end
