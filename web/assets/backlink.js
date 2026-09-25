(function () {
  var links = document.querySelectorAll('a.back[data-backlink]');
  if (!links.length) return;
  var ref = document.referrer;
  var target = null;
  if (ref) {
    try {
      var u = new URL(ref);
      if (u.origin === location.origin && u.href !== location.href) target = u.href;
    } catch (e) {}
  }
  if (target) {
    links.forEach(function (a) {
      a.setAttribute('href', target);
      a.textContent = '\u2190 Back';
    });
  }
})();
