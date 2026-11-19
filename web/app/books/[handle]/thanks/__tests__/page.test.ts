import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => null) }));
const hubMock = vi.hoisted(() => ({
  creator: { handle: "e2e_live_creator", display_name: "E2E Live Creator", products: [] },
  origin: "https://expanpress.com",
}));
vi.mock("../../../../../src/components/storefront/storefront", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../src/components/storefront/storefront")>()),
  fetchCreatorHub: vi.fn(async () => hubMock),
}));

import { GLOBAL } from "../../../../../../payments/src/settings_registry";
import ThankYouPage, { generateMetadata } from "../page";

async function render() {
  return renderToStaticMarkup(await ThankYouPage({ params: Promise.resolve({ handle: "e2e_live_creator" }) }));
}

describe("thank-you page (/books/{handle}/thanks)", () => {
  it("says the download link is on its way by email", async () => {
    const html = await render();
    expect(html).toContain("<h1");
    expect(html).toContain("Thank you, your download link is on its way by email");
  });

  it("shows the registry delivery timing and support address without 'check your spam'", async () => {
    const html = await render();
    expect(GLOBAL.delivery.buyer_typical_minutes).toBe(2);
    expect(GLOBAL.delivery.buyer_support_after_hours).toBe(1);
    expect(GLOBAL.email.reply_to).toBe("support@expanpress.com");
    expect(html).toContain(
      "Your e-book is on its way to the email you used at checkout, usually within 2 minutes. If it has not arrived within 1 hour, email support@expanpress.com and we will send it by hand.",
    );
    expect(html.toLowerCase()).not.toContain("spam");
    expect(html).toContain(`Support: ${GLOBAL.email.reply_to}`);
  });

  it("links back to the creator's books with a curly apostrophe", async () => {
    const html = await render();
    expect(html).toContain('href="/books/e2e_live_creator"');
    expect(html).toContain("Back to E2E Live Creator\u2019s books");
    expect(html).not.toContain("&#x27;");
  });

  it("drops the trailing brand suffix in generateMetadata when creator display name is the brand itself", async () => {
    hubMock.creator = { handle: "e2e_live_creator", display_name: "E2E Live Creator", products: [] };
    const creatorMeta = await generateMetadata({ params: Promise.resolve({ handle: "e2e_live_creator" }) });
    expect(creatorMeta.title).toBe("Thank you · E2E Live Creator · ExpanPress");

    hubMock.creator = { handle: "expanpress_house", display_name: GLOBAL.storefront.brand_name, products: [] };
    const houseMeta = await generateMetadata({ params: Promise.resolve({ handle: "expanpress_house" }) });
    expect(houseMeta.title).toBe("Thank you · ExpanPress");
    hubMock.creator = { handle: "e2e_live_creator", display_name: "E2E Live Creator", products: [] };
  });

  it("sends the logo to the B2C landing, not the B2B root", async () => {
    const html = await render();
    expect(html).toContain(`href="${GLOBAL.storefront.b2c_landing_url}"`);
    expect(html).not.toMatch(/href="\/"/);
  });
});
