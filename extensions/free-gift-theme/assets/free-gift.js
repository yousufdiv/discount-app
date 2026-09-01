(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Free Gift — auto-add / auto-remove the gift line so the native BXGY
  // discount can zero it out at checkout.
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

  // Each tier's name is the title of its automatic discount, so this is how we
  // recognise a price reduction as OUR OWN doing. See lineValue().
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
      .then(function (r) { return r.json(); });
  }

  function isGift(line) { return !!(line.properties && line.properties[GIFT_PROP]); }
  function tierIdOf(line) { return line.properties[GIFT_PROP]; }
  function realLines(cart) { return cart.items.filter(function (l) { return !isGift(l); }); }
  function money(cents) { return cents / 100; } // PKR thresholds are in major units

  /**
   * What a line contributes to a tier's threshold.
   *
   * This is `final_line_price` with OUR OWN gift discounts added back, and that
   * detail is the whole ballgame. Shopify allocates a BXGY discount across the
   * cart, so handing out a gift can reduce a real line's price. If we measured
   * that reduced price, our own promotion would push the cart back under its own
   * threshold — the tier would disqualify, we'd pull the gift, the price would go
   * back up, the tier would qualify again. That feedback loop is what removed a
   * gift whose condition was still genuinely met, and what made tiers flap.
   *
   * A tier's threshold must therefore be judged on what the customer chose to
   * buy, independent of what we gave them for it. Discounts from anything else
   * (the merchant's own sales, codes) stay deducted — those are real.
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

  function qualifies(tier, cart) {
    var v = measure(tier, cart);
    return tier.type === "collection_contains" ? v > 0 : v >= tier.threshold;
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
      // Peek at the body without consuming it for the caller.
      res
        .clone()
        .json()
        .then(function (data) { if (data && data.sections) lastSections = data.sections; })
        .catch(function () {});
      return res;
    });
  }

  /**
   * Apply removals and adds. With standard actions this is ONE atomic updateCart
   * call for the whole batch instead of a mutation per line — one re-render, one
   * chance to desync the theme, rather than several.
   */
  function applyChanges(addTiers, removeTierIds) {
    if (!addTiers.length && !removeTierIds.length) return Promise.resolve();
    if (!mutationBudget()) return Promise.resolve();

    if (!canUseActions()) {
      return removeSequentially(removeTierIds.slice()).then(function () {
        return addSequentially(addTiers.slice());
      });
    }

    return giftLineIdsByTier().then(function (byTier) {
      var lines = [];
      var unresolved = [];
      removeTierIds.forEach(function (id) {
        if (byTier && byTier[id]) lines.push({ id: byTier[id], quantity: 0 });
        else unresolved.push(id);
      });
      addTiers.forEach(function (t) {
        lines.push({
          merchandiseId: variantGid(t),
          quantity: 1,
          attributes: [{ key: GIFT_PROP, value: t.id }],
        });
      });

      var step = Promise.resolve();
      if (lines.length) {
        mutations++;
        step = Shopify.actions
          .updateCart({ lines: lines }, actionOpts)
          .then(function (r) {
            if (r && r.userErrors && r.userErrors.length) debug("updateCart userErrors", r.userErrors);
            if (r && r.warnings && r.warnings.length) debug("updateCart warnings", r.warnings);
          })
          .catch(function (e) { debug("updateCart threw", e); });
      }
      return step.then(function () {
        if (!unresolved.length) return null;
        // getCart didn't expose attributes, so we couldn't address these lines by
        // storefront id. Fall back to the Ajax API, which always can.
        debug("no storefront line id for", unresolved, "— using Ajax removal");
        return removeSequentially(unresolved);
      });
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

  function removeSequentially(queue) {
    if (!queue.length) return Promise.resolve();
    var id = queue.shift();
    return removeOneGift(id).then(function () { return removeSequentially(queue); });
  }

  /**
   * Remove a single gift line, trying each documented way of addressing a line
   * until the line is actually gone, verifying after every attempt.
   *
   * One strategy is not enough. A line key changes whenever the line's properties
   * or discount applications change, and a line index shifts on every removal —
   * so the same request can silently match nothing, which is exactly how a gift
   * stayed in the cart while its discount disappeared.
   * https://shopify.dev/docs/api/ajax/reference/cart
   */
  function removeOneGift(tierId) {
    return readCart().then(function (cart) {
      var line = null;
      var index = -1;
      for (var i = 0; i < cart.items.length; i++) {
        if (isGift(cart.items[i]) && tierIdOf(cart.items[i]) === tierId) {
          line = cart.items[i];
          index = i + 1; // Shopify's `line` parameter is 1-based
          break;
        }
      }
      if (!line) return true; // already gone

      var updates = {};
      updates[line.key] = 0;
      var attempts = [
        { how: "change.js id=key", path: "cart/change.js", body: { id: line.key, quantity: 0 } },
        { how: "update.js updates[key]", path: "cart/update.js", body: { updates: updates } },
        { how: "change.js line=index", path: "cart/change.js", body: { line: index, quantity: 0 } },
      ];

      function attempt(n) {
        if (n >= attempts.length) {
          debug("FAILED to remove gift line for", tierId, "— all strategies exhausted");
          return false;
        }
        var a = attempts[n];
        return post(a.path, a.body)
          .then(function () { return readCart(); })
          .then(function (fresh) {
            var stillThere = fresh.items.some(function (l) {
              return isGift(l) && tierIdOf(l) === tierId;
            });
            if (!stillThere) {
              debug("removed gift", tierId, "via", a.how);
              return true;
            }
            debug("removal attempt did not stick:", a.how);
            return attempt(n + 1);
          })
          .catch(function () { return attempt(n + 1); });
      }
      return attempt(0);
    });
  }

  /**
   * Resolve our gift tiers to Storefront cart line ids so removals can go
   * through updateCart. Returns null when unavailable (or when the returned
   * lines don't carry attributes), in which case we fall back to the Ajax API,
   * which always gives us a usable line key.
   */
  function giftLineIdsByTier() {
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
        if (!lines.some(function (l) { return l.merchandise && l.merchandise.id; })) {
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
  function refreshTheme() {
    // Read the cart so the event carries the real post-change state — themes put
    // it straight into their UI (item count, totals) with no further requests.
    return readCart()
      .catch(function () { return null; })
      .then(function (cart) {
        // Only trust the events if there's some sign this theme listens for them.
        // Otherwise an old theme would silently keep showing a stale cart.
        var listens =
          standardEventsSeen || canUseActions() || !!document.querySelector("cart-items-component");
        if (notifyThemeOfCartChange(cart) && listens) {
          debug("notified the theme", lastSections ? "(with rendered sections)" : "(no sections)");
          return null;
        }
        return legacyRefresh();
      });
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

  function reconcile() {
    if (busy) return;
    busy = true;

    var changedAny = false;
    unobservedMutation = false;
    lastSections = null; // never hand the theme section HTML from an earlier run

    function loop(depth) {
      if (depth >= MAX_PASSES) {
        debug("hit MAX_PASSES — giving up this run");
        return Promise.resolve();
      }
      return onePass().then(function (changed) {
        if (!changed) return null;
        changedAny = true;
        return loop(depth + 1);
      });
    }

    loop(0)
      .then(function () {
        // updateCart refreshes the theme's cart UI itself, but an Ajax mutation
        // doesn't — and we fall back to Ajax whenever a storefront line id can't
        // be resolved. Keying this off canUseActions() alone was the bug: the
        // removal succeeded server-side while the theme kept rendering the old
        // cart. Refresh whenever anything went through an unobserved route.
        if (changedAny && (unobservedMutation || !canUseActions())) return refreshTheme();
        return null;
      })
      .then(function () { busy = false; })
      .catch(function () { busy = false; });
  }

  /** One reconcile pass. Resolves true when it actually changed the cart. */
  function onePass() {
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
          // Shopify already refused to discount this gift for this exact cart.
          if (isBlocked(t.id, fingerprint)) return;
          // The same physical gift is already in the cart under another tier.
          // Only one line can be discounted, so a second would be charged for.
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
            id: t.id, name: t.name, type: t.type, threshold: t.threshold,
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
     * The BXGY discount can fail to zero the line for reasons invisible from
     * here — the merchant deleted or expired the discount, or two tiers competed
     * for the same cart items and Shopify only honoured one.
     *
     * Two different situations end up here, and they must not be treated alike:
     *
     *   - The tier no longer qualifies. The gift is on its way out anyway and its
     *     discount has simply lapsed. Remove it, and do NOT hold it against the
     *     tier — it did nothing wrong.
     *   - The tier DOES qualify and Shopify still won't discount the gift. That's
     *     a real conflict. Remove it and block the tier for this cart, so we don't
     *     add/remove on a loop (which is what desynced the theme).
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

      return applyChanges([], payable)
        .then(readCart)
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

      return added.length > 0 || removedCount > 0 || payable.length > 0;
    }

    return readCart().then(function (cart) {
      plan(cart);
      if (!wanted.length && !removals.length) {
        // Nothing to do — but an existing gift line may still be payable (the
        // merchant just deleted its discount), so always run the safety net.
        return dropPayableGifts(cart).then(function (r) {
          if (!r.payable.length) return false;
          return finish(r.cart, r.payable);
        });
      }

      // One atomic batch: adds and removals together, so the theme's rendered
      // line keys and indices are invalidated once instead of once per line.
      return applyChanges(wanted, removals)
        // Trust nothing: re-read and see what is actually in the cart. This is
        // what keeps the popup honest — a gift that failed to add (sold out,
        // inventory policy "deny", quantity limits) won't be here — and it's how
        // we catch a removal that silently didn't take effect.
        .then(readCart)
        .then(dropPayableGifts)
        .then(function (r) { return finish(r.cart, r.payable); });
    });
  }

  // ---- popup ---------------------------------------------------------------
  var timer;
  function popup(text) {
    var el = document.getElementById("tsf-gift-popup");
    if (!el) return;
    el.querySelector(".tsf-gift-popup__text").textContent = text;
    el.hidden = false;
    requestAnimationFrame(function () { el.setAttribute("data-show", "true"); });
    clearTimeout(timer);
    timer = setTimeout(function () {
      el.setAttribute("data-show", "false");
      pendingToast = null;
      setTimeout(function () { el.hidden = true; }, 300);
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
    readCart()
      .then(function (cart) {
        var sig = signature(cart);
        if (sig === lastSig) return;
        lastSig = sig;
        reconcile();
      })
      .catch(function () {});
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
      p.then(function () { maybeReconcile(); }).catch(function () {});
    } else {
      setTimeout(maybeReconcile, 300);
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
    var url = arguments[0] && (arguments[0].url || arguments[0]);
    var init = arguments[1];
    if (typeof url === "string" && /\/cart\/(add|change|update|clear)/.test(url)) {
      rememberSections(init && init.body);
      var p = origFetch.apply(this, arguments);
      if (!standardEventsSeen) {
        p.then(function () { setTimeout(maybeReconcile, 300); }).catch(function () {});
      }
      return p;
    }
    return origFetch.apply(this, arguments);
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
      if (!standardEventsSeen) {
        this.addEventListener("load", function () { setTimeout(maybeReconcile, 300); });
      }
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
