import * as fs from "fs";
import * as path from "path";
import { runCollectionCycle } from "./data/collector";
import { getDBStats } from "./storage/db";

// ============================================================
// MAIN - Entry point sistem trading bot
// Phase 1: Hanya mengumpulkan data (belum ada trading)
// ============================================================

// Load .env secara manual (tanpa library tambahan)
function loadEnv(): void {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    console.warn("⚠️  File .env tidak ditemukan. Buat file .env terlebih dahulu.");
    console.warn("   Contoh isi .env:\n   GMGN_API_KEY=your_api_key_here\n");
    return;
  }

  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join("=").trim();
    }
  }
  console.log("✅ .env berhasil dimuat");
}

// Watchlist token yang ingin dipantau secara khusus
// Tambahkan token address Solana yang ingin kamu pantau
const WATCHLIST: string[] = [
  // Contoh: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  // Tambahkan token address kamu di sini
];

// Interval pengumpulan data (dalam milidetik)
const COLLECTION_INTERVAL_MS = 5 * 60 * 1000; // 5 menit

async function main(): Promise<void> {
  console.log("🚀 GMGN Trading Bot - Phase 1: Data Collection");
  console.log("=".repeat(60));

  // Load environment variables
  loadEnv();

  if (!process.env.GMGN_API_KEY) {
    console.error("❌ GMGN_API_KEY belum di-set. Tambahkan ke file .env");
    process.exit(1);
  }

  console.log(`⚙️  Mode: PAPER TRADING (tidak ada eksekusi nyata)`);
  console.log(`⏱️  Interval: setiap ${COLLECTION_INTERVAL_MS / 60000} menit`);
  console.log(`👀 Watchlist: ${WATCHLIST.length > 0 ? WATCHLIST.length + " token" : "kosong (hanya trending)"}`);
  console.log(`📁 Data disimpan ke: ./data/db.json`);
  console.log("=".repeat(60));

  // Jalankan pertama kali langsung
  await runCollectionCycle(WATCHLIST);

  // Jalankan terus setiap interval
  console.log(`\n⏰ Scheduler aktif. Cycle berikutnya dalam ${COLLECTION_INTERVAL_MS / 60000} menit...`);
  setInterval(async () => {
    await runCollectionCycle(WATCHLIST);
    console.log(`\n⏰ Cycle berikutnya dalam ${COLLECTION_INTERVAL_MS / 60000} menit...`);
  }, COLLECTION_INTERVAL_MS);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n🛑 Bot dihentikan.");
  console.log("📁 Stats terakhir:", getDBStats());
  process.exit(0);
});

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
