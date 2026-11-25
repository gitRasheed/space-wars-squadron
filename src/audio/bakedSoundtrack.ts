export const SOUNDTRACK_IDS = ['saturn-orbit', 'megastructure-trench', 'sunset-ground-support'] as const;
export type SoundtrackId = (typeof SOUNDTRACK_IDS)[number];

/** Each file is the 32 s loop with half a second of wrapped audio on both sides, so the codec's edges sit outside the loop points. */
export const BAKED_LOOP = { startS: 0.5, endS: 32.5 } as const;

/** Resolves to nothing wherever the file cannot be fetched or decoded, and the caller keeps the synthesized loop. */
export async function loadBakedSoundtrack(ctx: AudioContext, id: SoundtrackId): Promise<AudioBuffer | undefined> {
  if (typeof fetch !== 'function' || typeof ctx.decodeAudioData !== 'function') return undefined;
  try {
    const response = await fetch(new URL(`audio/${id}.ogg`, document.baseURI));
    if (!response.ok) return undefined;
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    return buffer.duration >= BAKED_LOOP.endS ? buffer : undefined;
  } catch {
    return undefined;
  }
}
