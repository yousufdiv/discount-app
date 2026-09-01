import { DiscountClass, ProductDiscountSelectionStrategy } from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

const NO_DISCOUNTS = { operations: [] };

/**
 * Free Gift — makes the gift lines free, one function for every tier.
 *
 * This replaces one automatic Buy X Get Y discount per tier. A BXGY discount
 * *consumes* the cart items that satisfy its "customer buys" condition, and
 * separate BXGY discounts compete for the same items: with three tiers the first
 * two ate the qualifying spend and the third had nothing left, so its gift was
 * never discounted and the storefront had to pull it back out. Judging every
 * tier here, in one pass over one cart, removes that competition completely.
 *
 * It also closes a hole the BXGY setup had. A line is only discounted if it
 * carries the `_gift` attribute we set when granting it AND its tier's condition
 * genuinely holds. A customer who adds a gift SKU to their cart by hand pays for it.
 *
 * The theme script decides which gifts go in the cart; this decides which of them
 * are free. Both read the same tier config, so they can't disagree.
 *
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) return NO_DISCOUNTS;
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) return NO_DISCOUNTS;

  const config = input.discount.metafield?.jsonValue;
  const tiers = config && Array.isArray(config.tiers) ? config.tiers : [];
  if (!tiers.length) return NO_DISCOUNTS;

  // Gift lines carry our attribute; everything else is what the customer chose.
  const giftLines = [];
  const ownLines = [];
  for (const line of input.cart.lines) {
    const tierId = line.giftTier?.value;
    if (tierId) giftLines.push({ line, tierId });
    else ownLines.push(line);
  }
  if (!giftLines.length) return NO_DISCOUNTS;

  const amountOf = (line) => Number(line.cost.subtotalAmount.amount);
  const productIdOf = (line) =>
    line.merchandise.__typename === 'ProductVariant' ? line.merchandise.product.id : null;

  // Thresholds are judged only on the customer's own lines. Counting gift lines
  // would let a gift push the cart over — or under — its own threshold, which is
  // the feedback loop that made tiers flap on the storefront.
  const ownSubtotal = ownLines.reduce((sum, line) => sum + amountOf(line), 0);

  // Collection membership comes from product ids in the config, not from
  // `inAnyCollection`: that field needs its collection ids baked into the input
  // query at deploy time, and they differ per shop and per tier.
  //
  // Accepts both shapes on purpose. Tiers saved before this function existed only
  // cached numeric ids for the theme, so reading GIDs alone would silently make
  // every pre-existing collection tier stop qualifying.
  const collectionMembers = (tier) => {
    const members = new Set(
      Array.isArray(tier.collectionProductGids) ? tier.collectionProductGids : [],
    );
    if (Array.isArray(tier.collectionProductIds)) {
      for (const id of tier.collectionProductIds) {
        members.add(`gid://shopify/Product/${id}`);
      }
    }
    return members;
  };

  const linesInCollection = (tier) => {
    const members = collectionMembers(tier);
    if (!members.size) return [];
    return ownLines.filter((line) => {
      const productId = productIdOf(line);
      return productId !== null && members.has(productId);
    });
  };

  // A tier can be a window rather than a floor: "gift on orders of Rs 6,000 to
  // Rs 7,999" is threshold 6000 with thresholdMax 7999. Both ends are inclusive,
  // and no cap (absent, null, or zero) means the tier stays open-ended, which is
  // what every tier saved before this existed relies on.
  const withinRange = (value, tier) => {
    if (value < Number(tier.threshold ?? 0)) return false;
    const max = Number(tier.thresholdMax);
    return !(max > 0) || value <= max;
  };

  const qualifies = (tier) => {
    switch (tier.type) {
      case 'order_subtotal':
        return withinRange(ownSubtotal, tier);
      case 'collection_contains':
        return linesInCollection(tier).length > 0;
      case 'collection_subtotal':
        return withinRange(
          linesInCollection(tier).reduce((sum, line) => sum + amountOf(line), 0),
          tier,
        );
      default:
        return false;
    }
  };

  const tierById = new Map(tiers.filter((tier) => tier?.id).map((tier) => [tier.id, tier]));

  // Every tier stands on its own: a Rs 5,000 tier and a Rs 10,000 tier both pay
  // out on a Rs 12,000 cart, and a collection tier pays out alongside them.
  const candidates = [];
  const granted = new Set();
  for (const { line, tierId } of giftLines) {
    if (granted.has(tierId)) continue; // one free gift per tier
    const tier = tierById.get(tierId);
    if (!tier || tier.enabled === false) continue;
    if (!qualifies(tier)) continue;
    granted.add(tierId);
    candidates.push({
      message: tier.name || 'Free gift',
      targets: [{ cartLine: { id: line.id, quantity: 1 } }],
      value: { percentage: { value: 100 } },
    });
  }

  if (!candidates.length) return NO_DISCOUNTS;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          // All, not First: each candidate is a separate tier's gift and they must
          // all be discounted. First would make only one gift free.
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
