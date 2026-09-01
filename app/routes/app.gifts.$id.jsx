// app/routes/app.gifts.$id.jsx
// Uses Polaris web components (loaded via polaris.js in root). No @shopify/polaris import.
import { useState, useCallback } from "react";
import { useLoaderData, useNavigate, useSubmit, useNavigation, redirect } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getTiers, upsertTier } from "../models/gift-discounts.server";

export async function loader({ request, params }) {
  const { admin } = await authenticate.admin(request);
  if (params.id === "new") return { tier: null };
  const tier = (await getTiers(admin)).find((t) => t.id === params.id);
  if (!tier) throw redirect("/app");
  return { tier };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const f = await request.formData();
  await upsertTier(admin, {
    id: f.get("id") || undefined,
    name: f.get("name"),
    type: f.get("type"),
    threshold: f.get("threshold"),
    thresholdMax: f.get("thresholdMax"),
    enabled: f.get("enabled") === "true",
    collectionGid: f.get("collectionGid") || null,
    giftProductGid: f.get("giftProductGid"),
  });
  return redirect("/app");
}

export default function GiftEditor() {
  const { tier } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const saving = useNavigation().state === "submitting";

  const [name, setName] = useState(tier?.name ?? "");
  const [type, setType] = useState(tier?.type ?? "order_subtotal");
  const [threshold, setThreshold] = useState(String(tier?.threshold ?? ""));
  const [thresholdMax, setThresholdMax] = useState(
    tier?.thresholdMax ? String(tier.thresholdMax) : "",
  );
  const [enabled, setEnabled] = useState(tier?.enabled ?? true);
  const [collectionGid, setCollectionGid] = useState(tier?.collectionGid ?? "");
  const [collectionLabel, setCollectionLabel] = useState(tier?.collectionGid ? "Collection selected" : "");
  const [giftProductGid, setGiftProductGid] = useState(tier?.giftProductGid ?? "");
  const [giftLabel, setGiftLabel] = useState(tier?.giftProductTitle ?? "");

  const needsCollection = type !== "order_subtotal";
  const needsThreshold = type !== "collection_contains";

  // A blank cap is the normal case: the tier stays open-ended. A cap that isn't
  // above the threshold would be a tier that can never fire, so block the save
  // rather than let the merchant publish a dead tier.
  const capValue = Number(thresholdMax);
  const hasCap = thresholdMax !== "" && Number.isFinite(capValue);
  const capError =
    hasCap && capValue <= Number(threshold)
      ? "The maximum must be higher than the threshold."
      : "";

  const pickCollection = useCallback(async () => {
    const sel = await window.shopify.resourcePicker({ type: "collection", multiple: false });
    if (sel?.length) {
      setCollectionGid(sel[0].id);
      setCollectionLabel(sel[0].title);
    }
  }, []);

  const pickGift = useCallback(async () => {
    const sel = await window.shopify.resourcePicker({ type: "product", multiple: false, action: "select" });
    if (sel?.length) {
      setGiftProductGid(sel[0].id);
      setGiftLabel(sel[0].title);
    }
  }, []);

  const onSave = () => {
    const data = { name, type, threshold, enabled: String(enabled), giftProductGid };
    if (tier?.id) data.id = tier.id;
    if (needsCollection) data.collectionGid = collectionGid;
    // Always send it, blank included — that's how an existing cap gets cleared.
    if (needsThreshold) data.thresholdMax = hasCap ? String(capValue) : "";
    submit(data, { method: "post" });
  };

  const canSave =
    name &&
    giftProductGid &&
    (!needsCollection || collectionGid) &&
    (!needsThreshold || Number(threshold) > 0) &&
    !capError;

  return (
    <s-page>
      <TitleBar title={tier ? "Edit tier" : "New tier"} />
      <s-section>
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Tier name"
            value={name}
            details="Shown to merchants and used as the discount title."
            onChange={(e) => setName(e.currentTarget.value)}
          ></s-text-field>

          <s-select
            label="Condition"
            value={type}
            onChange={(e) => setType(e.currentTarget.value)}
          >
            <s-option value="order_subtotal">Order subtotal reaches a threshold (any products)</s-option>
            <s-option value="collection_subtotal">Subtotal of items from a collection reaches a threshold</s-option>
            <s-option value="collection_contains">Cart contains any item from a collection</s-option>
          </s-select>

          {needsThreshold && (
            <s-stack direction="block" gap="small">
              <s-number-field
                label="Threshold (PKR)"
                value={threshold}
                min="1"
                details="The gift starts at this amount."
                onChange={(e) => setThreshold(e.currentTarget.value)}
              ></s-number-field>
              <s-number-field
                label="Maximum (PKR) — optional"
                value={thresholdMax}
                min="1"
                error={capError || undefined}
                details="Leave blank for no upper limit. Both ends count, so 6000 and 7999 gives the gift from Rs 6,000 up to and including Rs 7,999 — and stops at Rs 8,000."
                onChange={(e) => setThresholdMax(e.currentTarget.value)}
              ></s-number-field>
            </s-stack>
          )}

          {needsCollection && (
            <s-stack direction="block" gap="small">
              <s-text>Collection</s-text>
              <s-stack direction="inline" gap="small" blockAlignment="center">
                <s-button onClick={pickCollection}>
                  {collectionGid ? "Change collection" : "Select collection"}
                </s-button>
                {collectionLabel && <s-text tone="subdued">{collectionLabel}</s-text>}
              </s-stack>
            </s-stack>
          )}

          <s-stack direction="block" gap="small">
            <s-text>Free gift product</s-text>
            <s-stack direction="inline" gap="small" blockAlignment="center">
              <s-button onClick={pickGift}>{giftProductGid ? "Change gift" : "Select gift"}</s-button>
              {giftLabel && <s-text tone="subdued">{giftLabel}</s-text>}
            </s-stack>
          </s-stack>

          <s-checkbox
            label="Active"
            checked={enabled || undefined}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          ></s-checkbox>

          <s-stack direction="inline" gap="small">
            <s-button
              variant="primary"
              loading={saving || undefined}
              disabled={!canSave || undefined}
              onClick={onSave}
            >
              Save tier
            </s-button>
            <s-button onClick={() => navigate("/app")}>Cancel</s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}