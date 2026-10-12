import { enqueueEmail } from './email-service.js';
import { verifyPassword } from './security.js';

export class OwnershipError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OwnershipError';
    this.status = status;
    this.code = code;
  }
}

function readOwnerRow(db) {
  return db.prepare(`
    SELECT platform_ownership.owner_user_id, platform_ownership.version, platform_ownership.updated_at,
      users.name AS owner_name, users.email AS owner_email
    FROM platform_ownership
    LEFT JOIN users ON users.id = platform_ownership.owner_user_id
    WHERE platform_ownership.singleton_id = 1
  `).get();
}

function formatOwnership(row) {
  return {
    ownerUserId: row.owner_user_id ?? null,
    ownerName: row.owner_name ?? null,
    ownerEmail: row.owner_email ?? null,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function activeAdmin(db, userId) {
  return db.prepare("SELECT id, name, email, password_hash FROM users WHERE id = ? AND role = 'admin' AND status = 'Active'").get(userId);
}

function requireVersion(value) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new OwnershipError(400, 'VERSION_REQUIRED', 'A valid ownership version is required.');
  return version;
}

async function reauthenticate(account, password) {
  if (!account || !(await verifyPassword(password, account.password_hash))) {
    throw new OwnershipError(401, 'REAUTHENTICATION_FAILED', 'Password reauthentication failed.');
  }
}

export function getOwnership(db) {
  return formatOwnership(readOwnerRow(db));
}

export function listOwnershipCandidates(db) {
  return db.prepare("SELECT id, name, email FROM users WHERE role = 'admin' AND status = 'Active' ORDER BY name, id").all();
}

export async function claimOwnership(db, { actorUserId, password, confirmation, expectedVersion }) {
  const version = requireVersion(expectedVersion);
  if (confirmation !== 'CLAIM PLATFORM OWNERSHIP') {
    throw new OwnershipError(400, 'CONFIRMATION_REQUIRED', 'Enter the exact ownership confirmation phrase.');
  }
  const actor = activeAdmin(db, actorUserId);
  await reauthenticate(actor, password);

  const execute = db.transaction(() => {
    const current = readOwnerRow(db);
    if (current.owner_user_id || current.version !== version) {
      throw new OwnershipError(409, 'OWNERSHIP_CONFLICT', 'Platform ownership changed. Refresh and try again.');
    }
    const updatedAt = new Date().toISOString();
    const result = db.prepare(`
      UPDATE platform_ownership SET owner_user_id = ?, version = version + 1, updated_at = ?
      WHERE singleton_id = 1 AND owner_user_id IS NULL AND version = ?
    `).run(actorUserId, updatedAt, version);
    if (result.changes !== 1) throw new OwnershipError(409, 'OWNERSHIP_CONFLICT', 'Platform ownership changed. Refresh and try again.');
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at)
      VALUES (?, 'ownership.claimed', 'platform', 'platform-owner', ?, ?)
    `).run(actorUserId, JSON.stringify({ fromOwnerUserId: null, toOwnerUserId: actorUserId, previousVersion: version, version: version + 1 }), updatedAt);
    enqueueEmail(db, {
      idempotencyKey: `email:ownership:claimed:${actorUserId}:${version + 1}`, eventType: 'ownership.claimed', aggregateType: 'platform', aggregateId: 'platform-owner',
      recipient: actor.email, recipientUserId: actor.id, templateId: 'account-status',
      payload: { name: actor.name, subject: 'Nevora Core platform ownership claimed', message: 'Your administrator account is now the platform owner. If you did not authorize this change, begin an immediate security review.', occurredAt: updatedAt }, createdAt: updatedAt,
    });
    return formatOwnership(readOwnerRow(db));
  });
  return execute.immediate();
}

export async function transferOwnership(db, { actorUserId, targetUserId, password, confirmation, expectedVersion }) {
  const version = requireVersion(expectedVersion);
  const actor = activeAdmin(db, actorUserId);
  await reauthenticate(actor, password);
  const target = activeAdmin(db, targetUserId);
  if (!target) throw new OwnershipError(404, 'TARGET_NOT_ELIGIBLE', 'Choose another active administrator.');
  if (target.id === actorUserId) throw new OwnershipError(400, 'SELF_TRANSFER', 'Choose another administrator as the new owner.');
  if (confirmation !== `TRANSFER OWNERSHIP TO ${target.email}`) {
    throw new OwnershipError(400, 'CONFIRMATION_REQUIRED', 'Enter the exact ownership transfer confirmation phrase.');
  }

  const execute = db.transaction(() => {
    const current = readOwnerRow(db);
    if (current.owner_user_id !== actorUserId) throw new OwnershipError(403, 'OWNER_REQUIRED', 'Only the current platform owner can transfer ownership.');
    if (current.version !== version) throw new OwnershipError(409, 'OWNERSHIP_CONFLICT', 'Platform ownership changed. Refresh and try again.');
    if (!activeAdmin(db, targetUserId)) throw new OwnershipError(409, 'TARGET_NOT_ELIGIBLE', 'The selected administrator is no longer eligible.');

    const updatedAt = new Date().toISOString();
    const result = db.prepare(`
      UPDATE platform_ownership SET owner_user_id = ?, version = version + 1, updated_at = ?
      WHERE singleton_id = 1 AND owner_user_id = ? AND version = ?
    `).run(targetUserId, updatedAt, actorUserId, version);
    if (result.changes !== 1) throw new OwnershipError(409, 'OWNERSHIP_CONFLICT', 'Platform ownership changed. Refresh and try again.');
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at)
      VALUES (?, 'ownership.transferred', 'platform', 'platform-owner', ?, ?)
    `).run(actorUserId, JSON.stringify({ fromOwnerUserId: actorUserId, toOwnerUserId: targetUserId, previousVersion: version, version: version + 1 }), updatedAt);
    for (const recipient of [actor, target]) enqueueEmail(db, {
      idempotencyKey: `email:ownership:transferred:${recipient.id}:${version + 1}`, eventType: 'ownership.transferred', aggregateType: 'platform', aggregateId: 'platform-owner',
      recipient: recipient.email, recipientUserId: recipient.id, templateId: 'account-status',
      payload: { name: recipient.name, subject: 'Nevora Core platform ownership changed', message: `Platform ownership was transferred from ${actor.name} to ${target.name}. If you did not authorize this change, begin an immediate security review.`, occurredAt: updatedAt }, createdAt: updatedAt,
    });
    return formatOwnership(readOwnerRow(db));
  });
  return execute.immediate();
}