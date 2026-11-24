export type AxisDirection = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export interface StyleCardBudgets {
  readonly trisMax?: number;
  readonly materialsMax?: number;
  readonly texturesMax?: number;
  readonly bytesMax?: number;
  readonly degenerateTrianglesMax?: number;
  readonly requireTriangleLists?: boolean;
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
  readonly separationMinDeltaE76?: number;
  readonly separationRoles?: readonly (readonly [string, string])[];
  readonly budgets?: StyleCardBudgets;
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

export interface PaletteAssessment {
  readonly status: 'assessed' | 'partial_textured' | 'unassessed_textured' | 'skipped_no_palette';
  readonly assessedMeshes: number;
  readonly texturedMeshes: number;
  readonly sampledCorners: number;
  readonly maxDeltaE76: number | null;
  readonly worstViolation: PaletteCornerViolation | null;
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
  readonly findings: readonly GateFinding[];
}

export interface TurntableReport {
  readonly schemaVersion: 'agent-3d/turntable/v1';
  readonly ok: boolean;
  readonly unsupportedGate: boolean;
  readonly asset: string;
  readonly cardId: string | null;
  readonly contactSheetPath: string;
  readonly metrics: AssetMetrics;
  readonly views: readonly ViewMetrics[];
  readonly findings: readonly GateFinding[];
}
