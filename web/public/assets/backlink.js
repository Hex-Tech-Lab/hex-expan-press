(function () {
  var links = document.querySelectorAll('a.back[data-backlink]');
  if (!links.length) return;
  var ref = document.referrer;
  var target = null;
  if (ref) {
    try {
      var u = new URL(ref);
      // Buyer pages (/books/*) only. Any other same-origin referrer would link a buyer into the B2B site.
      var inBooks = u.pathname === '/books' || u.pathname.indexOf('/books/') === 0;
      if (u.origin === location.origin && inBooks && u.href !== location.href) target = u.href;
    } catch (e) {}
  }
  if (target) {
    links.forEach(function (a) {
      a.setAttribute('href', target);
      a.textContent = '\u2190 Back to the books';
    });
  }
})();
