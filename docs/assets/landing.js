/* Landing-page only. The documentation pages load docs.js and nothing else. */

(function () {
  'use strict';

  var host = document.querySelector('[data-typed]');
  if (!host) return;

  var textEl = host.querySelector('.typed-text');
  var caret = host.querySelector('.caret');
  if (!textEl) return;

  /* Groups are separated by "|", and a group may hold several audiences joined
     by commas — "startups, MVPs". Grouping keeps the number of switches low:
     a line that swaps every couple of seconds pulls the eye back off the rest
     of the page, so two groups say more than five single words would. */
  var groups = host
    .getAttribute('data-typed')
    .split('|')
    .map(function (group) {
      return group.trim();
    })
    .filter(Boolean);

  if (groups.length < 2) return;

  /* Someone who has asked for no motion keeps the group the HTML shipped with.
     That text is real, not a placeholder, so the headline reads correctly with
     no JavaScript at all — this only ever takes over. */
  var still = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (still.matches) return;

  /* Deleting is quicker than typing, the way it is when a person does it.
     Equal speeds in both directions is the tell of a canned effect. */
  var TYPE = 55;
  var DELETE = 24;
  var COMMA = 260; // a beat after each comma, so the list reads as a list
  var HOLD = 2400; // long enough to read the group once, not to wait on it
  var GAP = 340; // before the next one starts

  var index = 0;
  var chars = groups[0].length; // the HTML already shows the first group
  var deleting = false;
  var timer = null;

  function blink(on) {
    if (caret) caret.classList.toggle('blinking', on);
  }

  function step() {
    var group = groups[index];

    if (!deleting && chars === group.length) {
      // Finished typing: hold it, blinking, then start removing it.
      deleting = true;
      blink(true);
      return schedule(HOLD);
    }

    if (deleting && chars === 0) {
      // Empty: move to the next group and start typing again.
      deleting = false;
      index = (index + 1) % groups.length;
      blink(true);
      return schedule(GAP);
    }

    chars += deleting ? -1 : 1;
    textEl.textContent = groups[index].slice(0, chars);
    blink(false);

    if (deleting) return schedule(DELETE);

    /* Pause on the character after a comma, so the beat lands in the gap
       between items. Without it a comma-separated group types as one long
       run of text and stops reading as a list at all. */
    var justPassedComma = group.charAt(chars - 1) === ',';
    schedule(justPassedComma ? COMMA : TYPE);
  }

  function schedule(delay) {
    timer = window.setTimeout(step, delay);
  }

  /* A background tab does not animate; without this some browsers replay the
     backlog in one burst when you return to it. */
  document.addEventListener('visibilitychange', function () {
    window.clearTimeout(timer);
    if (!document.hidden) schedule(GAP);
  });

  blink(true);
  schedule(HOLD);
})();
