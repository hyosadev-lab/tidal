import { fetchTokenInfo, fetchCandlestick, fetchTrendingTokens, fetchContractSecurity } from "./gmgn";
import { saveToken, saveCandlestick, saveTrending, saveSecurity, getDBStats } from "../storage/db";

// ============================================================
// COLLECTOR - Ambil data dari GMGN dan simpan ke JSON
// Ini adalah inti dari Phase 1: Observasi & Kumpulkan Data
// ============================================================

// Delay helper agar tidak spam API
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Kumpulkan data untuk satu token spesifik
export async function collectTokenData(tokenAddress: string): Promise<void> {
  console.log(`\n🔍 Mengumpulkan data untuk token: ${tokenAddress}`);

  try {
    // 1. Info dasar token
    const tokenInfo = await fetchTokenInfo(tokenAddress);
    saveToken(tokenInfo);
    console.log(`  ✅ Token info: ${tokenInfo.symbol} @ $${tokenInfo.price}`);

    await delay(500);

    // 2. Candlestick berbagai resolusi
    const resolutions = ["1m", "5m", "15m", "1h"];
    for (const res of resolutions) {
      const candles = await fetchCandlestick(tokenAddress, res, 100);
      saveCandlestick(candles);
      console.log(`  ✅ Candlestick ${res}: ${candles.candles.length} candles`);
      await delay(300);
    }

    // 3. Security check
    const security = await fetchContractSecurity(tokenAddress);
    saveSecurity(security);
    console.log(`  ✅ Security: Risk Level = ${security.riskLevel}`);

  } catch (err) {
    console.error(`  ❌ Gagal mengumpulkan data untuk ${tokenAddress}:`, err);
  }
}

// Kumpulkan trending tokens + data mereka
export async function collectTrendingData(limit: number = 10): Promise<void> {
  console.log(`\n🔥 Mengumpulkan trending tokens...`);

  try {
    const trending = await fetchTrendingTokens(limit);
    saveTrending(trending);
    console.log(`  ✅ ${trending.length} trending tokens disimpan`);

    // Kumpulkan detail untuk setiap trending token
    console.log(`\n📊 Mengumpulkan detail untuk setiap trending token...`);
    for (const token of trending) {
      await collectTokenData(token.address);
      await delay(1000); // Jeda antar token agar tidak kena rate limit
    }

  } catch (err) {
    console.error(`  ❌ Gagal mengumpulkan trending data:`, err);
  }
}

// Jalankan satu siklus pengumpulan data
export async function runCollectionCycle(watchlist: string[] = []): Promise<void> {
  const startTime = Date.now();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`⏰ Collection Cycle dimulai: ${new Date().toLocaleString("id-ID")}`);
  console.log(`${"=".repeat(60)}`);

  // Kumpulkan trending
  await collectTrendingData(10);

  // Kumpulkan data untuk token dalam watchlist (jika ada)
  if (watchlist.length > 0) {
    console.log(`\n👀 Mengumpulkan data watchlist (${watchlist.length} token)...`);
    for (const address of watchlist) {
      await collectTokenData(address);
      await delay(1000);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Collection Cycle selesai dalam ${elapsed}s`);
  console.log(`📁 Stats DB:`, getDBStats());
}
