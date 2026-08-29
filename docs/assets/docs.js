/* Theme, mobile nav, heading anchors, copy buttons and search.
   No dependencies — this file is the whole of the site's JavaScript. */

(function () {
  'use strict';

  var root = document.documentElement;
  var atRoot = !/\/(guide|reference)\//.test(location.pathname);
  var base = atRoot ? '' : '../';

  // --- theme ---------------------------------------------------------------
  var KEY = 'psk-theme';
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);
  } catch (e) {
    /* blocked storage — the media query still handles it */
  }

  function currentTheme() {
    return (
      root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    );
  }

  // --- copy buttons on every code block ------------------------------------
  document.querySelectorAll('pre.code-block').forEach(function (pre) {
    if (pre.querySelector('.copy-btn')) return;
    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'copy';
    btn.setAttribute('aria-label', 'Copy code');
    pre.appendChild(btn);
  });

  // --- heading anchors -----------------------------------------------------
  document.querySelectorAll('.content h2[id], .content h3[id]').forEach(function (h) {
    var a = document.createElement('a');
    a.className = 'anchor';
    a.href = '#' + h.id;
    a.textContent = '#';
    a.setAttribute('aria-label', 'Link to this section');
    h.appendChild(a);
  });

  // --- current page in the sidebar ----------------------------------------
  var here = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.sidebar a').forEach(function (link) {
    var target = link.getAttribute('href').split('/').pop().split('#')[0];
    if (target !== here) return;

    link.setAttribute('aria-current', 'page');

    // Open every <details> above it, so a page inside a submenu is not hidden
    // behind a closed group when you land on it.
    var group = link.closest('details');
    while (group) {
      group.open = true;
      group = group.parentElement && group.parentElement.closest('details');
    }
  });

  // --- search --------------------------------------------------------------
  var index = null;
  var indexPromise = null;

  function buildSearchUI() {
    if (document.getElementById('psk-search')) return document.getElementById('psk-search');

    var wrap = document.createElement('div');
    wrap.id = 'psk-search';
    wrap.className = 'search-overlay';
    wrap.innerHTML =
      '<div class="search-panel" role="dialog" aria-label="Search documentation">' +
      '<input type="search" class="search-input" placeholder="Search the documentation…" ' +
      'autocomplete="off" spellcheck="false" aria-label="Search">' +
      '<div class="search-results" role="listbox"></div>' +
      '<div class="search-hint"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>enter</kbd> to open · <kbd>esc</kbd> to close</div>' +
      '</div>';
    document.body.appendChild(wrap);
    return wrap;
  }

  /**
   * Load the search index, once, on first use.
   *
   * A <script> tag rather than `fetch`, because browsers block `fetch` on
   * file:// — the origin is opaque, so it fails CORS before it starts. People
   * do open documentation by double-clicking an HTML file, and "serve it over
   * HTTP first" is exactly the kind of hidden step this site should not have.
   * A script tag works from the filesystem and over HTTP alike.
   *
   * The promise is cached rather than a boolean flag: two callers arriving
   * while it is still loading now both wait for the same load, instead of the
   * second one getting `undefined` back immediately.
   */
  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (indexPromise) return indexPromise;

    indexPromise = new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = base + 'assets/search-index.js';
      script.onload = function () {
        index = window.PSK_SEARCH_INDEX || null;
        resolve(index);
      };
      script.onerror = function () {
        indexPromise = null; // let a later attempt retry
        resolve(null);
      };
      document.head.appendChild(script);
    });

    return indexPromise;
  }

  /**
   * Rank one index entry against the search terms.
   *
   * Three fields, three different meanings, so they cannot be scored as one
   * blob of text:
   *
   *   s  the SECTION heading  — what this specific entry is about
   *   t  the PAGE title       — what the page is about
   *   x  the surrounding text — only evidence the words appear somewhere
   *
   * Scoring them together was the bug: searching "transactions" did not return
   * the page called Transactions in the top three, because the title counted
   * for no more than a passing mention in someone else's paragraph.
   *
   * Every term must appear somewhere in the entry, so the terms are ANDed.
   */
  function score(entry, terms) {
    var heading = (entry.s || '').toLowerCase();
    var title = (entry.t || '').toLowerCase();
    var text = (entry.x || '').toLowerCase();
    var total = 0;

    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      var inHeading = heading.indexOf(term);
      var inTitle = title.indexOf(term);
      var inText = text.indexOf(term);

      if (inHeading === -1 && inTitle === -1 && inText === -1) return 0;

      if (inHeading !== -1) total += 10;
      if (inTitle !== -1) total += 6;
      if (inText !== -1) total += 1;

      // Matching at the start of a name beats matching in the middle of one.
      if (inHeading === 0) total += 4;
      if (inTitle === 0) total += 2;
    }

    // An entry with no heading IS the page. When the page itself is the answer,
    // that is a better landing place than one of its subsections.
    if (!entry.s) total += 3;

    return total;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c];
    });
  }

  function render(results, box) {
    if (!results.length) {
      box.innerHTML = '<p class="search-empty">Nothing found.</p>';
      return;
    }
    box.innerHTML = results
      .map(function (r, i) {
        // Every field is escaped, the URL included. The index is built from our
        // own filenames so nothing here is attacker-supplied today — but an
        // unescaped value inside an attribute is the kind of thing that stops
        // being true quietly, and escaping costs nothing.
        return (
          '<a class="search-hit' + (i === 0 ? ' active' : '') +
          '" href="' + escapeHtml(base + r.u) + '">' +
          '<span class="search-hit-title">' + escapeHtml(r.s || r.t) + '</span>' +
          '<span class="search-hit-page">' + escapeHtml(r.t) + '</span>' +
          '<span class="search-hit-text">' + escapeHtml(r.x) + '</span>' +
          '</a>'
        );
      })
      .join('');
  }

  function openSearch() {
    var wrap = buildSearchUI();
    wrap.classList.add('open');
    var input = wrap.querySelector('.search-input');
    var box = wrap.querySelector('.search-results');
    input.value = '';
    box.innerHTML = '';
    input.focus();

    loadIndex().then(function (data) {
      if (!data) box.innerHTML = '<p class="search-empty">Search is unavailable offline.</p>';
    });
  }

  function closeSearch() {
    var wrap = document.getElementById('psk-search');
    if (wrap) wrap.classList.remove('open');
  }

  function moveSelection(dir) {
    var hits = [].slice.call(document.querySelectorAll('.search-hit'));
    if (!hits.length) return;
    var i = hits.findIndex(function (h) { return h.classList.contains('active'); });
    hits.forEach(function (h) { h.classList.remove('active'); });
    var next = (i + dir + hits.length) % hits.length;
    hits[next].classList.add('active');
    hits[next].scrollIntoView({block: 'nearest'});
  }

  // --- one delegated click handler ----------------------------------------
  document.addEventListener('click', function (event) {
    var themeBtn = event.target.closest('[data-theme-toggle]');
    if (themeBtn) {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
      return;
    }

    if (event.target.closest('[data-search-open]')) { openSearch(); return; }

    var overlay = event.target.closest('.search-overlay');
    if (overlay && !event.target.closest('.search-panel')) { closeSearch(); return; }

    var copy = event.target.closest('.copy-btn, [data-copy]');
    if (copy) {
      var text = copy.getAttribute('data-copy');
      if (text === null || text === '') {
        var pre = copy.closest('pre.code-block') || copy.closest('.code-block');
        var code = pre && pre.querySelector('code');
        text = code ? code.textContent : '';
      }
      if (text && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          var was = copy.textContent;
          copy.textContent = 'copied';
          setTimeout(function () { copy.textContent = was; }, 1400);
        }, function () { /* ignore */ });
      }
      return;
    }

    var menu = event.target.closest('[data-menu-toggle]');
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    if (menu) {
      sidebar.classList.toggle('open');
      menu.setAttribute('aria-expanded', sidebar.classList.contains('open'));
    } else if (event.target.closest('.sidebar a')) {
      sidebar.classList.remove('open');
    } else if (sidebar.classList.contains('open') && !event.target.closest('.sidebar')) {
      sidebar.classList.remove('open');
    }
  });

  // --- typing in the search box -------------------------------------------
  document.addEventListener('input', function (event) {
    if (!event.target.classList.contains('search-input')) return;
    var box = document.querySelector('.search-results');
    var terms = event.target.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || !index) { box.innerHTML = ''; return; }

    var results = index
      .map(function (e) { return {e: e, n: score(e, terms)}; })
      .filter(function (r) { return r.n > 0; })
      .sort(function (a, b) { return b.n - a.n; })
      .slice(0, 12)
      .map(function (r) { return r.e; });

    render(results, box);
  });

  // --- keyboard ------------------------------------------------------------
  document.addEventListener('keydown', function (event) {
    var open = document.getElementById('psk-search');
    var isOpen = open && open.classList.contains('open');

    // "/" or ctrl/cmd-K opens search, unless you are typing somewhere
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!isOpen && ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key === 'k'))) {
      event.preventDefault();
      openSearch();
      return;
    }
    if (!isOpen) return;

    if (event.key === 'Escape') { closeSearch(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); return; }
    if (event.key === 'Enter') {
      var active = document.querySelector('.search-hit.active');
      if (active) { event.preventDefault(); location.href = active.getAttribute('href'); }
    }
  });
})();
