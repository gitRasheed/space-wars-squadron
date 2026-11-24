import * as THREE from 'three';
import { add, forwardOf, rightOf, scale, upOf } from '../sim/math';
import type { CameraMode, PlayerShipState, Quat, Vec3 } from '../sim/types';

export interface CameraPose {
  readonly position: Vec3;
  readonly up: Vec3;
  readonly lookAt: Vec3 | null;
  readonly orientation: Quat | null;
  readonly targetFov: number;
}

export function computeCameraPose(player: PlayerShipState, cameraMode: CameraMode): CameraPose {
  const boostKind = player.energy.boostMode.kind;
  const targetFov = boostKind === 'boosting' ? 82 : boostKind === 'drifting' ? 76 : 68;
  const fwd = forwardOf(player.orientation);
  const up = upOf(player.orientation);
  const right = rightOf(player.orientation);

  if (cameraMode === 'cockpit') {
    return {
      position: add(add(player.position, scale(up, 1.35)), scale(fwd, 1.8)),
      up,
      lookAt: null,
      orientation: player.orientation,
      targetFov,
    };
  }

  const chaseDist = boostKind === 'boosting' ? 27 : 23;
  const position = add(
    add(player.position, scale(fwd, -chaseDist)),
    add(scale(up, 8.2), scale(right, -player.angularVelocity.y * 1.3)),
  );
  // Look downrange along the ship's flight axis so the fighter sits in lower-center frame
  // while the projected gun boresight reticle sits cleanly near screen center.
  const lookAt = add(add(player.position, scale(fwd, 260)), scale(up, 2.5));
  return {
    position,
    up,
    lookAt,
    orientation: null,
    targetFov,
  };
}

export function projectPointFromPose(
  pose: CameraPose,
  point: Vec3,
  width: number,
  height: number,
  fovOverride?: number,
): { readonly x: number; readonly y: number; readonly inFront: boolean } {
  const fov = fovOverride ?? pose.targetFov;
  const camera = new THREE.PerspectiveCamera(fov, width / Math.max(1, height), 0.25, 12000);
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  if (pose.orientation !== null) {
    camera.quaternion.set(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w);
  } else if (pose.lookAt !== null) {
    camera.up.set(pose.up.x, pose.up.y, pose.up.z);
    camera.lookAt(pose.lookAt.x, pose.lookAt.y, pose.lookAt.z);
  }
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const projected = new THREE.Vector3(point.x, point.y, point.z).project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * width,
    y: (-projected.y * 0.5 + 0.5) * height,
    inFront: projected.z >= -1 && projected.z <= 1,
  };
}
