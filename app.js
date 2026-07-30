(function () {
  "use strict";

  var SUPABASE_URL = "https://kkqgxojxsfqgfpzdyzjv.supabase.co";
  var SUPABASE_KEY = "sb_publishable_bJn_oLoiXsa4U2wL59VpkQ_D6RYR_la";

  /* ---------- mobile menu ---------- */
  var menuBtn = document.querySelector(".menu-btn");
  var navLinks = document.querySelector(".nav-links");
  if (menuBtn && navLinks) {
    menuBtn.addEventListener("click", function () {
      var open = navLinks.classList.toggle("open");
      menuBtn.classList.toggle("open", open);
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---------- reveal on scroll ---------- */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.15 });
  document.querySelectorAll(".reveal").forEach(function (el) { io.observe(el); });

  /* ---------- waitlist modal ---------- */
  var overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="wl-title">' +
      '<button class="modal-close" type="button" aria-label="Close">&#x2715;&#xFE0E;</button>' +
      '<div class="modal-form-view">' +
        '<div class="sec-kicker">Early access</div>' +
        '<h3 id="wl-title">Be first in line when Etta starts calling.</h3>' +
        '<p class="modal-intro">Leave your email and we’ll write when it’s your turn. No spam — just a note when Etta is ready.</p>' +
        '<form novalidate>' +
          '<label class="field"><span>Your name <em>(optional)</em></span>' +
            '<input type="text" name="name" autocomplete="name" maxlength="120" placeholder="Jane Doe"></label>' +
          '<label class="field"><span>Email</span>' +
            '<input type="email" name="email" required autocomplete="email" maxlength="200" placeholder="you@example.com"></label>' +
          '<label class="field"><span>Tell us about your mom or dad <em>(optional)</em></span>' +
            '<textarea name="note" rows="3" maxlength="2000" placeholder="Mom is 82, lives alone, loves her garden…"></textarea></label>' +
          '<div class="hp-field" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>' +
          '<button class="btn" type="submit">Join the waitlist</button>' +
          '<p class="form-msg" role="status"></p>' +
        '</form>' +
      '</div>' +
      '<div class="modal-success" hidden>' +
        '<div class="success-mark">&#x2713;&#xFE0E;</div>' +
        '<h3 class="success-title">You’re on the list.</h3>' +
        '<p class="success-text"></p>' +
        '<button class="btn ghost modal-done" type="button">Done</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var modal = overlay.querySelector(".modal");
  var formView = overlay.querySelector(".modal-form-view");
  var successView = overlay.querySelector(".modal-success");
  var form = overlay.querySelector("form");
  var msg = overlay.querySelector(".form-msg");
  var submitBtn = form.querySelector('button[type="submit"]');
  var lastTrigger = null;

  function openModal(trigger) {
    lastTrigger = trigger || null;
    overlay.classList.add("open");
    document.body.classList.add("modal-open");
    window.setTimeout(function () {
      var email = form.elements.email;
      if (!successView.hidden || !email) return;
      email.focus();
    }, 250);
  }

  function closeModal() {
    overlay.classList.remove("open");
    document.body.classList.remove("modal-open");
    if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
    lastTrigger = null;
  }

  function showSuccess(text) {
    formView.hidden = true;
    successView.hidden = false;
    successView.querySelector(".success-text").textContent = text;
  }

  document.addEventListener("click", function (e) {
    var trigger = e.target.closest("[data-waitlist]");
    if (trigger) {
      e.preventDefault();
      openModal(trigger);
    }
  });
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector(".modal-close").addEventListener("click", closeModal);
  overlay.querySelector(".modal-done").addEventListener("click", closeModal);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && overlay.classList.contains("open")) closeModal();
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    msg.textContent = "";
    msg.classList.remove("error");

    var name = form.elements.name.value.trim();
    var email = form.elements.email.value.trim();
    var note = form.elements.note.value.trim();

    // Honeypot: bots fill the hidden field — pretend it worked.
    if (form.elements.website.value) {
      showSuccess("Thank you — we’ll write to " + email + " when it’s your turn.");
      return;
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      msg.textContent = "Please enter a valid email address.";
      msg.classList.add("error");
      form.elements.email.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Adding you…";

    fetch(SUPABASE_URL + "/rest/v1/waitlist_signups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        name: name || null,
        email: email,
        note: note || null
      })
    }).then(function (res) {
      if (res.status === 201) {
        showSuccess("Thank you — we’ll write to " + email + " when it’s your turn. We read everything, including replies.");
        form.reset();
      } else if (res.status === 409) {
        successView.querySelector(".success-title").textContent = "You’re already on the list.";
        showSuccess(email + " is already signed up — nothing more to do. We’ll be in touch.");
        form.reset();
      } else {
        throw new Error("Unexpected status " + res.status);
      }
    }).catch(function () {
      msg.textContent = "Something went wrong — please try again, or email hello@ettacalls.com.";
      msg.classList.add("error");
    }).finally(function () {
      submitBtn.disabled = false;
      submitBtn.textContent = "Join the waitlist";
    });
  });
})();
