/* ==========================================================================
   Heritage Housing Projects — progressive enhancement
   Vanilla JS, no dependencies.

   Design rule: every page is fully readable and navigable with this file
   absent or blocked. Nothing here creates content that isn't already in the
   HTML — this script only adds behaviour.

   Security note: this file never uses innerHTML. All dynamic text goes
   through textContent, so no value can ever be interpreted as markup.
   ========================================================================== */
(function () {
  "use strict";

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* Double-submit CSRF token. The server sets a readable `csrf` cookie; we
     echo it back in a header, and the server requires the two to match. An
     attacker on another origin can cause the cookie to be *sent* but cannot
     read it, so they cannot forge the header. */
  function csrfToken() {
    var match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function postForm(url, data) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": csrfToken() },
      credentials: "same-origin",
      body: new URLSearchParams(data).toString()
    });
  }

  /* ── Mobile navigation ──────────────────────────────────────────────── */
  function initNav() {
    var toggle = $(".menu-toggle");
    var nav = $("#mainNav");
    if (!toggle || !nav) return;

    function setOpen(open) {
      nav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    setOpen(false);

    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("open"));
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) {
        setOpen(false);
        toggle.focus();
      }
    });

    // Close when focus or a click leaves the header.
    document.addEventListener("click", function (e) {
      if (!nav.classList.contains("open")) return;
      if (!nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });

    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });

    // Reset when returning to the desktop layout.
    if (window.matchMedia) {
      var mq = window.matchMedia("(min-width: 901px)");
      var onChange = function (e) { if (e.matches) setOpen(false); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ── Toast ──────────────────────────────────────────────────────────── */
  var toastTimer = null;

  function toast(message, kind) {
    var el = $("#toast");
    if (!el) return;
    // Clear the previous timer, otherwise a queued hide would cut this
    // message short. This was a defect in the original toast().
    if (toastTimer) window.clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.toggle("toast-error", kind === "error");
    el.classList.add("show");
    toastTimer = window.setTimeout(function () {
      el.classList.remove("show");
      toastTimer = null;
    }, 3200);
  }
  window.toast = toast;

  /* ── Footer year ────────────────────────────────────────────────────── */
  function initYear() {
    $$("[data-year]").forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  /* ── Property filtering (progressive enhancement) ───────────────────── */
  function initFilters() {
    var grid = $("#propertyGrid");
    if (!grid) return;

    var selects = {
      project: $("#projectFilter"),
      type: $("#typeFilter"),
      size: $("#sizeFilter")
    };
    if (!selects.project || !selects.type || !selects.size) return;

    var cards = $$(".property-card", grid);
    var status = $("#filterStatus");

    // The filter bar is useless without JS, so reveal it now.
    var bar = $("#filterBar");
    if (bar) bar.hidden = false;

    function apply() {
      var p = selects.project.value;
      var t = selects.type.value;
      var s = selects.size.value;
      var shown = 0;

      cards.forEach(function (card) {
        var match =
          (p === "all" || card.dataset.project === p) &&
          (t === "all" || card.dataset.type === t) &&
          (s === "all" || card.dataset.size === s);
        card.hidden = !match;
        if (match) shown++;
      });

      if (status) {
        status.textContent = shown === 0
          ? "No properties match these filters."
          : shown + (shown === 1 ? " property" : " properties") + " shown.";
      }
    }

    Object.keys(selects).forEach(function (k) { selects[k].addEventListener("change", apply); });
    apply();
  }

  /* ── Enquiry form ───────────────────────────────────────────────────── */
  function initContactForm() {
    var form = $("#enquiryForm");
    if (!form) return;

    var status = $("#formStatus");
    var fileMode = window.location.protocol === "file:";

    function setError(name, message) {
      var slot = form.querySelector('[data-error-for="' + name + '"]');
      var input = form.elements[name];
      if (slot) slot.textContent = message || "";
      if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
    }

    function validate() {
      var ok = true;
      var name = form.elements.name.value.trim();
      var phone = form.elements.phone.value.trim();
      var message = form.elements.message.value.trim();

      setError("name", ""); setError("phone", ""); setError("message", "");

      if (name.length < 2) { setError("name", "Please enter your name."); ok = false; }
      if (phone.length < 6) { setError("phone", "Please enter a phone number or WhatsApp contact."); ok = false; }
      if (message.length < 10) { setError("message", "Please add a little more detail (10+ characters)."); ok = false; }
      return ok;
    }

    form.addEventListener("submit", function (e) {
      if (!validate()) {
        e.preventDefault();
        if (status) { status.textContent = "Please correct the highlighted fields."; status.className = "notice error"; }
        var firstBad = form.querySelector('[aria-invalid="true"]');
        if (firstBad) firstBad.focus();
        return;
      }

      // Without a server there is nowhere to POST, so hand off to email
      // instead of silently pretending the enquiry was captured.
      if (fileMode) {
        e.preventDefault();
        var body = "Name: " + form.elements.name.value +
                   "\nPhone: " + form.elements.phone.value +
                   "\nInterested in: " + form.elements.interest.value +
                   "\n\n" + form.elements.message.value;
        window.location.href = "mailto:heritagehousingp@gmail.com" +
          "?subject=" + encodeURIComponent("Website enquiry") +
          "&body=" + encodeURIComponent(body);
        return;
      }
      // Served by the backend: let the normal POST proceed.
    });

    // Live-correct a field once it has already complained.
    ["name", "phone", "message"].forEach(function (n) {
      var input = form.elements[n];
      if (!input) return;
      input.addEventListener("blur", validate);
      input.addEventListener("input", function () {
        if (input.getAttribute("aria-invalid") === "true") validate();
      });
    });

    // Server-rendered result of a non-JS POST.
    var params = new URLSearchParams(window.location.search);
    if (params.get("sent") === "1" && status) {
      status.textContent = "Thank you — your enquiry has been received. We will be in touch shortly.";
      status.className = "notice success";
    }
  }

  /* ── Prefill enquiry from a property card ───────────────────────────── */
  function initPrefill() {
    $$("[data-enquire]").forEach(function (link) {
      link.addEventListener("click", function () {
        var message = $("[name=message]");
        if (!message || message.value.trim()) return;
        message.value = "I would like to enquire about " + link.dataset.enquire + ".";
      });
    });
  }

  /* ── Portal login page ──────────────────────────────────────────────── */
  function initPortalLogin() {
    var form = $("#loginForm");
    if (!form) return;

    var status = $("#loginStatus");
    var fileMode = window.location.protocol === "file:";

    if (fileMode && status) {
      status.textContent =
        "The client portal requires the application server. Start it with " +
        "\u201Cnpm start\u201D (or \u201Cnode server/index.js\u201D) and open " +
        "portal.html on that server.";
      status.className = "notice info";
      form.querySelector("button[type=submit]").disabled = true;
      return;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("button[type=submit]");
      var clientNumber = form.elements.clientNumber.value.trim();
      var password = form.elements.password.value;

      if (status) { status.textContent = ""; status.className = "notice"; }
      btn.disabled = true;
      btn.textContent = "Signing in…";

      postForm("/api/auth/login", { clientNumber: clientNumber, password: password })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (res) {
          if (res.ok) {
            window.location.href = "/dashboard";
            return;
          }
          if (status) {
            status.textContent = res.body.error || "Sign-in failed.";
            status.className = "notice error";
          }
          form.elements.password.value = "";
        })
        .catch(function () {
          if (status) {
            status.textContent = "Could not reach the server. Please try again.";
            status.className = "notice error";
          }
        })
        .then(function () {
          btn.disabled = false;
          btn.textContent = "Sign in";
        });
    });
  }

  /* ── Dashboard: sign out + document actions ─────────────────────────── */
  function initDashboard() {
    var out = $("#signOut");
    if (out) {
      out.addEventListener("click", function (e) {
        e.preventDefault();
        postForm("/api/auth/logout", {})
          .then(function () { window.location.href = "/portal.html"; });
      });
    }
  }

  /* ── Destructive actions ────────────────────────────────────────────────
     A confirmation cannot be attached with an inline onsubmit attribute.
     The site sends script-src 'self', which drops inline event handlers
     without any error or console message, so the prompt never appeared and
     every delete went through on the first click. The wording lives in a
     data-confirm attribute instead, and this attaches the behaviour. */
  function initConfirms() {
    document.addEventListener("submit", function (e) {
      var form = e.target;
      if (!form || typeof form.getAttribute !== "function") return;

      var message = form.getAttribute("data-confirm");
      if (!message) return;

      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  /* ── Boot ───────────────────────────────────────────────────────────── */
  function boot() {
    initNav();
    initYear();
    initFilters();
    initContactForm();
    initPrefill();
    initPortalLogin();
    initDashboard();
    initConfirms();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
