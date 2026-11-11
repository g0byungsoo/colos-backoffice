import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDataSource } from "../data/local.js";
import { FakeEmbedder, RagIndex } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

describe("index integrity", () => {
  async function tinyCorpus() {
    const fixture = await setup();
    await fixture.data.replace(
      "Knowledge",
      [
        {
          doc_id: "test",
          title: "Pickup",
          body_markdown: "Bring the release number.",
          status: "current",
          updated_at: "2026-11-01T00:00:00Z",
        },
      ],
      true,
    );
    await fixture.data.replace("Notes", [], true);
    return fixture;
  }
  it("keeps source metadata fresh without embedding unchanged text", async () => {
    const { data, index } = await tinyCorpus();
    expect((await index.build()).embedded).toBe(1);
    const before = (await data.read("Knowledge"))[0];
    await data.upsert(
      "Knowledge",
      { ...before, updated_at: "2026-11-02T00:00:00Z", status: "superseded" },
      before,
    );
    expect((await index.build()).embedded).toBe(0);
    expect(await index.search("release", { mode: "bm25" })).toEqual([]);
    const archive = await index.search("release", {
      mode: "bm25",
      include_superseded: true,
    });
    expect(archive[0].updated_at).toBe("2026-11-02T00:00:00Z");
  });
  it("allows concurrent cache writers without sharing temporary paths", async () => {
    const { data, cacheDir } = await tinyCorpus();
    vi.spyOn(Date, "now").mockReturnValue(1);
    const indexes = Array.from(
      { length: 8 },
      () => new RagIndex(data, new FakeEmbedder(), { cacheDir }),
    );
    const results = await Promise.all(indexes.map((index) => index.build()));
    expect(results.every((result) => result.chunks === 1)).toBe(true);
    expect(
      (await new RagIndex(data, new FakeEmbedder(), { cacheDir }).build())
        .embedded,
    ).toBe(0);
  });
  it("rejects a truncated embedding batch instead of persisting empty vectors", async () => {
    const { data, cacheDir } = await tinyCorpus();
    const broken = new RagIndex(
      data,
      { name: "broken", tokens: 0, embed: async () => [] },
      { cacheDir },
    );
    await expect(broken.build()).rejects.toThrow("Embedding response");
  });
  it("does not embed empty queries", async () => {
    const { data, cacheDir } = await tinyCorpus();
    const index = new RagIndex(
      data,
      {
        name: "must-not-call",
        tokens: 0,
        embed: async () => {
          throw new Error("Unexpected embedding");
        },
      },
      { cacheDir },
    );
    expect(await index.search("  ")).toEqual([]);
  });
});
