/* Daily Activity Log — rich text editor.
 *
 * Hand-rolled rather than Quill from a CDN. The site sends `script-src 'self'`
 * with no CDN in the allowlist, so a third-party script tag would be dropped by
 * the browser without any error at all — the page would simply show a dead
 * editor. Loading from 'self' keeps the policy intact.
 *
 * The toolbar drives the browser's own editing commands. They are deprecated in
 * spec but still implemented everywhere, and for six formatting options they
 * are far less code than a maintained editor bundle.
 *
 * What matters for safety: this runs in the agent's own browser, and the server
 * sanitises whatever arrives. Nothing here is trusted.
 */
(function () {
  'use strict';

  function boot() {
    var editor = document.getElementById('richEditor');
    if (!editor) return;

    var input = document.getElementById('logText');
    var form = editor.closest('form');
    var toolbar = document.querySelector('.rt-toolbar');

    /* The form posts the hidden field, not the editable div. */
    function sync() {
      if (input) input.value = editor.innerHTML;
    }

    if (toolbar) {
      toolbar.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-cmd]');
        if (!button) return;
        event.preventDefault();

        var cmd = button.getAttribute('data-cmd');
        var arg = button.getAttribute('data-arg');

        editor.focus();
        try {
          document.execCommand(cmd, false, arg || null);
        } catch (err) {
          /* An unsupported command is not worth breaking the page over. */
        }
        sync();
      });
    }

    editor.addEventListener('input', sync);
    editor.addEventListener('blur', sync);
    editor.addEventListener('paste', function () {
      /* Let the paste happen, then strip the formatting it brought with it.
         Pasting from Word otherwise drags in fonts, colours and spans that the
         server would strip anyway — doing it here keeps what you see and what
         gets saved the same. */
      window.setTimeout(function () {
        editor.textContent = editor.textContent;
        sync();
      }, 0);
    });

    /* Belt and braces: the click handler syncs, but a form submitted by pressing
       Enter inside the editor would otherwise carry the previous value. */
    if (form) form.addEventListener('submit', sync);

    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
