'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SlotAssembler, strictlyAfter, strictlyAfterTransaction,
} = require('../src/core/SlotAssembler');

test('transaction index controls strict same-slot order', () => {
  const reference = { slot: 10, transactionIndex: 3, eventIndex: 1 };
  assert.equal(strictlyAfter({ slot: 10, transactionIndex: 4, eventIndex: 0 }, reference), true);
  assert.equal(strictlyAfter({ slot: 10, transactionIndex: 2, eventIndex: 9 }, reference), false);
  assert.equal(strictlyAfter({ slot: 10, transactionIndex: null, eventIndex: 9 }, reference), null);
});

test('strict transaction ordering crosses slots and rejects the dump transaction itself', () => {
  const reference = { slot: 10, transactionIndex: 2, eventIndex: 0 };
  assert.equal(strictlyAfterTransaction(
    { slot: 10, transactionIndex: 2, eventIndex: 9 }, reference,
  ), false);
  assert.equal(strictlyAfterTransaction(
    { slot: 10, transactionIndex: 3, eventIndex: 0 }, reference,
  ), true);
  assert.equal(strictlyAfterTransaction(
    { slot: 11, transactionIndex: 0, eventIndex: 0 }, reference,
  ), true);
  assert.equal(strictlyAfterTransaction(
    { slot: 9, transactionIndex: 99, eventIndex: 0 }, reference,
  ), false);
});

test('missing transaction index is labeled slot-correlated', () => {
  const assembler = new SlotAssembler({ retentionSlots: 2 });
  const strict = assembler.ingest({ slot: 10, transactionIndex: 1, eventIndex: 0 });
  const correlated = assembler.ingest({ slot: 10, transactionIndex: null, eventIndex: 1 });
  assert.equal(strict.orderingConfidence, 'STRICT');
  assert.equal(correlated.orderingConfidence, 'SLOT_CORRELATED');
  assert.equal(strict.receiveSequence, 1);
  assert.equal(correlated.receiveSequence, 2);
});
