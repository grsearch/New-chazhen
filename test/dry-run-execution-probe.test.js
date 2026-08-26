'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DryRunExecutionProbe } = require('../src/core/DryRunExecutionProbe');

test('dry-run probe measures local Solana build/sign work but never sends', () => {
  const rows = [];
  const probe = new DryRunExecutionProbe({
    config: { enabled: true, sendEnabled: false, model: 'TEST_NO_SEND' },
    store: { upsertExecutionProbe: (row) => rows.push(row) },
    now: () => 2_000,
  });
  const input = {
    episodeId: 'episode', shadowId: 'shadow', candidatePrimary: true,
    candidateProfileId: 'R2-B10-Q500-V1',
    candidateCohortStage: 'HOLDOUT_B10_Q500_V1', entryAtMs: 1_900,
    triggerSignature: 'rank-1-buy', entryReferenceSignature: 'rank-1-buy',
  };
  const result = probe.measure(input);
  assert.equal(rows.length, 1);
  assert.equal(result.status, 'LOCAL_MEASURED_NO_SEND');
  assert.equal(result.sendEnabled, false);
  assert.equal(result.sendStatus, 'DISABLED');
  assert.equal(result.landingStatus, 'NOT_SENT');
  assert.equal(result.rankStatus, 'NOT_MEASURABLE_WITHOUT_SEND');
  assert.ok(result.payloadBytes > 0);
  assert.ok(result.totalLocalDurationUs >= 0);
  const finalized = probe.finalize(input);
  assert.equal(finalized.status, 'LOCAL_MEASURED_VALIDATED');
  assert.equal(finalized.chainValidationStatus, 'MATCHED_FINAL_CHAIN_RANK_1');
  assert.equal(rows.length, 2, 'final chain order validation updates the same probe row');
  assert.equal(probe.health().sent, 0);
  assert.equal(probe.health().validated, 1);
});
