/**
 * Audio/video transcription via Deepgram API.
 * Used to transcribe media files from Google Drive (and potentially other sources).
 */
import { getCredential } from './keychain.ts';

export function hasDeepgramKey(): boolean {
  return getCredential('deepgram', 'default') !== null;
}

export async function transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = getCredential('deepgram', 'default');
  if (!apiKey) {
    throw new Error('Deepgram not configured. Run: gated-knowledge auth deepgram --token <api-key>');
  }

  const params = new URLSearchParams({
    model: 'nova-2',
    smart_format: 'true',
    paragraphs: 'true',
    utterances: 'true',
    diarize: 'true',
    detect_language: 'true',
  });

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': mimeType,
    },
    body: audioBuffer,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Deepgram API error (${res.status}): ${err}`);
  }

  const data = await res.json() as any;

  // Build metadata header
  const meta: string[] = [];
  const detected = data.results?.channels?.[0]?.detected_language;
  if (detected) meta.push(`Language: ${detected}`);
  const duration = data.metadata?.duration;
  if (duration) meta.push(`Duration: ${formatDuration(duration)}`);

  // Extract transcription with speaker labels (utterances mode)
  const utterances = data.results?.utterances;
  if (utterances?.length) {
    const text = utterances
      .map((u: any) => `[Speaker ${u.speaker}] ${u.transcript}`)
      .join('\n\n');
    return meta.length ? `${meta.join(' | ')}\n\n${text}` : text;
  }

  // Fallback to paragraphs
  const paragraphs = data.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs;
  if (paragraphs?.length) {
    const text = paragraphs
      .map((p: any) => p.sentences?.map((s: any) => s.text).join(' ') || '')
      .join('\n\n');
    return meta.length ? `${meta.join(' | ')}\n\n${text}` : text;
  }

  // Final fallback: plain transcript
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '(empty transcription)';
  return meta.length ? `${meta.join(' | ')}\n\n${transcript}` : transcript;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
