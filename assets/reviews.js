/**
 * Adelina Reviews Widget — vanilla JS, no dependencies.
 *
 * Security note: all innerHTML calls use ONLY developer-authored HTML templates.
 * User-supplied data (author, title, body) is always wrapped in escapeHtml()
 * before insertion. The Cloudflare Worker also sanitizes on write.
 * No raw user strings are injected into innerHTML without escapeHtml().
 */

(function () {
  'use strict';

  // Replace with your deployed Worker URL
  const API_BASE  = '';
  const PAGE_SIZE = 8;

  // ─── Init via IntersectionObserver (lazy load) ──────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    const widget = document.querySelector('[data-reviews-widget]');
    if (!widget) return;

    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { initWidget(widget); obs.disconnect(); }
      }, { rootMargin: '200px' });
      obs.observe(widget);
    } else {
      initWidget(widget);
    }
  });

  function initWidget(widget) {
    const productId = widget.dataset.productId;
    if (!productId) return;
    showSkeleton(widget);
    loadAndRender(widget, productId, 1, 'recent');
  }

  // ─── Data loading ────────────────────────────────────────────────────────

  function loadAndRender(widget, productId, page, sort) {
    const url = API_BASE + '/api/reviews?product_id=' + productId + '&page=' + page + '&sort=' + sort;
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) { renderWidget(widget, data, productId, page, sort); })
      .catch(function () { showError(widget); });
  }

  function renderWidget(widget, data, productId, page, sort) {
    // Build all HTML (user data goes through escapeHtml — see buildReviewCard)
    var html = buildWidgetHtml(data, productId, page, sort);
    widget.innerHTML = html; // safe: all user data escaped in builders
    attachEvents(widget, productId, sort);
  }

  // ─── HTML builders (all user data escaped) ──────────────────────────────

  function buildWidgetHtml(data, productId, page, sort) {
    var i18n = getI18n();
    var reviews = data.reviews || [];
    var count   = data.count   || 0;

    return (
      '<div class="rv-header">' +
        buildSummaryHtml(data, i18n) +
        '<button class="rv-write-btn Button Button--primary" data-action="open-form">' +
          escapeHtml(i18n.writeReview) +
        '</button>' +
      '</div>' +
      buildFormHtml(productId, i18n) +
      (count > 0 ? '<div class="rv-sort-bar">' + buildSortHtml(sort, i18n) + '</div>' : '') +
      '<div class="rv-list">' +
        (reviews.length > 0
          ? reviews.map(buildReviewCard).join('')
          : '<p class="rv-empty">' + escapeHtml(i18n.beFirst) + '</p>') +
      '</div>' +
      (data.pages > 1 ? buildPaginationHtml(page, data.pages) : '')
    );
  }

  function buildSummaryHtml(data, i18n) {
    var count = data.count || 0;
    var avg   = data.avg   || 0;
    var dist  = data.distribution || {1:0,2:0,3:0,4:0,5:0};

    if (count === 0) {
      return '<div class="rv-summary rv-summary--empty">' +
        buildStarsHtml(0) +
        '<span class="rv-summary__label">' + escapeHtml(i18n.noReviews) + '</span>' +
      '</div>';
    }

    var maxBar = Math.max(dist[1]||0, dist[2]||0, dist[3]||0, dist[4]||0, dist[5]||0);
    var bars   = [5,4,3,2,1].map(function (n) {
      var c   = dist[n] || 0;
      var pct = maxBar ? Math.round(c / maxBar * 100) : 0;
      return '<div class="rv-dist__row">' +
        '<span class="rv-dist__lbl">' + n + '</span>' +
        '<div class="rv-dist__track"><div class="rv-dist__fill" style="width:' + pct + '%"></div></div>' +
        '<span class="rv-dist__c">' + c + '</span>' +
      '</div>';
    }).join('');

    return '<div class="rv-summary">' +
      '<div class="rv-summary__score">' +
        '<span class="rv-summary__num">' + avg.toFixed(1) + '</span>' +
        buildStarsHtml(avg) +
        '<span class="rv-summary__total">' + count + ' ' + escapeHtml(i18n.reviews) + '</span>' +
      '</div>' +
      '<div class="rv-dist">' + bars + '</div>' +
    '</div>';
  }

  function buildStarsHtml(rating) {
    return '<span class="rv-stars" aria-label="' + rating.toFixed(1) + ' stars">' +
      [1,2,3,4,5].map(function (n) {
        if (rating >= n)              return '<i class="rv-star rv-star--full">★</i>';
        if (rating > n - 1) {
          var pct = Math.round((rating - (n-1)) * 100);
          return '<i class="rv-star rv-star--partial" style="--fill:' + pct + '%">★</i>';
        }
        return '<i class="rv-star rv-star--empty">★</i>';
      }).join('') +
    '</span>';
  }

  // All user content (r.author, r.title, r.body) is wrapped in escapeHtml()
  function buildReviewCard(r) {
    var i18n     = getI18n();
    var words    = escapeHtml(r.author).trim().split(' ');
    var initials = words.map(function (w) { return w[0] || ''; }).join('').slice(0,2).toUpperCase();
    var date     = new Date(r.date).toLocaleDateString(undefined, {year:'numeric', month:'short', day:'numeric'});
    var verified = r.verified
      ? '<span class="rv-badge rv-badge--verified">&#10003; ' + escapeHtml(i18n.verified) + '</span>'
      : '';

    return (
      '<article class="rv-card" itemscope itemtype="https://schema.org/Review">' +
        '<header class="rv-card__head">' +
          '<div class="rv-avatar" aria-hidden="true">' + initials + '</div>' +
          '<div class="rv-card__info">' +
            '<b class="rv-card__author" itemprop="author">' + escapeHtml(r.author) + '</b>' +
            verified +
            '<time class="rv-card__date" datetime="' + escapeHtml(r.date) + '">' + escapeHtml(date) + '</time>' +
          '</div>' +
          '<div class="rv-card__stars" itemprop="reviewRating" itemscope itemtype="https://schema.org/Rating">' +
            '<meta itemprop="ratingValue" content="' + Number(r.rating) + '">' +
            buildStarsHtml(Number(r.rating)) +
          '</div>' +
        '</header>' +
        (r.title ? '<h3 class="rv-card__title" itemprop="name">' + escapeHtml(r.title) + '</h3>' : '') +
        '<p class="rv-card__body" itemprop="reviewBody">' + escapeHtml(r.body) + '</p>' +
        '<footer class="rv-card__foot">' +
          '<button class="rv-helpful" data-review-id="' + escapeHtml(r.id) + '" aria-label="' + escapeHtml(i18n.helpful) + '">' +
            '&#128077; ' + escapeHtml(i18n.helpful) + ' <span class="rv-helpful__c">' + (r.helpful || 0) + '</span>' +
          '</button>' +
        '</footer>' +
      '</article>'
    );
  }

  function buildFormHtml(productId, i18n) {
    var starInputs = [1,2,3,4,5].map(function (n) {
      return '<label class="rv-picker__star" for="rv-star-' + n + '" aria-label="' + n + ' ' + escapeHtml(i18n.stars) + '">' +
        '<input type="radio" name="rating" id="rv-star-' + n + '" value="' + n + '" required> ★' +
      '</label>';
    }).join('');

    return '<div class="rv-form-wrap" id="rv-form-wrap" hidden>' +
      '<form class="rv-form" id="rv-form" data-product-id="' + escapeHtml(productId) + '" novalidate>' +
        '<h3 class="rv-form__ttl">' + escapeHtml(i18n.writeReview) + '</h3>' +
        '<fieldset class="rv-picker" aria-label="' + escapeHtml(i18n.rating) + '">' + starInputs + '</fieldset>' +
        '<label class="rv-form__lbl">' + escapeHtml(i18n.name) +
          '<input class="rv-form__input" type="text" name="author" required minlength="2" maxlength="60">' +
        '</label>' +
        '<label class="rv-form__lbl">' + escapeHtml(i18n.reviewTitle) +
          '<input class="rv-form__input" type="text" name="title" maxlength="100" placeholder="' + escapeHtml(i18n.titlePlaceholder) + '">' +
        '</label>' +
        '<label class="rv-form__lbl">' + escapeHtml(i18n.review) +
          '<textarea class="rv-form__area" name="review_body" required minlength="10" maxlength="1000" rows="4"></textarea>' +
          '<span class="rv-form__ctr"><span id="rv-char-count">0</span>/1000</span>' +
        '</label>' +
        '<input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off">' +
        '<div class="rv-form__actions">' +
          '<button type="submit" class="Button Button--primary rv-submit">' + escapeHtml(i18n.submit) + '</button>' +
          '<button type="button" class="rv-cancel" data-action="close-form">' + escapeHtml(i18n.cancel) + '</button>' +
        '</div>' +
        '<p class="rv-form__status" aria-live="polite"></p>' +
      '</form>' +
    '</div>';
  }

  function buildSortHtml(current, i18n) {
    return ['recent','helpful','rating'].map(function (s) {
      var label = { recent: i18n.sortRecent, helpful: i18n.sortHelpful, rating: i18n.sortRating }[s];
      return '<button class="rv-sort__btn' + (s === current ? ' rv-sort__btn--active' : '') + '" data-sort="' + s + '">' +
        escapeHtml(label) + '</button>';
    }).join('');
  }

  function buildPaginationHtml(page, pages) {
    return '<nav class="rv-pagination" aria-label="Reviews pages">' +
      (page > 1 ? '<button class="rv-pg" data-page="' + (page-1) + '">&#8592;</button>' : '') +
      '<span class="rv-pg-info">' + page + ' / ' + pages + '</span>' +
      (page < pages ? '<button class="rv-pg" data-page="' + (page+1) + '">&#8594;</button>' : '') +
    '</nav>';
  }

  // ─── Event handlers ──────────────────────────────────────────────────────

  function attachEvents(widget, productId, sort) {
    // Form toggle
    var openBtn  = widget.querySelector('[data-action="open-form"]');
    var closeBtn = widget.querySelector('[data-action="close-form"]');
    var formWrap = widget.querySelector('#rv-form-wrap');
    var form     = widget.querySelector('#rv-form');

    if (openBtn && formWrap)  openBtn.addEventListener('click', function () { formWrap.hidden = false; formWrap.querySelector('input[name="author"]').focus(); });
    if (closeBtn && formWrap) closeBtn.addEventListener('click', function () { formWrap.hidden = true; });

    // Char counter
    var textarea = form && form.querySelector('[name="review_body"]');
    var counter  = form && form.querySelector('#rv-char-count');
    if (textarea && counter) textarea.addEventListener('input', function () { counter.textContent = textarea.value.length; });

    // Star picker hover/select feedback
    if (form) {
      form.querySelectorAll('.rv-picker__star input').forEach(function (radio) {
        radio.addEventListener('change', function () {
          var val = Number(radio.value);
          form.querySelectorAll('.rv-picker__star').forEach(function (lbl, idx) {
            lbl.classList.toggle('rv-picker__star--on', idx < val);
          });
        });
      });
    }

    // Form submit
    if (form) attachFormSubmit(form, widget, productId);

    // Helpful votes
    widget.querySelectorAll('.rv-helpful').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.reviewId;
        fetch(API_BASE + '/api/reviews/' + id + '/helpful', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_id: productId }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var c = btn.querySelector('.rv-helpful__c');
            if (c) c.textContent = d.helpful;
            btn.disabled = true;
          });
      });
    });

    // Sort
    widget.querySelectorAll('[data-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showSkeleton(widget);
        loadAndRender(widget, productId, 1, btn.dataset.sort);
      });
    });

    // Pagination
    widget.querySelectorAll('[data-page]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showSkeleton(widget);
        loadAndRender(widget, productId, Number(btn.dataset.page), sort);
        widget.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function attachFormSubmit(form, widget, productId) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var i18n    = getI18n();
      var status  = form.querySelector('.rv-form__status');
      var btn     = form.querySelector('.rv-submit');
      var ratingInput = form.querySelector('input[name="rating"]:checked');

      if (!ratingInput) {
        setStatus(status, i18n.errorRating, 'error');
        return;
      }

      var payload = {
        product_id:  productId,
        rating:      Number(ratingInput.value),
        title:       form.querySelector('input[name="title"]').value.trim(),
        review_body: form.querySelector('[name="review_body"]').value.trim(),
        author:      form.querySelector('input[name="author"]').value.trim(),
        website:     form.querySelector('input[name="website"]').value,
      };

      btn.disabled = true;
      btn.textContent = '…';

      fetch(API_BASE + '/api/reviews', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (res.ok) {
            setStatus(status, i18n.submitted, 'success');
            form.reset();
            form.querySelectorAll('.rv-picker__star').forEach(function (l) { l.classList.remove('rv-picker__star--on'); });
          } else {
            var msg = (res.data.errors || []).join(', ') || res.data.error || i18n.errorGeneric;
            setStatus(status, msg, 'error');
            btn.disabled = false;
            btn.textContent = i18n.submit;
          }
        })
        .catch(function () {
          setStatus(status, i18n.errorGeneric, 'error');
          btn.disabled = false;
          btn.textContent = i18n.submit;
        });
    });
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  function showSkeleton(widget) {
    // Only template HTML — no user data, safe innerHTML
    widget.innerHTML = '<div class="rv-skeleton">' +
      [1,2,3].map(function () {
        return '<div class="rv-skeleton__card">' +
          '<div class="rv-skeleton__line rv-skeleton__line--wide"></div>' +
          '<div class="rv-skeleton__line"></div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function showError(widget) {
    widget.innerHTML = '<p class="rv-error">' + escapeHtml(getI18n().loadError) + '</p>';
  }

  function setStatus(el, msg, type) {
    if (!el) return;
    el.textContent = msg; // textContent — safe, no XSS
    el.className   = 'rv-form__status rv-form__status--' + type;
  }

  /** Escape user-provided strings before any DOM insertion. */
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getI18n() {
    return window.reviewsI18n || {
      writeReview: 'Write a Review', reviews: 'reviews', noReviews: 'No reviews yet.',
      beFirst: 'Be the first to review this product.', verified: 'Verified Purchase',
      helpful: 'Helpful', name: 'Your Name', review: 'Your Review',
      reviewTitle: 'Review Title', titlePlaceholder: 'Summarise your experience',
      rating: 'Rating', stars: 'stars', submit: 'Submit Review', cancel: 'Cancel',
      submitted: 'Thank you! Your review has been submitted for approval.',
      loadError: 'Could not load reviews.', errorRating: 'Please select a star rating.',
      errorGeneric: 'Something went wrong. Please try again.',
      sortBy: 'Sort by', sortRecent: 'Most Recent', sortHelpful: 'Most Helpful', sortRating: 'Top Rated',
    };
  }

})();
