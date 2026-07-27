'use strict';

// Derivado de vikunja-anytype-sync/src/field-sync.js
// (commit 238f617f8e2149ab69e50d63af3201e3174673ac). Misma máquina de
// decisión three-way; los lados aquí son Vikunja (hub) y Mindwtr (espejo).

const { stableStringify } = require('./canonical');

function equalValue(left, right) {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function chooseConflict(policy, canVikunjaToMindwtr, canMindwtrToVikunja) {
  if (policy === 'vikunja_wins' && canVikunjaToMindwtr) return 'write_mindwtr';
  if (policy === 'mindwtr_wins' && canMindwtrToVikunja) return 'write_vikunja';
  return 'conflict';
}

function decideFieldSync({
  vikunjaValue,
  mindwtrValue,
  lastCommonValue,
  hasLastCommon = true,
  direction,
  conflictPolicy = 'manual',
}) {
  const canVikunjaToMindwtr = direction === 'vikunja_to_mindwtr' || direction === 'bidirectional';
  const canMindwtrToVikunja = direction === 'mindwtr_to_vikunja' || direction === 'bidirectional';

  if (direction === 'disabled') return { action: 'noop', reason: 'disabled' };
  if (equalValue(vikunjaValue, mindwtrValue)) {
    return { action: 'accept_common', value: vikunjaValue, reason: 'already_equal' };
  }
  if (!hasLastCommon) {
    if (canVikunjaToMindwtr) return { action: 'write_mindwtr', reason: 'initial_vikunja_seed' };
    if (canMindwtrToVikunja) return { action: 'write_vikunja', reason: 'initial_mindwtr_seed' };
    return { action: 'noop', reason: 'direction_blocked' };
  }

  const vikunjaChanged = !equalValue(vikunjaValue, lastCommonValue);
  const mindwtrChanged = !equalValue(mindwtrValue, lastCommonValue);

  if (vikunjaChanged && !mindwtrChanged) {
    return canVikunjaToMindwtr
      ? { action: 'write_mindwtr', reason: 'vikunja_changed' }
      : { action: 'noop', reason: 'vikunja_direction_blocked' };
  }
  if (!vikunjaChanged && mindwtrChanged) {
    return canMindwtrToVikunja
      ? { action: 'write_vikunja', reason: 'mindwtr_changed' }
      : { action: 'noop', reason: 'mindwtr_direction_blocked' };
  }
  if (!vikunjaChanged && !mindwtrChanged) return { action: 'noop', reason: 'unchanged' };

  const action = chooseConflict(conflictPolicy, canVikunjaToMindwtr, canMindwtrToVikunja);
  return { action, reason: action === 'conflict' ? 'simultaneous_change' : 'conflict_policy' };
}

module.exports = {
  chooseConflict,
  decideFieldSync,
  equalValue,
};
