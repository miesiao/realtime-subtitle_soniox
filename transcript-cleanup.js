// Batch pipeline (SPEC §6.5 / §6): ended → read all TranscriptLine.original_text
// for the session → send once to Claude to clean up → write back
// cleaned_transcript, processing_status = 'ready'. This is a completely
// separate pipeline from the realtime broadcast path — it only ever runs
// after a session has already ended, and nothing here is on the hot path
// for live subtitles. Slow is fine; blocking a viewer is not.
import Anthropic from '@anthropic-ai/sdk';
import { dbGetTranscriptLines, dbSetProcessingStatus, dbSetCleanedTranscript } from './db.js';

// Cost-reasonable default for a first pass — swap for a stronger model later
// if cleanup quality needs it (SPEC: "先用一個成本合理的即可，之後再調").
const CLEANUP_MODEL = 'claude-haiku-4-5-20251001';

let anthropic = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

const SYSTEM_PROMPT = `你是逐字稿整理助手。輸入是即時語音辨識產生的原始逐句文字（可能有口頭禪、贅字、缺標點、少量辨識錯字）。
請將其整理成一份可閱讀的逐字稿：
- 合理分段
- 去除明顯的口頭禪與贅字（例如「呃」「那個」「就是說」重複贅詞），但不可改變原意或刪減實質內容
- 補上標點符號
- 視內容加上簡短小標（可選，只在有明顯段落主題時加）
只輸出整理後的逐字稿本文，不要加前言或說明。`;

// Exported standalone so a failed run can be retried later without
// re-deriving anything (SPEC: "設計成之後能重新觸發整理"). Safe to call
// again — it always re-reads the lines fresh and overwrites the previous
// result/status.
export async function runTranscriptCleanup(sessionId) {
  try {
    await dbSetProcessingStatus(sessionId, 'processing');

    const lines = await dbGetTranscriptLines(sessionId);
    if (lines.length === 0) {
      console.warn(`[transcript-cleanup] session=${sessionId} has no transcript lines — marking ready with empty transcript`);
      await dbSetCleanedTranscript(sessionId, '');
      return;
    }

    const client = getClient();
    if (!client) {
      throw new Error('ANTHROPIC_API_KEY not set — cannot run transcript cleanup');
    }

    const rawTranscript = lines.join('\n');
    const message = await client.messages.create({
      model: CLEANUP_MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: rawTranscript }],
    });

    const cleaned = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    await dbSetCleanedTranscript(sessionId, cleaned);
    console.log(`[transcript-cleanup] session=${sessionId} ready (${lines.length} lines → ${cleaned.length} chars)`);
  } catch (err) {
    console.error(`[transcript-cleanup] session=${sessionId} failed:`, err);
    try {
      await dbSetProcessingStatus(sessionId, 'failed');
    } catch (statusErr) {
      console.error(`[transcript-cleanup] session=${sessionId} also failed to record 'failed' status:`, statusErr);
    }
  }
}
