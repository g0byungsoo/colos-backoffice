import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../config/index.js";
import { LocalDataSource } from "../data/index.js";
import { approveInvoice, previewInvoice, sendInvoice } from "./invoices.js";
import { parseOfferEmail } from "./negotiation.js";

const fake = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  createInvoice: vi.fn(),
  retrieveInvoice: vi.fn(),
  listItems: vi.fn(),
  createItem: vi.fn(),
  finalize: vi.fn(),
  send: vi.fn(),
}));
vi.mock("stripe", () => ({
  default: class {
    customers = { create: fake.createCustomer };
    invoices = {
      create: fake.createInvoice,
      retrieve: fake.retrieveInvoice,
      finalizeInvoice: fake.finalize,
      sendInvoice: fake.send,
    };
    invoiceItems = { list: fake.listItems, create: fake.createItem };
  },
}));
const config = getConfig({
  DATA_SOURCE: "local",
  STRIPE_SECRET_KEY: "sk_test_unit",
});
const now = new Date("2026-11-11T19:00:00Z");
const invoice = () => ({
  id: "in_test",
  customer: "cus_test",
  livemode: false,
  currency: "usd",
  status: "draft",
  total: 266000,
  metadata: { colos_invoice_id: "INV-O001-1" },
});
async function approved() {
  const data = new LocalDataSource({ persist: false });
  await previewInvoice(data, config, "O001", { now, method: "card" });
  await approveInvoice(data, config, "O001", { now, method: "card" });
  return data;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.createCustomer.mockResolvedValue({ id: "cus_test" });
  fake.createInvoice.mockResolvedValue(invoice());
  fake.retrieveInvoice.mockResolvedValue(invoice());
  fake.listItems.mockResolvedValue({ data: [], has_more: false });
  fake.createItem.mockResolvedValue({ id: "ii_test" });
  fake.finalize.mockResolvedValue({ ...invoice(), status: "open" });
  fake.send.mockResolvedValue({ ...invoice(), status: "open" });
});
describe("invoice retry recovery", () => {
  it("recovers a preview when its approval write failed", async () => {
    const data = new LocalDataSource({ persist: false });
    const write = data.upsert.bind(data);
    let fail = true;
    vi.spyOn(data, "upsert").mockImplementation(
      async (table, row, expected) => {
        if (table === "Approvals" && fail) {
          fail = false;
          throw new Error("write unavailable");
        }
        return write(table, row, expected);
      },
    );
    await expect(previewInvoice(data, config, "O001", { now })).rejects.toThrow(
      "write unavailable",
    );
    await previewInvoice(data, config, "O001", { now });
    expect(await data.read("Invoices")).toHaveLength(1);
    expect(await data.read("Approvals")).toHaveLength(1);
    expect(
      (await approveInvoice(data, config, "O001", { now })).invoice.status,
    ).toBe("approved");
  });
  it("retains the Stripe identity when an item request fails", async () => {
    const data = await approved();
    fake.createItem.mockRejectedValueOnce(new Error("response lost"));
    await expect(
      sendInvoice(data, config, "O001", { now, method: "card" }),
    ).rejects.toThrow("response lost");
    expect((await data.read("Invoices"))[0].stripe_invoice_id).toBe("in_test");
    // Simulate an item that Stripe created before the client lost the response.
    fake.listItems.mockResolvedValue({
      data: [
        {
          amount: 266000,
          currency: "usd",
          metadata: { colos_invoice_id: "INV-O001-1" },
        },
      ],
      has_more: false,
    });
    await sendInvoice(data, config, "O001", { now, method: "card" });
    expect(fake.createInvoice).toHaveBeenCalledTimes(1);
    expect(fake.createItem).toHaveBeenCalledTimes(1);
    expect(fake.retrieveInvoice).toHaveBeenCalledWith("in_test");
  });
  it("serializes concurrent sends sharing a data source", async () => {
    const data = await approved();
    const results = await Promise.all([
      sendInvoice(data, config, "O001", { now }),
      sendInvoice(data, config, "O001", { now }),
    ]);
    expect(results.some((result) => result.already_sent)).toBe(true);
    expect(fake.createInvoice).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(await data.read("Outbox")).toHaveLength(1);
  });
  it("refuses altered Stripe items rather than finalizing them", async () => {
    const data = await approved();
    fake.listItems.mockResolvedValue({
      data: [{ amount: 1, currency: "usd", metadata: {} }],
      has_more: false,
    });
    await expect(sendInvoice(data, config, "O001", { now })).rejects.toThrow(
      "differs from approved",
    );
    expect(fake.finalize).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
  });
  it("retries an Outbox failure without losing the pending send", async () => {
    const data = await approved();
    const write = data.upsert.bind(data);
    let fail = true;
    vi.spyOn(data, "upsert").mockImplementation(
      async (table, row, expected) => {
        if (table === "Outbox" && fail) {
          fail = false;
          throw new Error("outbox unavailable");
        }
        return write(table, row, expected);
      },
    );
    await expect(sendInvoice(data, config, "O001", { now })).rejects.toThrow(
      "outbox unavailable",
    );
    expect((await data.read("Invoices"))[0].status).toBe("approved");
    fake.retrieveInvoice.mockResolvedValue({ ...invoice(), status: "open" });
    await sendInvoice(data, config, "O001", { now });
    expect(fake.createInvoice).toHaveBeenCalledTimes(1);
    expect(fake.createItem).toHaveBeenCalledTimes(1);
    expect(fake.send.mock.calls[0][2]).toEqual(fake.send.mock.calls[1][2]);
    expect((await data.read("Invoices"))[0].status).toBe("sent");
    expect(await data.read("Outbox")).toHaveLength(1);
  });
  it("rejects ambiguous offer headers", () => {
    expect(() =>
      parseOfferEmail("Order: O001\nOffer-Cents: 200000\nOffer: $2800.00"),
    ).toThrow("exactly one");
    expect(() =>
      parseOfferEmail("Order: O001\nOrder: O002\nOffer: $2800.00"),
    ).toThrow("exactly one");
  });
});
