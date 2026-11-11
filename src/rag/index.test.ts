import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDataSource } from "../data/local.js";
import { FakeEmbedder, RagIndex } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const cacheDir = await mkdtemp(join(tmpdir(), "colos-rag-"));
  directories.push(cacheDir);
  const data = new LocalDataSource({ persist: false });
  return {
    data,
    index: new RagIndex(data, new FakeEmbedder(), { cacheDir }),
    cacheDir,
  };
}
describe("retrieval boundaries and cache", () => {
  it("filters notes by account before lexical, vector, fusion and reranking", async () => {
    const { data, cacheDir } = await setup();
    let inspected = false;
    const index = new RagIndex(data, new FakeEmbedder(), {
      cacheDir,
      reranker: async (_query, results) => {
        inspected = true;
        expect(
          results.every(
            (result) => !result.customer_id || result.customer_id === "C001",
          ),
        ).toBe(true);
        return results;
      },
    });
    for (const mode of ["bm25", "vector", "hybrid", "rerank"] as const) {
      const hits = await index.search(
        "Bramble Ridge Supply invoices truck email",
        { customer_id: "C001", mode, limit: 200 },
      );
      expect(
        hits.every((hit) => !hit.customer_id || hit.customer_id === "C001"),
      ).toBe(true);
      expect(hits.some((hit) => hit.source_id === "N001-4")).toBe(true);
    }
    expect(inspected).toBe(true);
    const anonymous = await index.search("Alder Wharf Works callback", {
      limit: 200,
    });
    expect(anonymous.every((hit) => !hit.customer_id)).toBe(true);
  });
  it("skips superseded policy unless explicitly requested", async () => {
    const { index } = await setup();
    const current = await index.search("seven days reservation hold", {
      limit: 200,
    });
    expect(current.some((hit) => hit.source_id === "K11")).toBe(false);
    const archive = await index.search(
      "superseded seven calendar days reservation policy",
      { include_superseded: true },
    );
    expect(archive[0].source_id).toBe("K11");
  });
  it("reuses content hashes and embeds only an edited note", async () => {
    const { data, index } = await setup();
    expect((await index.build()).embedded).toBeGreaterThan(0);
    expect((await index.build()).embedded).toBe(0);
    const original = (await data.read("Notes"))[0];
    await data.upsert(
      "Notes",
      { ...original, text: `${original.text} Ask for the dispatch desk.` },
      original,
    );
    expect((await index.build()).embedded).toBe(1);
  });
  it("gives each heading a source and timestamp", async () => {
    const { index } = await setup();
    const hits = await index.search("wire payment clear", { mode: "bm25" });
    expect(hits[0].source_id).toBe("K01");
    expect(hits[0].id).toMatch(/^K01#/);
    expect(hits[0].updated_at).toBeTruthy();
  });
});
