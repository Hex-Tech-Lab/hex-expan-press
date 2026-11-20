(function () {
  var links = document.querySelectorAll('a[data-books-link]');
  if (!links.length) return;
  // On the pay host, /books is 404, so links stay on the absolute main-host URL.
  // On main/www/local/preview hosts, use the same-origin /books path with no referrer loop.
  if (location.hostname !== 'pay.expanpress.com') {
    links.forEach(function (a) {
      a.setAttribute('href', '/books');
    });
  }
})();
