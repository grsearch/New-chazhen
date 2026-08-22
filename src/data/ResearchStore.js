'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function value(input) {
  return input == null || input === '' ? null : input;
}

function number(input) {
  if (input == null || input === '') return null;
  const result = Number(input);
  return Number.isFinite(result) ? result : null;
}

function json(input) {
  if (input == null) return null;
  try { return JSON.stringify(input); } catch (_) { return null; }
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? ordered[lower]
    : ordered[lower] * (upper - index) + ordered[upper] * (index - lower);
}

function returnStats(rows) {
  const values = rows.map((row) => number(row.net_return_pct)).filter(Number.isFinite);
  const wins = values.filter((item) => item > 0);
  const losses = values.filter((item) => item < 0);
  const grossWins = wins.reduce((sum, item) => sum + item, 0);
  const grossLosses = Math.abs(losses.reduce((sum, item) => sum + item, 0));
  const worstCount = values.length ? Math.max(1, Math.ceil(values.length * 0.05)) : 0;
  const ordered = [...values].sort((a, b) => a - b);
  const winnerContributionPct = grossWins > 0 && wins.length
    ? Math.max(...wins) / grossWins * 100 : null;
  return {
    resolved: values.length,
    winRatePct: values.length ? wins.length / values.length * 100 : null,
    averageNetReturnPct: values.length
      ? values.reduce((sum, item) => sum + item, 0) / values.length : null,
    medianNetReturnPct: percentile(values, 0.5),
    profitFactor: values.length
      ? (grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? null : 0))
      : null,
    worst5PctAverage: worstCount
      ? ordered.slice(0, worstCount).reduce((sum, item) => sum + item, 0) / worstCount : null,
    largestWinnerContributionPct: winnerContributionPct,
  };
}

function eventConcentrationStats(rows) {
  const byEpisode = new Map();
  for (const row of rows) {
    if (!row?.episodeId) continue;
    const result = number(row.net_return_pct ?? row.netReturnPct);
    if (!Number.isFinite(result)) continue;
    const state = byEpisode.get(row.episodeId) || { hasWin: false, grossWin: 0 };
    if (result > 0) {
      state.hasWin = true;
      state.grossWin += result;
    }
    byEpisode.set(row.episodeId, state);
  }
  const grossWins = [...byEpisode.values()].map((row) => row.grossWin)
    .filter((result) => result > 0).sort((left, right) => right - left);
  const totalGrossWins = grossWins.reduce((sum, result) => sum + result, 0);
  const resolvedEpisodes = byEpisode.size;
  const episodesWithAnyWin = [...byEpisode.values()].filter((row) => row.hasWin).length;
  return {
    resolvedEpisodes,
    episodesWithAnyWin,
    episodeAnyWinRatePct: resolvedEpisodes ? episodesWithAnyWin / resolvedEpisodes * 100 : null,
    largestWinnerEventContributionPct: totalGrossWins > 0
      ? grossWins[0] / totalGrossWins * 100 : null,
    top3WinnerEventsContributionPct: totalGrossWins > 0
      ? grossWins.slice(0, 3).reduce((sum, result) => sum + result, 0) / totalGrossWins * 100 : null,
  };
}

function compareCohortPerformance(left, right) {
  const metrics = ['winRatePct', 'averageNetReturnPct', 'resolved', 'scheduled'];
  for (const metric of metrics) {
    const leftValue = number(left?.[metric]);
    const rightValue = number(right?.[metric]);
    if (leftValue == null && rightValue == null) continue;
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return [left.quoteModel, left.recoveryProfileId, left.entryVariantId, left.positionSol, left.exitProfileId]
    .join(':').localeCompare(
      [right.quoteModel, right.recoveryProfileId, right.entryVariantId, right.positionSol, right.exitProfileId]
        .join(':'),
    );
}

class ResearchStore {
  constructor(config) {
    this.config = {
      storeTradeRawJson: false,
      tradeRetentionMs: 30 * 86_400_000,
      slotSummaryRetentionMs: 30 * 86_400_000,
      maintenanceIntervalMs: 600_000,
      maintenanceBatchMax: 10_000,
      ...config,
    };
    if (this.config.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
    }
    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.pending = [];
    this.metrics = {
      queued: 0,
      flushed: 0,
      flushes: 0,
      errors: 0,
      maintenanceRuns: 0,
      maintenanceErrors: 0,
      prunedTrades: 0,
      prunedSlotSummaries: 0,
    };
    this._initSchema();
    this._prepare();
    this.timer = setInterval(() => this.flush(), this.config.flushMs);
    if (this.timer.unref) this.timer.unref();
    this.maintenanceTimer = setInterval(
      () => {
        try { this.maintain(); } catch (_) { /* surfaced by health metrics */ }
      },
      this.config.maintenanceIntervalMs,
    );
    if (this.maintenanceTimer.unref) this.maintenanceTimer.unref();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '5')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at_ms INTEGER NOT NULL,
        chain_timestamp_ms INTEGER,
        slot INTEGER,
        transaction_index INTEGER,
        instruction_index INTEGER,
        event_index INTEGER NOT NULL,
        receive_sequence INTEGER,
        signature TEXT NOT NULL,
        ordering_confidence TEXT NOT NULL,
        mint TEXT,
        pool TEXT,
        coin_creator TEXT,
        wallet TEXT,
        side TEXT NOT NULL,
        sol_amount REAL,
        token_amount REAL,
        event_price REAL,
        reserve_price REAL,
        token_decimals INTEGER,
        token_decimals_source TEXT,
        base_amount_raw TEXT,
        user_quote_amount_raw TEXT,
        pool_base_reserves_raw TEXT,
        pool_quote_reserves_raw TEXT,
        virtual_quote_reserves_raw TEXT,
        effective_quote_reserves_raw TEXT,
        lp_fee_bps REAL,
        protocol_fee_bps REAL,
        creator_fee_bps REAL,
        buyback_fee_bps REAL,
        total_fee_bps REAL,
        parse_version TEXT,
        raw_json TEXT,
        UNIQUE(signature, event_index)
      );
      CREATE INDEX IF NOT EXISTS idx_trades_pool_time ON trades(pool, received_at_ms);
      CREATE INDEX IF NOT EXISTS idx_trades_mint_time ON trades(mint, received_at_ms);

      CREATE TABLE IF NOT EXISTS slot_summaries (
        slot INTEGER PRIMARY KEY,
        first_received_at_ms INTEGER,
        last_received_at_ms INTEGER,
        event_count INTEGER,
        transaction_count INTEGER,
        transaction_index_coverage_pct REAL,
        strict_ordering_available INTEGER
      );

      CREATE TABLE IF NOT EXISTS dump_events (
        episode_id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        pool TEXT NOT NULL,
        seller TEXT,
        coin_creator TEXT,
        detected_at_ms INTEGER NOT NULL,
        chain_timestamp_ms INTEGER,
        slot INTEGER,
        transaction_index INTEGER,
        instruction_index INTEGER,
        event_index INTEGER,
        signature TEXT,
        ordering_confidence TEXT NOT NULL,
        matched_dump_profiles_json TEXT NOT NULL,
        status TEXT NOT NULL,
        toxic_rejected INTEGER NOT NULL,
        toxic_reasons_json TEXT,
        unavailable_checks_json TEXT,
        sell_sol REAL,
        sell_tokens REAL,
        pre_price REAL,
        pre_price_source TEXT,
        post_price REAL,
        low_price REAL,
        drop_pct REAL,
        pre_quote_sol REAL,
        post_quote_sol REAL,
        sell_to_quote_pct REAL,
        sell_token_to_reserve_pct REAL,
        pool_age_ms INTEGER,
        pool_age_source TEXT,
        pre_trades INTEGER,
        pre_buy_sol REAL,
        pre_sell_sol REAL,
        pre_net_flow_sol REAL,
        pre_buy_share_pct REAL,
        pre_unique_buyers INTEGER,
        pre_largest_buyer_share_pct REAL,
        pre_price_runup_pct REAL,
        valid_buy_sol REAL DEFAULT 0,
        raw_buy_sol REAL DEFAULT 0,
        follow_sell_sol REAL DEFAULT 0,
        unique_buyers INTEGER DEFAULT 0,
        buy_to_dump_pct REAL,
        price_bounce_pct REAL,
        max_recovery_pct REAL DEFAULT 0,
        current_quote_sol REAL,
        quote_retention_pct REAL,
        strict_same_slot_buys INTEGER DEFAULT 0,
        correlated_same_slot_buys INTEGER DEFAULT 0,
        second_dump INTEGER DEFAULT 0,
        second_dump_at_ms INTEGER,
        confirmed_profiles_json TEXT,
        survival_1s INTEGER,
        survival_2s INTEGER,
        survival_5s INTEGER,
        survival_10s INTEGER,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dump_time ON dump_events(detected_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_dump_pool ON dump_events(pool, detected_at_ms DESC);

      CREATE TABLE IF NOT EXISTS confirmations (
        confirmation_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES dump_events(episode_id),
        profile_id TEXT NOT NULL,
        confirmed_at_ms INTEGER NOT NULL,
        slot INTEGER,
        transaction_index INTEGER,
        instruction_index INTEGER,
        event_index INTEGER,
        signature TEXT,
        ordering_confidence TEXT NOT NULL,
        slot_delta INTEGER,
        current_price REAL,
        low_price REAL,
        price_bounce_pct REAL,
        drop_recovery_pct REAL,
        valid_buy_sol REAL,
        unique_buyers INTEGER,
        buy_to_dump_pct REAL,
        net_flow_sol REAL,
        net_flow_1s_sol REAL,
        net_flow_3s_sol REAL,
        current_quote_sol REAL,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_confirmations_time ON confirmations(confirmed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS same_slot_observations (
        observation_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES dump_events(episode_id),
        mint TEXT NOT NULL,
        pool TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        dump_transaction_index INTEGER,
        buy_transaction_index INTEGER,
        instruction_index INTEGER,
        event_index INTEGER NOT NULL,
        signature TEXT,
        wallet TEXT,
        classification TEXT NOT NULL,
        receive_lag_ms INTEGER NOT NULL,
        buy_sol REAL NOT NULL,
        price REAL,
        price_bounce_pct REAL,
        executable INTEGER NOT NULL DEFAULT 0 CHECK(executable = 0),
        rejection_reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_same_slot_episode
        ON same_slot_observations(episode_id, observed_at_ms);
      CREATE INDEX IF NOT EXISTS idx_same_slot_time
        ON same_slot_observations(observed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS simulations (
        simulation_id TEXT PRIMARY KEY,
        confirmation_id TEXT NOT NULL REFERENCES confirmations(confirmation_id),
        episode_id TEXT NOT NULL REFERENCES dump_events(episode_id),
        recovery_profile_id TEXT NOT NULL,
        entry_variant_id TEXT NOT NULL,
        entry_kind TEXT NOT NULL,
        entry_delay_ms INTEGER NOT NULL,
        exit_profile_id TEXT NOT NULL,
        position_sol REAL NOT NULL,
        quote_model TEXT NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        confirmed_at_ms INTEGER NOT NULL,
        confirmation_slot INTEGER,
        requested_entry_at_ms INTEGER,
        entry_deadline_at_ms INTEGER,
        entry_at_ms INTEGER,
        entry_slot INTEGER,
        entry_signature TEXT,
        entry_quote_lag_ms INTEGER,
        actual_entry_delay_ms INTEGER,
        entry_price REAL,
        entry_market_price REAL,
        entry_impact_pct REAL,
        entry_protocol_fee_bps REAL,
        entry_total_fee_bps REAL,
        entry_liquidity_usage_pct REAL,
        entry_capacity_round_trip_loss_pct REAL,
        entry_capacity_exit_liquidity_usage_pct REAL,
        token_units REAL,
        entry_reserve_source TEXT,
        entry_fee_sol REAL,
        exit_fee_sol REAL,
        failed_transaction_fee_sol REAL,
        max_exit_at_ms INTEGER,
        exit_triggered_at_ms INTEGER,
        exit_target_at_ms INTEGER,
        requested_exit_at_ms INTEGER,
        exit_deadline_at_ms INTEGER,
        exit_at_ms INTEGER,
        exit_slot INTEGER,
        exit_signature TEXT,
        exit_quote_lag_ms INTEGER,
        exit_horizon_lag_ms INTEGER,
        exit_reason TEXT,
        exit_price REAL,
        exit_market_price REAL,
        exit_impact_pct REAL,
        exit_protocol_fee_bps REAL,
        exit_total_fee_bps REAL,
        exit_liquidity_usage_pct REAL,
        exit_reserve_source TEXT,
        proceeds_sol REAL,
        total_cost_sol REAL,
        gross_return_pct REAL,
        net_return_pct REAL,
        mfe_net_pct REAL,
        mae_net_pct REAL,
        last_executable_net_pct REAL,
        last_executable_quote_at_ms INTEGER,
        hold_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sim_status ON simulations(status, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_sim_cohort ON simulations(
        recovery_profile_id, entry_variant_id, position_sol, exit_profile_id
      );
      CREATE INDEX IF NOT EXISTS idx_sim_model_cohort ON simulations(
        quote_model, recovery_profile_id, entry_variant_id, position_sol, exit_profile_id
      );
      CREATE INDEX IF NOT EXISTS idx_sim_confirmation ON simulations(confirmation_id);
      CREATE INDEX IF NOT EXISTS idx_sim_episode_status ON simulations(episode_id, status);

      CREATE TABLE IF NOT EXISTS toxic_wallets (
        wallet TEXT PRIMARY KEY,
        incidents INTEGER NOT NULL,
        last_reason TEXT,
        last_seen_at_ms INTEGER,
        last_episode_id TEXT
      );
    `);
    this._ensureColumn('simulations', 'entry_total_fee_bps', 'REAL');
    this._ensureColumn('simulations', 'exit_total_fee_bps', 'REAL');
    this._ensureColumn('simulations', 'entry_capacity_round_trip_loss_pct', 'REAL');
    this._ensureColumn('simulations', 'entry_capacity_exit_liquidity_usage_pct', 'REAL');
  }

  _ensureColumn(table, column, definition) {
    const exists = this.db.prepare(`PRAGMA table_info(${table})`).all()
      .some((row) => row.name === column);
    if (!exists) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  _prepare() {
    this.statements = {
      trade: this.db.prepare(`
        INSERT OR IGNORE INTO trades (
          received_at_ms, chain_timestamp_ms, slot, transaction_index, instruction_index,
          event_index, receive_sequence, signature, ordering_confidence, mint, pool,
          coin_creator, wallet, side, sol_amount, token_amount, event_price, reserve_price,
          token_decimals, token_decimals_source, base_amount_raw, user_quote_amount_raw,
          pool_base_reserves_raw, pool_quote_reserves_raw, virtual_quote_reserves_raw,
          effective_quote_reserves_raw, lp_fee_bps, protocol_fee_bps, creator_fee_bps,
          buyback_fee_bps, total_fee_bps, parse_version, raw_json
        ) VALUES (
          @receivedAtMs, @chainTimestampMs, @slot, @transactionIndex, @instructionIndex,
          @eventIndex, @receiveSequence, @signature, @orderingConfidence, @mint, @pool,
          @coinCreator, @wallet, @side, @solAmount, @tokenAmount, @eventPrice, @reservePrice,
          @tokenDecimals, @tokenDecimalsSource, @baseAmountRaw, @userQuoteAmountRaw,
          @poolBaseReservesRaw, @poolQuoteReservesRaw, @virtualQuoteReservesRaw,
          @effectiveQuoteReservesRaw, @lpFeeBps, @protocolFeeBps, @creatorFeeBps,
          @buybackFeeBps, @totalFeeBps, @parseVersion, @rawJson
        )
      `),
      slot: this.db.prepare(`
        INSERT INTO slot_summaries (
          slot, first_received_at_ms, last_received_at_ms, event_count, transaction_count,
          transaction_index_coverage_pct, strict_ordering_available
        ) VALUES (@slot,@firstReceivedAtMs,@lastReceivedAtMs,@eventCount,@transactionCount,
          @transactionIndexCoveragePct,@strictOrderingAvailable)
        ON CONFLICT(slot) DO UPDATE SET
          first_received_at_ms=excluded.first_received_at_ms,
          last_received_at_ms=excluded.last_received_at_ms,
          event_count=excluded.event_count,
          transaction_count=excluded.transaction_count,
          transaction_index_coverage_pct=excluded.transaction_index_coverage_pct,
          strict_ordering_available=excluded.strict_ordering_available
      `),
      dump: this.db.prepare(`
        INSERT OR IGNORE INTO dump_events (
          episode_id,mint,pool,seller,coin_creator,detected_at_ms,chain_timestamp_ms,slot,
          transaction_index,instruction_index,event_index,signature,ordering_confidence,
          matched_dump_profiles_json,status,toxic_rejected,toxic_reasons_json,
          unavailable_checks_json,sell_sol,sell_tokens,pre_price,pre_price_source,post_price,
          low_price,drop_pct,pre_quote_sol,post_quote_sol,sell_to_quote_pct,
          sell_token_to_reserve_pct,pool_age_ms,pool_age_source,pre_trades,pre_buy_sol,
          pre_sell_sol,pre_net_flow_sol,pre_buy_share_pct,pre_unique_buyers,
          pre_largest_buyer_share_pct,pre_price_runup_pct,updated_at_ms
        ) VALUES (
          @episodeId,@mint,@pool,@seller,@coinCreator,@detectedAtMs,@chainTimestampMs,@slot,
          @transactionIndex,@instructionIndex,@eventIndex,@signature,@orderingConfidence,
          @matchedDumpProfilesJson,@status,@toxicRejected,@toxicReasonsJson,
          @unavailableChecksJson,@sellSol,@sellTokens,@prePrice,@prePriceSource,@postPrice,
          @lowPrice,@dropPct,@preQuoteSol,@postQuoteSol,@sellToQuotePct,
          @sellTokenToReservePct,@poolAgeMs,@poolAgeSource,@preTrades,@preBuySol,
          @preSellSol,@preNetFlowSol,@preBuySharePct,@preUniqueBuyers,
          @preLargestBuyerSharePct,@prePriceRunupPct,@updatedAtMs
        )
      `),
      dumpUpdate: this.db.prepare(`
        UPDATE dump_events SET
          status=@status, valid_buy_sol=@validBuySol, raw_buy_sol=@rawBuySol,
          follow_sell_sol=@followSellSol, unique_buyers=@uniqueBuyers,
          buy_to_dump_pct=@buyToDumpPct, price_bounce_pct=@priceBouncePct,
          max_recovery_pct=@maxRecoveryPct, current_quote_sol=@currentQuoteSol,
          quote_retention_pct=@quoteRetentionPct,
          strict_same_slot_buys=@strictSameSlotBuys,
          correlated_same_slot_buys=@correlatedSameSlotBuys,
          second_dump=@secondDump, second_dump_at_ms=@secondDumpAtMs,
          confirmed_profiles_json=@confirmedProfilesJson,
          survival_1s=COALESCE(@survival1s,survival_1s),
          survival_2s=COALESCE(@survival2s,survival_2s),
          survival_5s=COALESCE(@survival5s,survival_5s),
          survival_10s=COALESCE(@survival10s,survival_10s),
          updated_at_ms=@updatedAtMs
        WHERE episode_id=@episodeId
      `),
      confirmation: this.db.prepare(`
        INSERT OR IGNORE INTO confirmations (
          confirmation_id,episode_id,profile_id,confirmed_at_ms,slot,transaction_index,
          instruction_index,event_index,signature,ordering_confidence,slot_delta,
          current_price,low_price,price_bounce_pct,drop_recovery_pct,valid_buy_sol,
          unique_buyers,buy_to_dump_pct,net_flow_sol,net_flow_1s_sol,net_flow_3s_sol,
          current_quote_sol,snapshot_json
        ) VALUES (
          @confirmationId,@episodeId,@profileId,@confirmedAtMs,@slot,@transactionIndex,
          @instructionIndex,@eventIndex,@signature,@orderingConfidence,@slotDelta,
          @currentPrice,@lowPrice,@priceBouncePct,@dropRecoveryPct,@validBuySol,
          @uniqueBuyers,@buyToDumpPct,@netFlowSol,@netFlow1sSol,@netFlow3sSol,
          @currentQuoteSol,@snapshotJson
        )
      `),
      sameSlotObservation: this.db.prepare(`
        INSERT OR IGNORE INTO same_slot_observations (
          observation_id,episode_id,mint,pool,observed_at_ms,slot,
          dump_transaction_index,buy_transaction_index,instruction_index,event_index,
          signature,wallet,classification,receive_lag_ms,buy_sol,price,
          price_bounce_pct,executable,rejection_reason
        ) VALUES (
          @observationId,@episodeId,@mint,@pool,@observedAtMs,@slot,
          @dumpTransactionIndex,@buyTransactionIndex,@instructionIndex,@eventIndex,
          @signature,@wallet,@classification,@receiveLagMs,@buySol,@price,
          @priceBouncePct,@executable,@rejectionReason
        )
      `),
      simulation: this.db.prepare(`
        INSERT INTO simulations (
          simulation_id,confirmation_id,episode_id,recovery_profile_id,entry_variant_id,
          entry_kind,entry_delay_ms,exit_profile_id,position_sol,quote_model,status,
          rejection_reason,confirmed_at_ms,confirmation_slot,requested_entry_at_ms,
          entry_deadline_at_ms,entry_at_ms,entry_slot,entry_signature,entry_quote_lag_ms,
          actual_entry_delay_ms,entry_price,entry_market_price,entry_impact_pct,
          entry_protocol_fee_bps,entry_total_fee_bps,entry_liquidity_usage_pct,
          entry_capacity_round_trip_loss_pct,entry_capacity_exit_liquidity_usage_pct,
          token_units,entry_reserve_source,
          entry_fee_sol,exit_fee_sol,failed_transaction_fee_sol,max_exit_at_ms,
          exit_triggered_at_ms,exit_target_at_ms,requested_exit_at_ms,exit_deadline_at_ms,
          exit_at_ms,exit_slot,exit_signature,exit_quote_lag_ms,exit_horizon_lag_ms,
          exit_reason,exit_price,exit_market_price,exit_impact_pct,exit_protocol_fee_bps,
          exit_total_fee_bps,
          exit_liquidity_usage_pct,exit_reserve_source,proceeds_sol,total_cost_sol,
          gross_return_pct,net_return_pct,mfe_net_pct,mae_net_pct,last_executable_net_pct,
          last_executable_quote_at_ms,hold_ms,created_at_ms,updated_at_ms
        ) VALUES (
          @simulationId,@confirmationId,@episodeId,@recoveryProfileId,@entryVariantId,
          @entryKind,@entryDelayMs,@exitProfileId,@positionSol,@quoteModel,@status,
          @rejectionReason,@confirmedAtMs,@confirmationSlot,@requestedEntryAtMs,
          @entryDeadlineAtMs,@entryAtMs,@entrySlot,@entrySignature,@entryQuoteLagMs,
          @actualEntryDelayMs,@entryPrice,@entryMarketPrice,@entryImpactPct,
          @entryProtocolFeeBps,@entryTotalFeeBps,@entryLiquidityUsagePct,
          @entryCapacityRoundTripLossPct,@entryCapacityExitLiquidityUsagePct,
          @tokenUnits,@entryReserveSource,
          @entryFeeSol,@exitFeeSol,@failedTransactionFeeSol,@maxExitAtMs,
          @exitTriggeredAtMs,@exitTargetAtMs,@requestedExitAtMs,@exitDeadlineAtMs,
          @exitAtMs,@exitSlot,@exitSignature,@exitQuoteLagMs,@exitHorizonLagMs,
          @exitReason,@exitPrice,@exitMarketPrice,@exitImpactPct,@exitProtocolFeeBps,
          @exitTotalFeeBps,
          @exitLiquidityUsagePct,@exitReserveSource,@proceedsSol,@totalCostSol,
          @grossReturnPct,@netReturnPct,@mfeNetPct,@maeNetPct,@lastExecutableNetPct,
          @lastExecutableQuoteAtMs,@holdMs,@createdAtMs,@updatedAtMs
        ) ON CONFLICT(simulation_id) DO UPDATE SET
          status=excluded.status,rejection_reason=excluded.rejection_reason,
          entry_at_ms=excluded.entry_at_ms,entry_slot=excluded.entry_slot,
          entry_signature=excluded.entry_signature,entry_quote_lag_ms=excluded.entry_quote_lag_ms,
          actual_entry_delay_ms=excluded.actual_entry_delay_ms,entry_price=excluded.entry_price,
          entry_market_price=excluded.entry_market_price,entry_impact_pct=excluded.entry_impact_pct,
          entry_protocol_fee_bps=excluded.entry_protocol_fee_bps,
          entry_total_fee_bps=excluded.entry_total_fee_bps,
          entry_liquidity_usage_pct=excluded.entry_liquidity_usage_pct,
          entry_capacity_round_trip_loss_pct=excluded.entry_capacity_round_trip_loss_pct,
          entry_capacity_exit_liquidity_usage_pct=excluded.entry_capacity_exit_liquidity_usage_pct,
          token_units=excluded.token_units,entry_reserve_source=excluded.entry_reserve_source,
          max_exit_at_ms=excluded.max_exit_at_ms,exit_triggered_at_ms=excluded.exit_triggered_at_ms,
          exit_target_at_ms=excluded.exit_target_at_ms,requested_exit_at_ms=excluded.requested_exit_at_ms,
          exit_deadline_at_ms=excluded.exit_deadline_at_ms,exit_at_ms=excluded.exit_at_ms,
          exit_slot=excluded.exit_slot,exit_signature=excluded.exit_signature,
          exit_quote_lag_ms=excluded.exit_quote_lag_ms,exit_horizon_lag_ms=excluded.exit_horizon_lag_ms,
          exit_reason=excluded.exit_reason,exit_price=excluded.exit_price,
          exit_market_price=excluded.exit_market_price,exit_impact_pct=excluded.exit_impact_pct,
          exit_protocol_fee_bps=excluded.exit_protocol_fee_bps,
          exit_total_fee_bps=excluded.exit_total_fee_bps,
          exit_liquidity_usage_pct=excluded.exit_liquidity_usage_pct,
          exit_reserve_source=excluded.exit_reserve_source,proceeds_sol=excluded.proceeds_sol,
          total_cost_sol=excluded.total_cost_sol,gross_return_pct=excluded.gross_return_pct,
          net_return_pct=excluded.net_return_pct,mfe_net_pct=excluded.mfe_net_pct,
          mae_net_pct=excluded.mae_net_pct,last_executable_net_pct=excluded.last_executable_net_pct,
          last_executable_quote_at_ms=excluded.last_executable_quote_at_ms,
          hold_ms=excluded.hold_ms,updated_at_ms=excluded.updated_at_ms
      `),
      toxic: this.db.prepare(`
        INSERT INTO toxic_wallets(wallet,incidents,last_reason,last_seen_at_ms,last_episode_id)
        VALUES(@wallet,@incidents,@lastReason,@lastSeenAtMs,@lastEpisodeId)
        ON CONFLICT(wallet) DO UPDATE SET incidents=excluded.incidents,
          last_reason=excluded.last_reason,last_seen_at_ms=excluded.last_seen_at_ms,
          last_episode_id=excluded.last_episode_id
      `),
      pruneTrades: this.db.prepare(`
        DELETE FROM trades WHERE id IN (
          SELECT id FROM trades WHERE received_at_ms < ? LIMIT ?
        )
      `),
      pruneSlotSummaries: this.db.prepare(`
        DELETE FROM slot_summaries WHERE slot IN (
          SELECT slot FROM slot_summaries WHERE last_received_at_ms < ? LIMIT ?
        )
      `),
    };
    this.flushTransaction = this.db.transaction((operations) => {
      for (const operation of operations) operation.statement.run(operation.params);
    });
  }

  _enqueue(statement, params) {
    this.pending.push({ statement, params });
    this.metrics.queued += 1;
    if (this.pending.length >= this.config.batchMax) this.flush();
  }

  recordTrade(trade) {
    if (trade?.type !== 'ammTrade' || !trade.signature) return;
    this._enqueue(this.statements.trade, {
      receivedAtMs: number(trade.receivedAtMs) || Date.now(),
      chainTimestampMs: number(trade.chainTimestampMs), slot: number(trade.slot),
      transactionIndex: number(trade.transactionIndex), instructionIndex: number(trade.instructionIndex),
      eventIndex: number(trade.eventIndex) ?? 0, receiveSequence: number(trade.receiveSequence),
      signature: trade.signature, orderingConfidence: trade.orderingConfidence || 'SLOT_CORRELATED',
      mint: value(trade.mint), pool: value(trade.pool), coinCreator: value(trade.coinCreator),
      wallet: value(trade.wallet), side: trade.side, solAmount: number(trade.solAmount),
      tokenAmount: number(trade.tokenAmount), eventPrice: number(trade.price),
      reservePrice: number(trade.reservePrice), tokenDecimals: number(trade.tokenDecimals),
      tokenDecimalsSource: value(trade.tokenDecimalsSource), baseAmountRaw: value(trade.baseAmountRaw),
      userQuoteAmountRaw: value(trade.userQuoteAmountRaw),
      poolBaseReservesRaw: value(trade.poolBaseReservesRaw),
      poolQuoteReservesRaw: value(trade.poolQuoteReservesRaw),
      virtualQuoteReservesRaw: value(trade.virtualQuoteReservesRaw),
      effectiveQuoteReservesRaw: value(trade.effectiveQuoteReservesRaw),
      lpFeeBps: number(trade.lpFeeBasisPoints), protocolFeeBps: number(trade.protocolFeeBasisPoints),
      creatorFeeBps: number(trade.coinCreatorFeeBasisPoints),
      buybackFeeBps: number(trade.buybackFeeBasisPoints), totalFeeBps: number(trade.totalFeeBps),
      parseVersion: value(trade.parseVersion),
      rawJson: this.config.storeTradeRawJson ? json(trade) : null,
    });
  }

  recordSlotSummary(summary) {
    this._enqueue(this.statements.slot, {
      ...summary,
      strictOrderingAvailable: summary.strictOrderingAvailable ? 1 : 0,
    });
  }

  insertDump(dump, toxic) {
    const pre = dump.preWindow || {};
    this._enqueue(this.statements.dump, {
      ...dump,
      matchedDumpProfilesJson: json(dump.matchedDumpProfiles) || '[]',
      status: toxic.rejected ? 'TOXIC_REJECTED' : 'OBSERVING',
      toxicRejected: toxic.rejected ? 1 : 0,
      toxicReasonsJson: json(toxic.reasons),
      unavailableChecksJson: json(toxic.unavailableChecks),
      preTrades: number(pre.trades), preBuySol: number(pre.buySol), preSellSol: number(pre.sellSol),
      preNetFlowSol: number(pre.netFlowSol), preBuySharePct: number(pre.buySharePct),
      preUniqueBuyers: number(pre.uniqueBuyers),
      preLargestBuyerSharePct: number(pre.largestBuyerSharePct),
      prePriceRunupPct: number(pre.priceRunupPct),
      updatedAtMs: dump.detectedAtMs,
    });
  }

  updateDump(snapshot) {
    this._enqueue(this.statements.dumpUpdate, {
      ...snapshot,
      status: snapshot.status || 'OBSERVING',
      validBuySol: number(snapshot.validBuySol) || 0,
      rawBuySol: number(snapshot.rawBuySol) || 0,
      followSellSol: number(snapshot.followSellSol) || 0,
      uniqueBuyers: number(snapshot.uniqueBuyers) || 0,
      buyToDumpPct: number(snapshot.buyToDumpPct), priceBouncePct: number(snapshot.priceBouncePct),
      maxRecoveryPct: number(snapshot.maxRecoveryPct) || 0,
      currentQuoteSol: number(snapshot.currentQuoteSol), quoteRetentionPct: number(snapshot.quoteRetentionPct),
      strictSameSlotBuys: number(snapshot.strictSameSlotBuys) || 0,
      correlatedSameSlotBuys: number(snapshot.correlatedSameSlotBuys) || 0,
      secondDump: snapshot.secondDump ? 1 : 0,
      secondDumpAtMs: number(snapshot.secondDumpAtMs),
      confirmedProfilesJson: json(snapshot.confirmedProfiles),
      survival1s: number(snapshot.survival1s), survival2s: number(snapshot.survival2s),
      survival5s: number(snapshot.survival5s), survival10s: number(snapshot.survival10s),
      updatedAtMs: number(snapshot.observedAtMs) || Date.now(),
    });
  }

  insertConfirmation(confirmation) {
    const snapshot = confirmation.snapshot;
    this._enqueue(this.statements.confirmation, {
      ...confirmation,
      slotDelta: number(snapshot.slotDelta), currentPrice: number(snapshot.currentPrice),
      lowPrice: number(snapshot.lowPrice), priceBouncePct: number(snapshot.priceBouncePct),
      dropRecoveryPct: number(snapshot.dropRecoveryPct), validBuySol: number(snapshot.validBuySol),
      uniqueBuyers: number(snapshot.uniqueBuyers), buyToDumpPct: number(snapshot.buyToDumpPct),
      netFlowSol: number(snapshot.netFlowSol), netFlow1sSol: number(snapshot.netFlow1sSol),
      netFlow3sSol: number(snapshot.netFlow3sSol), currentQuoteSol: number(snapshot.currentQuoteSol),
      snapshotJson: json(snapshot) || '{}',
    });
  }

  insertSameSlotObservation(observation) {
    this._enqueue(this.statements.sameSlotObservation, {
      ...observation,
      executable: 0,
      dumpTransactionIndex: number(observation.dumpTransactionIndex),
      buyTransactionIndex: number(observation.buyTransactionIndex),
      instructionIndex: number(observation.instructionIndex),
      eventIndex: number(observation.eventIndex) ?? 0,
      receiveLagMs: Math.max(0, number(observation.receiveLagMs) || 0),
      buySol: Math.max(0, number(observation.buySol) || 0),
      price: number(observation.price),
      priceBouncePct: number(observation.priceBouncePct),
    });
  }

  insertSimulation(simulation) { this._upsertSimulation(simulation); }
  updateSimulation(simulation) { this._upsertSimulation(simulation); }

  _upsertSimulation(row) {
    const params = {};
    const fields = [
      'simulationId','confirmationId','episodeId','recoveryProfileId','entryVariantId',
      'entryKind','entryDelayMs','exitProfileId','positionSol','quoteModel','status',
      'rejectionReason','confirmedAtMs','confirmationSlot','requestedEntryAtMs','entryDeadlineAtMs',
      'entryAtMs','entrySlot','entrySignature','entryQuoteLagMs','actualEntryDelayMs','entryPrice',
      'entryMarketPrice','entryImpactPct','entryProtocolFeeBps','entryTotalFeeBps',
      'entryLiquidityUsagePct','entryCapacityRoundTripLossPct',
      'entryCapacityExitLiquidityUsagePct','tokenUnits',
      'entryReserveSource','entryFeeSol','exitFeeSol','failedTransactionFeeSol','maxExitAtMs',
      'exitTriggeredAtMs','exitTargetAtMs','requestedExitAtMs','exitDeadlineAtMs','exitAtMs',
      'exitSlot','exitSignature','exitQuoteLagMs','exitHorizonLagMs','exitReason','exitPrice',
      'exitMarketPrice','exitImpactPct','exitProtocolFeeBps','exitTotalFeeBps',
      'exitLiquidityUsagePct',
      'exitReserveSource','proceedsSol','totalCostSol','grossReturnPct','netReturnPct','mfeNetPct',
      'maeNetPct','lastExecutableNetPct','lastExecutableQuoteAtMs','holdMs','createdAtMs','updatedAtMs',
    ];
    for (const field of fields) params[field] = value(row[field]);
    params.createdAtMs = number(params.createdAtMs) || Date.now();
    params.updatedAtMs = number(params.updatedAtMs) || params.createdAtMs;
    this._enqueue(this.statements.simulation, params);
  }

  upsertToxicWallet(row) {
    this._enqueue(this.statements.toxic, row);
  }

  listToxicWallets() {
    this.flush();
    return this.db.prepare(`
      SELECT wallet, incidents, last_reason AS lastReason,
        last_seen_at_ms AS lastSeenAtMs, last_episode_id AS lastEpisodeId
      FROM toxic_wallets
    `).all();
  }

  flush() {
    if (!this.pending.length) return;
    const operations = this.pending.splice(0);
    try {
      this.flushTransaction(operations);
      this.metrics.flushed += operations.length;
      this.metrics.flushes += 1;
    } catch (error) {
      this.metrics.errors += 1;
      this.pending.unshift(...operations);
      throw error;
    }
  }

  maintain(now = Date.now()) {
    try {
      this.flush();
      const batchMax = this.config.maintenanceBatchMax;
      const prunedTrades = this.statements.pruneTrades.run(
        now - this.config.tradeRetentionMs, batchMax,
      ).changes;
      const prunedSlotSummaries = this.statements.pruneSlotSummaries.run(
        now - this.config.slotSummaryRetentionMs, batchMax,
      ).changes;
      this.db.pragma('wal_checkpoint(PASSIVE)');
      this.metrics.maintenanceRuns += 1;
      this.metrics.prunedTrades += prunedTrades;
      this.metrics.prunedSlotSummaries += prunedSlotSummaries;
      return { prunedTrades, prunedSlotSummaries };
    } catch (error) {
      this.metrics.maintenanceErrors += 1;
      this.metrics.errors += 1;
      throw error;
    }
  }

  deleteSimulationsByPositionSizes(positionSizesSol = []) {
    this.flush();
    const sizes = [...new Set(positionSizesSol
      .map((item) => number(item))
      .filter((item) => Number.isFinite(item) && item > 0))];
    if (!sizes.length) return 0;
    const predicates = sizes.map(() => 'ABS(position_sol - ?) < 0.000000001').join(' OR ');
    return this.db.prepare(`DELETE FROM simulations WHERE ${predicates}`).run(...sizes).changes;
  }

  deleteSimulationsByQuoteModels(quoteModels = []) {
    this.flush();
    const models = [...new Set(quoteModels.map((item) => String(item || '').trim()).filter(Boolean))];
    if (!models.length) return 0;
    const placeholders = models.map(() => '?').join(',');
    return this.db.prepare(`DELETE FROM simulations WHERE quote_model IN (${placeholders})`)
      .run(...models).changes;
  }

  summary() {
    this.flush();
    const dump = this.db.prepare(`
      SELECT COUNT(*) independent,
        SUM(CASE WHEN ordering_confidence='STRICT' THEN 1 ELSE 0 END) strict_ordering,
        SUM(CASE WHEN strict_same_slot_buys>0 THEN 1 ELSE 0 END) strict_same_slot_recovery,
        SUM(CASE WHEN correlated_same_slot_buys>0 THEN 1 ELSE 0 END) correlated_same_slot,
        SUM(CASE WHEN toxic_rejected=1 THEN 1 ELSE 0 END) toxic_rejected,
        SUM(CASE WHEN second_dump=1 THEN 1 ELSE 0 END) second_dump,
        SUM(CASE WHEN seller=coin_creator AND seller IS NOT NULL THEN 1 ELSE 0 END) creator_sell,
        AVG(survival_1s) survival_1s_rate,
        AVG(survival_2s) survival_2s_rate,
        AVG(survival_5s) survival_5s_rate,
        AVG(survival_10s) survival_10s_rate,
        AVG(valid_buy_sol) average_valid_buy_sol,
        AVG(unique_buyers) average_unique_buyers,
        AVG(buy_to_dump_pct) average_buy_to_dump_pct,
        AVG(max_recovery_pct) average_max_recovery_pct
      FROM dump_events
    `).get();
    const confirmation = this.db.prepare(`
      SELECT COUNT(DISTINCT episode_id) recovered,
        COUNT(DISTINCT CASE WHEN slot_delta=1 THEN episode_id END) next_slot_confirmations,
        COUNT(*) total_confirmations
      FROM confirmations
    `).get();
    const confirmationCoverage = this.db.prepare(`
      WITH coverage AS (
        SELECT confirmation_id,episode_id,
          EXISTS(SELECT 1 FROM simulations s
            WHERE s.confirmation_id=confirmations.confirmation_id) has_simulation
        FROM confirmations
      )
      SELECT COUNT(*) total,
        SUM(has_simulation) with_simulation,
        SUM(CASE WHEN has_simulation=0 THEN 1 ELSE 0 END) without_simulation,
        COUNT(DISTINCT CASE WHEN has_simulation=1 THEN episode_id END) simulated_episodes
      FROM coverage
    `).get();
    const sameSlot = this.db.prepare(`
      SELECT COUNT(*) observations,
        SUM(CASE WHEN classification='STRICT_AFTER_DUMP' THEN 1 ELSE 0 END) strict_after_dump,
        SUM(CASE WHEN classification='SLOT_CORRELATED' THEN 1 ELSE 0 END) slot_correlated,
        COUNT(DISTINCT CASE WHEN classification='STRICT_AFTER_DUMP' THEN episode_id END)
          events_with_strict_buy,
        AVG(receive_lag_ms) average_receive_lag_ms,
        AVG(buy_sol) average_buy_sol,
        SUM(buy_sol) total_buy_sol,
        SUM(executable) executable_signals
      FROM same_slot_observations
    `).get();
    const simulationCounts = this.db.prepare(`
      SELECT COUNT(*) scheduled,
        SUM(CASE WHEN entry_at_ms IS NOT NULL THEN 1 ELSE 0 END) entry_filled,
        SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) exit_filled,
        SUM(CASE WHEN status='NO_ENTRY' THEN 1 ELSE 0 END) no_entry,
        SUM(CASE WHEN status='NO_EXIT' THEN 1 ELSE 0 END) no_exit,
        SUM(CASE WHEN status='NO_ENTRY'
          AND rejection_reason='RECOVERY_INVALIDATED_BEFORE_ENTRY' THEN 1 ELSE 0 END)
          invalidated_before_entry,
        SUM(CASE WHEN status='NO_ENTRY'
          AND rejection_reason='INSUFFICIENT_ROUND_TRIP_LIQUIDITY' THEN 1 ELSE 0 END)
          insufficient_round_trip_liquidity,
        SUM(CASE WHEN status='NO_ENTRY'
          AND rejection_reason='ROUND_TRIP_COST_TOO_HIGH' THEN 1 ELSE 0 END)
          round_trip_cost_too_high,
        SUM(CASE WHEN status='NO_ENTRY'
          AND rejection_reason='NO_CAUSAL_ENTRY_QUOTE' THEN 1 ELSE 0 END)
          no_causal_entry_quote
      FROM simulations
    `).get();
    const returns = this.db.prepare(`
      SELECT episode_id episodeId,net_return_pct FROM simulations WHERE status='CLOSED'
    `).all();
    const eligibleDumps = Math.max(0, dump.independent - (dump.toxic_rejected || 0));
    return {
      generatedAtMs: Date.now(),
      dumps: {
        independent: dump.independent,
        strictOrderingCoveragePct: dump.independent ? dump.strict_ordering / dump.independent * 100 : null,
        strictSameSlotRecoveryRatePct: dump.strict_ordering
          ? dump.strict_same_slot_recovery / dump.strict_ordering * 100 : null,
        correlatedSameSlotRatePct: dump.independent
          ? dump.correlated_same_slot / dump.independent * 100 : null,
        toxicRejected: dump.toxic_rejected || 0,
        secondDumpRatePct: dump.independent ? dump.second_dump / dump.independent * 100 : null,
        creatorSellRatePct: dump.independent ? dump.creator_sell / dump.independent * 100 : null,
        nextSlotRecoveryRatePct: eligibleDumps
          ? confirmation.next_slot_confirmations / eligibleDumps * 100 : null,
        recoveredEpisodes: confirmation.recovered || 0,
        totalConfirmations: confirmation.total_confirmations || 0,
        survival1sPct: dump.survival_1s_rate == null ? null : dump.survival_1s_rate * 100,
        survival2sPct: dump.survival_2s_rate == null ? null : dump.survival_2s_rate * 100,
        survival5sPct: dump.survival_5s_rate == null ? null : dump.survival_5s_rate * 100,
        survival10sPct: dump.survival_10s_rate == null ? null : dump.survival_10s_rate * 100,
        averageValidBuySol: dump.average_valid_buy_sol,
        averageUniqueBuyers: dump.average_unique_buyers,
        averageBuyToDumpPct: dump.average_buy_to_dump_pct,
        averageMaxRecoveryPct: dump.average_max_recovery_pct,
      },
      sameSlotProbe: {
        observations: sameSlot.observations || 0,
        strictAfterDumpBuys: sameSlot.strict_after_dump || 0,
        slotCorrelatedBuys: sameSlot.slot_correlated || 0,
        eventsWithStrictBuy: sameSlot.events_with_strict_buy || 0,
        eventRatePct: dump.independent
          ? (sameSlot.events_with_strict_buy || 0) / dump.independent * 100 : null,
        averageReceiveLagMs: sameSlot.average_receive_lag_ms,
        averageBuySol: sameSlot.average_buy_sol,
        totalBuySol: sameSlot.total_buy_sol || 0,
        executableSignals: sameSlot.executable_signals || 0,
        executionEnabled: false,
      },
      execution: {
        scheduled: simulationCounts.scheduled,
        entryFilled: simulationCounts.entry_filled || 0,
        exitFilled: simulationCounts.exit_filled || 0,
        noEntry: simulationCounts.no_entry || 0,
        noExit: simulationCounts.no_exit || 0,
        invalidatedBeforeEntry: simulationCounts.invalidated_before_entry || 0,
        insufficientRoundTripLiquidity:
          simulationCounts.insufficient_round_trip_liquidity || 0,
        roundTripCostTooHigh: simulationCounts.round_trip_cost_too_high || 0,
        noCausalEntryQuote: simulationCounts.no_causal_entry_quote || 0,
        totalConfirmations: confirmationCoverage.total || 0,
        confirmationsWithSimulation: confirmationCoverage.with_simulation || 0,
        confirmationsWithoutSimulation: confirmationCoverage.without_simulation || 0,
        simulatedEpisodes: confirmationCoverage.simulated_episodes || 0,
        confirmationCoveragePct: confirmationCoverage.total
          ? confirmationCoverage.with_simulation / confirmationCoverage.total * 100 : null,
        entryFillRatePct: simulationCounts.scheduled
          ? simulationCounts.entry_filled / simulationCounts.scheduled * 100 : null,
        exitFillRatePct: simulationCounts.entry_filled
          ? simulationCounts.exit_filled / simulationCounts.entry_filled * 100 : null,
        noExitRatePct: simulationCounts.entry_filled
          ? simulationCounts.no_exit / simulationCounts.entry_filled * 100 : null,
        ...returnStats(returns),
        ...eventConcentrationStats(returns),
      },
      cohorts: this.cohorts(),
      store: this.health(),
    };
  }

  cohorts() {
    const groups = this.db.prepare(`
      SELECT quote_model,recovery_profile_id,entry_variant_id,position_sol,exit_profile_id,
        COUNT(*) scheduled,
        SUM(CASE WHEN entry_at_ms IS NOT NULL THEN 1 ELSE 0 END) entry_filled,
        SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) exit_filled,
        SUM(CASE WHEN status='NO_EXIT' THEN 1 ELSE 0 END) no_exit,
        SUM(CASE WHEN status='NO_EXIT' AND rejection_reason='NO_CAUSAL_EXIT_QUOTE'
          THEN 1 ELSE 0 END) no_exit_quote,
        SUM(CASE WHEN status='NO_EXIT'
          AND rejection_reason='NO_TRADE_AT_OR_AFTER_EXIT_HORIZON'
          THEN 1 ELSE 0 END) no_trade_after_horizon,
        SUM(CASE WHEN status='NO_ENTRY'
          AND rejection_reason='RECOVERY_INVALIDATED_BEFORE_ENTRY'
          THEN 1 ELSE 0 END) invalidated_before_entry,
        SUM(CASE WHEN status='NO_ENTRY'
          AND rejection_reason='INSUFFICIENT_ROUND_TRIP_LIQUIDITY'
          THEN 1 ELSE 0 END) insufficient_round_trip_liquidity,
        SUM(CASE WHEN status='NO_ENTRY'
          AND rejection_reason='ROUND_TRIP_COST_TOO_HIGH'
          THEN 1 ELSE 0 END) round_trip_cost_too_high,
        SUM(CASE WHEN status='NO_ENTRY'
          AND rejection_reason='NO_CAUSAL_ENTRY_QUOTE'
          THEN 1 ELSE 0 END) no_causal_entry_quote
      FROM simulations
      GROUP BY quote_model,recovery_profile_id,entry_variant_id,position_sol,exit_profile_id
      ORDER BY quote_model,recovery_profile_id,entry_variant_id,position_sol,exit_profile_id
    `).all();
    const returns = this.db.prepare(`
      SELECT episode_id episodeId,quote_model,recovery_profile_id,entry_variant_id,position_sol,
        exit_profile_id,net_return_pct
      FROM simulations WHERE status='CLOSED'
    `).all();
    return groups.map((group) => {
      const rows = returns.filter((row) => row.recovery_profile_id === group.recovery_profile_id
        && row.quote_model === group.quote_model
        && row.entry_variant_id === group.entry_variant_id
        && row.position_sol === group.position_sol
        && row.exit_profile_id === group.exit_profile_id);
      return {
        quoteModel: group.quote_model,
        recoveryProfileId: group.recovery_profile_id,
        entryVariantId: group.entry_variant_id,
        positionSol: group.position_sol,
        exitProfileId: group.exit_profile_id,
        scheduled: group.scheduled,
        entryFillRatePct: group.scheduled ? group.entry_filled / group.scheduled * 100 : null,
        exitFillRatePct: group.entry_filled ? group.exit_filled / group.entry_filled * 100 : null,
        noExitRatePct: group.entry_filled ? group.no_exit / group.entry_filled * 100 : null,
        noExitQuote: group.no_exit_quote,
        noTradeAfterHorizon: group.no_trade_after_horizon,
        noExitOther: Math.max(0,
          group.no_exit - group.no_exit_quote - group.no_trade_after_horizon),
        invalidatedBeforeEntry: group.invalidated_before_entry || 0,
        insufficientRoundTripLiquidity: group.insufficient_round_trip_liquidity || 0,
        roundTripCostTooHigh: group.round_trip_cost_too_high || 0,
        noCausalEntryQuote: group.no_causal_entry_quote || 0,
        ...returnStats(rows),
        ...eventConcentrationStats(rows),
      };
    }).sort(compareCohortPerformance);
  }

  recentDumps(limit = 100) {
    this.flush();
    return this.db.prepare(`SELECT * FROM dump_events ORDER BY detected_at_ms DESC LIMIT ?`)
      .all(Math.max(1, Math.min(1_000, Math.trunc(limit))));
  }

  recentDumpsPage(page = 1, pageSize = 20) {
    this.flush();
    const normalizedSize = Math.max(1, Math.min(100, Math.trunc(pageSize) || 20));
    const total = this.db.prepare('SELECT COUNT(*) count FROM dump_events').get().count;
    const totalPages = Math.max(1, Math.ceil(total / normalizedSize));
    const normalizedPage = Math.max(1, Math.min(totalPages, Math.trunc(page) || 1));
    const items = this.db.prepare(`
      SELECT * FROM dump_events ORDER BY detected_at_ms DESC LIMIT ? OFFSET ?
    `).all(normalizedSize, (normalizedPage - 1) * normalizedSize);
    return {
      items,
      page: normalizedPage,
      pageSize: normalizedSize,
      total,
      totalPages,
    };
  }

  recentSimulations(limit = 100) {
    this.flush();
    return this.db.prepare(`SELECT * FROM simulations ORDER BY updated_at_ms DESC LIMIT ?`)
      .all(Math.max(1, Math.min(1_000, Math.trunc(limit))));
  }

  recentSameSlotObservations(limit = 100) {
    this.flush();
    return this.db.prepare(`
      SELECT * FROM same_slot_observations ORDER BY observed_at_ms DESC LIMIT ?
    `).all(Math.max(1, Math.min(1_000, Math.trunc(limit))));
  }

  recentSameSlotObservationsPage(page = 1, pageSize = 20) {
    this.flush();
    const normalizedSize = Math.max(1, Math.min(100, Math.trunc(pageSize) || 20));
    const total = this.db.prepare('SELECT COUNT(*) count FROM same_slot_observations').get().count;
    const totalPages = Math.max(1, Math.ceil(total / normalizedSize));
    const normalizedPage = Math.max(1, Math.min(totalPages, Math.trunc(page) || 1));
    const items = this.db.prepare(`
      SELECT * FROM same_slot_observations ORDER BY observed_at_ms DESC LIMIT ? OFFSET ?
    `).all(normalizedSize, (normalizedPage - 1) * normalizedSize);
    return {
      items,
      page: normalizedPage,
      pageSize: normalizedSize,
      total,
      totalPages,
    };
  }

  health() {
    const disk = this._diskHealth();
    return {
      dbPath: this.config.dbPath,
      storageMode: 'DUMP_EVENT_WINDOWS',
      storesTradeRawJson: this.config.storeTradeRawJson,
      tradeRetentionDays: this.config.tradeRetentionMs / 86_400_000,
      pendingWrites: this.pending.length,
      ...disk,
      ...this.metrics,
    };
  }

  _diskHealth() {
    if (this.config.dbPath === ':memory:') {
      return { dbFileBytes: null, diskFreeBytes: null, diskTotalBytes: null, diskFreePct: null };
    }
    const directory = path.dirname(this.config.dbPath);
    const sizeOf = (file) => {
      try { return fs.statSync(file).size; } catch (_) { return 0; }
    };
    const dbFileBytes = sizeOf(this.config.dbPath)
      + sizeOf(`${this.config.dbPath}-wal`) + sizeOf(`${this.config.dbPath}-shm`);
    try {
      const stats = fs.statfsSync(directory);
      const diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
      const diskTotalBytes = Number(stats.blocks) * Number(stats.bsize);
      return {
        dbFileBytes,
        diskFreeBytes,
        diskTotalBytes,
        diskFreePct: diskTotalBytes > 0 ? diskFreeBytes / diskTotalBytes * 100 : null,
      };
    } catch (_) {
      return { dbFileBytes, diskFreeBytes: null, diskTotalBytes: null, diskFreePct: null };
    }
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.maintenanceTimer);
    this.flush();
    this.db.close();
  }
}

module.exports = {
  ResearchStore, compareCohortPerformance, returnStats, eventConcentrationStats,
};
