// app/models/gift-discounts.server.js
//
// ONE automatic app discount, backed by our Discount Function, covers every tier.
//
// It used to be one native Buy X Get Y discount per tier, and that could not work.
// A BXGY discount *consumes* the cart items that satisfy its "customer buys"
// condition, and separate BXGY discounts compete for the same items — with three
// tiers the first two ate the qualifying spend and the third had nothing left, so
// its gift was never discounted. BXGY also has no "any product" condition, which
// forced an auto-created "All products" smart collection, and that collection
// overlapped the merchant's real collections and made the competition worse.
//
// The function evaluates all tiers itself, in one pass over one cart, so tiers
// stack cleanly: Rs 5,000 and Rs 10,000 both pay out on a Rs 12,000 cart.
//
// Two copies of the tier config, for two different readers:
//   SHOP metafield (storefront PUBLIC_READ) -> the theme, which adds/removes the
//     gift line. Needs numeric ids, because it matches against /cart.js.
//   DISCOUNT metafield -> the function, which decides which gift lines are free.
//     Needs GIDs, because it matches against merchandise.product.id.
// upsertTier writes both, so they can't drift apart.

export const SHOP_NS = "theskinfit_gift";
export const SHOP_KEY = "gift_tiers";

// Where we remember the single app discount we own.
const DISCOUNT_ID_KEY = "discount_node";

// Must match the `handle` in extensions/free-gift-discount/shopify.extension.toml.
const FUNCTION_HANDLE = "free-gift-discount";
const DISCOUNT_TITLE = "Free Gift";

// Matches the definition declared in shopify.app.toml:
//   [discount.metafields.app.function-configuration]
// which the function reads as metafield(namespace: "$app", key: "function-configuration").
// On the write side MetafieldInput documents the namespace as alphanumeric,
// hyphen and underscore only, so the reserved `$app` form may be rejected there —
// hence the fallback list rather than a single guess.
const FN_CONFIG_KEY = "function-configuration";
const FN_CONFIG_NAMESPACES = ["$app", "app"];

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

/**
 * True when a mutation failed because the discount is no longer there — the
 * merchant deleted it directly in the Shopify admin. Shopify reports this as
 * "Automatic discount does not exist."
 */
function isMissingDiscount(err) {
  const m = String(err?.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("not found");
}

function isNamespaceError(err) {
  const m = String(err?.message ?? "").toLowerCase();
  return m.includes("namespace");
}

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

async function giftDetails(admin, giftProductGid) {
  const d = await gql(
    admin,
    `#graphql
    query P($id: ID!) {
      product(id: $id) {
        title
        variants(first: 1) { nodes { id } }
      }
    }`,
    { id: giftProductGid },
  );
  const variantGid = d?.product?.variants?.nodes?.[0]?.id ?? null;
  return { title: d?.product?.title ?? "Gift", variantGid, variantId: numId(variantGid) };
}

// ---------------------------------------------------------------------------
// The single app discount
// ---------------------------------------------------------------------------
/** Only what the function actually needs — the metafield has a size limit. */
function functionConfig(tiers) {
  return JSON.stringify({
    tiers: tiers
      .filter((t) => t.enabled !== false)
      .map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        threshold: t.threshold,
        thresholdMax: t.thresholdMax ?? null,
        enabled: true,
        collectionProductGids: t.collectionProductGids ?? [],
      })),
  });
}

function discountInput(tiers, namespace) {
  return {
    title: DISCOUNT_TITLE,
    functionHandle: FUNCTION_HANDLE,
    startsAt: new Date(0).toISOString(),
    discountClasses: ["PRODUCT"],
    // A gift must still be free when the customer is already using another
    // promotion, so opt into combining with every class.
    combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
    metafields: [
      { namespace, key: FN_CONFIG_KEY, type: "json", value: functionConfig(tiers) },
    ],
  };
}

/**
 * Run `mutate(namespace)` against each candidate namespace until one is accepted.
 * Only namespace rejections are retried; anything else is a real failure.
 */
async function withConfigNamespace(mutate) {
  let lastErr = null;
  for (const ns of FN_CONFIG_NAMESPACES) {
    try {
      return await mutate(ns);
    } catch (e) {
      if (!isNamespaceError(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Could not write the function configuration metafield.");
}

async function createDiscount(admin, tiers) {
  const id = await withConfigNamespace(async (namespace) => {
    const d = await gql(
      admin,
      `#graphql
      mutation CreateGiftDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
      { automaticAppDiscount: discountInput(tiers, namespace) },
    );
    const errs = d.discountAutomaticAppCreate.userErrors;
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
    return d.discountAutomaticAppCreate.automaticAppDiscount.discountId;
  });
  await writeShopMetafield(admin, DISCOUNT_ID_KEY, id, "single_line_text_field");
  return id;
}

async function updateDiscount(admin, id, tiers) {
  await withConfigNamespace(async (namespace) => {
    const d = await gql(
      admin,
      `#graphql
      mutation UpdateGiftDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
          userErrors { field message }
        }
      }`,
      { id, automaticAppDiscount: discountInput(tiers, namespace) },
    );
    const errs = d.discountAutomaticAppUpdate.userErrors;
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  });
}

/**
 * Push the current tier list into the function's configuration, creating the
 * discount on first use. Self-heals if the merchant deleted it in the admin.
 */
async function syncDiscount(admin, tiers) {
  const storedId = await readShopMetafield(admin, DISCOUNT_ID_KEY);
  if (!storedId) return createDiscount(admin, tiers);
  try {
    await updateDiscount(admin, storedId, tiers);
    return storedId;
  } catch (e) {
    if (!isMissingDiscount(e)) throw e;
    return createDiscount(admin, tiers);
  }
}

/**
 * Delete the leftover per-tier BXGY discounts from the old design. Called on
 * save, so the first save after upgrading cleans up automatically instead of
 * leaving stale discounts fighting the function for the same cart items.
 */
async function removeLegacyBxgyDiscounts(admin, tiers) {
  const ids = tiers.map((t) => t.discountNodeId).filter(Boolean);
  for (const id of ids) {
    await gql(
      admin,
      `#graphql
      mutation DelLegacy($id: ID!) {
        discountAutomaticDelete(id: $id) { userErrors { field message } }
      }`,
      { id },
    ).catch(() => {}); // already gone, or not ours any more — either way, move on
  }
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

  const idx = tiers.findIndex((t) => t.id === tier.id);
  if (idx >= 0) tiers[idx] = tier;
  else tiers.push(tier);

  await removeLegacyBxgyDiscounts(admin, tiers);
  // The function is the source of truth for what is free, so it has to know
  // about the tier before the theme starts handing its gift out.
  await syncDiscount(admin, tiers);
  await persistTiers(admin, tiers.map(({ discountNodeId, ...rest }) => rest));
  return tier;
}

// ---------------------------------------------------------------------------
// Pause / resume and delete — all just reshape the one discount's config
// ---------------------------------------------------------------------------
export async function setTierEnabled(admin, id, enabled) {
  const tiers = await getTiers(admin);
  const tier = tiers.find((t) => t.id === id);
  if (!tier) return;

  tier.enabled = enabled;
  tier.updatedAt = new Date().toISOString();
  await syncDiscount(admin, tiers);
  await persistTiers(admin, tiers);
}

export async function deleteTier(admin, id) {
  const tiers = await getTiers(admin);
  const tier = tiers.find((t) => t.id === id);
  const remaining = tiers.filter((t) => t.id !== id);

  // Clean up the tier's own legacy BXGY discount, if it still has one.
  if (tier?.discountNodeId) await removeLegacyBxgyDiscounts(admin, [tier]);

  await syncDiscount(admin, remaining);
  await persistTiers(admin, remaining);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
/**
 * Tiers annotated with the state of the one discount that backs them all. If it
 * is missing or inactive, no gift can be made free, and the merchant needs to
 * know before customers start seeing gifts they'd be charged for.
 */
export async function getTiersWithHealth(admin) {
  const tiers = await getTiers(admin);
  if (!tiers.length) return [];

  let status = null;
  let checked = false;
  try {
    const storedId = await readShopMetafield(admin, DISCOUNT_ID_KEY);
    if (storedId) {
      const d = await gql(
        admin,
        `#graphql
        query GiftDiscountHealth($id: ID!) {
          node(id: $id) {
            ... on DiscountAutomaticNode {
              automaticDiscount {
                __typename
                ... on DiscountAutomaticApp { status }
              }
            }
          }
        }`,
        { id: storedId },
      );
      status = d?.node?.automaticDiscount?.status ?? null;
    }
    checked = true;
  } catch {
    // Fail OPEN: reporting a healthy tier as broken switches off a working
    // promotion, which is worse than being slow to notice a broken one. The
    // storefront's own "a gift must be free" check is the real safety net.
    checked = false;
  }

  // A tier is only broken if we actually established that the discount is gone
  // or not running.
  const broken = checked && status !== "ACTIVE";
  return tiers.map((t) => ({
    ...t,
    discountStatus: status,
    broken: broken && t.enabled !== false,
  }));
}
