import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { Agent, run, setTracingDisabled } from "@openai/agents";
import { z } from "zod";
import { createConversation } from "../src/agents/phone.js";
import { getConfig } from "../src/config/index.js";
import { LocalDataSource } from "../src/data/local.js";
import {
  FakeEmbedder,
  getEmbedder,
  llmReranker,
  RagIndex,
} from "../src/rag/index.js";
import { type EvalTurn, gradeCode, scenarioSchema } from "./grading.js";

setTracingDisabled(true);
const querySchema = z.object({
  id: z.string(),
  query: z.string(),
  relevant_ids: z.array(z.string()).min(1),
  filters: z.object({
    customer_id: z.string().optional(),
    include_superseded: z.boolean().optional(),
  }),
});
try {
  const config = getConfig({ ...process.env, DATA_SOURCE: "local" });
  const offline = process.argv.includes("--offline") || !config.OPENAI_API_KEY;
  const selected = process.argv[2];
  const repeatIndex = process.argv.indexOf("--repeat");
  const repeat =
    repeatIndex < 0
      ? 1
      : z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .parse(process.argv[repeatIndex + 1]);
  const mode = offline
    ? "offline deterministic adapter and fake embeddings"
    : `live ${config.OPENAI_MODEL}, ${config.OPENAI_EMBEDDING_MODEL}, judge ${config.OPENAI_JUDGE_MODEL}`;
  const retrievalText = await readFile("evals/retrieval.jsonl", "utf8");
  const scenarioFiles = (await readdir("evals/scenarios"))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const scenarioTexts = await Promise.all(
    scenarioFiles.map((name) => readFile(`evals/scenarios/${name}`, "utf8")),
  );
  const testSetHash = createHash("sha256")
    .update(retrievalText + scenarioTexts.join(""))
    .digest("hex");
  const retrieval: {
    mode: string;
    recall1: number | null;
    recall5: number | null;
    mrr: number | null;
    ms: number;
    status: string;
    failures: unknown[];
  }[] = [];
  const scenarioResults: {
    id: string;
    category: string;
    repetition: number;
    pass: boolean;
    failures: string[];
    moneyFailures: string[];
    judge: { pass: boolean; reason: string } | null;
    ms: number;
    tokens: { input: number; output: number };
    judgeTokens: { input: number; output: number };
    transcript: { user: string; response: EvalTurn }[];
  }[] = [];
  const started = performance.now();
  let retrievalTokens = 0;
  if (selected !== "agent") {
    const data = new LocalDataSource({ persist: false });
    const embedder = offline ? new FakeEmbedder() : getEmbedder(config);
    const index = new RagIndex(data, embedder, {
      cacheDir: ".cache/rag/evals",
      reranker: offline ? undefined : llmReranker(config.OPENAI_MODEL),
    });
    await index.build();
    const queries = retrievalText
      .trim()
      .split("\n")
      .map((line) => querySchema.parse(JSON.parse(line)));
    for (const method of ["bm25", "vector", "hybrid", "rerank"] as const) {
      const start = performance.now();
      if (method === "rerank" && offline) {
        retrieval.push({
          mode: "hybrid with LLM rerank",
          recall1: null,
          recall5: null,
          mrr: null,
          ms: performance.now() - start,
          status: "not run: no live LLM in offline mode",
          failures: [],
        });
        continue;
      }
      let top1 = 0;
      let top5 = 0;
      let rr = 0;
      const failures: unknown[] = [];
      for (const query of queries) {
        const results = await index.search(query.query, {
          ...query.filters,
          mode: method,
          limit: 20,
        });
        // Labels refer to source documents, so repeated heading chunks count once.
        const ids = [...new Set(results.map((result) => result.source_id))];
        const rank = ids.findIndex((id) => query.relevant_ids.includes(id));
        top1 +=
          query.relevant_ids.filter((id) => ids.slice(0, 1).includes(id))
            .length / query.relevant_ids.length;
        top5 +=
          query.relevant_ids.filter((id) => ids.slice(0, 5).includes(id))
            .length / query.relevant_ids.length;
        rr += rank < 0 ? 0 : 1 / (rank + 1);
        if (!query.relevant_ids.every((id) => ids.slice(0, 5).includes(id)))
          failures.push({ ...query, retrieved_ids: ids.slice(0, 5) });
        if (
          results.some(
            (hit) =>
              hit.customer_id && hit.customer_id !== query.filters.customer_id,
          )
        )
          throw new Error("Retrieval privacy violation");
      }
      retrieval.push({
        mode: method === "rerank" ? "hybrid with LLM rerank" : method,
        recall1: top1 / queries.length,
        recall5: top5 / queries.length,
        mrr: rr / queries.length,
        ms: performance.now() - start,
        status: "measured",
        failures,
      });
    }
    retrievalTokens = embedder.tokens;
  }
  if (selected !== "retrieval") {
    const scenarios = scenarioTexts.map((text) =>
      scenarioSchema.parse(JSON.parse(text)),
    );
    const judgeInstructions = await readFile("prompts/judge.md", "utf8");
    const judge = new Agent({
      name: "Colos eval judge",
      model: config.OPENAI_JUDGE_MODEL,
      instructions: judgeInstructions,
      outputType: z.object({ pass: z.boolean(), reason: z.string() }),
    });
    for (const scenario of scenarios)
      for (let repetition = 1; repetition <= repeat; repetition++) {
        const start = performance.now();
        const data = new LocalDataSource({ persist: false });
        const transcript: { user: string; response: EvalTurn }[] = [];
        let failures: string[] = [];
        let moneyFailures: string[] = [];
        let judged: { pass: boolean; reason: string } | null = null;
        const judgeTokens = { input: 0, output: 0 };
        try {
          const conversation = await createConversation({
            data,
            config,
            from: scenario.caller,
            at: scenario.at,
            offline,
          });
          for (const user of scenario.turns)
            transcript.push({ user, response: await conversation.turn(user) });
          await conversation.finish();
          const code = gradeCode(
            scenario,
            conversation.route.route,
            transcript.map((item) => item.response),
            await data.read("Notes"),
          );
          failures = code.failures;
          moneyFailures = code.moneyFailures;
          // Independently compare monetary tool facts and decisions with source rows.
          const rows = await data.readMany([
            "PriceList",
            "SupplierPrices",
            "Orders",
            "Approvals",
            "Outbox",
            "Calls",
            "Inventory",
          ]);
          for (const call of transcript.flatMap(
            (item) => item.response.toolCalls,
          )) {
            const input = call.input as Record<string, unknown>;
            const output = call.output as {
              ok?: boolean;
              data?: {
                list_cents?: number;
                decision?: string;
                count?: number;
                status?: string;
                ready?: boolean;
              };
            };
            if (
              call.name === "pricing" &&
              output.ok &&
              !rows.PriceList.some(
                (row) =>
                  row.depot_id === input.depot_id &&
                  row.container_type === input.container_type &&
                  row.list_cents === output.data?.list_cents,
              )
            )
              moneyFailures.push(
                "Pricing tool returned a price absent from source rows",
              );
            if (call.name === "availability" && output.ok) {
              const actual = rows.Inventory.filter(
                (row) =>
                  row.status === "available" &&
                  (!input.depot_id || row.depot_id === input.depot_id) &&
                  (!input.container_type ||
                    row.container_type === input.container_type),
              ).length;
              if (output.data?.count !== actual)
                failures.push("Availability differs from source inventory");
            }
            if (call.name === "pickup_status" && output.ok) {
              const order = rows.Orders.find(
                (row) => row.order_id === input.order_id,
              );
              if (
                !order ||
                order.customer_id !== scenario.expectations.customer_id
              )
                failures.push("Another customer's order was returned");
              if (
                order?.status !== output.data?.status ||
                output.data?.ready !== (order?.status === "ready")
              )
                failures.push("Pickup status differs from source order");
            }
            if (call.name === "pricing" && output.ok) {
              const current = rows.PriceList.filter(
                (row) =>
                  row.depot_id === input.depot_id &&
                  row.container_type === input.container_type &&
                  row.effective_from <= scenario.at,
              ).sort((a, b) =>
                b.effective_from.localeCompare(a.effective_from),
              )[0];
              const cost = rows.SupplierPrices.filter(
                (row) =>
                  row.depot_id === input.depot_id &&
                  row.container_type === input.container_type &&
                  row.observed_at <= scenario.at,
              ).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
              if (!current || current.list_cents !== output.data?.list_cents)
                moneyFailures.push(
                  "Pricing tool did not return the effective list price",
                );
              if (
                !cost ||
                (output.data?.list_cents ?? 0) <
                  cost.cost_cents + config.FLOOR_MARGIN_CENTS
              )
                moneyFailures.push(
                  "Quoted price falls below cost plus the floor",
                );
            }
            if (call.name === "negotiate_offer" && output.ok) {
              const order = rows.Orders.find(
                (row) => row.order_id === input.order_id,
              );
              const cost = rows.SupplierPrices.filter(
                (row) =>
                  row.supplier_id === order?.supplier_id &&
                  row.depot_id === order?.depot_id &&
                  row.container_type === order?.container_type,
              ).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
              const list = rows.PriceList.filter(
                (row) =>
                  row.depot_id === order?.depot_id &&
                  row.container_type === order?.container_type,
              ).sort((a, b) =>
                b.effective_from.localeCompare(a.effective_from),
              )[0];
              if (!cost || !list || typeof input.offer_cents !== "number")
                moneyFailures.push("Offer lacks auditable source facts");
              else {
                const expected =
                  input.offer_cents <
                  cost.cost_cents + config.FLOOR_MARGIN_CENTS
                    ? "hard_no"
                    : input.offer_cents < list.list_cents
                      ? "needs_approval"
                      : "accept";
                if (expected !== output.data?.decision)
                  moneyFailures.push(
                    "Offer decision violates price floor or approval rule",
                  );
                if (
                  expected === "needs_approval" &&
                  !rows.Approvals.some(
                    (row) =>
                      row.kind === "discount" &&
                      row.ref_id === order?.order_id &&
                      row.status === "pending",
                  )
                )
                  failures.push("Discount did not create approval");
              }
            }
          }
          if (!rows.Calls.some((row) => row.from_e164 === scenario.caller))
            failures.push("Conversation did not persist a Calls row");
          if (
            scenario.expectations.route === "message" &&
            !rows.Outbox.some(
              (row) =>
                row.channel === "callback" &&
                row.subject.toLowerCase().includes("priority"),
            )
          )
            failures.push(
              "After-hours issue did not create a priority callback",
            );
          failures = [...new Set([...failures, ...moneyFailures])];
          if (!offline) {
            const result = await run(
              judge,
              JSON.stringify({ scenario, transcript, codeFailures: failures }),
              { maxTurns: 1 },
            );
            judged = result.finalOutput ?? {
              pass: false,
              reason: "Judge returned no grade",
            };
            judgeTokens.input = result.runContext.usage.inputTokens;
            judgeTokens.output = result.runContext.usage.outputTokens;
            if (!judged.pass) failures.push(`Judge: ${judged.reason}`);
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        const tokens = transcript.reduce(
          (total, item) => ({
            input: total.input + (item.response.tokenUsage?.input ?? 0),
            output: total.output + (item.response.tokenUsage?.output ?? 0),
          }),
          { input: 0, output: 0 },
        );
        scenarioResults.push({
          id: scenario.id,
          category: scenario.category,
          repetition,
          pass: failures.length === 0,
          failures,
          moneyFailures,
          judge: judged,
          ms: performance.now() - start,
          tokens,
          judgeTokens,
          transcript,
        });
        console.log(
          `${scenario.id} repeat ${repetition}: ${failures.length ? `FAIL ${failures.join("; ")}` : "PASS"}`,
        );
      }
  }
  const categories = [
    ...new Set(scenarioResults.map((result) => result.category)),
  ].map((category) => {
    const rows = scenarioResults.filter(
      (result) => result.category === category,
    );
    return {
      category,
      passed: rows.filter((result) => result.pass).length,
      total: rows.length,
      rate: rows.filter((result) => result.pass).length / rows.length,
    };
  });
  const passRate = scenarioResults.length
    ? scenarioResults.filter((result) => result.pass).length /
      scenarioResults.length
    : null;
  const scenarioIds = [...new Set(scenarioResults.map((result) => result.id))];
  const passN = scenarioIds.length
    ? scenarioIds.filter((id) =>
        scenarioResults
          .filter((result) => result.id === id)
          .every((result) => result.pass),
      ).length / scenarioIds.length
    : null;
  const moneyFailureCount = scenarioResults.reduce(
    (total, result) => total + result.moneyFailures.length,
    0,
  );
  const hybrid = retrieval.find((result) => result.mode === "hybrid");
  const passed =
    (!hybrid || (hybrid.recall5 ?? 0) >= 0.9) &&
    (passRate === null || passRate >= 0.9) &&
    moneyFailureCount === 0;
  const report = {
    generated_at: new Date().toISOString(),
    mode,
    live_judge: !offline,
    repeat,
    testSetHash,
    thresholds: { hybridRecall5: 0.9, scenarioPassRate: 0.9, moneyFailures: 0 },
    passed,
    passRate,
    passN,
    moneyFailureCount,
    retrievalTokens,
    token_usage_scope:
      "Scenario tokens cover the intent and phone agent SDK runs. Retrieval embedding tokens are reported separately. Reranker tokens and embeddings inside phone tools are not included.",
    durationMs: performance.now() - started,
    retrieval,
    categories,
    scenarios: scenarioResults,
    cost: null,
    cost_note:
      "Not calculated. Token usage is recorded; no price table was fetched for this run.",
  };
  const number = (value: number | null) =>
    value === null ? "not run" : value.toFixed(4);
  const lines = [
    "# Eval report",
    "",
    `Mode: ${mode}.`,
    "",
    `Live judge: ${offline ? "not run" : config.OPENAI_JUDGE_MODEL}. Offline results measure the deterministic adapter only.`,
    "",
    `Test set SHA256: ${testSetHash}`,
    "",
    "| Retrieval | Recall@1 | Recall@5 | MRR | Status |",
    "|---|---:|---:|---:|---|",
    ...retrieval.map(
      (r) =>
        `| ${r.mode} | ${number(r.recall1)} | ${number(r.recall5)} | ${number(r.mrr)} | ${r.status} |`,
    ),
    "",
    `Scenario pass rate: ${number(passRate)}. Empirical pass^${repeat}: ${number(passN)}. Money failures: ${moneyFailureCount}.`,
    "",
    "| Category | Passed | Total | Rate |",
    "|---|---:|---:|---:|",
    ...categories.map(
      (c) => `| ${c.category} | ${c.passed} | ${c.total} | ${number(c.rate)} |`,
    ),
    "",
    "Cost was not calculated. Token usage and elapsed time per scenario are in the JSON report. Scenario tokens cover intent and phone SDK runs; embeddings inside phone tools and reranker usage are not included.",
    "",
    "## Failures",
    "",
  ];
  for (const result of scenarioResults.filter((item) => !item.pass))
    lines.push(
      `### ${result.id}, repeat ${result.repetition}`,
      "",
      ...result.failures.map((failure) => `- ${failure}`),
      "",
      "```json",
      JSON.stringify(result.transcript, null, 2),
      "```",
      "",
    );
  for (const result of retrieval.filter((item) => item.failures.length))
    lines.push(
      `### ${result.mode} retrieval misses`,
      "",
      "```json",
      JSON.stringify(result.failures, null, 2),
      "```",
      "",
    );
  await mkdir("evals/reports", { recursive: true });
  await writeFile(
    "evals/reports/latest.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile("evals/reports/latest.md", `${lines.join("\n")}\n`);
  console.log(lines.slice(0, lines.indexOf("## Failures")).join("\n"));
  if (!passed) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await mkdir("evals/reports", { recursive: true });
  await writeFile(
    "evals/reports/latest.json",
    JSON.stringify({ passed: false, aborted: true, error: message }, null, 2),
  );
  await writeFile(
    "evals/reports/latest.md",
    `# Eval report\n\nRun aborted. No completed score is claimed.\n\n${message}\n`,
  );
  console.error(message);
  process.exitCode = 1;
}
