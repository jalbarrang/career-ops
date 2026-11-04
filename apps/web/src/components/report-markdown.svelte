<script lang="ts">
  import { ChevronDown } from "@lucide/svelte";
  import { Badge } from "@/components/ui/badge";
  import { renderInline, renderMarkdown } from "@/lib/markdown";
  import {
    colIndex,
    fitColumnIndex,
    fitTone,
    isStarTableHeader,
    parsePipeTable,
    splitPipeTables,
  } from "@/lib/report-tables.ts";

  // GFM report body: STAR+R grids become cards; Fit cells become tone badges.
  //
  // The source walked react-markdown's element tree to recolor one column. There
  // is no tree with `marked`, and re-parsing the generated HTML string to inject
  // a badge is how a report ends up broken by an escaped pipe — so each table
  // block is parsed up front and rendered here, which also keeps a Fit cell a
  // real <Badge> instead of an injected span. Everything that is NOT a table
  // still goes through marked, so prose keeps its full GFM formatting.
  let { children }: { children: string } = $props();

  type ParsedTable = { header: string[]; rows: string[][] };
  type Chunk =
    | { kind: "md"; text: string }
    | {
        kind: "star";
        rows: string[][];
        numCol: number;
        reqCol: number;
        storyCol: number;
        fields: { label: string; i: number }[];
      }
    | { kind: "table"; table: ParsedTable; fitCol: number };

  function starChunk(parsed: ParsedTable): Chunk {
    return {
      kind: "star",
      rows: parsed.rows,
      numCol: colIndex(parsed.header, ["#"]),
      reqCol: colIndex(parsed.header, ["jd requirement", "requirement"]),
      storyCol: colIndex(parsed.header, ["story"]),
      fields: [
        { label: "Situation", i: colIndex(parsed.header, ["s"]) },
        { label: "Task", i: colIndex(parsed.header, ["t"]) },
        { label: "Action", i: colIndex(parsed.header, ["a"]) },
        { label: "Result", i: colIndex(parsed.header, ["r"]) },
        { label: "Reflection", i: colIndex(parsed.header, ["reflection"]) },
      ].filter((f) => f.i >= 0),
    };
  }

  const chunks = $derived.by((): Chunk[] =>
    splitPipeTables(children).map((c): Chunk => {
      const parsed = c.type === "table" ? parsePipeTable(c.text) : null;
      // A "table" block we cannot parse stays with marked, exactly as the source
      // fell through to ReactMarkdown when parsePipeTable returned null.
      if (!parsed) return { kind: "md", text: c.text };
      if (isStarTableHeader(parsed.header)) return starChunk(parsed);
      return { kind: "table", table: parsed, fitCol: fitColumnIndex(parsed.header) };
    }),
  );
</script>

{#each chunks as chunk, i (i)}
  {#if chunk.kind === "md"}
    {@html renderMarkdown(chunk.text)}
  {:else if chunk.kind === "star"}
    <ol class="my-4 list-none space-y-2 p-0">
      {#each chunk.rows as row, r (r)}
        {@const num = chunk.numCol >= 0 ? row[chunk.numCol] : String(r + 1)}
        {@const req = chunk.reqCol >= 0 ? row[chunk.reqCol] : ""}
        {@const story = chunk.storyCol >= 0 ? row[chunk.storyCol] : ""}
        <li>
          <details class="group overflow-hidden rounded-xl border border-border bg-surface/40">
            <summary class="flex min-h-[44px] cursor-pointer list-none items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-hover">
              <span class="mt-0.5 shrink-0 font-mono text-xs tabular-nums text-faint">{num}</span>
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-foreground">{req || story || `Story ${num}`}</span>
                {#if req && story}
                  <span class="mt-0.5 block text-xs text-muted">{story}</span>
                {/if}
              </span>
              <ChevronDown class="mt-0.5 size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
            </summary>
            <dl class="grid gap-3 border-t border-border px-4 py-3 sm:grid-cols-2">
              {#each chunk.fields as f (f.label)}
                {@const value = row[f.i] ?? ""}
                {#if value}
                  <div class={f.label === "Reflection" ? "sm:col-span-2" : undefined}>
                    <dt class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">{f.label}</dt>
                    <dd class="mt-1 text-sm text-foreground">{value}</dd>
                  </div>
                {/if}
              {/each}
            </dl>
          </details>
        </li>
      {/each}
    </ol>
  {:else}
    <table>
      <thead>
        <tr>
          {#each chunk.table.header as cell, h (h)}
            <th>{@html renderInline(cell)}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each chunk.table.rows as row, r (r)}
          <tr>
            {#each row as cell, c (c)}
              {@const tone = c === chunk.fitCol ? fitTone(cell) : null}
              <td>
                {#if tone}
                  <Badge {tone}>{@html renderInline(cell)}</Badge>
                {:else}
                  {@html renderInline(cell)}
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/each}
