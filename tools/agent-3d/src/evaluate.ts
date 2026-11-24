import { deltaE76, hexSrgbToLinearRgb, linearRgbToLabD65 } from './color.js';
import type { AssetMetrics, GateFinding, StyleCard, ViewMetrics } from './types.js';

export function evaluateAssetGates(
  metrics: AssetMetrics,
  card: StyleCard | null,
  views?: readonly ViewMetrics[],
): { readonly ok: boolean; readonly unsupportedGate: boolean; readonly findings: readonly GateFinding[] } {
  const findings: GateFinding[] = [];
  let unsupportedGate = false;

  if (metrics.visibleMeshCount === 0 || metrics.trianglesByOccurrence === 0 || metrics.worldBounds === null) {
    findings.push({
      id: 'EMPTY_GEOMETRY',
      severity: 'fail',
      message: 'Asset contains no visible mesh triangles',
      actual: metrics.trianglesByOccurrence,
      limit: 1,
    });
  }

  const maxDegenerate = card?.budgets?.degenerateTrianglesMax ?? 0;
  if (metrics.degenerateTriangles > maxDegenerate) {
    findings.push({
      id: 'DEGENERATE_TRIANGLES',
      severity: 'fail',
      message: `Detected ${metrics.degenerateTriangles} degenerate triangle(s) (limit ${maxDegenerate})`,
      actual: metrics.degenerateTriangles,
      limit: maxDegenerate,
    });
  }

  if (card !== null) {
    const budgets = card.budgets;
    if (budgets?.trisMax !== undefined && metrics.trianglesByOccurrence > budgets.trisMax) {
      findings.push({
        id: 'TRIANGLES_OVER_BUDGET',
        severity: 'fail',
        message: `Visible triangles (${metrics.trianglesByOccurrence}) exceed budget (${budgets.trisMax})`,
        actual: metrics.trianglesByOccurrence,
        limit: budgets.trisMax,
      });
    }

    if (budgets?.materialsMax !== undefined && metrics.effectiveMaterials > budgets.materialsMax) {
      findings.push({
        id: 'MATERIALS_OVER_BUDGET',
        severity: 'fail',
        message: `Referenced material count (${metrics.effectiveMaterials}) exceeds budget (${budgets.materialsMax})`,
        actual: metrics.effectiveMaterials,
        limit: budgets.materialsMax,
      });
    }

    if (budgets?.texturesMax !== undefined && metrics.effectiveTextures > budgets.texturesMax) {
      findings.push({
        id: 'TEXTURES_OVER_BUDGET',
        severity: 'fail',
        message: `Referenced texture count (${metrics.effectiveTextures}) exceeds budget (${budgets.texturesMax})`,
        actual: metrics.effectiveTextures,
        limit: budgets.texturesMax,
      });
    }

    if (
      budgets?.bytesMax !== undefined &&
      metrics.glbSource !== null &&
      metrics.glbSource.bytes > budgets.bytesMax
    ) {
      findings.push({
        id: 'GLB_BYTES_OVER_BUDGET',
        severity: 'fail',
        message: `GLB size (${metrics.glbSource.bytes} bytes) exceeds budget (${budgets.bytesMax} bytes)`,
        actual: metrics.glbSource.bytes,
        limit: budgets.bytesMax,
      });
    }

    if (
      budgets?.requireTriangleLists === true &&
      metrics.glbSource !== null &&
      metrics.glbSource.nonTrianglePrimitives > 0
    ) {
      findings.push({
        id: 'NON_TRIANGLE_PRIMITIVES',
        severity: 'fail',
        message: `Source GLB contains ${metrics.glbSource.nonTrianglePrimitives} non-triangle primitive(s)`,
        actual: metrics.glbSource.nonTrianglePrimitives,
        limit: 0,
      });
    }

    if (card.pivot !== undefined && metrics.worldBounds !== null && metrics.worldBounds.maxExtent > 0) {
      const tol = (card.pivotToleranceFraction ?? 0.05) * metrics.worldBounds.maxExtent;
      if (card.pivot === 'ground') {
        if (Math.abs(metrics.worldBounds.min.y) > tol) {
          findings.push({
            id: 'PIVOT_GROUND_MISMATCH',
            severity: 'fail',
            message: `Ground pivot mismatch: min.y=${metrics.worldBounds.min.y} (tolerance ±${tol})`,
            actual: metrics.worldBounds.min.y,
            limit: tol,
          });
        }
      } else {
        const offset = Math.hypot(
          metrics.worldBounds.center.x,
          metrics.worldBounds.center.y,
          metrics.worldBounds.center.z,
        );
        if (offset > tol) {
          findings.push({
            id: 'PIVOT_CENTER_MISMATCH',
            severity: 'fail',
            message: `Center pivot offset ${offset} exceeds tolerance ${tol}`,
            actual: offset,
            limit: tol,
          });
        }
      }
    }

    if (card.palette !== undefined && Object.keys(card.palette).length > 0) {
      // Evaluate all assessed untextured colors regardless of whether textured meshes are also present.
      if (
        metrics.palette.assessedMeshes > 0 &&
        card.paletteDeltaE76Max !== undefined &&
        metrics.palette.maxDeltaE76 !== null &&
        metrics.palette.maxDeltaE76 > card.paletteDeltaE76Max
      ) {
        const worst = metrics.palette.worstViolation;
        findings.push({
          id: 'PALETTE_DELTA_E_EXCEEDED',
          severity: 'fail',
          message:
            worst !== null
              ? `Mesh '${worst.meshName}' color ${worst.hexSrgb} has ΔE76=${worst.deltaE76.toFixed(2)} vs ${worst.nearestRole} (${worst.nearestHex}), limit ${card.paletteDeltaE76Max}`
              : `Max palette ΔE76 (${metrics.palette.maxDeltaE76}) exceeds limit (${card.paletteDeltaE76Max})`,
          actual: metrics.palette.maxDeltaE76,
          limit: card.paletteDeltaE76Max,
        });
      }

      if (metrics.palette.texturedMeshes > 0) {
        if (card.requirePaletteOnTextured === true) {
          unsupportedGate = true;
          findings.push({
            id: 'PALETTE_UNSUPPORTED_TEXTURED',
            severity: 'unsupported',
            message:
              'Style card requires palette verification on textured meshes, which is unsupported in v1',
          });
        } else {
          findings.push({
            id: 'PALETTE_UNASSESSED_TEXTURED',
            severity: 'info',
            message: `Palette check skipped on ${metrics.palette.texturedMeshes} textured mesh(es); inspect contact sheet`,
          });
        }
      }

      if (card.separationRoles !== undefined && card.separationMinDeltaE76 !== undefined) {
        for (const [roleA, roleB] of card.separationRoles) {
          const hexA = card.palette[roleA];
          const hexB = card.palette[roleB];
          if (hexA === undefined || hexB === undefined) {
            unsupportedGate = true;
            findings.push({
              id: 'SEPARATION_ROLE_MISSING',
              severity: 'unsupported',
              message: `Named separation pair [${roleA}, ${roleB}] references a role missing from palette`,
            });
            continue;
          }
          const linA = hexSrgbToLinearRgb(hexA);
          const linB = hexSrgbToLinearRgb(hexB);
          const dist = deltaE76(
            linearRgbToLabD65(linA[0], linA[1], linA[2]),
            linearRgbToLabD65(linB[0], linB[1], linB[2]),
          );
          if (dist < card.separationMinDeltaE76) {
            findings.push({
              id: 'ROLE_SEPARATION_LOW',
              severity: 'fail',
              message: `Palette roles '${roleA}' (${hexA}) and '${roleB}' (${hexB}) ΔE76=${dist.toFixed(4)} below minimum ${card.separationMinDeltaE76}`,
              actual: dist,
              limit: card.separationMinDeltaE76,
            });
          }
        }
      }
    }
  }

  if (views !== undefined) {
    for (const view of views) {
      if (view.coverageRatio < 0.01) {
        findings.push({
          id: 'VIEW_SUBJECT_MISSING',
          severity: 'fail',
          message: `View '${view.id}' mask coverage ${view.coverageRatio} is blank/missing`,
          actual: view.coverageRatio,
          limit: 0.01,
        });
      }
      if (view.edgeClipped) {
        findings.push({
          id: 'VIEW_EDGE_CLIPPED',
          severity: 'fail',
          message: `View '${view.id}' subject touches tile edge (clipped)`,
          actual: true,
          limit: false,
        });
      }
      if (view.beautyUniqueColors < 4) {
        findings.push({
          id: 'VIEW_BEAUTY_FLAT',
          severity: 'fail',
          message: `View '${view.id}' beauty tile has only ${view.beautyUniqueColors} quantized colors`,
          actual: view.beautyUniqueColors,
          limit: 4,
        });
      }
    }
  }

  const hasFailure = findings.some((f) => f.severity === 'fail');
  return {
    ok: !hasFailure && !unsupportedGate,
    unsupportedGate,
    findings,
  };
}
