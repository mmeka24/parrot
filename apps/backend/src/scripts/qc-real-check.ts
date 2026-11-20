/**
 * Run the real QC gate on real files - no mocks. Prints each check.
 *
 *   npx tsx src/scripts/qc-real-check.ts <dub> <original> <targetLang> [dubProvider]
 *
 * Needs XAI_API_KEY and FFMPEG_PATH (or ffmpeg on PATH).
 */
import { getConfig, loadDotEnv } from '../config.js';
import { QcService } from '../services/qc-service.js';

loadDotEnv();
const [dubPath, sourcePath, targetLang = 'es', dubProvider = 'ElevenLabs'] = process.argv.slice(2);
if (!dubPath || !sourcePath) {
  console.error('usage: qc-real-check.ts <dub> <original> <targetLang> [dubProvider]');
  process.exit(1);
}
const qc = new QcService({ ffmpegPath: getConfig().env.FFMPEG_PATH });
const report = await qc.run({ dubPath, sourcePath, sourceDurationS: 0, targetLang, dubProvider });
console.log(`RESULT: ${report.passed ? 'PUBLISH' : 'BLOCKED'}`);
for (const c of report.checks) {
  console.log(`  [${c.status.toUpperCase()}] ${c.name}: ${c.detail}`);
}
