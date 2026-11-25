export type AxisDirection = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export interface StyleCardBudgets {
  readonly trisMax?: number;
  readonly materialsMax?: number;
  readonly texturesMax?: number;
  readonly bytesMax?: number;
  readonly degenerateTrianglesMax?: number;
  readonly requireTriangleLists?: boolean;
}

/** Opt-in shape gates. Every measured value is reported whether or not a gate is set. */
export interface StyleCardGeometry {
  /** Lowest vertex must sit on y=0 within groundToleranceFraction of the largest extent. */
  readonly groundContact?: boolean;
  readonly groundToleranceFraction?: number;
  /** Minimum ground footprint (x/z box of vertices within tolerance of min.y, over the full x/z box). */
  readonly groundFootprintMin?: number;
  /** Minimum share of vertices whose mirror across the width-axis mid-plane has a vertex within tolerance. */
  readonly mirrorSymmetryMin?: number;
  readonly symmetryToleranceFraction?: number;
  /** Inclusive [min, max] for length / width, with length along frontAxis. */
  readonly lengthToWidth?: readonly [number, number];
  /** Inclusive [min, max] for height / length. */
  readonly heightToLength?: readonly [number, number];
}

export interface StyleCard {
  readonly id: string;
  readonly frontAxis?: AxisDirection;
  readonly topUpAxis?: AxisDirection;
  readonly pivot?: 'center' | 'ground';
  readonly pivotToleranceFraction?: number;
  readonly palette?: Readonly<Record<string, string>>;
  readonly paletteDeltaE76Max?: number;
  readonly requirePaletteOnTextured?: boolean;
  /** ShaderMaterial uniforms tried in order for the base color; the first Color or Vector3 found is scored. */
  readonly shaderColorUniforms?: readonly string[];
  /** [color, intensity] uniforms added to a scored shader color, like emissive on a built-in material. */
  readonly shaderEmissiveUniforms?: readonly [string, string];
  readonly separationMinDeltaE76?: number;
  readonly separationRoles?: readonly (readonly [string, string])[];
  readonly budgets?: StyleCardBudgets;
  readonly geometry?: StyleCardGeometry;
}

export type LightingPreset = 'studio' | 'cel' | 'dramatic';

export interface CaptureSettings {
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** Framing multiplier; above 1 crops in, so edge clipping becomes informational. */
  readonly zoom: number;
  /** Ortho views stay at zoom 1 unless this is set, so silhouettes never clip. */
  readonly zoomOrtho: boolean;
  readonly lighting: LightingPreset;
}

export interface MirrorSymmetry {
  readonly planeAxis: 'x' | 'y' | 'z';
  readonly planeCoord: number;
  /** |planeCoord| / maxExtent: how far the mirror plane sits from the pivot. */
  readonly planeOffsetFraction: number;
  readonly matchRatio: number;
  readonly sampledPoints: number;
  readonly toleranceFraction: number;
}

export interface ShapeMetrics {
  readonly lengthAxis: 'x' | 'y' | 'z';
  readonly widthAxis: 'x' | 'y' | 'z';
  readonly heightAxis: 'x' | 'y' | 'z';
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly lengthToWidth: number | null;
  readonly heightToLength: number | null;
  readonly groundOffset: number;
  readonly groundFootprintRatio: number | null;
  readonly groundToleranceFraction: number;
  readonly mirror: MirrorSymmetry;
}

export interface Vec3Tuple {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface WorldBounds {
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
  readonly size: Vec3Tuple;
  readonly center: Vec3Tuple;
  readonly maxExtent: number;
  readonly boundingRadius: number;
}

export interface GlbSourceInfo {
  readonly bytes: number;
  readonly scenes: number;
  readonly declaredMaterials: number;
  readonly declaredTextures: number;
  readonly nonTrianglePrimitives: number;
}

export interface PaletteCornerViolation {
  readonly meshName: string;
  readonly hexSrgb: string;
  readonly nearestRole: string;
  readonly nearestHex: string;
  readonly deltaE76: number;
}

export interface SampledColor {
  readonly hexSrgb: string;
  readonly samples: number;
  /** First few mesh names (sorted) that produced this color. */
  readonly meshes: readonly string[];
  readonly nearestRole: string | null;
  readonly nearestHex: string | null;
  readonly deltaE76: number | null;
}

export interface PaletteAssessment {
  readonly status: 'assessed' | 'partial_textured' | 'unassessed_textured' | 'skipped_no_palette';
  readonly assessedMeshes: number;
  readonly texturedMeshes: number;
  /** Meshes drawn with a ShaderMaterial that has no recognized color uniform, so the authored color is unknown. */
  readonly shaderMeshes: number;
  /** Meshes whose color was read from a ShaderMaterial uniform. */
  readonly shaderUniformMeshes: number;
  readonly sampledCorners: number;
  readonly distinctColors: number;
  readonly maxDeltaE76: number | null;
  readonly worstViolation: PaletteCornerViolation | null;
  /** Most-sampled distinct colors, capped at 48. Sampled even without a card palette. */
  readonly colors: readonly SampledColor[];
}

export interface AssetMetrics {
  readonly inputKind: 'glb' | 'factory';
  readonly glbSource: GlbSourceInfo | null;
  readonly trianglesByOccurrence: number;
  readonly trianglesUnique: number;
  readonly positionVerticesUnique: number;
  readonly lineSegmentsCount: number;
  readonly lineVerticesCount: number;
  readonly effectiveMaterials: number;
  readonly effectiveTextures: number;
  readonly degenerateTriangles: number;
  readonly visibleMeshCount: number;
  readonly hiddenMeshCount: number;
  readonly worldBounds: WorldBounds | null;
  readonly palette: PaletteAssessment;
  readonly shape: ShapeMetrics | null;
}

export interface GateFinding {
  readonly id: string;
  readonly severity: 'fail' | 'warn' | 'info' | 'unsupported';
  readonly message: string;
  readonly actual?: number | string | boolean;
  readonly limit?: number | string | boolean;
}

export interface ViewMetrics {
  readonly id: string;
  readonly ortho: boolean;
  /** Camera zoom this view was rendered at. */
  readonly zoom: number;
  readonly coverageRatio: number;
  readonly culledFrontSideRatio?: number;
  readonly edgeClipped: boolean;
  readonly beautyUniqueColors: number;
}

export interface Check3DReport {
  readonly schemaVersion: 'agent-3d/check/v1';
  readonly ok: boolean;
  readonly unsupportedGate: boolean;
  readonly asset: string;
  readonly cardId: string | null;
  readonly metrics: AssetMetrics;
  readonly consoleErrors: readonly string[];
  readonly findings: readonly GateFinding[];
}

export interface TurntableReport {
  readonly schemaVersion: 'agent-3d/turntable/v1';
  readonly ok: boolean;
  readonly unsupportedGate: boolean;
  readonly asset: string;
  readonly cardId: string | null;
  readonly contactSheetPath: string;
  /** Black-on-white ortho-top and ortho-front masks, written with --black-fill. */
  readonly silhouetteSheetPath: string | null;
  readonly viewPaths: readonly string[];
  readonly capture: CaptureSettings;
  readonly metrics: AssetMetrics;
  readonly views: readonly ViewMetrics[];
  readonly consoleErrors: readonly string[];
  readonly findings: readonly GateFinding[];
}

export interface BatchAssetRow {
  readonly name: string;
  readonly asset: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly reportPath: string | null;
  readonly triangles: number | null;
  readonly degenerateTriangles: number | null;
  readonly paletteStatus: PaletteAssessment['status'] | null;
  readonly assessedMeshes: number | null;
  readonly shaderUniformMeshes: number | null;
  readonly unassessedMeshes: number | null;
  readonly paletteSamples: number | null;
  readonly paletteMaxDeltaE76: number | null;
  /** Ids of findings with severity fail or unsupported. */
  readonly failures: readonly string[];
  readonly error: string | null;
}

export interface BatchReport {
  readonly schemaVersion: 'agent-3d/batch/v1';
  readonly ok: boolean;
  readonly dir: string;
  readonly outDir: string;
  readonly cardId: string | null;
  readonly capture: CaptureSettings;
  /** Every asset's ortho-top and ortho-front masks in one image, written with --black-fill. */
  readonly blackFillMasksPath: string | null;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly assets: readonly BatchAssetRow[];
}
