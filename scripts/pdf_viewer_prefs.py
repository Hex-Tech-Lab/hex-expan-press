"""Open the book as printed spreads: two-page view with the cover alone (odd pages on the right),
fit the window, show the document title. Usage: pdf_viewer_prefs.py in.pdf (in place)."""
import sys
import pikepdf

pdf = pikepdf.open(sys.argv[1], allow_overwriting_input=True)
pdf.Root.PageLayout = pikepdf.Name.TwoPageRight
pdf.Root.PageMode = pikepdf.Name.UseNone
pdf.Root.ViewerPreferences = pikepdf.Dictionary(DisplayDocTitle=True, FitWindow=True)
pdf.save(sys.argv[1])
print("viewer prefs: TwoPageRight (cover alone, true spreads)")
