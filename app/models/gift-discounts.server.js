// app/models/gift-discounts.server.js
//
// The gift is a Rs 0 variant. No discount is involved at all.
//
// Two earlier designs are worth knowing about, because both are dead ends:
//
//   1. One native Buy X Get Y discount per tier. A BXGY discount *consumes* the
//      cart items satisfying its "customer buys" condition, and separate BXGY
//      discounts compete for the same items — with three tiers the first two ate
//      the qualifying spend and the third's gift was never discounted.
//   2. One automatic app discount backed by our Discount Function. Correct, and it
//      passed every test — on a development store. Shopify only lets stores on the
//      Shopify Plus plan use functions from a CUSTOM app ("Shop must be on a
//      Shopify Plus plan to activate functions from a custom app"), and this app is
//      custom-distribution. Public App Store apps have no such restriction, which
//      is why competing apps manage it.
//      https://shopify.dev/docs/apps/build/functions
//
// So the gift carries no price to discount away: the merchant creates a Rs 0
// variant, and the theme adds and removes that line. Every tier rule — thresholds,
// the min/max window, collection conditions — lives in the theme script, which was
// already the only thing deciding WHICH gift to add. Nothing is lost, and it works
// on every plan.
//
// The safety net moves accordingly. There is no discount whose absence could charge
// a customer; instead the gift variant's PRICE is the thing that must be zero, so
// that is what getTiersWithHealth checks, and the theme independently pulls any
// gift line it finds with a non-zero price.
//
// The discount function in extensions/free-gift-discount is deliberately left in
// place, unused: it becomes correct again the day this ships as a public app.

export const SHOP_NS = "theskinfit_gift";
export const SHOP_KEY = "gift_tiers";

// Where a previous version recorded the app discount it created. Still read, so a
// store that ran that version gets the stale discount cleaned up on the next save.
const DISCOUNT_ID_KEY = "discount_node";

const numId = (gid) => (gid ? Number(String(gid).split("/").pop()) : null);

/**
 * An optional upper bound on a tier's threshold, so a tier can be a window
 * ("gift on orders of Rs 6,000 to Rs 7,999") instead of a floor. Blank, zero and
 * anything unparseable all mean no cap — tiers saved before this field existed
 * must keep behaving as open-ended.
 */
const capOrNull = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

// ---------------------------------------------------------------------------
// Shop-level config: the tier list the theme reads
// ---------------------------------------------------------------------------
async function readShopMetafield(admin, key) {
  const d = await gql(
    admin,
    `#graphql
    query ShopConfig($ns: String!, $key: String!) {
      shop { metafield(namespace: $ns, key: $key) { value } }
    }`,
    { ns: SHOP_NS, key },
  );
  return d?.shop?.metafield?.value ?? null;
}

export async function getTiers(admin) {
  try {
    const v = await readShopMetafield(admin, SHOP_KEY);
    return v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
}

async function writeShopMetafield(admin, key, value, type = "json") {
  const { shop } = await gql(admin, `#graphql
    query { shop { id } }`);
  const d = await gql(
    admin,
    `#graphql
    mutation Save($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { metafields: [{ ownerId: shop.id, namespace: SHOP_NS, key, type, value }] },
  );
  const errs = d.metafieldsSet.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
}

async function persistTiers(admin, tiers) {
  await writeShopMetafield(admin, SHOP_KEY, JSON.stringify(tiers));
}

/**
 * Ensure the shop metafield is defined with storefront read access so the theme
 * can read shop.metafields.theskinfit_gift.gift_tiers. Safe to call repeatedly.
 */
export async function ensureDefinition(admin) {
  await gql(
    admin,
    `#graphql
    mutation Def($def: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $def) {
        userErrors { code message }
      }
    }`,
    {
      def: {
        name: "Free Gift Tiers",
        namespace: SHOP_NS,
        key: SHOP_KEY,
        type: "json",
        ownerType: "SHOP",
        access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" },
      },
    },
  ).catch(() => {}); // ignore TAKEN
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Collection members in both shapes: numeric ids for the theme, GIDs for the function. */
async function cacheCollectionProducts(admin, collectionGid) {
  const gids = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const d = await gql(
      admin,
      `#graphql
      query Coll($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: collectionGid, cursor },
    );
    const conn = d?.collection?.products;
    if (!conn) break;
    conn.nodes.forEach((n) => gids.push(n.id));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { gids, ids: gids.map(numId) };
}

/**
 * The variant to hand out as the gift, and what it costs.
 *
 * The merchant picks a PRODUCT, so we choose the variant — and we deliberately
 * prefer a Rs 0 one. That is the whole mechanism now: a gift product typically has
 * its normal saleable variant alongside a Rs 0 "gift" variant, and blindly taking
 * `variants(first: 1)` would hand out the paid one and charge the customer for
 * their gift.
 *
 * The price comes back with it so the caller can record it and warn the merchant
 * when no free variant exists.
 */
async function giftDetails(admin, giftProductGid) {
  const d = await gql(
    admin,
    `#graphql
    query P($id: ID!) {
      product(id: $id) {
        title
        variants(first: 100) { nodes { id price } }
      }
    }`,
    { id: giftProductGid },
  );
  const nodes = d?.product?.variants?.nodes ?? [];
  const free = nodes.find((v) => Number(v.price) === 0);
  const chosen = free ?? nodes[0] ?? null;
  return {
    title: d?.product?.title ?? "Gift",
    variantGid: chosen?.id ?? null,
    variantId: numId(chosen?.id),
    variantPrice: chosen ? Number(chosen.price) : null,
  };
}

// ---------------------------------------------------------------------------
// Cleaning up after the two designs that came before
// ---------------------------------------------------------------------------
async function deleteAutomaticDiscount(admin, id) {
  await gql(
    admin,
    `#graphql
    mutation DelDiscount($id: ID!) {
      discountAutomaticDelete(id: $id) { userErrors { field message } }
    }`,
    { id },
  ).catch(() => {}); // already gone, or not ours any more — either way, move on
}

/**
 * Delete the leftover per-tier BXGY discounts from the oldest design.
 */
async function removeLegacyBxgyDiscounts(admin, tiers) {
  for (const id of tiers.map((t) => t.discountNodeId).filter(Boolean)) {
    await deleteAutomaticDiscount(admin, id);
  }
}

/**
 * Delete the single "Free Gift" app discount, if a previous version of this app
 * managed to create one.
 *
 * This matters on any store where the function version worked — a development
 * store, or a Plus store. Left behind, that discount would keep running the
 * function against a configuration nobody updates any more, and could zero a line
 * the theme no longer considers a gift. Nothing reads it now, so it has to go.
 */
async function removeManagedAppDiscount(admin) {
  const storedId = await readShopMetafield(admin, DISCOUNT_ID_KEY);
  if (!storedId) return;
  await deleteAutomaticDiscount(admin, storedId);
  // Clear the pointer too, so this runs once rather than on every save.
  await writeShopMetafield(admin, DISCOUNT_ID_KEY, "", "single_line_text_field").catch(() => {});
}

// ---------------------------------------------------------------------------
// Create / update a tier
// ---------------------------------------------------------------------------
export async function upsertTier(admin, form) {
  await ensureDefinition(admin);
  const tiers = await getTiers(admin);
  const existing = form.id ? tiers.find((t) => t.id === form.id) : null;

  const tier = {
    id: form.id || `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: form.name?.trim() || "Free gift tier",
    type: form.type,
    threshold: form.type === "collection_contains" ? 0 : Number(form.threshold) || 0,
    thresholdMax: form.type === "collection_contains" ? null : capOrNull(form.thresholdMax),
    collectionGid: form.collectionGid || null,
    collectionId: numId(form.collectionGid),
    collectionProductIds: [],  // numeric, for the theme
    collectionProductGids: [], // GIDs, for the function
    giftProductGid: form.giftProductGid,
    giftProductId: numId(form.giftProductGid),
    giftVariantGid: null,
    giftVariantId: null,
    giftVariantPrice: null,
    giftProductTitle: "",
    enabled: form.enabled !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (tier.type !== "order_subtotal" && tier.collectionGid) {
    const members = await cacheCollectionProducts(admin, tier.collectionGid);
    tier.collectionProductIds = members.ids;
    tier.collectionProductGids = members.gids;
  }
  const gift = await giftDetails(admin, tier.giftProductGid);
  tier.giftProductTitle = gift.title;
  tier.giftVariantGid = gift.variantGid;
  tier.giftVariantId = gift.variantId;
  tier.giftVariantPrice = gift.variantPrice;

  const idx = tiers.findIndex((t) => t.id === tier.id);
  if (idx >= 0) tiers[idx] = tier;
  else tiers.push(tier);

  // Both older designs left automatic discounts behind. Clear them on save so a
  // store that ran either one converges on the Rs 0 variant mechanism instead of
  // having a stale discount still acting on the cart.
  await removeLegacyBxgyDiscounts(admin, tiers);
  await removeManagedAppDiscount(admin);

  // Drop the legacy per-tier discount pointer as the list is rewritten — the
  // discount it referred to has just been deleted.
  await persistTiers(
    admin,
    tiers.map((t) => {
      const copy = { ...t };
      delete copy.discountNodeId;
      return copy;
    }),
  );
  return tier;
}

// ---------------------------------------------------------------------------
// Pause / resume and delete — the tier list is the only state there is
// ---------------------------------------------------------------------------
export async function setTierEnabled(admin, id, enabled) {
  const tiers = await getTiers(admin);
  const tier = tiers.find((t) => t.id === id);
  if (!tier) return;

  tier.enabled = enabled;
  tier.updatedAt = new Date().toISOString();
  await persistTiers(admin, tiers);
}

export async function deleteTier(admin, id) {
  const tiers = await getTiers(admin);
  const tier = tiers.find((t) => t.id === id);

  // Clean up the tier's own legacy BXGY discount, if it still has one.
  if (tier?.discountNodeId) await removeLegacyBxgyDiscounts(admin, [tier]);

  await persistTiers(admin, tiers.filter((t) => t.id !== id));
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
/**
 * Tiers annotated with whether their gift is actually free.
 *
 * With no discount in the picture, the gift variant's price IS the mechanism. A
 * tier pointed at a priced variant would put a line the customer pays for into
 * their cart and call it a gift, so this is the one thing worth checking — and it
 * is checked live, because a merchant can edit the price in Shopify long after the
 * tier was saved.
 */
export async function getTiersWithHealth(admin) {
  const tiers = await getTiers(admin);
  if (!tiers.length) return [];

  const ids = [...new Set(tiers.map((t) => t.giftVariantGid).filter(Boolean))];
  let livePrice = null;
  try {
    if (ids.length) {
      const d = await gql(
        admin,
        `#graphql
        query GiftVariantPrices($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant { id price }
          }
        }`,
        { ids },
      );
      livePrice = new Map(
        (d?.nodes ?? []).filter(Boolean).map((v) => [v.id, Number(v.price)]),
      );
    } else {
      livePrice = new Map();
    }
  } catch {
    // Fail OPEN: flagging a working tier as broken switches off a live promotion,
    // which is worse than being slow to notice a broken one. The theme does its own
    // check on every cart — it removes any gift line with a price — so a
    // misconfigured tier still can't charge a customer while we're in the dark.
    livePrice = null;
  }

  return tiers.map((t) => {
    if (!livePrice) return { ...t, broken: false, brokenReason: null };

    let reason = null;
    if (!t.giftVariantGid) reason = "No gift variant";
    else if (!livePrice.has(t.giftVariantGid)) reason = "Gift variant deleted";
    else if (livePrice.get(t.giftVariantGid) > 0) reason = "Gift is not free";

    return {
      ...t,
      giftVariantPrice: livePrice.get(t.giftVariantGid) ?? t.giftVariantPrice ?? null,
      broken: !!reason && t.enabled !== false,
      brokenReason: reason,
    };
  });
}
