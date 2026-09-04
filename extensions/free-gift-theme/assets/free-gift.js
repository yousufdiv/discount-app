(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Free Gift — auto-add / auto-remove the gift line.
  //
  // The gift is a Rs 0 variant, so nothing has to discount it: adding the line IS
  // giving it away. (Earlier designs used a BXGY discount, then a Discount Function;
  // Shopify only allows functions from a custom app on Shopify Plus stores, so the
  // price itself became the mechanism.) That makes this script the only thing
  // deciding who gets what — and the only thing that can protect the customer, so
  // it removes any gift line it finds carrying a price. See dropPayableGifts.
  //
  // Theme independence is the hard requirement here: this ships to many
  // merchants on unknown themes, so we never reach into theme-specific DOM.
  // Strategy, in order of preference:
  //
  //   WRITE  -> Shopify.actions.updateCart (standard storefront action). Every
  //             Liquid storefront has a default implementation, and the theme
  //             refreshes its own cart UI (falling back to a reload) — so we
  //             never need to know the theme's markup.
  //             https://shopify.dev/docs/api/storefront-events-and-actions/actions/update-cart
  //   DETECT -> shopify:cart:lines-update (standard storefront event), with
  //             fetch/XHR interception as a fallback for themes that don't emit
  //             standard events yet.
  //   READ   -> /cart.js (Ajax API). Universal on every Shopify-hosted theme and
  //             the only source that reliably exposes line properties, variant
  //             and product ids, and line prices.
  //   REFRESH fallback (no standard actions) -> bundled section rendering using
  //             the section ids the theme itself asked for, swapped by the
  //             platform's `shopify-section-<id>` wrapper convention; a full
  //             reload as the last resort so the cart is never left stale.
  // ---------------------------------------------------------------------------

  var TIERS = (window.__TSF_GIFT_TIERS__ || []).filter(function (t) {
    return t.enabled && (t.giftVariantId || t.giftVariantGid);
  });
  var GIFT_PROP = window.__TSF_GIFT_PROP__ || "_gift";
  if (!TIERS.length) return;

  // A tier's name is the title its automatic discount carried, back when tiers were
  // backed by one. Nothing creates those discounts now, so this normally matches
  // nothing — it is kept because it costs one string compare and it is what keeps
  // lineValue() honest on any store that still has such a discount lying around.
  var OUR_DISCOUNT_TITLES = {};
  TIERS.forEach(function (t) { if (t.name) OUR_DISCOUNT_TITLES[t.name] = 1; });

  var ROOT = (window.Shopify && Shopify.routes && Shopify.routes.root) || "/";
  var TOAST_KEY = "tsf_gift_toast";
  var SELF = "tsf-free-gift"; // marks our own writes so we don't react to them
  var CART_LINES_UPDATE = "shopify:cart:lines-update"; // standard storefront protocol
  var THEME_CART_UPDATE = "cart:update";               // Horizon's own ThemeEvents.cartUpdate
  var lastSections = null; // section HTML returned by our own last cart mutation
  var FAIL_COOLDOWN_MS = 15000; // add failed — most likely sold out

  // Internal plumbing must use the ORIGINAL fetch. Going through our own
  // interceptor would make every gift add/remove re-trigger reconciliation.
  var origFetch = window.fetch;

  var busy = false;
  var lastSig = "";
  var failedUntil = {};   // tierId -> timestamp to stop retrying a sold-out gift
  var themeSections = null; // section ids the theme asks for on its cart calls
  var pendingToast = null;

  function variantGid(tier) {
    return tier.giftVariantGid || "gid://shopify/ProductVariant/" + tier.giftVariantId;
  }
  function canUseActions() {
    return !!(window.Shopify && Shopify.actions && typeof Shopify.actions.updateCart === "function");
  }

  // Opt-in logging. Turn on from the storefront console with:
  //   localStorage.setItem('tsf_gift_debug', '1')  then reload.
  function debugOn() {
    if (window.__TSF_GIFT_DEBUG__ === true) return true;
    try { return localStorage.getItem("tsf_gift_debug") === "1"; } catch (e) { return false; }
  }
  function debug() {
    if (!debugOn()) return;
    console.log.apply(console, ["[free-gift]"].concat(Array.prototype.slice.call(arguments)));
  }

  // Tiers whose gift Shopify refused to discount, so we stop retrying and stop
  // thrashing the cart. Stored against the cart contents at the time, NOT
  // forever: blocking for the whole session meant that once a tier misfired, it
  // never handed out its gift again even after the customer changed the cart and
  // the condition was cleanly met. The block is about one cart state, so it must
  // expire when that state does.
  var BLOCK_KEY = "tsf_gift_blocked";
  var blocked = (function () {
    try { return JSON.parse(sessionStorage.getItem(BLOCK_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  })();
  function blockTier(id, cartFingerprint) {
    blocked[id] = cartFingerprint;
    try { sessionStorage.setItem(BLOCK_KEY, JSON.stringify(blocked)); } catch (e) {}
  }
  function isBlocked(id, cartFingerprint) {
    return Object.prototype.hasOwnProperty.call(blocked, id) && blocked[id] === cartFingerprint;
  }

  // ---- read (Ajax API — universal) -----------------------------------------
  function readCart() {
    return origFetch(ROOT + "cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (cart) { rememberGiftLines(cart); return cart; });
  }

  // Which cart lines are gifts, by line key and by 1-based position. Refreshed on
  // every cart read, because the guard below has to recognise a gift line in a
  // request body that is on its way out — there is no time to go and ask.
  var giftKeys = {};      // line key -> true
  var giftPositions = {}; // 1-based line index -> true
  var cartLineCount = 0;

  function rememberGiftLines(cart) {
    giftKeys = {};
    giftPositions = {};
    cartLineCount = 0;
    if (!cart || !cart.items) return;
    cartLineCount = cart.items.length;
    cart.items.forEach(function (l, i) {
      if (isGift(l)) {
        giftKeys[l.key] = true;
        giftPositions[i + 1] = true;
      }
    });
  }

  function isGift(line) { return !!(line.properties && line.properties[GIFT_PROP]); }
  function tierIdOf(line) { return line.properties[GIFT_PROP]; }
  function realLines(cart) { return cart.items.filter(function (l) { return !isGift(l); }); }
  function money(cents) { return cents / 100; } // PKR thresholds are in major units

  /**
   * What a line contributes to a tier's threshold.
   *
   * `final_line_price` with our own gift discounts added back. A tier's threshold
   * must be judged on what the customer chose to buy, independent of what we gave
   * them for it: an allocation of ours reducing a real line's price would push the
   * cart back under its own threshold, so the tier would disqualify, we'd pull the
   * gift, the price would go back up, and the tier would qualify again. That
   * feedback loop is what used to remove a gift whose condition was still met.
   *
   * A Rs 0 gift allocates nothing, so today this is normally just
   * `final_line_price` — but the guard has to stay, because it is what keeps the
   * loop from coming back on a store that still has an old gift discount active.
   * Discounts from anything else (the merchant's own sales, codes) stay deducted —
   * those are real reductions in what the customer is spending.
   */
  function lineValue(l) {
    var allocations = l.line_level_discount_allocations || l.discount_allocations || [];
    var ours = 0;
    for (var i = 0; i < allocations.length; i++) {
      var a = allocations[i];
      var title = a && a.discount_application && a.discount_application.title;
      if (title && OUR_DISCOUNT_TITLES[title]) ours += a.amount || 0;
    }
    return l.final_line_price + ours;
  }

  /**
   * The number a tier is measured against: PKR subtotal for the subtotal tiers,
   * item count for collection_contains. Gift lines never count toward it.
   * Exposed separately from qualifies() so the debug inspector can show the
   * exact figure the decision was made on.
   */
  function measure(tier, cart) {
    var lines = realLines(cart);
    if (tier.type === "order_subtotal") {
      return money(lines.reduce(function (s, l) { return s + lineValue(l); }, 0));
    }
    var ids = tier.collectionProductIds || [];
    var inColl = lines.filter(function (l) { return ids.indexOf(l.product_id) !== -1; });
    if (tier.type === "collection_contains") return inColl.length;
    if (tier.type === "collection_subtotal") {
      return money(inColl.reduce(function (a, l) { return a + lineValue(l); }, 0));
    }
    return 0;
  }

  /**
   * A threshold tier can be a window rather than a floor: "gift on orders of
   * Rs 6,000 to Rs 7,999" is threshold 6000 with thresholdMax 7999. Both ends are
   * inclusive. No cap — absent, null or zero — leaves the tier open-ended, which
   * is what every tier saved before thresholdMax existed relies on.
   *
   * The discount function applies the identical rule, so a gift the theme hands
   * out is always one the function will make free.
   */
  function qualifies(tier, cart) {
    var v = measure(tier, cart);
    if (tier.type === "collection_contains") return v > 0;
    if (v < tier.threshold) return false;
    var max = Number(tier.thresholdMax);
    return !(max > 0) || v <= max;
  }

  // ---- write ---------------------------------------------------------------
  //
  // Every cart mutation we make invalidates the line keys AND the 1-based line
  // indices the theme has already rendered with. A theme that then acts on a
  // stale one gets "line parameter is invalid" from Shopify — which is what the
  // quantity stepper was showing. We can't fix the theme's cached state, so the
  // rule here is: make as FEW mutations as possible, and never leave the cart in
  // a state that makes us want to mutate again.
  var actionOpts = { event: { context: "standard-action", detail: { source: SELF } } };

  var MAX_MUTATIONS = 12; // circuit breaker against a pathological add/remove loop
  var mutations = 0;

  function mutationBudget() {
    if (mutations < MAX_MUTATIONS) return true;
    debug("mutation budget exhausted — standing down for this page view");
    return false;
  }

  // Set whenever we change the cart by a route the theme cannot observe (the Ajax
  // API). updateCart makes the theme refresh itself; a raw Ajax call does not, so
  // the server cart and the rendered cart silently diverge — the theme keeps
  // showing a line that no longer exists, and its stepper then fails with
  // "line parameter is invalid". If this is set, WE owe the theme a refresh.
  var unobservedMutation = false;

  /**
   * The cart section ids the theme renders its cart from. Horizon's own cart
   * component builds exactly this list from `cart-items-component[data-section-id]`
   * before every cart request, so we read the same source. Section ids captured
   * from the theme's own traffic are the fallback for other themes.
   */
  function themeCartSectionIds() {
    var nodes = document.querySelectorAll("cart-items-component[data-section-id]");
    var seen = {};
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute("data-section-id");
      if (id && !seen[id]) { seen[id] = 1; list.push(id); }
    }
    if (list.length) return list.join(",");
    return themeSections || null;
  }

  /**
   * POST to the Ajax Cart API, resolving to { ok, status, body }.
   *
   * The parsed body matters as much as the status. cart/change.js and
   * cart/update.js return the WHOLE resulting cart, so a caller can verify what
   * it just did straight from the response instead of making another /cart.js
   * request — that follow-up read, once per attempt, was a large part of the
   * removal lag. cart/add.js returns only the added line(s), hence isFullCart().
   */
  function post(path, body) {
    mutations++;
    unobservedMutation = true;
    // Bundled section rendering: ask for the theme's cart sections in the SAME
    // request. Handing the theme ready-made HTML lets it morph immediately —
    // without this it has to go fetch the section itself, which was the visible
    // couple-of-seconds lag before the drawer caught up.
    var ids = /cart\/(add|change|update|clear)/.test(path) ? themeCartSectionIds() : null;
    if (ids) {
      body = Object.assign({}, body, { sections: ids, sections_url: window.location.pathname });
    }
    return origFetch(ROOT + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      // Read the body here rather than peeking at a clone in the background: the
      // background read finished after the caller had already moved on, so
      // lastSections could still be empty when we told the theme to re-render,
      // costing it a round trip of its own.
      return res.json().then(
        function (data) {
          if (data && data.sections) lastSections = data.sections;
          // Keep the guard's picture current the moment our own write lands — the
          // theme's next write can arrive before any reconcile reads the cart.
          if (isFullCart(data)) rememberGiftLines(data);
          return { ok: res.ok, status: res.status, body: data };
        },
        function () { return { ok: res.ok, status: res.status, body: null }; },
      );
    });
  }

  /** True for a response body that is a complete cart, usable in place of a read. */
  function isFullCart(o) {
    return !!(o && Array.isArray(o.items) && typeof o.item_count === "number");
  }

  /**
   * Apply removals and adds, and resolve to the resulting cart when we know it
   * (null means the caller has to read it).
   *
   * `cart` is the cart the plan was made from. Reusing it instead of re-reading is
   * most of the speed-up here: the round trips this function used to make before
   * touching anything were what made a gift take three or four seconds to appear.
   */
  function applyChanges(addTiers, removeTierIds, cart) {
    if (!addTiers.length && !removeTierIds.length) return Promise.resolve(null);
    if (!mutationBudget()) return Promise.resolve(null);

    if (!canUseActions()) return ajaxChanges(addTiers, removeTierIds, cart);

    // Only a removal needs a storefront line id; an add is addressed by variant.
    // Fetching the cart when there is nothing to remove was a wasted round trip
    // on the commonest path of all — the customer just crossed a threshold.
    var idsPromise = removeTierIds.length ? giftLineIdsByTier() : Promise.resolve({});

    return idsPromise.then(function (byTier) {
      var lines = [];
      var unresolved = [];
      removeTierIds.forEach(function (id) {
        if (byTier && byTier[id]) lines.push({ id: byTier[id], quantity: 0 });
        else unresolved.push(id);
      });

      // Half by updateCart and half by Ajax within one pass is how the theme ended
      // up rendering a cart that no longer existed. If any line can't be addressed
      // by storefront id, do the whole batch one way — over the Ajax API.
      if (unresolved.length) {
        debug("no storefront line id for", unresolved, "— whole batch over the Ajax API");
        return ajaxChanges(addTiers, removeTierIds, cart);
      }

      addTiers.forEach(function (t) {
        lines.push({
          merchandiseId: variantGid(t),
          quantity: 1,
          attributes: [{ key: GIFT_PROP, value: t.id }],
        });
      });
      if (!lines.length) return null;

      mutations++;
      return Shopify.actions
        .updateCart({ lines: lines }, actionOpts)
        .then(function (r) {
          if (r && r.userErrors && r.userErrors.length) debug("updateCart userErrors", r.userErrors);
          if (r && r.warnings && r.warnings.length) debug("updateCart warnings", r.warnings);
          return null; // not the Ajax cart shape — the caller must read the cart
        })
        .catch(function (e) { debug("updateCart threw", e); return null; });
    });
  }

  /** Removals then adds, entirely over the Ajax API. Resolves to a cart or null. */
  function ajaxChanges(addTiers, removeTierIds, cart) {
    return removeGiftsAjax(removeTierIds, cart).then(function (after) {
      if (!addTiers.length) return after;
      // cart/add.js returns only the added line, so the cart we hold is stale now.
      return addSequentially(addTiers.slice()).then(function () { return null; });
    });
  }

  function addSequentially(queue) {
    if (!queue.length) return Promise.resolve();
    var t = queue.shift();
    var props = {}; props[GIFT_PROP] = t.id;
    return post("cart/add.js", { items: [{ id: t.giftVariantId, quantity: 1, properties: props }] })
      .then(function (r) { if (!r.ok) debug("cart/add.js refused", t.id, r.status); })
      .catch(function () {})
      .then(function () { return addSequentially(queue); });
  }

  /**
   * Remove gift lines for the given tiers, in as few requests as possible, and
   * resolve to the resulting cart.
   *
   * cart/update.js takes a map of line key -> quantity, so every gift comes out in
   * ONE request rather than one request each, and its response is the whole cart,
   * so the removal is verified from that instead of a follow-up /cart.js read.
   * Removing two gifts used to cost six round trips; it now costs one.
   *
   * Verification is not optional, and neither is the fallback. A line key is
   * rewritten whenever the line's properties or discount applications change, and
   * a 1-based line index shifts on every removal, so a request addressing a stale
   * one silently matches nothing — which is exactly how a gift stayed in the cart
   * while its discount vanished.
   * https://shopify.dev/docs/api/ajax/reference/cart
   */
  function removeGiftsAjax(tierIds, cart) {
    if (!tierIds.length) return Promise.resolve(cart);

    function present(c, ids) {
      return ids.filter(function (id) {
        return c.items.some(function (l) { return isGift(l) && tierIdOf(l) === id; });
      });
    }
    // change.js/update.js hand back the cart; anything else means we must read it.
    function cartFrom(result) {
      return isFullCart(result.body) ? Promise.resolve(result.body) : readCart();
    }

    function batch(c) {
      var updates = {};
      var found = 0;
      c.items.forEach(function (l) {
        if (isGift(l) && tierIds.indexOf(tierIdOf(l)) !== -1) { updates[l.key] = 0; found++; }
      });
      if (!found) return Promise.resolve(c);
      return post("cart/update.js", { updates: updates })
        .then(cartFrom)
        .catch(function () { return readCart(); });
    }

    // Per-line fallback, re-reading between tries because a successful removal
    // shifts the indices of everything after it.
    function one(id, c) {
      var line = null;
      var index = -1;
      for (var i = 0; i < c.items.length; i++) {
        if (isGift(c.items[i]) && tierIdOf(c.items[i]) === id) {
          line = c.items[i];
          index = i + 1; // Shopify's `line` parameter is 1-based
          break;
        }
      }
      if (!line) return Promise.resolve(c);

      var attempts = [
        { how: "change.js id=key", body: { id: line.key, quantity: 0 } },
        { how: "change.js line=index", body: { line: index, quantity: 0 } },
      ];
      function attempt(n, current) {
        if (n >= attempts.length) {
          debug("FAILED to remove gift line for", id, "— all strategies exhausted");
          return Promise.resolve(current);
        }
        return post("cart/change.js", attempts[n].body)
          .then(cartFrom)
          .then(function (after) {
            if (!present(after, [id]).length) {
              debug("removed gift", id, "via", attempts[n].how);
              return after;
            }
            debug("removal attempt did not stick:", attempts[n].how);
            return attempt(n + 1, after);
          })
          .catch(function () {
            return readCart().then(function (after) { return attempt(n + 1, after); });
          });
      }
      return attempt(0, c);
    }

    function sweep(ids, c) {
      if (!ids.length) return Promise.resolve(c);
      return one(ids[0], c).then(function (after) { return sweep(ids.slice(1), after); });
    }

    return batch(cart).then(function (after) {
      var left = present(after, tierIds);
      if (!left.length) return after;
      debug("batch removal left", left, "— falling back to per-line removal");
      return sweep(left, after);
    });
  }

  /**
   * Resolve our gift tiers to Storefront cart line ids so removals can go
   * through updateCart. Returns null when unavailable (or when the returned
   * lines don't carry attributes), in which case we fall back to the Ajax API,
   * which always gives us a usable line key.
   */
  // Set once we've established that this storefront's getCart payload cannot
  // identify our gift lines. Without it we made that round trip before every
  // single removal and threw the answer away every time.
  var storefrontLineIdsUnavailable = false;

  function giftLineIdsByTier() {
    if (storefrontLineIdsUnavailable) return Promise.resolve(null);
    if (!canUseActions() || typeof Shopify.actions.getCart !== "function") {
      return Promise.resolve(null);
    }
    return Shopify.actions
      .getCart()
      .then(function (res) {
        // getCart returns lines as a connection ({ nodes: [...] }) on this store,
        // but the reference documents a plain array. Accept either.
        var raw = (res && res.cart && res.cart.lines) || [];
        var lines = Array.isArray(raw) ? raw : raw.nodes || [];
        if (!lines.length) return null;
        debug("getCart line fields:", Object.keys(lines[0] || {}));

        // Preferred: the line carries our own attribute.
        var byTier = {};
        lines.forEach(function (l) {
          (l.attributes || []).forEach(function (a) {
            if (a.key === GIFT_PROP) byTier[a.value] = l.id;
          });
        });
        if (Object.keys(byTier).length) return byTier;

        // No attributes. Try the gift's variant instead — but only if the payload
        // even carries one. On this storefront getCart returns just id/quantity/cost,
        // so there is nothing to match on and an extra cart read would be wasted.
        // That's a fact about the storefront, not about this cart, so remember it
        // and stop asking.
        if (!lines.some(function (l) { return l.merchandise && l.merchandise.id; })) {
          storefrontLineIdsUnavailable = true;
          debug("getCart can't identify gift lines here — using the Ajax API from now on");
          return null;
        }

        // Match by variant, and only when unambiguous: if the customer also bought
        // the gift product, two lines share the variant and we must not guess.
        return readCart().then(function (ajax) {
          var giftTierByVariant = {};
          var linesPerVariant = {};
          ajax.items.forEach(function (l) {
            linesPerVariant[l.variant_id] = (linesPerVariant[l.variant_id] || 0) + 1;
            if (isGift(l)) giftTierByVariant[l.variant_id] = tierIdOf(l);
          });
          lines.forEach(function (l) {
            var gid = l.merchandise && l.merchandise.id;
            if (!gid) return;
            var variantId = Number(String(gid).split("/").pop());
            var tierId = giftTierByVariant[variantId];
            if (tierId && linesPerVariant[variantId] === 1) byTier[tierId] = l.id;
          });
          if (Object.keys(byTier).length) debug("matched gift lines by variant:", byTier);
          return Object.keys(byTier).length ? byTier : null;
        });
      })
      .catch(function (e) {
        debug("giftLineIdsByTier failed", e);
        return null;
      });
  }

  // ---- make the theme re-render --------------------------------------------
  //
  /**
   * Ask the theme to refresh its own cart UI, by speaking the protocol it already
   * listens to rather than touching its DOM.
   *
   * Horizon's cart-items-component does exactly this:
   *
   *   document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartUpdate)
   *   ...
   *   if (event.target === this) return;
   *   event.promise?.then(({ detail }) => {
   *     const html = detail?.sections?.[this.sectionId];
   *     if (html) morphSection(...); else sectionRenderer.renderSection(...);
   *   })
   *
   * So dispatching the event from `document` with a resolved promise that carries
   * NO `detail.sections` makes the theme fetch and morph its own cart section —
   * correctly, with its own components and animations intact.
   *
   * This replaces swapping `#shopify-section-*` outerHTML, which tore out
   * Horizon's custom elements and blanked the cart drawer.
   */
  function notifyThemeOfCartChange(cart) {
    // Two different event protocols are in the wild and we can't tell from here
    // which one this theme was built against, so speak both. The one it doesn't
    // understand is simply ignored.
    //
    //   cart:update                  — Horizon's own ThemeEvents.cartUpdate, whose
    //                                  CartUpdateEvent carries
    //                                  detail = { resource, sourceId, data }
    //   shopify:cart:lines-update    — the standard storefront protocol, read off
    //                                  event.promise
    //
    // Both get the section HTML our own mutation already fetched. That's what
    // removes the lag: with sections present the theme morphs straight away
    // instead of making its own round trip to re-render.
    var sections = lastSections || undefined;
    var sent = false;

    try {
      document.dispatchEvent(
        new CustomEvent(THEME_CART_UPDATE, {
          bubbles: true,
          detail: {
            resource: cart || null,
            sourceId: SELF,
            data: {
              source: SELF,
              sections: sections,
              itemCount: cart ? cart.item_count : undefined,
              didError: false,
            },
          },
        }),
      );
      sent = true;
    } catch (e) {
      debug("could not dispatch " + THEME_CART_UPDATE, e);
    }

    try {
      var detail = { source: SELF, sections: sections };
      var evt = new CustomEvent(CART_LINES_UPDATE, { bubbles: true, detail: detail });
      evt.promise = Promise.resolve({ cart: cart || null, detail: detail });
      evt.action = "update";
      evt.context = "cart";
      evt.lines = [];
      document.dispatchEvent(evt);
      sent = true;
    } catch (e) {
      debug("could not dispatch " + CART_LINES_UPDATE, e);
    }

    return sent;
  }

  // Needed after any mutation the theme couldn't observe.
  //
  // `cart` is the post-change cart the reconcile pass already has. Themes put it
  // straight into their UI (item count, totals) with no further requests, and
  // re-reading it here just to hand it over was one more round trip sitting on
  // the critical path between the gift landing and the drawer showing it.
  function refreshTheme(cart) {
    // Only trust the events if there's some sign this theme listens for them.
    // Otherwise an old theme would silently keep showing a stale cart.
    var listens =
      standardEventsSeen || canUseActions() || !!document.querySelector("cart-items-component");
    if (notifyThemeOfCartChange(cart || null) && listens) {
      debug("notified the theme", lastSections ? "(with rendered sections)" : "(no sections)");
      return Promise.resolve(null);
    }
    return legacyRefresh();
  }

  function legacyRefresh() {
    // Themes that understood neither event: bundled section rendering using the
    // ids the theme itself asked for, and a reload if we never saw any — a stale
    // cart is worse than a reload.
    var ids = themeCartSectionIds();
    if (!ids) return reloadPage();

    return origFetch(ROOT + "cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ updates: {}, sections: ids }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var sections = (data && data.sections) || {};
        var swapped = 0;
        Object.keys(sections).forEach(function (id) {
          var html = sections[id];
          if (!html) return; // sections that fail to render come back null
          // Every Shopify section renders inside <div id="shopify-section-{id}">.
          // That's a platform convention, not a theme one — safe to rely on.
          var el = document.getElementById("shopify-section-" + id);
          if (!el) return;
          el.outerHTML = html;
          swapped++;
        });
        if (!swapped) return reloadPage();
        // Nudge any theme/app listeners that watch for cart changes.
        document.documentElement.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true }));
      })
      .catch(function () { return reloadPage(); });
  }

  function reloadPage() {
    // Carry the toast across the reload so the customer still sees it.
    try { if (pendingToast) sessionStorage.setItem(TOAST_KEY, pendingToast); } catch (e) {}
    window.location.reload();
    return new Promise(function () {}); // reload in flight — never resolve
  }

  // ---- reconcile -----------------------------------------------------------
  // Removing or adding one gift can change what *other* tiers qualify for, so a
  // single pass isn't enough — we run passes until the cart stops changing.
  // Bounded, so a misconfigured pair of tiers can't spin forever.
  var MAX_PASSES = 4;

  function reconcile(initialCart) {
    if (busy) return;
    busy = true;

    var changedAny = false;
    unobservedMutation = false;
    lastSections = null; // never hand the theme section HTML from an earlier run

    // Each pass hands the next one the cart it ended with. A pass that finds
    // nothing left to do then costs no network at all — and there is always such
    // a pass, because the loop only stops once the cart stops changing.
    function loop(depth, cart) {
      if (depth >= MAX_PASSES) {
        debug("hit MAX_PASSES — giving up this run");
        return Promise.resolve(cart);
      }
      return onePass(cart).then(function (r) {
        if (!r.changed) return r.cart;
        changedAny = true;
        return loop(depth + 1, r.cart);
      });
    }

    function done() {
      busy = false;
      // A cart change that arrived mid-run was previously dropped: the trigger
      // recorded the new signature and then found reconcile() busy, so nothing
      // ever acted on it. Pick it up now instead.
      if (rerunRequested) {
        rerunRequested = false;
        scheduleReconcile();
      }
    }

    (initialCart ? Promise.resolve(initialCart) : readCart())
      .then(function (cart) { return loop(0, cart); })
      .then(function (cart) {
        // updateCart refreshes the theme's cart UI itself, but an Ajax mutation
        // doesn't — and we fall back to Ajax whenever a storefront line id can't
        // be resolved. Keying this off canUseActions() alone was the bug: the
        // removal succeeded server-side while the theme kept rendering the old
        // cart. Refresh whenever anything went through an unobserved route.
        if (changedAny && (unobservedMutation || !canUseActions())) return refreshTheme(cart);
        return null;
      })
      .then(done)
      .catch(function (e) { debug("reconcile failed", e); done(); });
  }

  /**
   * A gift line is always quantity 1. Put it back if it isn't.
   *
   * We only ever add with quantity 1, so an inflated gift line is somebody else's
   * write. Themes address cart lines by 1-based index, and inserting a gift shifts
   * every index the theme has already rendered — so a customer setting their own
   * line to 7 can land that 7 on the gift line instead. The reported symptom was
   * exactly that: the gift quantity tracking the quantity of the product that
   * earned it, seven products giving seven gifts.
   *
   * We can't stop a theme writing to a stale index, and we can't tell afterwards
   * which write did it. So this doesn't try to detect the cause — it treats
   * "every gift line is quantity 1" as an invariant and re-establishes it at the
   * start of every pass, before anything is measured or planned.
   *
   * Resolves to { cart, fixed }.
   */
  function fixGiftQuantities(cart) {
    var updates = {};
    var found = 0;
    cart.items.forEach(function (l) {
      if (isGift(l) && l.quantity !== 1) { updates[l.key] = 1; found++; }
    });
    if (!found) return Promise.resolve({ cart: cart, fixed: false });

    debug("gift line quantity was not 1 — correcting", updates);
    return post("cart/update.js", { updates: updates })
      .then(function (r) { return isFullCart(r.body) ? r.body : readCart(); })
      .catch(function () { return readCart(); })
      .then(function (fresh) { return { cart: fresh, fixed: true }; });
  }

  /**
   * One reconcile pass over the given cart. Resolves to { changed, cart }, where
   * `cart` is the freshest state this pass knows about — the next pass plans from
   * it directly instead of re-reading.
   */
  function onePass(startCart) {
    var wanted = [];       // tiers we attempted to add this pass
    var removals = [];     // tier ids whose gift should come out
    var qualifying = {};   // tierId -> whether its condition holds right now

    function plan(cart) {
      var present = {};         // tierId -> true
      var presentVariants = {}; // variant id -> true, across all gift lines
      cart.items.forEach(function (l) {
        if (!isGift(l)) return;
        present[tierIdOf(l)] = true;
        presentVariants[l.variant_id] = true;
      });

      var now = new Date().getTime();
      var fingerprint = realFingerprint(cart);

      // Every tier is judged on its own, against the same cart. Two tiers on the
      // same condition (Rs 5,000 and Rs 10,000) both fire at Rs 12,000, and a
      // collection tier fires alongside an order-total tier — nothing competes,
      // nothing is shadowed by a "higher" tier.
      TIERS.forEach(function (t) {
        var ok = qualifies(t, cart);
        qualifying[t.id] = ok;
        if (ok && !present[t.id]) {
          // This tier's gift already turned out to cost money for this exact cart.
          if (isBlocked(t.id, fingerprint)) return;
          // The same physical gift is already in the cart under another tier.
          // Adding it again would just hand out two of the same thing.
          if (presentVariants[t.giftVariantId]) {
            debug("skipping", t.id, "— its gift variant is already in the cart");
            return;
          }
          // A recent attempt failed (most likely sold out).
          if (failedUntil[t.id] && now < failedUntil[t.id]) return;
          wanted.push(t);
        } else if (!ok && present[t.id]) {
          removals.push(t.id);
        }
      });
      // Gift lines for tiers that no longer exist.
      Object.keys(present).forEach(function (tid) {
        if (!TIERS.some(function (t) { return t.id === tid; })) removals.push(tid);
      });

      debug("pass", {
        tiers: TIERS.map(function (t) {
          return {
            id: t.id, name: t.name, type: t.type,
            threshold: t.threshold, thresholdMax: t.thresholdMax || null,
            measured: measure(t, cart), qualifies: qualifies(t, cart),
            inCart: !!present[t.id],
            blocked: isBlocked(t.id, fingerprint),
          };
        }),
        toAdd: wanted.map(function (t) { return t.id; }),
        toRemove: removals,
      });
    }

    /**
     * A gift the customer would actually PAY for must never be left in the cart.
     * This is the safety net, and with no discount in play it is the ONLY one.
     *
     * A gift line costs money when the tier points at a priced variant rather than
     * the Rs 0 one — the merchant edited the price in Shopify, or picked a product
     * that never had a free variant. The app warns about both, but the storefront
     * must not depend on the merchant having seen the warning.
     *
     * Two different situations end up here, and they must not be treated alike:
     *
     *   - The tier no longer qualifies. The gift is on its way out anyway. Remove
     *     it, and do NOT hold it against the tier — it did nothing wrong.
     *   - The tier DOES qualify and the line still costs money. That is a real
     *     misconfiguration. Remove it and block the tier for this cart, so we don't
     *     add and remove it on a loop (which is what desynced the theme).
     */
    function dropPayableGifts(cart) {
      var payable = [];
      cart.items.forEach(function (l) {
        if (isGift(l) && l.final_line_price > 0) payable.push(tierIdOf(l));
      });
      if (!payable.length) return Promise.resolve({ cart: cart, payable: payable });

      var fingerprint = realFingerprint(cart);
      payable.forEach(function (id) {
        if (qualifying[id]) {
          debug("gift not discounted although its tier qualifies — blocking", id, "for this cart");
          blockTier(id, fingerprint);
        } else {
          debug("gift no longer discounted because its tier lapsed — removing", id);
        }
      });

      return applyChanges([], payable, cart)
        .then(function (after) { return after || readCart(); })
        .then(function (fresh) { return { cart: fresh, payable: payable }; });
    }

    function finish(cart, payable) {
      var nowPresent = {};
      cart.items.forEach(function (l) { if (isGift(l)) nowPresent[tierIdOf(l)] = true; });

      var added = wanted.filter(function (t) {
        return nowPresent[t.id] && payable.indexOf(t.id) === -1;
      });
      var stuck = removals.filter(function (id) { return nowPresent[id]; });
      var removedCount = removals.length - stuck.length;

      var now = new Date().getTime();
      wanted.forEach(function (t) {
        if (payable.indexOf(t.id) !== -1) return; // already on the long cooldown
        failedUntil[t.id] = nowPresent[t.id] ? 0 : now + FAIL_COOLDOWN_MS;
      });

      if (stuck.length) debug("removal did not take effect for", stuck);

      // Keep the signature in sync with the cart we just caused, so our own
      // change doesn't look like a fresh customer action.
      lastSig = signature(cart);

      if (added.length) {
        announce(
          added.length === 1
            ? "You earned a free gift: " + added[0].giftProductTitle + " 🎁"
            : "You earned free gifts: " +
                added.map(function (t) { return t.giftProductTitle; }).join(", ") + " 🎁",
        );
        document.dispatchEvent(new CustomEvent("tsf:gift-updated"));
      }

      // Hand the cart on as well as the verdict: the next pass plans from it
      // rather than reading it again.
      return {
        changed: added.length > 0 || removedCount > 0 || payable.length > 0,
        cart: cart,
      };
    }

    // Correct any inflated gift line BEFORE measuring anything: a gift line at
    // quantity 7 is not what the customer earned, and planning against it would
    // just bake the mistake into the next decision.
    return fixGiftQuantities(startCart).then(function (q) {
      var cart = q.cart;
      // A quantity correction is itself a change — the loop has to run again and
      // the theme has to be told, or the drawer keeps showing 7.
      var withFix = function (r) { return { changed: r.changed || q.fixed, cart: r.cart }; };

      plan(cart);
      if (!wanted.length && !removals.length) {
        // Nothing to add or remove — but an existing gift line may still carry a
        // price, so always run the safety net.
        return dropPayableGifts(cart).then(function (r) {
          if (!r.payable.length) return { changed: q.fixed, cart: r.cart };
          return withFix(finish(r.cart, r.payable));
        });
      }

      // One atomic batch: adds and removals together, so the theme's rendered
      // line keys and indices are invalidated once instead of once per line.
      return applyChanges(wanted, removals, cart)
        // Trust nothing: work from what is actually in the cart afterwards. This is
        // what keeps the popup honest — a gift that failed to add (sold out,
        // inventory policy "deny", quantity limits) won't be there — and it's how we
        // catch a removal that silently didn't take effect. When the mutation
        // already handed back the whole cart we use that; only otherwise do we read.
        .then(function (after) { return after || readCart(); })
        .then(dropPayableGifts)
        .then(function (r) { return withFix(finish(r.cart, r.payable)); });
    });
  }

  // ---- popup ---------------------------------------------------------------
  //
  // The toast has to sit above the cart drawer, and z-index cannot do that. A
  // drawer opened with dialog.showModal() lives in the browser's TOP LAYER, which
  // renders above every z-index there is — which is why the toast was appearing
  // behind it. The Popover API puts our toast in that same top layer without
  // making it modal, so it stays click-through and never traps focus.
  //
  // Elements in the top layer stack in the order they were promoted, so a drawer
  // opened after us would still cover us. Hence the hide-then-show below: every
  // announcement re-promotes the toast to the front.
  var TOAST_EXIT_MS = 340; // must outlast the CSS transition, or it vanishes mid-slide
  var timer;
  var exitTimer;

  function toastSupportsPopover(el) {
    return typeof el.showPopover === "function" && el.hasAttribute("popover");
  }

  function showToast(el) {
    el.hidden = false; // `hidden` would keep it display:none even while open
    if (!toastSupportsPopover(el)) return;
    try { el.hidePopover(); } catch (e) {} // ignore: it simply wasn't open
    try { el.showPopover(); } catch (e) {}
  }

  function hideToast(el) {
    if (toastSupportsPopover(el)) {
      try { el.hidePopover(); } catch (e) {}
      return;
    }
    el.hidden = true;
  }

  function popup(text) {
    var el = document.getElementById("tsf-gift-popup");
    if (!el) return;
    el.querySelector(".tsf-gift-popup__text").textContent = text;

    clearTimeout(timer);
    clearTimeout(exitTimer);
    showToast(el);

    // Two frames, not one: the first commits the element's newly shown layout at
    // its off-screen start position, the second flips the attribute so there is
    // something to transition FROM. One frame can land in the same style
    // recalculation and skip the animation entirely.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.setAttribute("data-show", "true"); });
    });

    timer = setTimeout(function () {
      el.setAttribute("data-show", "false");
      pendingToast = null;
      exitTimer = setTimeout(function () { hideToast(el); }, TOAST_EXIT_MS);
    }, 4000);
  }

  function announce(msg) {
    pendingToast = msg; // picked up by reloadPage() if a reload follows
    popup(msg);
  }

  // A reload (fallback refresh path) swallows the toast, so replay it on load.
  function replayToast() {
    var msg = null;
    try {
      msg = sessionStorage.getItem(TOAST_KEY);
      if (msg) sessionStorage.removeItem(TOAST_KEY);
    } catch (e) {}
    if (msg) popup(msg);
  }

  // ---- change detection ----------------------------------------------------
  // Keyed on variant + quantity, never on line keys: a line key is rewritten
  // whenever discount applications change, so a key-based signature reported a
  // "change" every time a gift discount landed, and we'd reconcile all over again.
  function signature(cart) {
    return cart.items
      .map(function (l) { return l.variant_id + ":" + l.quantity + (isGift(l) ? ":g" : ""); })
      .sort()
      .join("|");
  }

  /** The customer's own cart, ignoring gifts entirely. A block is scoped to this. */
  function realFingerprint(cart) {
    return realLines(cart)
      .map(function (l) { return l.variant_id + ":" + l.quantity; })
      .sort()
      .join("|");
  }

  function maybeReconcile() {
    // Don't spend a cart read to discover we can't act on it. The run in flight
    // will be told to go round again when it finishes.
    if (busy) { rerunRequested = true; return; }
    readCart()
      .then(function (cart) {
        var sig = signature(cart);
        if (sig === lastSig) return;
        lastSig = sig;
        // Hand the cart straight to reconcile — it used to read it all over again.
        reconcile(cart);
      })
      .catch(function () {});
  }

  /**
   * Coalesce a burst of cart requests into one reconcile.
   *
   * Themes routinely fire several requests for a single click, and each trigger
   * used to sit behind a flat 300ms wait — paid once per trigger, on top of every
   * round trip that followed. A short window merges the burst instead, so we react
   * roughly a quarter of a second sooner and still only run once.
   */
  // ---- guard: a gift line can never exceed quantity 1 ----------------------
  //
  // Correcting an inflated gift line after the fact is not enough, and the
  // storefront proved it: /cart.js on the cart page reported the gift at 1 while
  // checkout showed 5. A theme renders its cart form once and submits the cached
  // `updates` it captured then — so the LAST write before the customer leaves the
  // storefront can put the stale quantity straight back, and checkout is built
  // from that. Reconciling can't win a race it only learns about afterwards.
  //
  // So the write is clamped in flight instead. This is the one place where the
  // interceptor stops being a pure observer. Two rules keep it safe:
  //
  //   - Only ever clamp DOWN to 1, and only a gift line. A customer's own
  //     quantity is never touched.
  //   - Prefer the line KEY, which is unambiguous. A positional update is clamped
  //     only when the body's line count matches the cart we last read; a mismatch
  //     means our picture is stale, and quietly rewriting the wrong line's
  //     quantity would be far worse than letting one extra gift through.
  //
  // Known gap: a theme that passes a Request object to fetch (rather than a url
  // plus init) writes past this. The reconcile pass is still the backstop there.
  var GIFT_MAX = 1;

  /** Clamp a parsed JSON cart body in place. True when something changed. */
  function clampJsonBody(o) {
    if (!o || typeof o !== "object") return false;
    var changed = false;

    // change.js — { id: <key>, quantity: n } or { line: <1-based index>, quantity: n }
    if (o.quantity !== undefined) {
      var targetsGift =
        (o.id !== undefined && giftKeys[String(o.id)]) ||
        (o.line !== undefined && giftPositions[Number(o.line)]);
      if (targetsGift && Number(o.quantity) > GIFT_MAX) {
        o.quantity = GIFT_MAX;
        changed = true;
      }
    }

    // update.js — { updates: { <key>: n } } or { updates: [n, n, ...] }
    var u = o.updates;
    if (u && typeof u === "object") {
      if (Object.prototype.toString.call(u) === "[object Array]") {
        if (u.length === cartLineCount) {
          for (var i = 0; i < u.length; i++) {
            if (giftPositions[i + 1] && Number(u[i]) > GIFT_MAX) { u[i] = GIFT_MAX; changed = true; }
          }
        } else {
          debug("positional updates:", u.length, "vs", cartLineCount, "cart lines — not clamping");
        }
      } else {
        Object.keys(u).forEach(function (k) {
          if (giftKeys[k] && Number(u[k]) > GIFT_MAX) { u[k] = GIFT_MAX; changed = true; }
        });
      }
    }
    return changed;
  }

  /** Clamp a URLSearchParams or FormData body in place. True when it changed. */
  function clampParams(p) {
    var changed = false;
    var names = [];
    p.forEach(function (v, k) { if (names.indexOf(k) === -1) names.push(k); });

    // change.js style: id=<key>&quantity=n, or line=<index>&quantity=n
    if (names.indexOf("quantity") !== -1) {
      var id = p.get("id");
      var line = p.get("line");
      if (((id && giftKeys[id]) || (line && giftPositions[Number(line)])) &&
          Number(p.get("quantity")) > GIFT_MAX) {
        p.set("quantity", String(GIFT_MAX));
        changed = true;
      }
    }

    // updates[<key>]=n — the cart form's per-line inputs
    names.forEach(function (k) {
      var m = /^updates\[(.+)\]$/.exec(k);
      if (m && giftKeys[m[1]] && Number(p.get(k)) > GIFT_MAX) {
        p.set(k, String(GIFT_MAX));
        changed = true;
      }
    });

    // updates[]=n&updates[]=n — positional
    var name = p.getAll("updates[]").length ? "updates[]" : "updates";
    var positional = p.getAll(name);
    if (positional.length) {
      if (positional.length !== cartLineCount) {
        debug("positional updates:", positional.length, "vs", cartLineCount, "cart lines — not clamping");
      } else {
        var next = positional.map(function (v, i) {
          return giftPositions[i + 1] && Number(v) > GIFT_MAX ? String(GIFT_MAX) : v;
        });
        if (next.join(" ") !== positional.join(" ")) {
          p.delete(name);
          next.forEach(function (v) { p.append(name, v); });
          changed = true;
        }
      }
    }
    return changed;
  }

  /** The body to actually send. Returns the same reference when nothing changed. */
  function clampCartWriteBody(body) {
    if (!body) return body;

    if (typeof body === "string") {
      if (body.charAt(0) === "{" || body.trim().charAt(0) === "{") {
        try {
          var parsed = JSON.parse(body);
          return clampJsonBody(parsed) ? JSON.stringify(parsed) : body;
        } catch (e) {
          return body;
        }
      }
      try {
        var params = new URLSearchParams(body);
        return clampParams(params) ? params.toString() : body;
      } catch (e) {
        return body;
      }
    }

    // FormData exposes the same get/set/getAll/append surface clampParams uses.
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      try { clampParams(body); } catch (e) {}
      return body;
    }

    return body;
  }

  // A theme's cart form posts its cached `updates` straight to /cart on the way to
  // checkout — a full page navigation, with no fetch or XHR to intercept. So repair
  // the inputs instead, on the way out. The form is NOT cancelled: the customer
  // reaches checkout exactly as they expect. Blocking that button was never an
  // option on a live store; only the gift's quantity is held down.
  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      var action = form && form.action ? String(form.action) : "";
      if (!/\/cart(\/|\?|$)/.test(action)) return;

      var inputs = form.querySelectorAll("[name^='updates']");
      if (!inputs.length) return;

      var fixed = 0;
      var positional = [];
      for (var i = 0; i < inputs.length; i++) {
        var m = /^updates\[(.*)\]$/.exec(inputs[i].getAttribute("name") || "");
        var key = m ? m[1] : null;
        if (key) {
          if (giftKeys[key] && Number(inputs[i].value) > GIFT_MAX) {
            inputs[i].value = String(GIFT_MAX);
            fixed++;
          }
        } else {
          positional.push(inputs[i]);
        }
      }
      if (positional.length && positional.length !== cartLineCount) {
        debug("cart form has", positional.length, "positional inputs vs", cartLineCount, "cart lines — not clamping");
      } else {
        for (var j = 0; j < positional.length; j++) {
          if (giftPositions[j + 1] && Number(positional[j].value) > GIFT_MAX) {
            positional[j].value = String(GIFT_MAX);
            fixed++;
          }
        }
      }
      if (fixed) debug("held", fixed, "gift quantity input(s) at 1 before the cart form submitted");
    },
    true, // capture, so we run before any theme handler reads the form
  );

  var RECONCILE_DEBOUNCE_MS = 60;
  var scheduled = null;
  var rerunRequested = false;

  function scheduleReconcile() {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(function () {
      scheduled = null;
      maybeReconcile();
    }, RECONCILE_DEBOUNCE_MS);
  }

  // 1. Standard storefront event — theme-agnostic, no DOM or fetch knowledge.
  //    It fires *before* the cart settles, so we wait on event.promise.
  document.addEventListener(CART_LINES_UPDATE, function (e) {
    // Our own write, or our own synthetic refresh nudge. Checked FIRST: counting it
    // as evidence that the theme emits standard events would be circular, since we
    // emitted it ourselves.
    if (e.detail && e.detail.source === SELF) return;

    // A genuine theme event. This is the better trigger, so stop reconciling off
    // the wire. The fetch wrapper stays installed as a pure observer — it's how we
    // learn the theme's cart section ids for the legacy refresh path.
    if (!standardEventsSeen) {
      standardEventsSeen = true;
      debug("standard cart events detected — no longer triggering off fetch/XHR");
    }
    var p = e.promise;
    if (p && typeof p.then === "function") {
      p.then(function () { scheduleReconcile(); }).catch(function () {});
    } else {
      scheduleReconcile();
    }
  });

  // 2. A pass-through observer on the wire. Two jobs:
  //    a) record which sections the theme re-renders its cart from, so we can
  //       refresh it in place instead of reloading the page;
  //    b) trigger reconciliation on themes that don't emit standard events.
  //    Job (b) stops once standard events are confirmed; job (a) runs forever.
  //    It never alters the request, the response, or the timing.
  var standardEventsSeen = false;
  var patchedFetch = function () {
    var args = Array.prototype.slice.call(arguments);
    var url = args[0] && (args[0].url || args[0]);
    var init = args[1];
    if (typeof url === "string" && /\/cart\/(add|change|update|clear)/.test(url)) {
      rememberSections(init && init.body);
      if (init && init.body) {
        var guarded = clampCartWriteBody(init.body);
        if (guarded !== init.body) {
          debug("held a gift line at quantity 1 in an outgoing cart write");
          args[1] = Object.assign({}, init, { body: guarded });
        }
      }
      var p = origFetch.apply(this, args);
      if (!standardEventsSeen) {
        p.then(function () { scheduleReconcile(); }).catch(function () {});
      }
      return p;
    }
    return origFetch.apply(this, args);
  };

  // 3. Older themes (jQuery and friends) still use XMLHttpRequest.
  var XhrOpen = XMLHttpRequest.prototype.open;
  var XhrSend = XMLHttpRequest.prototype.send;
  var patchedOpen = function (method, url) {
    this.__tsfCart = typeof url === "string" && /\/cart\/(add|change|update|clear)/.test(url);
    return XhrOpen.apply(this, arguments);
  };
  var patchedSend = function (body) {
    if (this.__tsfCart) {
      rememberSections(body);
      var guarded = clampCartWriteBody(body);
      if (guarded !== body) {
        debug("held a gift line at quantity 1 in an outgoing XHR cart write");
        body = guarded;
      }
      if (!standardEventsSeen) {
        this.addEventListener("load", function () { scheduleReconcile(); });
      }
      return XhrSend.call(this, body);
    }
    return XhrSend.apply(this, arguments);
  };

  window.fetch = patchedFetch;
  XMLHttpRequest.prototype.open = patchedOpen;
  XMLHttpRequest.prototype.send = patchedSend;

  /**
   * Themes using bundled section rendering tell the Cart API which sections to
   * re-render. We reuse that list for our own fallback refresh so we never have
   * to guess a theme's section names.
   */
  function rememberSections(body) {
    if (!body || typeof body !== "string") return;
    try {
      var parsed = JSON.parse(body);
      if (parsed && parsed.sections) themeSections = parsed.sections;
    } catch (e) {
      // URL-encoded form body
      try {
        var m = /(?:^|&)sections=([^&]*)/.exec(body);
        if (m) themeSections = decodeURIComponent(m[1].replace(/\+/g, " "));
      } catch (e2) {}
    }
  }

  // ---- diagnostics ---------------------------------------------------------
  // Run `__tsfGiftInspect()` in the storefront console to see exactly which
  // lines are recognised as gifts and what figure each tier was judged on.
  window.__tsfGiftInspect = function () {
    return readCart().then(function (cart) {
      var report = {
        standardActionsAvailable: canUseActions(),
        blockedTiers: blocked,
        realCartFingerprint: realFingerprint(cart),
        mutationsThisPageView: mutations,
        shopifyActionsKeys:
          window.Shopify && Shopify.actions ? Object.keys(Shopify.actions) : "Shopify.actions is undefined",
        giftPropertyKey: GIFT_PROP,
        lines: cart.items.map(function (l) {
          return {
            title: l.title,
            variant_id: l.variant_id,
            product_id: l.product_id,
            quantity: l.quantity,
            final_line_price: l.final_line_price,
            countsTowardThreshold: isGift(l) ? 0 : lineValue(l),
            properties: l.properties,
            countedAsGift: isGift(l),
          };
        }),
        tiers: TIERS.map(function (t) {
          return {
            id: t.id,
            name: t.name,
            type: t.type,
            threshold: t.threshold,
            thresholdMax: t.thresholdMax || null,
            giftVariantId: t.giftVariantId,
            measured: measure(t, cart),
            qualifies: qualifies(t, cart),
          };
        }),
      };
      if (!canUseActions() || typeof Shopify.actions.getCart !== "function") {
        console.log("[free-gift] inspect", report);
        return report;
      }
      return Shopify.actions
        .getCart()
        .then(function (r) {
          report.getCartLines = (r && r.cart && r.cart.lines) || null;
          console.log("[free-gift] inspect", report);
          return report;
        })
        .catch(function () {
          console.log("[free-gift] inspect", report);
          return report;
        });
    });
  };

  // Clear the session's blocked-tier list and mutation budget, then re-check.
  // Needed while testing: once a tier is blocked it stays blocked for the whole
  // session, which otherwise looks like the tier is broken.
  window.__tsfGiftReset = function () {
    blocked = {};
    mutations = 0;
    lastSig = "";
    failedUntil = {};
    lastSections = null;
    try { sessionStorage.removeItem(BLOCK_KEY); } catch (e) {}
    console.log("[free-gift] reset — re-checking cart");
    maybeReconcile();
  };

  // ---- boot ----------------------------------------------------------------
  function boot() {
    replayToast();
    maybeReconcile();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
