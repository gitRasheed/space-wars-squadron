import { deltaE76, hexSrgbToLinearRgb, linearRgbToLabD65 } from './color.js';
import type { AssetMetrics, CaptureSettings, GateFinding, StyleCard, StyleCardGeometry, ViewMetrics } from './types.js';

export interface GateContext {
  readonly consoleErrors?: readonly string[];
  /** Default true: any console error fails the gate. False reports them as warnings. */
  readonly failOnConsoleError?: boolean;
  readonly capture?: CaptureSettings;
}

function geometryFindings(metrics: AssetMetrics, geometry: StyleCardGeometry): GateFinding[] {
  const shape = metrics.shape;
  const bounds = metrics.worldBounds;
  if (shape === null || bounds === null) return [];
  const findings: GateFinding[] = [];
  if (geometry.groundContact === true) {
    const tol = shape.groundToleranceFraction * bounds.maxExtent;
    if (Math.abs(shape.groundOffset) > tol) {
      const floating = shape.groundOffset > 0;
      findings.push({
        id: floating ? 'GROUND_FLOATING' : 'GROUND_SINKING',
        severity: 'fail',
        message: `Lowest point min.y=${shape.groundOffset.toFixed(4)} ${floating ? 'floats above' : 'sinks below'} y=0 (tolerance ±${tol.toFixed(4)})`,
        actual: shape.groundOffset,
        limit: tol,
      });
    }
  }
  if (
    geometry.groundFootprintMin !== undefined &&
    (shape.groundFootprintRatio === null || shape.groundFootprintRatio < geometry.groundFootprintMin)
  ) {
    findings.push({
      id: 'GROUND_FOOTPRINT_SMALL',
      severity: 'fail',
      message: `Ground footprint ${shape.groundFootprintRatio?.toFixed(3) ?? 'n/a'} of the x/z box is below ${geometry.groundFootprintMin}; the asset may balance on a point or edge`,
      actual: shape.groundFootprintRatio ?? 0,
      limit: geometry.groundFootprintMin,
    });
  }
  if (geometry.mirrorSymmetryMin !== undefined && shape.mirror.matchRatio < geometry.mirrorSymmetryMin) {
    findings.push({
      id: 'MIRROR_SYMMETRY_LOW',
      severity: 'fail',
      message: `Only ${(shape.mirror.matchRatio * 100).toFixed(1)}% of vertices mirror across ${shape.mirror.planeAxis}=${shape.mirror.planeCoord.toFixed(4)} within ${shape.mirror.toleranceFraction} of max extent (minimum ${(geometry.mirrorSymmetryMin * 100).toFixed(1)}%)`,
      actual: shape.mirror.matchRatio,
      limit: geometry.mirrorSymmetryMin,
    });
  }
  const ranges = [
    ['lengthToWidth', 'ASPECT_LENGTH_TO_WIDTH', shape.lengthToWidth, geometry.lengthToWidth],
    ['heightToLength', 'ASPECT_HEIGHT_TO_LENGTH', shape.heightToLength, geometry.heightToLength],
  ] as const;
  for (const [name, id, actual, range] of ranges) {
    if (range === undefined) continue;
    if (actual === null || actual < range[0] || actual > range[1]) {
      findings.push({
        id,
        severity: 'fail',
        message: `${name} ${actual?.toFixed(3) ?? 'n/a'} is outside [${range[0]}, ${range[1]}] (length ${shape.length.toFixed(3)} on ${shape.lengthAxis}, width ${shape.width.toFixed(3)} on ${shape.widthAxis}, height ${shape.height.toFixed(3)} on ${shape.heightAxis})`,
        actual: actual ?? 'n/a',
        limit: `[${range[0]}, ${range[1]}]`,
      });
    }
  }
  return findings;
}

export function evaluateAssetGates(
  metrics: AssetMetrics,
  card: StyleCard | null,
  views?: readonly ViewMetrics[],
  context: GateContext = {},
): { readonly ok: boolean; readonly unsupportedGate: boolean; readonly findings: readonly GateFinding[] } {
  const findings: GateFinding[] = [];
  let unsupportedGate = false;

  const consoleErrors = context.consoleErrors ?? [];
  if (consoleErrors.length > 0) {
    const fail = context.failOnConsoleError ?? true;
    findings.push({
      id: 'CONSOLE_ERROR',
      severity: fail ? 'fail' : 'warn',
      message: `Browser logged ${consoleErrors.length} console error(s); first: ${consoleErrors[0]}`,
      actual: consoleErrors.length,
      limit: 0,
    });
  }

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
    if (metrics.inputKind === 'factory' && budgets !== undefined) {
      const skipped = (['bytesMax', 'requireTriangleLists'] as const).filter(key => budgets[key] !== undefined);
      if (skipped.length > 0) {
        findings.push({
          id: 'GLB_BUDGETS_SKIPPED',
          severity: 'info',
          message: `Skipped GLB-only budgets on factory input: ${skipped.join(', ')}`,
        });
      }
    }
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

      if (metrics.palette.shaderMeshes > 0) {
        findings.push({
          id: 'PALETTE_UNASSESSED_SHADER',
          severity: 'info',
          message: `Palette check skipped on ${metrics.palette.shaderMeshes} mesh(es) drawn by a ShaderMaterial without a color; inspect contact sheet`,
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

  if (card?.geometry !== undefined) {
    findings.push(...geometryFindings(metrics, card.geometry));
  }

  if (views !== undefined) {
    const croppedIn = (context.capture?.zoom ?? 1) > 1;
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
          severity: croppedIn ? 'info' : 'fail',
          message: croppedIn
            ? `View '${view.id}' subject touches tile edge (expected with --zoom ${context.capture?.zoom})`
            : `View '${view.id}' subject touches tile edge (clipped)`,
          actual: true,
          limit: false,
        });
      }
      if (view.culledFrontSideRatio !== undefined && view.culledFrontSideRatio > 0.5) {
        findings.push({
          id: 'INVERTED_WINDING',
          severity: 'fail',
          message: `View '${view.id}' culls over half the nearest FrontSide surface. Check triangle winding.`,
          actual: view.culledFrontSideRatio,
          limit: 0.5,
        });
      }
      if (view.beautyUniqueColors < 2) {
        // Zoomed far enough in, one flat face can legitimately fill the whole tile.
        const faceFillsTile = croppedIn && view.coverageRatio === 1;
        findings.push({
          id: 'VIEW_BEAUTY_FLAT',
          severity: faceFillsTile ? 'info' : 'fail',
          message: `View '${view.id}' beauty tile has only ${view.beautyUniqueColors} quantized colors${faceFillsTile ? ' (subject fills the zoomed tile)' : ''}`,
          actual: view.beautyUniqueColors,
          limit: 2,
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
