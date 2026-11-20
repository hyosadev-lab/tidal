# tidal-trading-agent

Agent trading otomatis untuk memecoin **Solana**. Kandidat dari [GMGN OpenAPI](https://gmgn.ai),
keputusan beli dari LLM (default lewat [OpenRouter](https://openrouter.ai)), swap lewat
[Jupiter](https://developers.jup.ag), plus dashboard buat ngeliat semuanya. Cuma `fetch` + stdlib —
jalan di Node 22+, Bun, atau Deno. Nol dependency runtime, nol build step.

```bash
cp .env.example .env         # isi OPENROUTER_API_KEY + GMGN_API_KEY
npm start                    # dashboard di http://127.0.0.1:3712
npm test
```

Proses selalu mulai dalam keadaan **berhenti**: gak ada yang dibeli atau dijual sampai kamu tekan
**Start** di dashboard. Default-nya **paper mode** — harga dan rute Jupiter beneran, uang bohongan,
dompet gak kesentuh.

---

## Cara kerjanya

Pembagiannya disengaja:

- **Model cuma milih.** Tiap token yang jatuh tempo dikasih vonis `buy`, `wait`, atau `skip`.
  Model gak pernah menjual dan gak pernah menentukan ukuran posisi.
- **Sisanya kode biasa.** Cek keamanan, slot, ukuran, kas, dan semua exit jalan deterministik —
  posisi yang udah kebuka gak pernah bergantung sama panggilan LLM buat bisa ditutup.

### Entry loop (`src/entry.ts`)

Jalan siklus demi siklus tanpa timer, selama status **running**:

1. **Fetch** — GMGN rank 1 jam (urut volume, 40 baris) + feed sinyal dalam empat grup: smart money
   buy, KOL buy, harga (spike / ATH / level market cap), dan community takeover. Token wash trading
   dibuang. **Fetch filters** di dashboard dikirim ke GMGN, sisanya dicek per baris.
2. **Jatuh tempo** — token baru, `wait` yang waktunya udah lewat, atau yang pernah dibeli dan
   cooldown-nya selesai. `skip` itu final; token yang lagi dipegang atau diblokir gak pernah ikut.
3. **Snapshot** — maksimal 10 token per siklus, masing-masing satu `/v1/token/info` yang disimpan ke
   ledger (`src/snapshot.ts`).
4. **Satu run agent** (`src/decide.ts`) — semua token dalam satu brief, system prompt + prompt
   operator, empat tool GMGN read-only dengan jatah panggilan (`toolCalls`, default 12). Jawabannya
   JSON yang divalidasi: token yang gak dijawab jadi `wait`, waktu tunggu diklem.
5. **Beli**, conviction tertinggi duluan: rencana exit → cek keamanan → slot → ukuran → kas →
   snapshot entry → `trade.buy`.

Kalau gak bisa beli (slot penuh, kena pause rugi harian), loop **gak fetch dan gak manggil model** —
dia nunggu dibangunin: posisi ditutup, Start, Resume, settings disimpan, atau 00:00 UTC.

### Cek keamanan sebelum beli

Lewat `/v1/token/security`, sekali per beli. Ditolak kalau:

- mint atau freeze authority belum di-renounce,
- likuiditas belum dibakar (praktisnya: belum migrasi dari bonding curve),
- buy/sell tax > 10%,
- honeypot / gak bisa dijual.

Data yang gak kebaca **bukan lolos**. Penolakan karena token-nya sendiri dicatat sebagai `skip`
(final) dan token-nya diblokir; kalau cuma request-nya yang gagal, token-nya balik lagi nanti.
Beli di bawah $3 juga ditolak — fee bakal makan semuanya. Berlaku di paper juga, biar hasilnya
sebanding.

### Exit loop (`src/exit.ts`) — tiap 1 detik

Satu baca Jupiter Price API memberi harga semua posisi terbuka, lalu tiap posisi dicek berurutan:

1. **Stop loss** — default −25%, jual semua
2. **Health** — likuiditas turun lebih dari 55% dari bacaan saat masuk
3. **Time stop** — default 30 menit
4. **Take profit bertingkat** — default jual 40% di +60%, 30% di +150%, 30% di +400%

Lonjakan harga >3× dikonfirmasi ke GMGN dulu sebelum dipakai. Kalau harga gak kebaca, cuma time
stop yang jalan. Di live mode, wallet dicocokkan tiap ~30 detik; token yang hilang tanpa dijual
proses ini dicatat sebagai `external`. Semua penjualan lewat satu antrian, jadi exit loop, Close,
dan Close all gak pernah jual token yang sama dua kali.

Rencana exit bisa **fixed** (rencana operator untuk semua posisi) atau **agent** (model nulis
rencananya per beli, diklem ke batas yang kamu set; rencana yang gak menjual 100% diganti rencana
fixed atau beli-nya dibatalkan).

### Rugi harian

Rugi hari ini nembus `maxDailyLossPct` (default 20%) dari equity awal hari → **beli di-pause**, exit
tetap jalan. Hari dihitung UTC. Mode `auto` mencabut pause jam 00:00 UTC; `manual` nunggu Resume.

---

## Dashboard

`npm start` → http://127.0.0.1:3712 — vanilla JS, polling `/api/state` tiap 3 detik.

- **Overview** — kurva equity / realised PnL, posisi terbuka, kesehatan loop dan layanan, fills hari
  ini.
- **Trading** — token yang dilihat agent dan statusnya, aktivitas agent per hari, detail tiap run:
  brief, vonis, dan tool call-nya. Klik posisi buat lihat kenapa agent membelinya.
- **Settings** — Mode, Buy cycle, Risk check, Exit plan, Agent (model, jatah tool, prompt operator),
  plus Fetch filters. Disimpan utuh ke tabel `settings`, berlaku mulai siklus berikutnya. Semua nilai
  diklem di `src/config.ts` — setting bisa mempersempit batas risiko, gak bisa melebarkannya.
- **Start / Stop / Resume / Close** — Stop bisa sekalian *Close all & stop*.

"Hari ini" dan hari di grafik pakai zona waktu browser; cuma batas rugi harian yang pakai UTC.

Semua data ada di `data/tta.db` (SQLite, `TTA_DB` buat ganti path): token, snapshot, sinyal, run
agent, tool call, vonis, posisi, trade, equity. Kas dan equity paper dihitung dari tabel `trades` /
`equity`, gak disimpan terpisah.

### Prompt operator

Prompt di **Settings → Agent** ditempel ke system prompt sebagai kebijakan seleksi. Dia bisa
**memperketat** pilihan, gak bisa melonggarkan cek keamanan atau batas risiko — itu jalan di kode.
Contoh:

```
Cuma beli token yang udah migrasi ke PumpSwap, top 10 holder di bawah 30%, dan harga 1m masih naik.
Kalau bundler udah mulai jual, skip.
```

---

## Live mode

Live mode kirim swap on-chain beneran yang gak bisa dibatalin.

Swap lewat Jupiter Swap V2 (`/order` → tanda tangan di proses ini → `/execute`), pakai
`SOLANA_PRIVATE_KEY` di `.env`. Itu private key wallet beneran — **pakai hot wallet khusus dengan
saldo kecil.** Mengisi variabel itu adalah persetujuan kamu buat live trading otomatis. 0.02 SOL
selalu disisakan buat fee.

`GMGN_ALLOW_AUTOMATED_TRADES` cuma berlaku untuk route GMGN yang mengeluarkan dana (engine ini gak
memakainya). Kode ini sengaja gak pernah nge-set variabel itu sendiri.

Saran: jalanin paper dulu beberapa hari. Kalau equity-nya gak naik di paper, live cuma bikin rugi
lebih cepat.

> Memecoin trading risikonya sangat tinggi. Sebagian besar token akan ke nol. Ini alat, bukan
> saran finansial — kamu yang menanggung semua hasilnya.

---

## Environment

```
OPENROUTER_API_KEY=sk-or-v1-...    # wajib buat entry loop
OPENROUTER_MODEL=                  # default anthropic/claude-sonnet-4.5; bisa diganti per run di Settings
LLM_BASE_URL=                      # opsional: endpoint chat completions lain yang kompatibel OpenAI
GMGN_API_KEY=                      # wajib: semua route baca GMGN
GMGN_PRIVATE_KEY=                  # opsional: cuma route GMGN bertanda tangan
SOLANA_PRIVATE_KEY=                # cuma live mode
JUPITER_API_KEY=                   # opsional
SOLANA_RPC_URL=                    # opsional, default RPC publik mainnet
TTA_DB=                            # opsional, default data/tta.db
PORT=3712
HOST=127.0.0.1
DASHBOARD_TOKEN=                   # wajib kalau HOST bukan loopback; min. 32 karakter
```

**Rate limit:** GMGN Free plan dibatasi bobot 5 per detik, Jupiter 1 request per detik. Dua-duanya
diantrikan di proses ini (`src/gmgn/endpoint.ts`, `src/jupiter/client.ts`). Di plan berbayar,
naikkan `RATE_WEIGHT` di `endpoint.ts`.

### Deploy ke VPS

`HOST=0.0.0.0` tanpa `DASHBOARD_TOKEN` bikin proses nolak start. Dengan token, dashboard menampilkan
halaman login; sesinya (cookie HttpOnly) berlaku 30 hari, dan ganti token = semua sesi logout.
Tanpa token, request dengan Host di luar allowlist ditolak (proteksi DNS rebinding). Pasang HTTPS
di depannya, misalnya Caddy (`tidal.domainmu.com { reverse_proxy 127.0.0.1:3712 }`), dan biarkan
`HOST=127.0.0.1`.

---

## Struktur

```
public/                 dashboard (index.html, app.js, app.css — tanpa build step)
src/
  index.ts              entry point: exit loop, sampel equity, dashboard
  config.ts             setting operator: default, klem, fetch filters
  control.ts            Start / Stop / Resume / Close, pause rugi harian
  entry.ts              entry loop: fetch → jatuh tempo → snapshot → agent → beli
  decide.ts             satu run agent: brief, prompt, vonis
  snapshot.ts           /v1/token/info → tokens, token_snapshots, snapshot_flow
  exit.ts               exit loop: evaluate (murni) + eksekusi
  trade.ts              beli, jual, cek keamanan, buku paper & live
  view.ts               semua angka dashboard dihitung di sini
  server.ts, auth.ts    HTTP (node:http) dan login
  db.ts                 ledger SQLite (node:sqlite), STRICT tables
  agent/llm.ts          loop tool-calling di atas chat completions; gak impor apa pun dari repo
  gmgn/                 transport GMGN: auth, signing, antrian rate limit, tool agent
  jupiter/client.ts     swap, harga, baca saldo RPC
tests/                  node --test, mirror src/
```

Tool agent sengaja satu route read-only per tool (`src/gmgn/tools.ts`) — gak ada shell, gak ada
route yang mengeluarkan dana. Nama dan simbol token ditulis deployer-nya: diperlakukan sebagai data,
bukan instruksi, baik di prompt maupun di dashboard.
