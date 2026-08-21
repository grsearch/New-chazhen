'use strict';

const EventEmitter = require('events');

function finiteInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function strictOrderKey(event) {
  const transactionIndex = finiteInteger(event?.transactionIndex);
  const eventIndex = finiteInteger(event?.eventIndex);
  if (transactionIndex == null || eventIndex == null) return null;
  return [transactionIndex, eventIndex];
}

function strictlyAfter(candidate, reference) {
  if (finiteInteger(candidate?.slot) !== finiteInteger(reference?.slot)) return null;
  const left = strictOrderKey(candidate);
  const right = strictOrderKey(reference);
  if (!left || !right) return null;
  return left[0] > right[0] || (left[0] === right[0] && left[1] > right[1]);
}

class SlotAssembler extends EventEmitter {
  constructor({ retentionSlots = 8 } = {}) {
    super();
    this.retentionSlots = retentionSlots;
    this.slots = new Map();
    this.sequence = 0;
    this.highestSlot = null;
  }

  ingest(event) {
    this.sequence += 1;
    const slot = finiteInteger(event?.slot);
    const transactionIndex = finiteInteger(event?.transactionIndex);
    const normalized = {
      ...event,
      receiveSequence: this.sequence,
      orderingConfidence: slot != null && transactionIndex != null
        ? 'STRICT' : 'SLOT_CORRELATED',
    };
    if (slot == null) return normalized;

    const state = this.slots.get(slot) || {
      slot, firstReceivedAtMs: normalized.receivedAtMs,
      lastReceivedAtMs: normalized.receivedAtMs,
      events: 0, signatures: new Set(), transactionIndexes: new Set(),
      missingTransactionIndex: false,
    };
    state.events += 1;
    state.lastReceivedAtMs = Math.max(state.lastReceivedAtMs || 0, normalized.receivedAtMs || 0);
    if (normalized.signature) state.signatures.add(normalized.signature);
    if (transactionIndex == null) state.missingTransactionIndex = true;
    else state.transactionIndexes.add(transactionIndex);
    this.slots.set(slot, state);

    if (this.highestSlot == null || slot > this.highestSlot) {
      this.highestSlot = slot;
      this._finalizeOldSlots();
    }
    return normalized;
  }

  _finalizeOldSlots() {
    const cutoff = this.highestSlot - this.retentionSlots;
    for (const [slot, state] of this.slots) {
      if (slot > cutoff) continue;
      this.emit('slotFinalized', {
        slot,
        firstReceivedAtMs: state.firstReceivedAtMs,
        lastReceivedAtMs: state.lastReceivedAtMs,
        eventCount: state.events,
        transactionCount: state.signatures.size,
        transactionIndexCoveragePct: state.signatures.size
          ? (state.transactionIndexes.size / state.signatures.size) * 100 : null,
        strictOrderingAvailable: !state.missingTransactionIndex,
      });
      this.slots.delete(slot);
    }
  }

  health() {
    return {
      highestSlot: this.highestSlot,
      bufferedSlots: this.slots.size,
      receivedEvents: this.sequence,
    };
  }
}

module.exports = { SlotAssembler, strictlyAfter, strictOrderKey };
