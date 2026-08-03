(function () {
  "use strict";

  /* ---------- the pages Etta has ---------- */
  /* t = title, u = url, s = section label, d = description, k = extra search words */
  var PAGES = [
    {
      t: "The daily call you can't always make",
      u: "/",
      s: "Home",
      d: "Etta phones your mom or dad every day for a warm, unhurried conversation — then sends you a short note on how they're really doing.",
      k: "home start overview etta daily check-in call parent mom dad companion"
    },
    {
      t: "How it works",
      u: "/how-it-works",
      s: "How it works",
      d: "Three steps — and why the middle one, your parent's own yes, matters most.",
      k: "setup set up steps consent yes summary notes text message schedule call time timezone"
    },
    {
      t: "Our pledge",
      u: "/pledge",
      s: "Our pledge",
      d: "Five promises, starting with the big one: Etta never pretends to be human.",
      k: "honesty honest promises never pretend human ai disclosure trust stop selling"
    },
    {
      t: "Pricing",
      u: "/pricing",
      s: "Pricing",
      d: "Three simple plans and a handful of add-ons. 14 days free, cancel anytime.",
      k: "price cost how much money plans subscription billing trial free cancel monthly cheap"
    },
    {
      t: "Standard — three calls a week",
      u: "/pricing#standard",
      s: "Pricing",
      d: "$19 a month. Check-in calls Monday, Wednesday and Friday, with a summary after every one.",
      k: "19 nineteen basic cheapest three times weekly plan"
    },
    {
      t: "Daily — a call every single day",
      u: "/pricing#daily",
      s: "Pricing",
      d: "$39 a month. Seven days a week, weekly trend reports, and summaries to up to five family members.",
      k: "39 thirty nine most popular plan everyday seven days trends"
    },
    {
      t: "Companion — a longer call every day",
      u: "/pricing#companion",
      s: "Pricing",
      d: "$69 a month. Ten to fifteen unhurried minutes for someone who's often alone.",
      k: "69 sixty nine loneliness lonely alone long conversation plan"
    },
    {
      t: "Add-ons",
      u: "/pricing#add-ons",
      s: "Pricing",
      d: "A second parent, an evening call, medication reminders, a monthly care report, call archive, occasion calls, concierge setup.",
      k: "addons extras second parent evening call medication reminders care report doctor archive recordings occasion birthday concierge setup"
    },
    {
      t: "FAQ",
      u: "/faq",
      s: "FAQ",
      d: "The things families ask first, answered plainly — consent, privacy, missed calls.",
      k: "questions answers help support common"
    },
    {
      t: "Will my mom know she's talking to an AI?",
      u: "/faq#ai-disclosure",
      s: "FAQ",
      d: "Yes — always. Etta introduces herself as an AI companion at the start of every call.",
      k: "robot bot fake pretend human honest disclosure voice"
    },
    {
      t: "What if she doesn't want the calls?",
      u: "/faq#consent",
      s: "FAQ",
      d: "Then they don't happen. Your parent consents personally, and can stop the service at any moment.",
      k: "opt out refuse decline unsubscribe quit stop cancel calls consent"
    },
    {
      t: "What happens if she doesn't answer?",
      u: "/faq#missed-calls",
      s: "FAQ",
      d: "Etta retries, texts her, then works through the contact chain you chose.",
      k: "missed no answer unanswered escalation emergency contact neighbor sibling alert"
    },
    {
      t: "Are the calls recorded?",
      u: "/faq#recordings",
      s: "FAQ",
      d: "Calls are transcribed to produce the family summary, and your parent is told this plainly.",
      k: "recording transcript privacy data audio listen"
    },
    {
      t: "How long do you keep the recordings?",
      u: "/faq#retention",
      s: "FAQ",
      d: "Thirty days, then the audio is deleted. Written summaries stay.",
      k: "retention delete deletion storage 30 days archive download"
    },
    {
      t: "Will Etta try to sell my parent anything?",
      u: "/faq#no-selling",
      s: "FAQ",
      d: "No. Etta never mentions pricing, never suggests an upgrade, and never tells your parent what you're paying.",
      k: "selling sales telemarketing ads advertising scam upsell"
    },
    {
      t: "Can Etta call both my parents?",
      u: "/faq#both-parents",
      s: "FAQ",
      d: "Yes — each on their own phone, at their own time, for $15 a month more.",
      k: "two parents second mom dad couple both"
    },
    {
      t: "Can my brother and sister split the cost with me?",
      u: "/faq#split-cost",
      s: "FAQ",
      d: "Yes, and it's free to set up. Each sibling pays their own share, straight off your bill.",
      k: "split share siblings brother sister family payment cost divide"
    },
    {
      t: "Is this a medical or emergency service?",
      u: "/faq#not-medical",
      s: "FAQ",
      d: "No. Etta is a wellbeing and companionship service, not a medical device or emergency response.",
      k: "medical doctor nurse emergency 911 health care alert device"
    },
    {
      t: "Set up Etta",
      u: "/signup",
      s: "Get started",
      d: "Two minutes for you, one honest yes from your parent — that's the whole setup.",
      k: "sign up signup register join subscribe get started account create order buy"
    },
    {
      t: "Privacy policy",
      u: "/privacy",
      s: "Legal",
      d: "What we collect, how we use it, who else ever sees it, and how long we keep it.",
      k: "privacy data gdpr ccpa personal information security cookies sms messages retention"
    },
    {
      t: "Terms of service",
      u: "/terms",
      s: "Legal",
      d: "The plain-language agreement: what Etta is, who decides, billing, and messaging.",
      k: "terms conditions legal agreement billing refund messaging program fair use liability"
    },
    {
      t: "hello@ettacalls.com",
      u: "mailto:hello@ettacalls.com",
      s: "Contact",
      d: "Write to us — a person reads everything.",
      k: "contact email support help talk to someone human reach us"
    }
  ];

  /* ---------- text helpers ---------- */
  function norm(str) {
    return String(str)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function tokens(str) {
    var n = norm(str);
    return n ? n.split(" ") : [];
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* edit distance, capped — enough to forgive a typo or a swapped pair of letters */
  function within(a, b, max) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > max) return false;
    var rows = [], i, j;
    for (i = 0; i <= a.length; i++) {
      rows[i] = [i];
      for (j = 1; j <= b.length; j++) rows[i][j] = i === 0 ? j : 0;
    }
    for (i = 1; i <= a.length; i++) {
      var best = Infinity;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        var d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 &&
            a.charAt(i - 1) === b.charAt(j - 2) &&
            a.charAt(i - 2) === b.charAt(j - 1)) {
          d = Math.min(d, rows[i - 2][j - 2] + 1);
        }
        rows[i][j] = d;
        if (d < best) best = d;
      }
      if (best > max) return false;
    }
    return rows[a.length][b.length] <= max;
  }

  function fuzzyLimit(len) {
    if (len >= 8) return 2;
    if (len >= 5) return 1;
    return 0;  /* short words are too easy to confuse with each other */
  }

  /* score one field's words against one query token */
  function scoreField(words, token, weights) {
    var best = 0, i, w;
    var limit = fuzzyLimit(token.length);
    for (i = 0; i < words.length; i++) {
      w = words[i];
      if (w === token) return weights[0];
      if (w.indexOf(token) === 0) best = Math.max(best, weights[1]);
      /* "plan" should still find "plans", and vice versa */
      else if (w.length > 3 && token.indexOf(w) === 0) best = Math.max(best, weights[1]);
      else if (token.length > 3 && w.indexOf(token) > 0) best = Math.max(best, weights[2]);
      else if (limit > 0 && within(w, token, limit)) best = Math.max(best, weights[2]);
    }
    return best;
  }

  var INDEX = PAGES.map(function (p) {
    return {
      page: p,
      title: tokens(p.t),
      keys: tokens(p.k + " " + p.s),
      body: tokens(p.d)
    };
  });

  function search(query, limit) {
    var qs = tokens(query);
    if (!qs.length) return [];
    var out = [];

    INDEX.forEach(function (entry) {
      var total = 0, hit = 0;
      qs.forEach(function (token) {
        var s = scoreField(entry.title, token, [12, 8, 4]) +
                scoreField(entry.keys, token, [7, 5, 2.5]) +
                scoreField(entry.body, token, [4, 2.5, 1]);
        if (s > 0) { hit++; total += s; }
      });
      if (!hit) return;
      /* pages matching every word beat pages matching only some */
      total *= Math.pow(hit / qs.length, 2);
      out.push({ page: entry.page, score: total });
    });

    out.sort(function (a, b) {
      return b.score - a.score || a.page.t.length - b.page.t.length;
    });
    return out.slice(0, limit || 6);
  }

  /* ---------- rendering ---------- */
  var WORD_RE = /[A-Za-z0-9\u00C0-\u024F]+/g;

  function isHit(word, token) {
    var limit = fuzzyLimit(token.length);
    return word === token ||
      word.indexOf(token) === 0 ||
      (word.length > 3 && token.indexOf(word) === 0) ||
      (token.length > 3 && word.indexOf(token) > 0) ||
      (limit > 0 && within(word, token, limit));
  }

  function highlight(text, qs) {
    var raw = String(text);
    if (!qs.length) return esc(raw);
    var out = "", cursor = 0, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(raw)) !== null) {
      var word = norm(m[0]);
      if (!word) continue;
      var matched = qs.some(function (t) { return isHit(word, t); });
      if (!matched) continue;
      out += esc(raw.slice(cursor, m.index)) + "<mark>" + esc(m[0]) + "</mark>";
      cursor = m.index + m[0].length;
    }
    return out + esc(raw.slice(cursor));
  }

  function render(results, qs) {
    return results.map(function (r) {
      var p = r.page;
      return '<a class="result" href="' + esc(p.u) + '">' +
        '<span class="result-sec">' + esc(p.s) + "</span>" +
        '<span class="result-title">' + highlight(p.t, qs) + "</span>" +
        '<span class="result-desc">' + highlight(p.d, qs) + "</span>" +
        "</a>";
    }).join("");
  }

  /* ---------- wire up the page ---------- */
  var form = document.querySelector("[data-site-search]");
  if (!form) return;

  var input = form.querySelector("input[type=search]");
  var results = document.querySelector("[data-search-results]");
  var status = document.querySelector("[data-search-status]");
  var fallback = document.querySelector("[data-search-fallback]");
  var top = null;

  function run(query) {
    var qs = tokens(query);
    var found = qs.length ? search(query) : [];
    top = found.length ? found[0].page : null;

    if (!qs.length) {
      results.innerHTML = "";
      status.textContent = "";
      if (fallback) fallback.hidden = false;
      return;
    }
    if (fallback) fallback.hidden = true;

    if (!found.length) {
      results.innerHTML = "";
      status.innerHTML = "Nothing here matches <b>" + esc(query.trim()) +
        "</b>. Try <i>pricing</i>, <i>consent</i> or <i>recordings</i> — or email " +
        '<a href="mailto:hello@ettacalls.com">hello@ettacalls.com</a>.';
      return;
    }
    status.textContent = found.length === 1 ? "1 page matches" : found.length + " pages match";
    results.innerHTML = render(found, qs);
  }

  var timer;
  input.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(function () { run(input.value); }, 90);
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    run(input.value);
    if (top) window.location.href = top.u;
  });

  /* words a URL carries that say nothing about what the visitor wanted */
  var SEED_NOISE = ["a", "an", "the", "our", "my", "your", "their", "of", "for", "and",
    "page", "pages", "index", "home", "html", "htm", "php", "www", "en", "us", "site", "web"];

  /* seed the box from the URL that missed, e.g. /our-prices → "our prices" */
  var seed = tokens(decodeURIComponent(window.location.pathname).replace(/\.[a-z]+$/i, ""))
    .filter(function (t) { return SEED_NOISE.indexOf(t) === -1 && t !== "404"; })
    .join(" ");
  var badPath = document.querySelector("[data-bad-path]");
  if (badPath) {
    var shown = window.location.pathname + window.location.search;
    badPath.textContent = shown.length > 60 ? shown.slice(0, 57) + "…" : shown;
  }
  if (seed) {
    input.value = seed;
    run(seed);
    try { input.setSelectionRange(seed.length, seed.length); } catch (err) { /* not selectable */ }
  }
  input.focus({ preventScroll: true });
})();
