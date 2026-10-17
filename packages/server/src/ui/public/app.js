// blindkey admin UI behaviour. Loaded with `defer` after htmx; every handler is delegated from
// `document`, so markup swapped in by htmx (reveal partial, preview) needs no re-binding.
// The CSP forbids inline scripts, handlers and style attributes: all behaviour lives here.
(function () {
  'use strict';

  // The flash for ?done=... is rendered server-side (it must survive a no-JS request), so this
  // only cleans the URL afterwards: without it, reloading or navigating back would re-show the
  // same flash forever. Only the `done` param is removed; every other query param and the hash
  // are preserved.
  (function stripDoneParam() {
    var params = new URLSearchParams(location.search);
    if (!params.has('done')) return;
    params.delete('done');
    var qs = params.toString();
    var url = location.pathname + (qs ? '?' + qs : '') + location.hash;
    history.replaceState(history.state, '', url);
  })();

  var timers = new WeakMap();

  function flashCopied(btn) {
    var original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(function () { btn.textContent = original; }, 1500);
  }

  function copyText(text, btn) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () { flashCopied(btn); });
  }

  function stopTimer(row) {
    var timerEl = row.querySelector('.timer[data-seconds]');
    if (timerEl && timers.has(timerEl)) {
      clearInterval(timers.get(timerEl));
      timers.delete(timerEl);
    }
  }

  // Re-masks a revealed row. Revealing again is a new audited request. The field key never
  // flows through string-built HTML: the template is found with CSS.escape.
  function hideField(btn) {
    var row = btn.closest('.kv-row');
    if (!row) return;
    stopTimer(row);
    var key = row.getAttribute('data-field-row') || '';
    var tmpl = document.querySelector('template[data-masked-row="' + CSS.escape(key) + '"]');
    if (tmpl && tmpl.content.firstElementChild) {
      var clone = tmpl.content.firstElementChild.cloneNode(true);
      row.replaceWith(clone);
      // A clone from a <template> was never processed by htmx; without this the restored
      // Reveal form would do a full-page POST instead of swapping the row.
      if (window.htmx && typeof window.htmx.process === 'function') window.htmx.process(clone);
    } else {
      row.remove();
    }
  }

  function startTimers(root) {
    root.querySelectorAll('.timer[data-seconds]').forEach(function (el) {
      if (timers.has(el)) return;
      var row = el.closest('.kv-row');
      var seconds = parseInt(el.getAttribute('data-seconds'), 10) || 0;
      var id = setInterval(function () {
        seconds -= 1;
        if (seconds <= 0) {
          clearInterval(id);
          timers.delete(el);
          var hideBtn = row ? row.querySelector('[data-action="hide-field"]') : null;
          if (hideBtn) hideField(hideBtn);
        } else {
          el.textContent = 'hides in ' + seconds + ' s';
        }
      }, 1000);
      timers.set(el, id);
    });
  }

  function lockLabel(btn, locked) {
    btn.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-lock"/></svg> ' + (locked ? 'Locked' : 'Visible');
  }

  function toggleLock(btn) {
    var card = btn.closest('.field-card');
    if (!card) return;
    var hidden = card.querySelector('input[name="sensitive"]');
    var locked = hidden.value !== '1';
    hidden.value = locked ? '1' : '0';
    btn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    card.classList.toggle('is-locked', locked);
    lockLabel(btn, locked);
  }

  function hintKeys() {
    var rows = document.getElementById('rows');
    try {
      var parsed = JSON.parse((rows && rows.getAttribute('data-hint-keys')) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function smallButton(action, label, text) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn sm ghost';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('data-action', action);
    b.textContent = text;
    return b;
  }

  // Keys are set via .value, never concatenated into HTML.
  function addRow(key) {
    var rows = document.getElementById('rows');
    if (!rows) return;
    var locked = hintKeys().indexOf(key) === -1;

    var card = document.createElement('div');
    card.className = 'field-card' + (locked ? ' is-locked' : '');

    var keyInput = document.createElement('input');
    keyInput.name = 'key';
    keyInput.value = key;
    keyInput.placeholder = 'password';
    keyInput.setAttribute('aria-label', 'Key');
    card.appendChild(keyInput);

    var valueArea = document.createElement('textarea');
    valueArea.name = 'value';
    valueArea.rows = 1;
    valueArea.spellcheck = false;
    valueArea.setAttribute('aria-label', 'Value');
    card.appendChild(valueArea);

    var controls = document.createElement('div');
    controls.className = 'field-controls';

    var lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'btn sm lock-toggle';
    lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    lockBtn.setAttribute('data-action', 'toggle-lock');
    lockLabel(lockBtn, locked);
    controls.appendChild(lockBtn);

    var sensitiveInput = document.createElement('input');
    sensitiveInput.type = 'hidden';
    sensitiveInput.name = 'sensitive';
    sensitiveInput.value = locked ? '1' : '0';
    controls.appendChild(sensitiveInput);

    var rowButtons = document.createElement('div');
    rowButtons.className = 'row-buttons';
    rowButtons.appendChild(smallButton('move-up', 'Move up', '↑'));
    rowButtons.appendChild(smallButton('move-down', 'Move down', '↓'));
    rowButtons.appendChild(smallButton('remove-row', 'Remove', '✕'));
    controls.appendChild(rowButtons);

    card.appendChild(controls);
    rows.appendChild(card);
  }

  // Rows are submitted positionally, so moving the .field-card is all a reorder needs.
  function moveRow(btn, dir) {
    var card = btn.closest('.field-card');
    if (!card) return;
    var sibling = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (!sibling) return;
    if (dir < 0) card.parentNode.insertBefore(card, sibling);
    else card.parentNode.insertBefore(sibling, card);
    btn.focus();
  }

  var actions = {
    'copy-field': function (btn) {
      var row = btn.closest('.kv-row');
      var valueEl = row ? row.querySelector('.field-value') : null;
      if (valueEl) copyText(valueEl.textContent, btn);
    },
    'hide-field': hideField,
    'copy-new-token': function (btn) {
      var el = document.getElementById('new-token-value');
      if (el) copyText(el.textContent, btn);
    },
    'copy-text': function (btn) {
      var el = document.getElementById(btn.getAttribute('data-copy-target') || '');
      if (!el) return;
      // A list (the recovery codes) copies one item per line; anything else copies its text.
      var text = el.tagName === 'OL' || el.tagName === 'UL'
        ? Array.prototype.map.call(el.querySelectorAll('li'), function (li) { return li.textContent.trim(); }).join('\n')
        : el.textContent;
      copyText(text, btn);
    },
    'toggle-lock': toggleLock,
    'move-up': function (btn) { moveRow(btn, -1); },
    'move-down': function (btn) { moveRow(btn, 1); },
    'remove-row': function (btn) {
      var card = btn.closest('.field-card');
      if (card) card.remove();
    },
    'add-row': function (btn) { addRow(btn.getAttribute('data-key') || ''); }
  };

  document.addEventListener('click', function (e) {
    var target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    var opener = target.closest('[data-open-dialog]');
    if (opener) {
      var dlg = document.getElementById(opener.getAttribute('data-open-dialog') || '');
      if (dlg && !dlg.open) dlg.showModal();
      return;
    }
    var closer = target.closest('[data-close-dialog]');
    if (closer) {
      var parent = closer.closest('dialog');
      if (parent) parent.close();
      return;
    }
    var el = target.closest('[data-action]');
    if (!el) return;
    var fn = actions[el.getAttribute('data-action') || ''];
    if (fn) fn(el);
  });

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('dialog[data-open-on-load]').forEach(function (d) {
      if (!d.open) d.showModal();
    });
    startTimers(document);
    // A page waiting on something outside the browser (an agent picking up its approved token)
    // reloads itself until that shows up; an open dialog pauses it so a form is never lost.
    var auto = document.querySelector('[data-auto-refresh]');
    if (auto) {
      var secs = Number(auto.getAttribute('data-auto-refresh')) || 3;
      setTimeout(function tick() {
        if (document.querySelector('dialog[open]')) { setTimeout(tick, secs * 1000); return; }
        window.location.replace(window.location.pathname);
      }, secs * 1000);
    }
  });

  document.addEventListener('htmx:afterSwap', function () { startTimers(document); });
})();
