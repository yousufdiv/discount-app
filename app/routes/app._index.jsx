// app/routes/app._index.jsx
// Uses Polaris web components (loaded via polaris.js in root). No @shopify/polaris import.
import { useActionData, useLoaderData, useNavigate, useSubmit } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getTiersWithHealth, deleteTier, setTierEnabled } from "../models/gift-discounts.server";

const TYPE_LABELS = {
  order_subtotal: "Order subtotal",
  collection_subtotal: "Collection subtotal",
  collection_contains: "Has collection item",
};

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  return { tiers: await getTiersWithHealth(admin) };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const id = form.get("id");
  // Never let a failed tier operation take down the whole page — an unhandled
  // throw here rendered a raw stack trace instead of letting the merchant retry.
  try {
    if (intent === "delete") await deleteTier(admin, id);
    if (intent === "pause") await setTierEnabled(admin, id, false);
    if (intent === "resume") await setTierEnabled(admin, id, true);
  } catch (e) {
    return { ok: false, error: e?.message ?? "Something went wrong." };
  }
  return { ok: true };
}

export default function Index() {
  const { tiers } = useLoaderData();
  const actionData = useActionData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const broken = tiers.filter((t) => t.broken);

  const money = (n) => `Rs${Number(n).toLocaleString("en-PK")}`;
  const act = (intent, id) => submit({ intent, id }, { method: "post" });
  const condition = (t) =>
    t.type === "collection_contains" ? "≥ 1 item" : `≥ ${money(t.threshold)}`;

  // Tiers created before these fields existed have no timestamps — show a dash
  // rather than "Invalid Date".
  const when = (iso) =>
    iso
      ? new Date(iso).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" })
      : "—";

  return (
    <s-page>
      <TitleBar title="Free Gift Tiers">
        <button variant="primary" onClick={() => navigate("/app/gifts/new")}>
          Add tier
        </button>
      </TitleBar>

      <s-section>
        {actionData?.error && <s-banner tone="critical">{actionData.error}</s-banner>}

        {broken.length > 0 && (
          <s-banner tone="critical" heading="The Free Gift discount isn't running">
            <s-paragraph>
              All tiers are powered by a single automatic discount named “Free Gift”, and it is
              currently missing or inactive in Shopify. Until it runs, no gift can be made free —
              the storefront will keep taking gifts back out of the cart rather than let a customer
              be charged for one. Save any tier below to rebuild it.
            </s-paragraph>
          </s-banner>
        )}

        <s-banner tone="info">
          All tiers share one automatic discount powered by this app's discount function, so tiers
          stack: a Rs 5,000 tier and a Rs 10,000 tier both pay out on a Rs 12,000 cart. The gift is
          auto-added in the cart by the Free Gift theme app embed (enable it under Theme editor →
          App embeds), and the function makes it free at checkout — but only when the tier's
          condition genuinely holds.
        </s-banner>
      </s-section>

      <s-section heading="Tiers">
        {tiers.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-heading>Create your first gift tier</s-heading>
            <s-paragraph>Reward customers with a free gift based on order value or a collection.</s-paragraph>
            <s-button variant="primary" onClick={() => navigate("/app/gifts/new")}>Add tier</s-button>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            {tiers.map((t, i) => (
              <div key={t.id}>
                {i > 0 && <s-divider />}
                <s-box padding="base">
                  <s-stack direction="inline" gap="large" inlineAlignment="space-between" blockAlignment="center">
                    <s-stack direction="block" gap="small-200">
                      <s-text fontWeight="bold">{t.name}</s-text>
                      <s-text tone="subdued">
                        {TYPE_LABELS[t.type]} · {condition(t)} · Gift: {t.giftProductTitle}
                      </s-text>
                      <s-text tone="subdued">
                        Created {when(t.createdAt)} · Updated {when(t.updatedAt)}
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="small" blockAlignment="center">
                      {t.broken ? (
                        <s-badge tone="critical">
                          {t.discountStatus
                            ? `Discount ${t.discountStatus.toLowerCase()}`
                            : "Discount missing"}
                        </s-badge>
                      ) : (
                        <s-badge tone={t.enabled ? "success" : "warning"}>
                          {t.enabled ? "Active" : "Paused"}
                        </s-badge>
                      )}

                      <s-button
                        commandFor={`tier-menu-${t.id}`}
                        icon="menu-vertical"
                        variant="tertiary"
                        accessibilityLabel={`Actions for ${t.name}`}
                      ></s-button>
                      <s-menu id={`tier-menu-${t.id}`} accessibilityLabel={`Actions for ${t.name}`}>
                        <s-button icon="edit" onClick={() => navigate(`/app/gifts/${t.id}`)}>
                          Edit
                        </s-button>
                        {/* A broken tier can't be resumed — there's no discount to
                            activate. Editing and saving rebuilds it. */}
                        {!t.broken &&
                          (t.enabled ? (
                            <s-button onClick={() => act("pause", t.id)}>Pause</s-button>
                          ) : (
                            <s-button onClick={() => act("resume", t.id)}>Activate</s-button>
                          ))}
                        <s-button icon="delete" tone="critical" onClick={() => act("delete", t.id)}>
                          Delete
                        </s-button>
                      </s-menu>
                    </s-stack>
                  </s-stack>
                </s-box>
              </div>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}