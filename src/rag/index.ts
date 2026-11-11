import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, run } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import type { DataSource } from '../data/index.js';

export interface Embedder {
  readonly name: string;
  tokens: number;
  embed(texts: string[]): Promise<number[][]>;
}
const stop = new Set('a an the is are was were can could do does how what when where which who to for from of on in at and or my our your please i we me it that this about with'.split(' '));
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => !stop.has(word)).map((word) => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
}
/** A hashed bag of words, not a semantic model. Only for reproducible offline checks. */
export class FakeEmbedder implements Embedder {
  readonly name = 'fake-hash-v1';
  tokens = 0;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array<number>(2048).fill(0);
      for (const term of tokenize(text)) {
        const hash = createHash('sha256').update(term).digest().readUInt32LE(0);
        vector[hash % vector.length] = (vector[hash % vector.length] ?? 0) + 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
      return vector.map((n) => n / norm);
    });
  }
}
export class OpenAIEmbedder implements Embedder {
  readonly name: string;
  tokens = 0;
  private client: OpenAI;
  constructor(apiKey: string, model = 'text-embedding-3-small') {
    this.name = model;
    this.client = new OpenAI({ apiKey });
  }
  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const response = await this.client.embeddings.create({ model: this.name, input: texts.slice(i, i + 64), encoding_format: 'float' });
      this.tokens += response.usage.total_tokens;
      vectors.push(...response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding));
    }
    return vectors;
  }
}
export function getEmbedder(config: { OPENAI_API_KEY?: string; OPENAI_EMBEDDING_MODEL?: string }, options: { offline?: boolean } = {}): Embedder {
  return options.offline || !config.OPENAI_API_KEY ? new FakeEmbedder() : new OpenAIEmbedder(config.OPENAI_API_KEY, config.OPENAI_EMBEDDING_MODEL);
}
const chunkSchema = z.object({ id: z.string(), source_id: z.string(), updated_at: z.string(), text: z.string(), customer_id: z.string().optional(), status: z.enum(['current', 'superseded']), hash: z.string(), vector: z.array(z.number()) });
export type Chunk = z.infer<typeof chunkSchema>;
export type SearchResult = Omit<Chunk, 'vector' | 'hash'> & { score: number };
export interface SearchOptions {
  customer_id?: string;
  include_superseded?: boolean;
  mode?: 'bm25' | 'vector' | 'hybrid' | 'rerank';
  limit?: number;
}
export type Reranker = (query: string, results: SearchResult[]) => Promise<SearchResult[]>;
export function llmReranker(model: string): Reranker {
  return async (query, results) => {
    const instructions = await readFile('prompts/reranker.md', 'utf8');
    const agent = new Agent({ name: 'Retrieval reranker', model, instructions, outputType: z.object({ ids: z.array(z.string()) }) });
    const result = await run(agent, JSON.stringify({ query, candidates: results }), { maxTurns: 1 });
    const ids = result.finalOutput?.ids ?? [];
    const rank = new Map(ids.map((id, i) => [id, i]));
    return [...results].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
  };
}
export class RagIndex {
  private chunks: Chunk[] = [];
  readonly cacheDir: string;
  private reranker?: Reranker;
  constructor(private data: DataSource, readonly embedder: Embedder, options: { cacheDir?: string; reranker?: Reranker } = {}) {
    this.cacheDir = options.cacheDir ?? '.cache/rag';
    this.reranker = options.reranker;
  }
  async build(): Promise<{ chunks: number; embedded: number; model: string }> {
    const { Knowledge, Notes } = await this.data.readMany(['Knowledge', 'Notes']);
    const pending: Omit<Chunk, 'vector'>[] = [];
    for (const doc of Knowledge) {
      const sections = doc.body_markdown.split(/(?=^#{1,6}\s)/m).filter((part) => part.trim());
      sections.forEach((section, i) => {
        const text = `${doc.title}\n${section.trim()}`;
        pending.push({ id: `${doc.doc_id}#${i}`, source_id: doc.doc_id, text, status: doc.status, updated_at: doc.updated_at, hash: digest(text) });
      });
    }
    for (const note of Notes) pending.push({ id: note.note_id, source_id: note.note_id, customer_id: note.customer_id, text: note.text, status: 'current', updated_at: note.created_at, hash: digest(note.text) });
    await mkdir(this.cacheDir, { recursive: true });
    const path = join(this.cacheDir, `${digest(this.embedder.name).slice(0, 16)}.json`);
    let previous: Chunk[] = [];
    try { previous = z.array(chunkSchema).parse(JSON.parse(await readFile(path, 'utf8'))); } catch (error) {
      if (!(error instanceof Error)) throw error;
      // A missing, corrupt, or old cache is rebuilt from source rows.
    }
    const cached = new Map(previous.map((chunk) => [chunk.hash, chunk.vector]));
    const missing = [...new Map(pending.filter((chunk) => !cached.has(chunk.hash)).map((chunk) => [chunk.hash, chunk.text]))];
    const embedded = await this.embedder.embed(missing.map(([, text]) => text));
    missing.forEach(([hash], i) => cached.set(hash, embedded[i] ?? []));
    this.chunks = pending.map((chunk) => ({ ...chunk, vector: cached.get(chunk.hash) ?? [] }));
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.chunks));
    await rename(temporary, path);
    return { chunks: this.chunks.length, embedded: missing.length, model: this.embedder.name };
  }
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.chunks.length) await this.build();
    // Filter before every scoring stage. A reranker never sees another account's notes.
    const candidates = this.chunks.filter((chunk) => (!chunk.customer_id || chunk.customer_id === options.customer_id) && (options.include_superseded || chunk.status !== 'superseded'));
    const bm = bm25(query, candidates);
    const mode = options.mode ?? 'hybrid';
    let ranked = bm;
    if (mode !== 'bm25') {
      const [vector] = await this.embedder.embed([query]);
      const semantic = candidates.map((chunk) => ({ chunk, score: cosine(vector ?? [], chunk.vector) })).sort(byScore);
      ranked = mode === 'vector' ? semantic : fuse(bm, semantic);
    }
    let results: SearchResult[] = ranked.map(({ chunk, score }) => ({ id: chunk.id, source_id: chunk.source_id, updated_at: chunk.updated_at, text: chunk.text, customer_id: chunk.customer_id, status: chunk.status, score }));
    if (mode === 'rerank') {
      if (!this.reranker) throw new Error('LLM reranking is not configured');
      results = await this.reranker(query, results.slice(0, 20));
    }
    return results.slice(0, options.limit ?? 5);
  }
}
function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
type Ranked = { chunk: Chunk; score: number };
function byScore(a: Ranked, b: Ranked): number { return b.score - a.score || a.chunk.id.localeCompare(b.chunk.id); }
function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
  return dot / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
}
export function bm25(query: string, chunks: Chunk[]): Ranked[] {
  const docs = chunks.map((chunk) => tokenize(chunk.text));
  const average = docs.reduce((sum, words) => sum + words.length, 0) / (docs.length || 1);
  const terms = [...new Set(tokenize(query))];
  const frequency = new Map(terms.map((term) => [term, docs.filter((words) => words.includes(term)).length]));
  return chunks.map((chunk, i) => {
    const words = docs[i] ?? [];
    const score = terms.reduce((total, term) => {
      const count = words.filter((word) => word === term).length;
      const idf = Math.log(1 + (docs.length - (frequency.get(term) ?? 0) + 0.5) / ((frequency.get(term) ?? 0) + 0.5));
      return total + idf * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * words.length / (average || 1)));
    }, 0);
    return { chunk, score };
  }).sort(byScore);
}
function fuse(...rankings: Ranked[][]): Ranked[] {
  const scores = new Map<string, Ranked>();
  for (const ranking of rankings) ranking.forEach(({ chunk }, i) => {
    scores.set(chunk.id, { chunk, score: (scores.get(chunk.id)?.score ?? 0) + 1 / (60 + i + 1) });
  });
  return [...scores.values()].sort(byScore);
}
