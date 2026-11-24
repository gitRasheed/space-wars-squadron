export type SupportedSampleRate = 44100 | 48000;
export type SupportedChannels = 1 | 2;
export type SupportedBitFormat = 'pcm16' | 'pcm24' | 'float32';

export interface AudioBufferData {
  readonly sampleRate: SupportedSampleRate;
  readonly channels: readonly Float64Array[];
  readonly format: SupportedBitFormat;
}

export type WavErrorCode =
  | 'FILE_NOT_FOUND'
  | 'INVALID_HEADER'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_SAMPLE_RATE'
  | 'UNSUPPORTED_CHANNELS'
  | 'MISSING_DATA_CHUNK'
  | 'TRUNCATED_DATA'
  | 'NONFINITE_SAMPLE';

export class WavError extends Error {
  readonly code: WavErrorCode;
  constructor(code: WavErrorCode, message: string) {
    super(message);
    this.name = 'WavError';
    this.code = code;
  }
}

export type FindingSeverity = 'fail' | 'warn' | 'info';

export interface CheckFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly channel?: number;
  readonly frame?: number;
  readonly timeS?: number;
}

export interface ChannelMetrics {
  readonly channel: number;
  readonly peakLinear: number;
  readonly peakDbfs: number | null;
  readonly rmsLinear: number;
  readonly rmsDbfs: number | null;
  readonly dcOffset: number;
  readonly fullScaleSamples: number;
  readonly fullScaleMaxRun: number;
  readonly startEdgePeak: number;
  readonly endEdgePeak: number;
  readonly leadingSilenceS: number;
  readonly trailingSilenceS: number;
  readonly maxFirstDiff: number;
  readonly clickRatio: number;
  readonly clickFrame: number;
  readonly clickTimeS: number;
  readonly loopSeam: LoopSeamMetrics | null;
}

export interface LoopSeamMetrics {
  readonly wrapDelta: number;
  readonly wrapPredictionError: number;
  readonly interiorPredictionP95: number;
  readonly discontinuityRatio: number;
}

export interface LoudnessMetrics {
  readonly integratedLufs: number | null;
  readonly integratedReason: string | null;
  readonly momentaryMaxLufs: number | null;
  readonly momentaryPadded: boolean;
  readonly truePeakDbtp: number | null;
  readonly truePeakChannel: number | null;
  readonly truePeakFrame: number | null;
}

export interface SpectralMetrics {
  readonly centroidHz: number;
  readonly rolloff85Hz: number;
  readonly rolloff95Hz: number;
}

export interface StereoMetrics {
  readonly balanceDb: number | null;
  readonly correlation: number | null;
}

export interface CheckThresholds {
  readonly maxTruePeakDbtp?: number;
  readonly maxDcOffset?: number;
  readonly maxFullScaleSamples?: number;
  readonly maxLeadingSilenceS?: number;
  readonly maxEndEdgeRatio?: number;
  readonly maxClickRatio?: number;
  readonly minMomentaryLufs?: number;
  readonly maxMomentaryLufs?: number;
  readonly minIntegratedLufs?: number;
  readonly maxIntegratedLufs?: number;
  readonly maxLoopDiscontinuityRatio?: number;
  readonly maxLoopWrapDelta?: number;
  readonly maxStereoBalanceDb?: number;
}

export interface CheckReport {
  readonly schemaVersion: 'agent-audio/check/v1';
  readonly ok: boolean;
  readonly file: string;
  readonly loopChecked: boolean;
  readonly format: {
    readonly sampleRateHz: SupportedSampleRate;
    readonly channels: SupportedChannels;
    readonly encoding: SupportedBitFormat;
    readonly frames: number;
    readonly durationS: number;
  };
  readonly loudness: LoudnessMetrics;
  readonly stereo: StereoMetrics | null;
  readonly spectral: SpectralMetrics;
  readonly channels: readonly ChannelMetrics[];
  readonly thresholds: CheckThresholds;
  readonly findings: readonly CheckFinding[];
  readonly pngs?: {
    readonly waveform: string;
    readonly spectrogram: string;
    readonly seamWrap?: string;
  };
}

export type WaveformType = 'sine' | 'triangle' | 'saw' | 'square' | 'noise' | 'fm';

export interface AdsrEnvelope {
  readonly attackS: number;
  readonly decayS: number;
  readonly sustainLevel: number;
  readonly releaseS: number;
}

export interface BiquadSpec {
  readonly type: 'lowpass' | 'highpass' | 'bandpass';
  readonly freqHz: number;
  readonly q?: number;
}

export interface VoiceSpec {
  readonly id: string;
  readonly waveform: WaveformType;
  readonly gainDb: number;
  readonly pan?: number;
  readonly freqStartHz?: number;
  readonly freqEndHz?: number;
  readonly freqCurve?: 'linear' | 'exp';
  readonly fmRatio?: number;
  readonly fmIndex?: number;
  readonly envelope: AdsrEnvelope;
  readonly filter?: BiquadSpec;
  readonly drive?: number;
  readonly startS?: number;
  readonly durationS?: number;
}

export interface NoteEvent {
  readonly startBeat: number;
  readonly durationBeats: number;
  readonly midi: number;
  readonly velocity: number;
}

export interface MusicTrackSpec {
  readonly id: string;
  readonly voice: Omit<VoiceSpec, 'id' | 'freqStartHz' | 'freqEndHz' | 'startS' | 'durationS'>;
  readonly notes: readonly NoteEvent[];
}

export interface OneShotRecipe {
  readonly schemaVersion: 'agent-audio/recipe/v1';
  readonly kind: 'one-shot';
  readonly id: string;
  readonly sampleRate?: SupportedSampleRate;
  readonly channels?: SupportedChannels;
  readonly encoding?: 'pcm16' | 'float32';
  readonly seed?: number;
  readonly durationS: number;
  readonly masterGainDb?: number;
  readonly voices: readonly VoiceSpec[];
}

export interface LoopRecipe {
  readonly schemaVersion: 'agent-audio/recipe/v1';
  readonly kind: 'loop';
  readonly id: string;
  readonly sampleRate?: SupportedSampleRate;
  readonly channels?: SupportedChannels;
  readonly encoding?: 'pcm16' | 'float32';
  readonly seed?: number;
  readonly bpm: number;
  readonly beats: number;
  readonly masterGainDb?: number;
  readonly loopWrap?: boolean;
  readonly tracks: readonly MusicTrackSpec[];
}

export type AudioRecipe = OneShotRecipe | LoopRecipe;
