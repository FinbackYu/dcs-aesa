'use strict';
// Flight gate and designation verdicts of the SAR service.
//
// Continuous capture only takes a patch when the flight can actually produce one: enough
// trajectory, a sane speed and vertical rate, no turn, and a side-looking geometry. Those
// judgements are the service's (they read the captured scene and the protocol's imaging
// window), and they are stated once here so the retry loop, /designate/check and the DBS
// request all agree on what "imageable" means.
const {PROTOCOL, sar} = require('../../src/shared/config.cjs');
const {apertureGeometry} = require('../../src/sar_core/geometry.cjs');
const PROTOCOL_SAR = PROTOCOL.sar;

// The imageability rule for one designated point, stated once and only here: the Export itself
// refuses a target whose ground range leaves 1–50 km, and the project only recommends side-looking
// geometry, 20–160° off the ground track. The viewer consumes the verdict of /designate/check and
// renders the reasons instead of re-deriving the window, so these two numbers live in one place.
const IMAGE_MIN_RANGE_M = PROTOCOL_SAR.capture.min_range_m, IMAGE_MAX_RANGE_M = PROTOCOL_SAR.capture.max_range_m,
  IMAGE_MIN_ANGLE_DEG = PROTOCOL_SAR.image_window.min_angle_deg, IMAGE_MAX_ANGLE_DEG = PROTOCOL_SAR.image_window.max_angle_deg;

// Geometry gate, shared by the prediction (from the newest capture) and the assessment of a
// freshly completed scene. Reasons are user-facing: continuous mode reports them instead of stopping.
function azimuthIssue(target, label) {
  if (!target || !Number.isFinite(target.relative_track_deg)) return null;
  const angle = target.relative_track_deg;
  if (Math.abs(angle) < IMAGE_MIN_ANGLE_DEG || Math.abs(angle) > IMAGE_MAX_ANGLE_DEG)
    return `${label}斜视角 ${angle.toFixed(0)}°（正右/负左），等待进入 ${IMAGE_MIN_ANGLE_DEG}–${IMAGE_MAX_ANGLE_DEG}° 侧视窗口`;
  return null;
}
function flightIssue(scene, predictNextPatch = true) {
  const trajectory = scene?.trajectory;
  if (!Array.isArray(trajectory) || trajectory.length < sar.geometry.trajectory_min_frames) return '等待足够的轨迹采样';
  const last = trajectory.at(-1), previous = trajectory[trajectory.length - 2], dt = last.t - previous.t;
  if (!(dt > 0)) return '轨迹时间戳异常';
  const speed = Math.hypot(last.pos[0] - previous.pos[0], last.pos[2] - previous.pos[2]) / dt, vertical = Math.abs(last.pos[1] - previous.pos[1]) / dt;
  if (speed < 20 || speed > 400) return `地面速度 ${speed.toFixed(0)} m/s 超出 20–400 m/s`;
  if (vertical > 40) return `垂速 ${vertical.toFixed(1)} m/s 偏大，等待平飞`;
  const midpoint = Math.floor(trajectory.length / 2), heading = (a, b) => Math.atan2(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]);
  const turn = Math.abs(((heading(trajectory[midpoint], last) - heading(trajectory[0], trajectory[midpoint]) + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / ((last.t - trajectory[0].t) / 2) * 180 / Math.PI;
  if (turn > 6) return `转弯率 ${turn.toFixed(1)}°/s 偏大，等待平稳飞行`;
  try { apertureGeometry(scene); } catch { return '侧向孔径不足（接近前视/后视），等待侧视航迹'; }
  return predictNextPatch ? azimuthIssue(scene.target, '当前') : null;
}
// The gate judges the flight that produced the newest capture, and — outside the sweep — its
// achieved squint, because the relative mode repeats the same side/range patch. The sweep picks a
// different square of the window at a predicted pose instead: its geometry gate is the window
// itself, built from that same predicted pose, so the last patch's stale squint must not veto it.
function gateReason(lastCaptured, gateWindow, predictNextPatch = true) {
  if (!lastCaptured || Date.now() - lastCaptured.at > gateWindow) return null;
  return flightIssue(lastCaptured.scene, predictNextPatch);
}

// The verdict of one designated point, from one pose. `fresh` says whether the newest capture is
// recent enough to advise on the flight (an old pose describes a flight that has since changed).
function designateCheck(pose, x, z, { flightIssue: advisory = null } = {}) {
  const dx = x - pose.pos[0], dz = z - pose.pos[2], range = Math.hypot(dx, dz);
  // A point under the aircraft has no line of sight to judge: the range alone is the honest verdict,
  // and pinning the angle to 0 keeps the answer free of nulls for the client to unpack.
  const degenerate = range < 1;
  // Positive is to the right, exactly as the Export reports relative_track_deg: it measures the
  // target bearing as atan2(dz,dx) and the track as atan2(vz,vx), while both angles are the
  // complements here (pose.heading is atan2(dx,dz) just like this bearing). The difference is
  // therefore heading minus bearing — taking it the other way round swaps right and left.
  let angle = (pose.heading - Math.atan2(dx, dz)) * 180 / Math.PI;
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;
  if (degenerate) angle = 0;
  const reasons = [];
  if (degenerate) reasons.push('目标与本机位置重合，无法构成侧视几何');
  else {
    if (range < IMAGE_MIN_RANGE_M) reasons.push(`目标地距 ${(range / 1000).toFixed(2)} km 小于 ${IMAGE_MIN_RANGE_M / 1000} km 下限`);
    if (range > IMAGE_MAX_RANGE_M) reasons.push(`目标地距 ${(range / 1000).toFixed(1)} km 超出 ${IMAGE_MAX_RANGE_M / 1000} km 上限`);
    if (Math.abs(angle) < IMAGE_MIN_ANGLE_DEG || Math.abs(angle) > IMAGE_MAX_ANGLE_DEG)
      reasons.push(`斜视角 ${angle.toFixed(0)}°（正右/负左）不在 ${IMAGE_MIN_ANGLE_DEG}–${IMAGE_MAX_ANGLE_DEG}° 侧视窗内`);
  }
  return {
    ok: reasons.length === 0, reasons, range_km: +(range / 1000).toFixed(2), relative_track_deg: +angle.toFixed(1),
    side: angle >= 0 ? 1 : -1, flightIssue: advisory
  };
}

// The newest pose of a captured trajectory: where the aircraft was for the last patch, and the
// mean ground velocity over the whole trajectory (the two-second mean is the honest "current"
// vector; a single frame pair is noisy and the gate already bounds the turn rate).
function trajectoryPose(trajectory, height) {
  if (!Array.isArray(trajectory) || trajectory.length < 2) return null;
  const last = trajectory.at(-1), previous = trajectory[trajectory.length - 2], dt = last.t - previous.t;
  if (!(dt > 0)) return null;
  const first = trajectory[0], span = last.t - first.t;
  const velocity = span > 0 ? [(last.pos[0] - first.pos[0]) / span, (last.pos[2] - first.pos[2]) / span] : null;
  return {
    pos: last.pos.slice(), heading: Math.atan2(last.pos[0] - previous.pos[0], last.pos[2] - previous.pos[2]),
    height: Number.isFinite(height) ? height : 0, velocity
  };
}
// Where the aircraft will be when the next patch is collected. A pose without a usable velocity is
// returned unchanged, which restores the pre-prediction behaviour: the window is measured from the
// newest pose and the Export's own 1 km floor applies.
function leadPose(pose, seconds) {
  if (!pose) return null;
  if (!pose.velocity) return {...pose, lead_s: 0};
  return {...pose, pos: [pose.pos[0] + pose.velocity[0] * seconds, pose.pos[1], pose.pos[2] + pose.velocity[1] * seconds], lead_s: seconds};
}

module.exports = {azimuthIssue, flightIssue, gateReason, designateCheck, trajectoryPose, leadPose,
  IMAGE_MIN_RANGE_M, IMAGE_MAX_RANGE_M, IMAGE_MIN_ANGLE_DEG, IMAGE_MAX_ANGLE_DEG};
