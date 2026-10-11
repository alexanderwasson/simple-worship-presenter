/* Simple Worship Presenter — public website helper.
   Keeps the application URL configurable in one place so the static site can be
   deployed to any host without editing every page. */
(function () {
  'use strict';

  // Override this on a page (before site.js loads) to point somewhere else.
  var DEFAULT_APP_URL = 'https://app.simpleworshippresenter.com';

  // When the site is previewed from the application server (localhost), follow
  // the app on the same origin instead of the production domain.
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  var appUrl = window.SWP_APP_URL || (local ? '/' : DEFAULT_APP_URL);

  function apply() {
    document.querySelectorAll('[data-app-link]').forEach(function (a) {
      a.setAttribute('href', appUrl);
    });
    document.querySelectorAll('[data-site-year]').forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
