# tidal-trading-agent

Agent trading otomatis untuk memecoin, jalan di atas [GMGN OpenAPI](https://gmgn.ai),
dengan dashboard buat ngeliat semua aktivitasnya. LLM lewat [OpenRouter](https://openrouter.ai).
Cuma pakai `fetch` + stdlib — jalan di Node 22+, Bun, atau Deno. Nol dependency runtime,
nol binary eksternal.

```bash
cp .env.example .env         # isi OPENROUTER_API_KEY + GMGN_API_KEY
                             # (GMGN_PRIVATE_KEY cuma perlu buat live mode)

npm run dash                 # dashboard di http://127.0.0.1:3111
npm start                    # chat interaktif (mode lama, /reset & /exit)
npm test
```

Default-nya **paper mode**: harga beneran, uang bohongan. Dompet kamu gak kesentuh sama sekali.

---

## Cara agent-nya mikir

Pembagiannya disengaja:

- **Gate, sizing, dan exit itu kode biasa.** Deterministik, jalan tiap 30 detik, gak peduli
  modelnya lagi lemot, kena rate limit, atau lagi ngaco. Posisi yang udah kebuka gak pernah
  bergantung sama panggilan LLM buat bisa ditutup.
- **Model cuma milih dan nulis tesis.** Dia me-ranking kandidat yang *udah* lolos semua gate,
  boleh nolak, boleh minta exit lebih awal — tapi gak bisa melonggarkan satu pun batas risiko.

### 1. Scan (tiap `interval` menit)

Tiga feed digabung: `market trending` 1 jam, `market trending` 5 menit, dan `market trenches`
(token yang udah graduate). Filter awal didorong ke server GMGN biar hemat rate limit.

### 2. Gate — gagal satu, gugur

Gate adalah salinan kolom 🔴 Skip dari tabel "Pass / Watch / Skip Criteria" di dokumentasi
GMGN (`skills/gmgn-market/SKILL.md`). Tidak ada angka karangan sendiri di sini.

| Gate | Default |
|---|---|
| smart money | >= 1 wallet |
| `rug_ratio` | <= 0.3 |
| `creator_token_status` | bukan `creator_hold` |
| wash trading | tolak langsung |
| top-10 holder | <= 50% |
| likuiditas | >= $10k |
| honeypot | tolak langsung |

Ambang ini adalah batas "jangan disentuh sama sekali", bukan batas "layak dibeli". Pita
🟡 Watch sengaja diloloskan — yang menghukumnya skor, bukan gate. Token dengan kolam $12k dan
rug 0.28 akan lolos, lalu jadi urusan analis untuk menolaknya.

**Tidak ada satu pun yang bisa diatur dari dashboard.** Angkanya ada di konstanta `SKIP`
(`trading/config.ts`) dan bukan bagian dari `TradeConfig` — ini ambang yang dipublikasikan
untuk hal yang didiskualifikasi, jadi tidak ada yang perlu ditala. Kalau mau berdagang lebih
ketat dari lantai ini, tulis di kolom instruksi dashboard: di situ analis bisa menindaklanjutinya,
tanpa membuat angka karangan yang menyandang nama tabel.

Dua hal yang bukan kebijakan risiko juga masih menggugurkan kandidat: token tanpa alamat dan
tanpa harga. Itu penjaga integritas data, supaya kandidat rusak tidak lolos ke sizing.

Sisanya bukan gate, tapi **penolakan pre-trade** — sekali per entry, lewat `token_security`,
karena cuma route itu yang jawabannya bisa dipercaya (baris feed sering mengosongkannya):

- **buy/sell tax > 10%** — semua chain. Token yang bisa dibeli dan dijual tapi dipotong 40%
  bukan honeypot, dan tabel kriteria di atas tidak punya barisnya. Ambang 10% diambil dari
  band 🔴 milik `buy_tax`/`sell_tax` di `skills/gmgn-token/SKILL.md`.
- **mint / freeze authority masih hidup, atau likuiditas belum dibakar** — Solana saja. Di EVM
  kedua konsep itu tidak ada, dan likuiditasnya dikunci, bukan dibakar.

Gagal baca = ditolak, di semua chain. Ini berlaku di paper mode juga, biar hasilnya sebanding.

### 3. Skor struktural (0-100)

Smart money bobotnya paling besar. Momentum dihargai **sampai titik tertentu** — token yang
udah naik 400% dalam sejam justru dikurangi skornya, karena masuk di situ artinya kamu jadi
likuiditas buat orang yang keluar. Ditambah kedalaman kolam, turnover, konsentrasi holder,
status dev, dan umur token.

### 4. Analis (LLM)

Kandidat yang lolos dikirim ke model bareng posisi terbuka dan instruksi kamu. Model punya
tool read-only: `token_detail`, `token_security`, `top_holders`, `price_history`,
`smart_money_flow`, plus semua skill `gmgn-*`. **Sengaja gak ada tool bash dan gak ada tool
swap** — analis yang gak bisa belanja gak bisa dibujuk buat belanja sama teks yang dia baca
di nama token.

Model balikin JSON: `entries`, `exits`, `notes`. Conviction di bawah 40 otomatis ditolak kode.

### 5. Sizing

`riskPerTradePct` dari equity (default 4%), diskalakan sama conviction, maksimal 5 posisi
bareng, dan gak pernah pakai lebih dari 90% cash yang tersisa.

**Di live mode, saldo dibaca dari dompet asli** lewat `/v1/user/info` tiap siklus —
bukan dari paper bankroll. Kalau saldonya gak kebaca, entry di-skip siklus itu; sizing dari
angka karangan cuma bikin swap ditolak GMGN, dan error `insufficient token balance` punya
rate limiter sendiri. Sebagian saldo native disisihkan buat gas (SOL 0.02) dan gak pernah
ikut dihitung — kalau semua SOL masuk posisi, kamu gak punya ongkos buat keluar.

**Lantai ukuran posisi per chain:** SOL $3, BSC/Base $5, ETH $25. Di bawah itu, fee dan
slippage lebih besar dari trade-nya. Kalau `equity x riskPerTradePct` gak pernah nyampe
lantai, agent nolak start dan bilang kenapa — daripada bikin log "skipped" tiap siklus
selamanya. Contoh: bankroll $45 dengan risk 5% cuma bisa bikin posisi $2.25, di bawah
lantai SOL, jadi butuh minimal 7%.

### 6. Exit — mekanis, tiap 30 detik

Dicek berurutan, yang pertama cocok yang jalan:

1. **Stop loss** -25%
2. **Trailing stop** — aktif setelah +45%, keluar kalau turun 25% dari puncak
3. **Take-profit bertingkat** — jual 40% di +60%, 30% di +150%, 20% di +400%
4. **Time stop** — 180 menit masih di bawah +8% -> tutup, uangnya dipindah ke ide lain
5. **Health check** — likuiditas anjlok >55% dari waktu masuk, atau token berubah honeypot

Di live mode, take-profit dan stop-loss juga **ditempelkan ke transaksi beli** lewat
`--condition-orders`, jadi posisinya tetap punya proteksi di sisi GMGN walaupun proses ini mati.

### 7. Kill switch

Rugi harian nembus `maxDailyLossPct` (default 15%) -> agent berhenti sendiri dan gak bisa
jalan lagi sampai besok atau sampai kamu start manual. Reset otomatis tengah malam.

---

## Dashboard

`npm run dash` -> http://127.0.0.1:3111

- **Chain** — SOL / BSC / BASE / ETH
- **Mode** — paper atau live (live minta konfirmasi ketik, lihat di bawah)
- **Start / Stop** — posisi terbuka sengaja dibiarkan pas stop; tutup manual kalau mau keluar
- **Instructions** — prompt opsional buat ngarahin analis, plus 4 preset siap pakai
- **Interval** — menit antar scan; exit tetap dicek tiap 30 detik
- **Risk envelope & Entry gates** — semua angka di atas bisa diubah dari UI
- **Scan now** — paksa satu siklus tanpa nunggu timer

Yang bisa dilihat: kurva equity (garis pasang tertinggi & surut terendah), posisi terbuka
dengan P&L jalan, **Soundings** — semua token hasil scan terakhir lengkap sama alasan kenapa
ditolak, riwayat fill, dan log streaming. Update lewat SSE, gak ada polling.

State disimpan di `data/` — ledger dan setelan tetap ada setelah restart.

### Prompt: contoh yang bagus

```
Cuma masuk kalau minimal 3 wallet smart money beda beli dalam sejam terakhir dan belum ada
yang mulai jual. Cek top holders dulu sebelum commit. Kalau smart money-nya udah distribusi,
lewatin — sebagus apa pun chart-nya.
```

Prompt kamu bisa **memperketat** seleksi, gak bisa melonggarkan batas risiko. Minta agent
"pakai 50% modal per trade" tetap ditolak kode.

---

## Live mode

Live mode kirim swap on-chain beneran yang gak bisa dibatalin.

`gmgn.swap()` nolak jalan kecuali `GMGN_ALLOW_AUTOMATED_TRADES=1` ada di environment.
**Kode ini sengaja gak pernah nge-set variabel itu sendiri** — itu bentuk persetujuan kamu
buat eksekusi tanpa konfirmasi, dan bukan hak proses ini buat ngasih izin atas nama kamu.
Proses ini nandatangani sendiri request trade-nya, jadi cek itu satu-satunya penghalang
yang tersisa — gak ada proses lain lagi yang bakal nolak buat kamu. Set sendiri:

```bash
export GMGN_ALLOW_AUTOMATED_TRADES=1
npm run dash
```

Plus: isi alamat wallet di panel **Live wallet** (harus wallet yang terikat ke GMGN API key kamu),
dan `GMGN_PRIVATE_KEY` sudah terkonfigurasi di `~/.config/gmgn/.env`. Tanpa ketiganya, entry
live ditolak dan dicatat di log.

Saran: jalanin paper mode dulu beberapa hari. Kalau equity-nya gak naik di paper, live cuma
bikin rugi lebih cepat.

> Memecoin trading risikonya sangat tinggi. Sebagian besar token akan ke nol. Ini alat, bukan
> saran finansial — kamu yang menanggung semua hasilnya.

---

## Struktur

```
server.ts              HTTP + SSE, API kontrol
public/                dashboard (vanilla, tanpa build step)
trading/
  types.ts             tipe bersama
  config.ts            default + sanitasi (semua input dari UI diclamp di sini)
  store.ts             state, persistensi, event bus
  gmgn.ts              client GMGN OpenAPI + leaky bucket rate limiter
  plan.ts              gate, skor, sizing, aturan exit, prompt analis
  broker.ts            eksekusi paper & live
  engine.ts            loop scan + monitor
  skills/              skill analis: scanning + analysis
src/
  agent/
    llm.ts             loop tool-calling (dipakai analis)
    skills.ts          loader <root>/<nama>/SKILL.md
  gmgn/                client GMGN OpenAPI standalone (belum dipakai trading/)
skills/                skill gmgn-* bawaan, buat chat CLI (butuh bash)
index.ts               chat CLI (mode lama, punya tool bash)
```

`trading.test.ts` nutupin gate, skor, sizing, tiap aturan exit, round trip paper, clamping
config, penolakan live mode, dan parsing output model. `npm test` buat jalanin semuanya.

---

## Nambah tool / skill

Nambah tool analis = tambah entry di `analystTools` (`trading/engine.ts`): `description`,
`parameters` (JSON Schema), `run`. Read-only aja.

Ada **dua root skill** dan gak bisa ditukar. `trading/skills/` buat analis headless — isinya
harus ngomongin tool, bukan perintah shell, dan gak boleh nyapa user (di loop itu gak ada user).
`skills/` buat chat CLI di `index.ts` yang punya bash. Nambah skill = bikin
`trading/skills/<nama>/SKILL.md` atau `skills/<nama>/SKILL.md`:

```md
---
name: gmgn-token
description: kapan skill ini dipakai — ini yang dibaca model buat mutusin
---

Instruksi lengkapnya di sini.
```

Nama + deskripsi doang yang masuk system prompt; isi lengkapnya baru dikirim kalau model
manggil tool `load_skill`. File pendukung taro di folder yang sama — `load_skill` ngasih path
absolut folder-nya ke model.

## Environment

```
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
PORT=3111                          # opsional
HOST=127.0.0.1                     # opsional
GMGN_ALLOW_AUTOMATED_TRADES=1      # HANYA kalau kamu mau live trading otomatis
```
