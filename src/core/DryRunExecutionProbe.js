'use strict';

const {
  Keypair, SystemProgram, TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');

function elapsedUs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000;
}

class DryRunExecutionProbe {
  constructor({ config = {}, store = null, now = () => Date.now() } = {}) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.signer = Keypair.generate();
    this.probes = new Map();
    this.metrics = { measured: 0, validated: 0, rejected: 0, lateFallback: 0, errors: 0, sent: 0 };
  }

  measure(simulation) {
    if (!this.config.enabled || !simulation?.candidatePrimary) return null;
    const probeId = `${simulation.episodeId}:${simulation.candidateProfileId}`;
    if (this.probes.has(probeId)) return this.probes.get(probeId);
    const measuredAtMs = this.now();
    const row = {
      probeId,
      episodeId: simulation.episodeId,
      shadowId: simulation.shadowId,
      candidateProfileId: simulation.candidateProfileId,
      candidateCohortStage: simulation.candidateCohortStage,
      mode: 'DRY_RUN_NO_SEND',
      model: this.config.model || 'SOLANA_V0_EPHEMERAL_NOOP_V1',
      status: 'LOCAL_MEASURED_NO_SEND',
      triggerSignature: simulation.triggerSignature
        || simulation.entryReferenceSignature || null,
      chainValidationStatus: 'PENDING_SLOT_FINALIZATION',
      triggerAtMs: simulation.entryAtMs,
      measuredAtMs,
      triggerToProbeMs: Math.max(0, measuredAtMs - simulation.entryAtMs),
      sendEnabled: false,
      sendStatus: 'DISABLED',
      landingStatus: 'NOT_SENT',
      rankStatus: 'NOT_MEASURABLE_WITHOUT_SEND',
      createdAtMs: measuredAtMs,
      updatedAtMs: measuredAtMs,
    };
    try {
      const buildStarted = process.hrtime.bigint();
      const instruction = SystemProgram.transfer({
        fromPubkey: this.signer.publicKey,
        toPubkey: this.signer.publicKey,
        lamports: 0,
      });
      const message = new TransactionMessage({
        payerKey: this.signer.publicKey,
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [instruction],
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      row.buildDurationUs = elapsedUs(buildStarted);
      const signStarted = process.hrtime.bigint();
      transaction.sign([this.signer]);
      row.signDurationUs = elapsedUs(signStarted);
      const serializeStarted = process.hrtime.bigint();
      const payload = transaction.serialize();
      row.serializeDurationUs = elapsedUs(serializeStarted);
      row.payloadBytes = payload.length;
      row.totalLocalDurationUs = row.buildDurationUs + row.signDurationUs
        + row.serializeDurationUs;
      this.metrics.measured += 1;
    } catch (error) {
      row.status = 'LOCAL_PROBE_ERROR';
      row.error = error.message;
      this.metrics.errors += 1;
    }
    this.probes.set(probeId, row);
    this.store?.upsertExecutionProbe?.(row);
    return row;
  }

  finalize(simulation) {
    if (!this.config.enabled || !simulation?.candidatePrimary) return null;
    const probeId = `${simulation.episodeId}:${simulation.candidateProfileId}`;
    let row = this.probes.get(probeId);
    let lateFallback = false;
    if (!row) {
      row = this.measure({
        ...simulation,
        triggerSignature: simulation.entryReferenceSignature,
      });
      if (!row) return null;
      lateFallback = true;
      this.metrics.lateFallback += 1;
    }
    const matchesRank1 = Boolean(row.triggerSignature
      && row.triggerSignature === simulation.entryReferenceSignature);
    row.shadowId = simulation.shadowId;
    row.chainValidationStatus = matchesRank1
      ? 'MATCHED_FINAL_CHAIN_RANK_1' : 'TRIGGER_WAS_NOT_FINAL_CHAIN_RANK_1';
    row.status = matchesRank1
      ? (lateFallback
        ? 'LOCAL_MEASURED_LATE_FALLBACK_VALIDATED' : 'LOCAL_MEASURED_VALIDATED')
      : 'LOCAL_MEASURED_REJECTED_CHAIN_ORDER';
    row.updatedAtMs = this.now();
    if (matchesRank1) this.metrics.validated += 1;
    else this.metrics.rejected += 1;
    this.store?.upsertExecutionProbe?.(row);
    return row;
  }

  health() {
    return {
      enabled: Boolean(this.config.enabled),
      sendsTransactions: false,
      sendEnabled: false,
      model: this.config.model || null,
      ...this.metrics,
    };
  }
}

module.exports = { DryRunExecutionProbe };
