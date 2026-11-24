import * as THREE from 'three';
import { COCKPIT_CAMERA_OFFSET } from '../sim/combat';
import { add, forwardOf, scale, upOf } from '../sim/math';
import type { CameraMode, PlayerShipState, Quat, Vec3 } from '../sim/types';

export interface CameraPose {
  readonly position: Vec3;
  readonly up: Vec3;
  readonly lookAt: Vec3 | null;
  readonly orientation: Quat | null;
  readonly targetFov: number;
}

export function computeCameraPose(player: PlayerShipState, _cameraMode: CameraMode = 'cockpit'): CameraPose {
  const targetFov = player.energy.overdrive ? 79 : 68;
  const fwd = forwardOf(player.orientation);
  const up = upOf(player.orientation);

  return {
    position: add(
      add(player.position, scale(up, COCKPIT_CAMERA_OFFSET.up)),
      scale(fwd, COCKPIT_CAMERA_OFFSET.forward),
    ),
    up,
    lookAt: null,
    orientation: player.orientation,
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
