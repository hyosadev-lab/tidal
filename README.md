# tidal-trading-agent

Agent loop dengan tool calling, LLM lewat [OpenRouter](https://openrouter.ai).
Cuma pakai `fetch` + stdlib — jalan di Node 22+, Bun, atau Deno.

```bash
cp .env.example .env   # isi OPENROUTER_API_KEY

node --env-file-if-exists=.env index.ts   # chat interaktif, /reset & /exit
node --test

# atau: bun index.ts  /  bun test
```

- [agent.ts](agent.ts) — loop-nya: kirim messages → kalau model minta tool, jalankan, balikin hasilnya → ulang sampai model jawab tanpa tool call.
- [index.ts](index.ts) — contoh tool (`get_price`) + entry point.

Nambah tool = nambah entry di object `tools`: `description`, `parameters` (JSON Schema), `run`.
