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

- [skills.ts](skills.ts) — baca `skills/<nama>/SKILL.md`. Nama + deskripsi doang yang masuk system prompt; isi lengkapnya baru dikirim kalau agent manggil tool `load_skill`.

Nambah tool = nambah entry di object `tools`: `description`, `parameters` (JSON Schema), `run`.

Nambah skill = bikin `skills/<nama>/SKILL.md`:

```md
---
name: gmgn-token
description: kapan skill ini dipakai — ini yang dibaca model buat mutusin
---

Instruksi lengkapnya di sini.
```

File pendukung (script dll) taro di folder yang sama; `load_skill` ngasih path absolut folder-nya
ke model, jadi path `~/.claude/skills/...` di dalam SKILL.md gak masalah.

## Tool `bash`

Skill gmgn semuanya nyuruh jalanin `gmgn-cli` / `python3`, jadi agent punya tool `bash`.
Command jalan langsung tanpa konfirmasi, cuma di-echo ke terminal — termasuk `gmgn-swap`
yang eksekusi transaksi on-chain beneran.

```bash
npm install -g gmgn-cli   # dibutuhin skill gmgn-*
```
