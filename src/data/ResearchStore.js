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

function numericScenarioStats(values) {
  const finiteValues = values.filter(Number.isFinite);
  const wins = finiteValues.filter((item) => item > 0);
  const losses = finiteValues.filter((item) => item < 0);
  const grossWins = wins.reduce((sum, item) => sum + item, 0);
  const grossLosses = Math.abs(losses.reduce((sum, item) => sum + item, 0));
  return {
    samples: finiteValues.length,
    averageNetReturnPct: finiteValues.length
      ? finiteValues.reduce((sum, item) => sum + item, 0) / finiteValues.length : null,
    winRatePct: finiteValues.length ? wins.length / finiteValues.length * 100 : null,
    profitFactor: finiteValues.length
      ? (grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? null : 0)) : null,
  };
}

function shadowScenarioStats({
  closedRows, noExit, noExitLossPcts = [-15, -100], jitoTipScenariosSol = [],
  positionSol = null, modeledTipSol = null,
}) {
  const rows = closedRows.filter((row) => Number.isFinite(number(row.net_return_pct)));
  const closedReturnSum = rows.reduce((sum, row) => sum + number(row.net_return_pct), 0);
  const resolved = rows.length + noExit;
  const noExitScenarios = noExitLossPcts.map((lossPct) => ({
    lossPct,
    averageNetReturnPct: resolved
      ? (closedReturnSum + noExit * lossPct) / resolved : null,
  }));
  const jitoTipScenarios = jitoTipScenariosSol.map((tipSol) => {
    const adjusted = rows.map((row) => {
      const positionSol = number(row.position_sol);
      if (!(positionSol > 0)) return null;
      const modeledTipSol = Math.max(0, number(row.modeled_jito_tip_sol) || 0);
      return number(row.net_return_pct) - (tipSol - modeledTipSol) * 2 / positionSol * 100;
    }).filter(Number.isFinite);
    return {
      tipSol,
      averageNetReturnPct: adjusted.length
        ? adjusted.reduce((sum, value) => sum + value, 0) / adjusted.length : null,
    };
  });
  const normalizedPositionSol = number(positionSol);
  const normalizedModeledTipSol = Math.max(0, number(modeledTipSol)
    ?? (rows.length ? number(rows[0].modeled_jito_tip_sol) : 0) ?? 0);
  const combinedScenarios = normalizedPositionSol > 0
    ? noExitLossPcts.flatMap((lossPct) => jitoTipScenariosSol.map((tipSol) => {
      const jitoCostPct = (tipSol - normalizedModeledTipSol)
        * 2 / normalizedPositionSol * 100;
      const adjustedClosedSum = rows.reduce(
        (sum, row) => sum + number(row.net_return_pct) - jitoCostPct, 0,
      );
      return {
        noExitLossPct: lossPct,
        tipSol,
        averageNetReturnPct: resolved
          ? (adjustedClosedSum + noExit * (lossPct - jitoCostPct)) / resolved : null,
      };
    })) : [];
  return { noExitScenarios, jitoTipScenarios, combinedScenarios };
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
      maxDumpDropPct: 40,
      acceptedDumpParseVersion: null,
      sameSlotQuoteModel: null,
      sameSlotPrimaryProfileId: 'R2-B5',
      sameSlotPrimaryCohortStage: 'HOLDOUT_B5_V1',
      sameSlotStrongTriggerBuySol: 5,
      sameSlotMaxTradeSol: 1_000,
      sameSlotNoExitScenarioLossPcts: [-15, -100],
      sameSlotJitoTipScenariosSol: [0, 0.005, 0.01, 0.02],
      sameSlotCandidate: { enabled: false },
      maxReportedRecoveryPct: 500,
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
      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '13')
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
        ingestion_mode TEXT,
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
        parse_version TEXT,
        ingestion_mode TEXT,
        valid_buy_sol REAL DEFAULT 0,
        raw_buy_sol REAL DEFAULT 0,
        follow_sell_sol REAL DEFAULT 0,
        unique_buyers INTEGER DEFAULT 0,
        buy_to_dump_pct REAL,
        price_bounce_pct REAL,
        max_recovery_pct REAL DEFAULT 0,
        absorption_score REAL,
        absorption_score_components_json TEXT,
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
        absorption_score REAL,
        absorption_score_components_json TEXT,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_confirmations_time ON confirmations(confirmed_at_ms DESC);

      CREATE TABLE IF NOT EXISTS watched_wallet_trades (
        observation_id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        chain_timestamp_ms INTEGER,
        slot INTEGER,
        transaction_index INTEGER,
        instruction_index INTEGER,
        event_index INTEGER NOT NULL,
        signature TEXT NOT NULL,
        ordering_confidence TEXT NOT NULL,
        mint TEXT,
        pool TEXT,
        side TEXT NOT NULL,
        sol_amount REAL,
        token_amount REAL,
        price REAL,
        reserve_price REAL,
        ingestion_mode TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_watched_wallet_time
        ON watched_wallet_trades(wallet,received_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_watched_wallet_mint_time
        ON watched_wallet_trades(mint,received_at_ms DESC);

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
        data_quality_status TEXT NOT NULL DEFAULT 'UNASSESSED',
        data_quality_reasons_json TEXT,
        executable INTEGER NOT NULL DEFAULT 0 CHECK(executable = 0),
        rejection_reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_same_slot_episode
        ON same_slot_observations(episode_id, observed_at_ms);
      CREATE INDEX IF NOT EXISTS idx_same_slot_time
        ON same_slot_observations(observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_same_slot_chain_order
        ON same_slot_observations(
          episode_id,classification,buy_transaction_index,instruction_index,event_index
        );

      CREATE TABLE IF NOT EXISTS same_slot_shadow_simulations (
        shadow_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES dump_events(episode_id),
        target_rank INTEGER NOT NULL,
        entry_profile_id TEXT NOT NULL DEFAULT 'LEGACY',
        cohort_stage TEXT NOT NULL DEFAULT 'LEGACY',
        candidate_profile_id TEXT,
        candidate_cohort_stage TEXT,
        candidate_primary INTEGER NOT NULL DEFAULT 0,
        candidate_novel_mint INTEGER,
        candidate_criteria_json TEXT,
        position_sol REAL NOT NULL,
        exit_horizon_ms INTEGER NOT NULL,
        quote_model TEXT NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        infrastructure_mode TEXT NOT NULL,
        infrastructure_executable INTEGER NOT NULL DEFAULT 0
          CHECK(infrastructure_executable = 0),
        infrastructure_reason TEXT NOT NULL,
        parse_budget_ms REAL,
        build_budget_ms REAL,
        sign_budget_ms REAL,
        send_budget_ms REAL,
        response_budget_ms REAL,
        latency_model TEXT NOT NULL DEFAULT 'LEGACY_DUMP_TO_COMPETITOR',
        competitor_observed_at_ms INTEGER,
        competitor_receive_lag_ms REAL,
        competitor_reference_at_ms INTEGER,
        competitor_gap_ms REAL,
        competitor_headroom_ms REAL,
        trigger_buy_sol REAL,
        trigger_buy_to_dump_pct REAL,
        trigger_wallet TEXT,
        data_quality_status TEXT NOT NULL DEFAULT 'UNASSESSED',
        data_quality_reasons_json TEXT,
        entry_assumption TEXT NOT NULL,
        entry_reference_rank INTEGER NOT NULL,
        entry_at_ms INTEGER NOT NULL,
        entry_slot INTEGER,
        entry_reference_signature TEXT,
        entry_reference_transaction_index INTEGER,
        entry_reference_instruction_index INTEGER,
        entry_reference_event_index INTEGER,
        entry_price REAL,
        entry_market_price REAL,
        entry_impact_pct REAL,
        entry_total_fee_bps REAL,
        entry_liquidity_usage_pct REAL,
        entry_capacity_round_trip_loss_pct REAL,
        entry_capacity_exit_liquidity_usage_pct REAL,
        token_units REAL,
        entry_reserve_source TEXT,
        entry_fee_sol REAL,
        exit_fee_sol REAL,
        modeled_jito_tip_sol REAL DEFAULT 0,
        requested_exit_at_ms INTEGER,
        exit_deadline_at_ms INTEGER,
        active_exit_target_at_ms INTEGER,
        active_exit_deadline_at_ms INTEGER,
        exit_phase TEXT NOT NULL DEFAULT 'PRIMARY',
        active_rescue_horizon_ms INTEGER,
        rescue_horizon_ms INTEGER,
        rescue_attempted_horizons_json TEXT,
        primary_no_exit_reason TEXT,
        exit_reason TEXT,
        post_horizon_trades INTEGER NOT NULL DEFAULT 0,
        exit_at_ms INTEGER,
        exit_slot INTEGER,
        exit_signature TEXT,
        exit_quote_lag_ms INTEGER,
        exit_price REAL,
        exit_market_price REAL,
        exit_impact_pct REAL,
        exit_total_fee_bps REAL,
        exit_liquidity_usage_pct REAL,
        exit_reserve_source TEXT,
        proceeds_sol REAL,
        total_cost_sol REAL,
        gross_return_pct REAL,
        net_return_pct REAL,
        hold_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_same_slot_shadow_status
        ON same_slot_shadow_simulations(status,updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_same_slot_shadow_cohort
        ON same_slot_shadow_simulations(
          quote_model,target_rank,position_sol,exit_horizon_ms
        );
      CREATE INDEX IF NOT EXISTS idx_same_slot_shadow_episode
        ON same_slot_shadow_simulations(episode_id,status);

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
    this._ensureColumn('dump_events', 'parse_version', 'TEXT');
    this._ensureColumn('trades', 'ingestion_mode', 'TEXT');
    this._ensureColumn('dump_events', 'ingestion_mode', 'TEXT');
    this._ensureColumn('dump_events', 'absorption_score', 'REAL');
    this._ensureColumn('dump_events', 'absorption_score_components_json', 'TEXT');
    this._ensureColumn('confirmations', 'absorption_score', 'REAL');
    this._ensureColumn('confirmations', 'absorption_score_components_json', 'TEXT');
    this._ensureColumn('same_slot_observations', 'data_quality_status',
      "TEXT NOT NULL DEFAULT 'UNASSESSED'");
    this._ensureColumn('same_slot_observations', 'data_quality_reasons_json', 'TEXT');
    this._ensureColumn('same_slot_shadow_simulations', 'entry_profile_id',
      "TEXT NOT NULL DEFAULT 'LEGACY'");
    this._ensureColumn('same_slot_shadow_simulations', 'cohort_stage',
      "TEXT NOT NULL DEFAULT 'LEGACY'");
    this._ensureColumn('same_slot_shadow_simulations', 'candidate_profile_id', 'TEXT');
    this._ensureColumn('same_slot_shadow_simulations', 'candidate_cohort_stage', 'TEXT');
    this._ensureColumn('same_slot_shadow_simulations', 'candidate_primary',
      'INTEGER NOT NULL DEFAULT 0');
    this._ensureColumn('same_slot_shadow_simulations', 'candidate_novel_mint', 'INTEGER');
    this._ensureColumn('same_slot_shadow_simulations', 'candidate_criteria_json', 'TEXT');
    this._ensureColumn('same_slot_shadow_simulations', 'latency_model',
      "TEXT NOT NULL DEFAULT 'LEGACY_DUMP_TO_COMPETITOR'");
    this._ensureColumn('same_slot_shadow_simulations', 'competitor_reference_at_ms', 'INTEGER');
    this._ensureColumn('same_slot_shadow_simulations', 'competitor_gap_ms', 'REAL');
    this._ensureColumn('same_slot_shadow_simulations', 'trigger_buy_sol', 'REAL');
    this._ensureColumn('same_slot_shadow_simulations', 'trigger_buy_to_dump_pct', 'REAL');
    this._ensureColumn('same_slot_shadow_simulations', 'trigger_wallet', 'TEXT');
    this._ensureColumn('same_slot_shadow_simulations', 'data_quality_status',
      "TEXT NOT NULL DEFAULT 'UNASSESSED'");
    this._ensureColumn('same_slot_shadow_simulations', 'data_quality_reasons_json', 'TEXT');
    this._ensureColumn('same_slot_shadow_simulations', 'modeled_jito_tip_sol', 'REAL DEFAULT 0');
    this._ensureColumn('same_slot_shadow_simulations', 'active_exit_target_at_ms', 'INTEGER');
    this._ensureColumn('same_slot_shadow_simulations', 'active_exit_deadline_at_ms', 'INTEGER');
    this._ensureColumn('same_slot_shadow_simulations', 'exit_phase',
      "TEXT NOT NULL DEFAULT 'PRIMARY'");
    this._ensureColumn('same_slot_shadow_simulations', 'active_rescue_horizon_ms', 'INTEGER');
    this._ensureColumn('same_slot_shadow_simulations', 'rescue_horizon_ms', 'INTEGER');
    this._ensureColumn('same_slot_shadow_simulations', 'rescue_attempted_horizons_json', 'TEXT');
    this._ensureColumn('same_slot_shadow_simulations', 'primary_no_exit_reason', 'TEXT');
    this._ensureColumn('same_slot_shadow_simulations', 'exit_reason', 'TEXT');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_excluded_mints (
        profile_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        reason TEXT NOT NULL,
        first_seen_at_ms INTEGER,
        PRIMARY KEY(profile_id,mint)
      );
      CREATE TABLE IF NOT EXISTS execution_probes (
        probe_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES dump_events(episode_id),
        shadow_id TEXT,
        candidate_profile_id TEXT NOT NULL,
        candidate_cohort_stage TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_signature TEXT,
        chain_validation_status TEXT NOT NULL DEFAULT 'PENDING_SLOT_FINALIZATION',
        trigger_at_ms INTEGER,
        measured_at_ms INTEGER NOT NULL,
        trigger_to_probe_ms REAL,
        build_duration_us REAL,
        sign_duration_us REAL,
        serialize_duration_us REAL,
        total_local_duration_us REAL,
        payload_bytes INTEGER,
        send_enabled INTEGER NOT NULL DEFAULT 0 CHECK(send_enabled=0),
        send_status TEXT NOT NULL,
        send_duration_us REAL,
        landing_status TEXT NOT NULL,
        landing_duration_ms REAL,
        landed_signature TEXT,
        landed_slot INTEGER,
        landed_transaction_index INTEGER,
        landed_rank INTEGER,
        rank_status TEXT NOT NULL,
        error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_probe_candidate
        ON execution_probes(candidate_profile_id,measured_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_same_slot_candidate
        ON same_slot_shadow_simulations(
          candidate_profile_id,candidate_primary,candidate_novel_mint,status
        );
    `);
    this._ensureColumn('execution_probes', 'trigger_signature', 'TEXT');
    this._ensureColumn('execution_probes', 'chain_validation_status',
      "TEXT NOT NULL DEFAULT 'PENDING_SLOT_FINALIZATION'");
    this.db.prepare(`
      UPDATE same_slot_shadow_simulations
      SET entry_profile_id='R2-B5',cohort_stage='DISCOVERY_RECLASSIFIED_20260824'
      WHERE target_rank=2 AND entry_profile_id='R2-B2' AND trigger_buy_sol>=?
    `).run(this.config.sameSlotStrongTriggerBuySol);
    this._initializeCandidateBaseline();
    this.db.prepare(`
      UPDATE same_slot_observations
      SET data_quality_status='QUARANTINED',
        data_quality_reasons_json='["TRADE_SOL_ABOVE_LIMIT"]'
      WHERE COALESCE(data_quality_status,'UNASSESSED')='UNASSESSED'
        AND buy_sol>?
    `).run(this.config.sameSlotMaxTradeSol);
    this.db.prepare(`
      UPDATE same_slot_observations
      SET data_quality_status='QUARANTINED',
        data_quality_reasons_json='["OBSERVATION_PRICE_BOUNCE_ABOVE_LIMIT"]'
      WHERE COALESCE(data_quality_status,'UNASSESSED')='UNASSESSED'
        AND ABS(price_bounce_pct)>?
    `).run(this.config.maxReportedRecoveryPct);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_same_slot_shadow_profile_cohort
        ON same_slot_shadow_simulations(
          quote_model,entry_profile_id,position_sol,exit_horizon_ms,data_quality_status
        )
    `);
    this.db.exec(`
      UPDATE dump_events
      SET parse_version=(
        SELECT t.parse_version FROM trades t
        WHERE t.signature=dump_events.signature
          AND t.event_index=dump_events.event_index
        LIMIT 1
      )
      WHERE parse_version IS NULL
    `);
    this.db.exec(`
      UPDATE dump_events
      SET ingestion_mode=(
        SELECT t.ingestion_mode FROM trades t
        WHERE t.signature=dump_events.signature
          AND t.event_index=dump_events.event_index
        LIMIT 1
      )
      WHERE ingestion_mode IS NULL
    `);
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
          buyback_fee_bps, total_fee_bps, parse_version, ingestion_mode, raw_json
        ) VALUES (
          @receivedAtMs, @chainTimestampMs, @slot, @transactionIndex, @instructionIndex,
          @eventIndex, @receiveSequence, @signature, @orderingConfidence, @mint, @pool,
          @coinCreator, @wallet, @side, @solAmount, @tokenAmount, @eventPrice, @reservePrice,
          @tokenDecimals, @tokenDecimalsSource, @baseAmountRaw, @userQuoteAmountRaw,
          @poolBaseReservesRaw, @poolQuoteReservesRaw, @virtualQuoteReservesRaw,
          @effectiveQuoteReservesRaw, @lpFeeBps, @protocolFeeBps, @creatorFeeBps,
          @buybackFeeBps, @totalFeeBps, @parseVersion, @ingestionMode, @rawJson
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
      watchedWalletTrade: this.db.prepare(`
        INSERT OR IGNORE INTO watched_wallet_trades (
          observation_id,wallet,received_at_ms,chain_timestamp_ms,slot,transaction_index,
          instruction_index,event_index,signature,ordering_confidence,mint,pool,side,
          sol_amount,token_amount,price,reserve_price,ingestion_mode
        ) VALUES (
          @observationId,@wallet,@receivedAtMs,@chainTimestampMs,@slot,@transactionIndex,
          @instructionIndex,@eventIndex,@signature,@orderingConfidence,@mint,@pool,@side,
          @solAmount,@tokenAmount,@price,@reservePrice,@ingestionMode
        )
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
          pre_largest_buyer_share_pct,pre_price_runup_pct,parse_version,ingestion_mode,
          updated_at_ms
        ) VALUES (
          @episodeId,@mint,@pool,@seller,@coinCreator,@detectedAtMs,@chainTimestampMs,@slot,
          @transactionIndex,@instructionIndex,@eventIndex,@signature,@orderingConfidence,
          @matchedDumpProfilesJson,@status,@toxicRejected,@toxicReasonsJson,
          @unavailableChecksJson,@sellSol,@sellTokens,@prePrice,@prePriceSource,@postPrice,
          @lowPrice,@dropPct,@preQuoteSol,@postQuoteSol,@sellToQuotePct,
          @sellTokenToReservePct,@poolAgeMs,@poolAgeSource,@preTrades,@preBuySol,
          @preSellSol,@preNetFlowSol,@preBuySharePct,@preUniqueBuyers,
          @preLargestBuyerSharePct,@prePriceRunupPct,@parseVersion,@ingestionMode,@updatedAtMs
        )
      `),
      dumpUpdate: this.db.prepare(`
        UPDATE dump_events SET
          status=@status, valid_buy_sol=@validBuySol, raw_buy_sol=@rawBuySol,
          follow_sell_sol=@followSellSol, unique_buyers=@uniqueBuyers,
          buy_to_dump_pct=@buyToDumpPct, price_bounce_pct=@priceBouncePct,
          max_recovery_pct=@maxRecoveryPct, absorption_score=@absorptionScore,
          absorption_score_components_json=@absorptionScoreComponentsJson,
          current_quote_sol=@currentQuoteSol,
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
          current_quote_sol,absorption_score,absorption_score_components_json,snapshot_json
        ) VALUES (
          @confirmationId,@episodeId,@profileId,@confirmedAtMs,@slot,@transactionIndex,
          @instructionIndex,@eventIndex,@signature,@orderingConfidence,@slotDelta,
          @currentPrice,@lowPrice,@priceBouncePct,@dropRecoveryPct,@validBuySol,
          @uniqueBuyers,@buyToDumpPct,@netFlowSol,@netFlow1sSol,@netFlow3sSol,
          @currentQuoteSol,@absorptionScore,@absorptionScoreComponentsJson,@snapshotJson
        )
      `),
      sameSlotObservation: this.db.prepare(`
        INSERT OR IGNORE INTO same_slot_observations (
          observation_id,episode_id,mint,pool,observed_at_ms,slot,
          dump_transaction_index,buy_transaction_index,instruction_index,event_index,
          signature,wallet,classification,receive_lag_ms,buy_sol,price,
          price_bounce_pct,data_quality_status,data_quality_reasons_json,
          executable,rejection_reason
        ) VALUES (
          @observationId,@episodeId,@mint,@pool,@observedAtMs,@slot,
          @dumpTransactionIndex,@buyTransactionIndex,@instructionIndex,@eventIndex,
          @signature,@wallet,@classification,@receiveLagMs,@buySol,@price,
          @priceBouncePct,@dataQualityStatus,@dataQualityReasonsJson,
          @executable,@rejectionReason
        )
      `),
      sameSlotShadow: this.db.prepare(`
        INSERT INTO same_slot_shadow_simulations (
          shadow_id,episode_id,target_rank,entry_profile_id,cohort_stage,
          candidate_profile_id,candidate_cohort_stage,candidate_primary,
          candidate_novel_mint,candidate_criteria_json,position_sol,
          exit_horizon_ms,quote_model,
          status,rejection_reason,infrastructure_mode,infrastructure_executable,
          infrastructure_reason,parse_budget_ms,build_budget_ms,sign_budget_ms,
          send_budget_ms,response_budget_ms,latency_model,competitor_observed_at_ms,
          competitor_receive_lag_ms,competitor_reference_at_ms,competitor_gap_ms,
          competitor_headroom_ms,trigger_buy_sol,trigger_buy_to_dump_pct,trigger_wallet,
          data_quality_status,data_quality_reasons_json,entry_assumption,
          entry_reference_rank,entry_at_ms,entry_slot,entry_reference_signature,
          entry_reference_transaction_index,entry_reference_instruction_index,
          entry_reference_event_index,entry_price,entry_market_price,entry_impact_pct,
          entry_total_fee_bps,entry_liquidity_usage_pct,
          entry_capacity_round_trip_loss_pct,entry_capacity_exit_liquidity_usage_pct,
          token_units,entry_reserve_source,entry_fee_sol,exit_fee_sol,modeled_jito_tip_sol,
          requested_exit_at_ms,exit_deadline_at_ms,active_exit_target_at_ms,
          active_exit_deadline_at_ms,exit_phase,active_rescue_horizon_ms,rescue_horizon_ms,
          rescue_attempted_horizons_json,primary_no_exit_reason,exit_reason,
          post_horizon_trades,exit_at_ms,
          exit_slot,exit_signature,exit_quote_lag_ms,exit_price,exit_market_price,
          exit_impact_pct,exit_total_fee_bps,exit_liquidity_usage_pct,exit_reserve_source,
          proceeds_sol,total_cost_sol,gross_return_pct,net_return_pct,hold_ms,
          created_at_ms,updated_at_ms
        ) VALUES (
          @shadowId,@episodeId,@targetRank,@entryProfileId,@cohortStage,
          @candidateProfileId,@candidateCohortStage,@candidatePrimary,
          @candidateNovelMint,@candidateCriteriaJson,@positionSol,
          @exitHorizonMs,@quoteModel,
          @status,@rejectionReason,@infrastructureMode,@infrastructureExecutable,
          @infrastructureReason,@parseBudgetMs,@buildBudgetMs,@signBudgetMs,
          @sendBudgetMs,@responseBudgetMs,@latencyModel,@competitorObservedAtMs,
          @competitorReceiveLagMs,@competitorReferenceAtMs,@competitorGapMs,
          @competitorHeadroomMs,@triggerBuySol,@triggerBuyToDumpPct,@triggerWallet,
          @dataQualityStatus,@dataQualityReasonsJson,@entryAssumption,
          @entryReferenceRank,@entryAtMs,@entrySlot,@entryReferenceSignature,
          @entryReferenceTransactionIndex,@entryReferenceInstructionIndex,
          @entryReferenceEventIndex,@entryPrice,@entryMarketPrice,@entryImpactPct,
          @entryTotalFeeBps,@entryLiquidityUsagePct,
          @entryCapacityRoundTripLossPct,@entryCapacityExitLiquidityUsagePct,
          @tokenUnits,@entryReserveSource,@entryFeeSol,@exitFeeSol,@modeledJitoTipSol,
          @requestedExitAtMs,@exitDeadlineAtMs,@activeExitTargetAtMs,
          @activeExitDeadlineAtMs,@exitPhase,@activeRescueHorizonMs,@rescueHorizonMs,
          @rescueAttemptedHorizonsJson,@primaryNoExitReason,@exitReason,
          @postHorizonTrades,@exitAtMs,
          @exitSlot,@exitSignature,@exitQuoteLagMs,@exitPrice,@exitMarketPrice,
          @exitImpactPct,@exitTotalFeeBps,@exitLiquidityUsagePct,@exitReserveSource,
          @proceedsSol,@totalCostSol,@grossReturnPct,@netReturnPct,@holdMs,
          @createdAtMs,@updatedAtMs
        ) ON CONFLICT(shadow_id) DO UPDATE SET
          status=excluded.status,rejection_reason=excluded.rejection_reason,
          entry_profile_id=excluded.entry_profile_id,
          cohort_stage=excluded.cohort_stage,
          candidate_profile_id=excluded.candidate_profile_id,
          candidate_cohort_stage=excluded.candidate_cohort_stage,
          candidate_primary=excluded.candidate_primary,
          candidate_novel_mint=excluded.candidate_novel_mint,
          candidate_criteria_json=excluded.candidate_criteria_json,
          latency_model=excluded.latency_model,
          competitor_observed_at_ms=excluded.competitor_observed_at_ms,
          competitor_receive_lag_ms=excluded.competitor_receive_lag_ms,
          competitor_reference_at_ms=excluded.competitor_reference_at_ms,
          competitor_gap_ms=excluded.competitor_gap_ms,
          competitor_headroom_ms=excluded.competitor_headroom_ms,
          trigger_buy_sol=excluded.trigger_buy_sol,
          trigger_buy_to_dump_pct=excluded.trigger_buy_to_dump_pct,
          trigger_wallet=excluded.trigger_wallet,
          data_quality_status=excluded.data_quality_status,
          data_quality_reasons_json=excluded.data_quality_reasons_json,
          modeled_jito_tip_sol=excluded.modeled_jito_tip_sol,
          requested_exit_at_ms=excluded.requested_exit_at_ms,
          exit_deadline_at_ms=excluded.exit_deadline_at_ms,
          active_exit_target_at_ms=excluded.active_exit_target_at_ms,
          active_exit_deadline_at_ms=excluded.active_exit_deadline_at_ms,
          exit_phase=excluded.exit_phase,
          active_rescue_horizon_ms=excluded.active_rescue_horizon_ms,
          rescue_horizon_ms=excluded.rescue_horizon_ms,
          rescue_attempted_horizons_json=excluded.rescue_attempted_horizons_json,
          primary_no_exit_reason=excluded.primary_no_exit_reason,
          exit_reason=excluded.exit_reason,
          post_horizon_trades=excluded.post_horizon_trades,
          exit_at_ms=excluded.exit_at_ms,exit_slot=excluded.exit_slot,
          exit_signature=excluded.exit_signature,exit_quote_lag_ms=excluded.exit_quote_lag_ms,
          exit_price=excluded.exit_price,exit_market_price=excluded.exit_market_price,
          exit_impact_pct=excluded.exit_impact_pct,exit_total_fee_bps=excluded.exit_total_fee_bps,
          exit_liquidity_usage_pct=excluded.exit_liquidity_usage_pct,
          exit_reserve_source=excluded.exit_reserve_source,proceeds_sol=excluded.proceeds_sol,
          total_cost_sol=excluded.total_cost_sol,gross_return_pct=excluded.gross_return_pct,
          net_return_pct=excluded.net_return_pct,hold_ms=excluded.hold_ms,
          updated_at_ms=excluded.updated_at_ms
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
      executionProbe: this.db.prepare(`
        INSERT INTO execution_probes(
          probe_id,episode_id,shadow_id,candidate_profile_id,candidate_cohort_stage,
          mode,model,status,trigger_signature,chain_validation_status,
          trigger_at_ms,measured_at_ms,trigger_to_probe_ms,
          build_duration_us,sign_duration_us,serialize_duration_us,total_local_duration_us,
          payload_bytes,send_enabled,send_status,send_duration_us,landing_status,
          landing_duration_ms,landed_signature,landed_slot,landed_transaction_index,
          landed_rank,rank_status,error,created_at_ms,updated_at_ms
        ) VALUES (
          @probeId,@episodeId,@shadowId,@candidateProfileId,@candidateCohortStage,
          @mode,@model,@status,@triggerSignature,@chainValidationStatus,
          @triggerAtMs,@measuredAtMs,@triggerToProbeMs,
          @buildDurationUs,@signDurationUs,@serializeDurationUs,@totalLocalDurationUs,
          @payloadBytes,0,@sendStatus,@sendDurationUs,@landingStatus,
          @landingDurationMs,@landedSignature,@landedSlot,@landedTransactionIndex,
          @landedRank,@rankStatus,@error,@createdAtMs,@updatedAtMs
        ) ON CONFLICT(probe_id) DO UPDATE SET
          shadow_id=excluded.shadow_id,status=excluded.status,
          trigger_signature=excluded.trigger_signature,
          chain_validation_status=excluded.chain_validation_status,
          trigger_to_probe_ms=excluded.trigger_to_probe_ms,
          build_duration_us=excluded.build_duration_us,
          sign_duration_us=excluded.sign_duration_us,
          serialize_duration_us=excluded.serialize_duration_us,
          total_local_duration_us=excluded.total_local_duration_us,
          payload_bytes=excluded.payload_bytes,send_status=excluded.send_status,
          landing_status=excluded.landing_status,rank_status=excluded.rank_status,
          error=excluded.error,updated_at_ms=excluded.updated_at_ms
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
      ingestionMode: value(trade.ingestionMode || 'UNKNOWN'),
      rawJson: this.config.storeTradeRawJson ? json(trade) : null,
    });
  }

  recordWatchedWalletTrade(trade) {
    if (trade?.type !== 'ammTrade' || !trade.wallet || !trade.signature) return;
    const eventIndex = number(trade.eventIndex) ?? 0;
    this._enqueue(this.statements.watchedWalletTrade, {
      observationId: `${trade.wallet}:${trade.signature}:${eventIndex}`,
      wallet: trade.wallet,
      receivedAtMs: number(trade.receivedAtMs) || Date.now(),
      chainTimestampMs: number(trade.chainTimestampMs),
      slot: number(trade.slot),
      transactionIndex: number(trade.transactionIndex),
      instructionIndex: number(trade.instructionIndex),
      eventIndex,
      signature: trade.signature,
      orderingConfidence: trade.orderingConfidence || 'SLOT_CORRELATED',
      mint: value(trade.mint), pool: value(trade.pool), side: trade.side,
      solAmount: number(trade.solAmount), tokenAmount: number(trade.tokenAmount),
      price: number(trade.price), reservePrice: number(trade.reservePrice),
      ingestionMode: value(trade.ingestionMode || 'UNKNOWN'),
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
      parseVersion: value(dump.parseVersion || dump.signalTrade?.parseVersion),
      ingestionMode: value(dump.ingestionMode || dump.signalTrade?.ingestionMode || 'UNKNOWN'),
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
      absorptionScore: number(snapshot.absorptionScore),
      absorptionScoreComponentsJson: json(snapshot.absorptionScoreComponents),
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
      absorptionScore: number(snapshot.absorptionScore),
      absorptionScoreComponentsJson: json(snapshot.absorptionScoreComponents),
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
      dataQualityStatus: value(observation.dataQualityStatus) || 'UNASSESSED',
      dataQualityReasonsJson: json(observation.dataQualityReasons),
    });
  }

  _initializeCandidateBaseline() {
    const candidate = this.config.sameSlotCandidate || {};
    if (!candidate.enabled || !candidate.profileId) return;
    const marker = `candidate_baseline:${candidate.profileId}`;
    if (this.db.prepare('SELECT 1 FROM schema_meta WHERE key=?').get(marker)) return;
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO candidate_excluded_mints(
          profile_id,mint,reason,first_seen_at_ms
        )
        SELECT ?,d.mint,'PRE_HOLDOUT_HISTORY',MIN(d.detected_at_ms)
        FROM dump_events d
        WHERE d.mint IS NOT NULL
        GROUP BY d.mint
      `).run(candidate.profileId);
      this.db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?)')
        .run(marker, String(Date.now()));
    })();
  }

  isCandidateMintExcluded(profileId, mint) {
    if (!profileId || !mint) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM candidate_excluded_mints WHERE profile_id=? AND mint=?
    `).get(profileId, mint));
  }

  insertSameSlotShadow(simulation) { this._upsertSameSlotShadow(simulation); }
  updateSameSlotShadow(simulation) { this._upsertSameSlotShadow(simulation); }

  _upsertSameSlotShadow(row) {
    const fields = [
      'shadowId','episodeId','targetRank','entryProfileId','cohortStage',
      'candidateProfileId','candidateCohortStage','candidatePrimary','candidateNovelMint',
      'positionSol',
      'exitHorizonMs','quoteModel',
      'status','rejectionReason','infrastructureMode','infrastructureReason',
      'parseBudgetMs','buildBudgetMs','signBudgetMs','sendBudgetMs','responseBudgetMs',
      'latencyModel','competitorObservedAtMs','competitorReceiveLagMs',
      'competitorReferenceAtMs','competitorGapMs','competitorHeadroomMs',
      'triggerBuySol','triggerBuyToDumpPct','triggerWallet','dataQualityStatus',
      'entryAssumption','entryReferenceRank','entryAtMs','entrySlot',
      'entryReferenceSignature','entryReferenceTransactionIndex',
      'entryReferenceInstructionIndex','entryReferenceEventIndex','entryPrice',
      'entryMarketPrice','entryImpactPct','entryTotalFeeBps','entryLiquidityUsagePct',
      'entryCapacityRoundTripLossPct','entryCapacityExitLiquidityUsagePct','tokenUnits',
      'entryReserveSource','entryFeeSol','exitFeeSol','modeledJitoTipSol',
      'requestedExitAtMs','exitDeadlineAtMs','activeExitTargetAtMs','activeExitDeadlineAtMs',
      'exitPhase','activeRescueHorizonMs','rescueHorizonMs','primaryNoExitReason','exitReason',
      'postHorizonTrades','exitAtMs','exitSlot','exitSignature','exitQuoteLagMs','exitPrice',
      'exitMarketPrice','exitImpactPct','exitTotalFeeBps','exitLiquidityUsagePct',
      'exitReserveSource','proceedsSol','totalCostSol','grossReturnPct','netReturnPct','holdMs',
      'createdAtMs','updatedAtMs',
    ];
    const params = {};
    for (const field of fields) params[field] = value(row[field]);
    params.entryProfileId = row.entryProfileId || 'LEGACY';
    params.cohortStage = row.cohortStage || 'LEGACY';
    params.candidatePrimary = row.candidatePrimary ? 1 : 0;
    params.candidateNovelMint = row.candidateNovelMint == null
      ? null : (row.candidateNovelMint ? 1 : 0);
    params.candidateCriteriaJson = json(row.candidateCriteria);
    params.latencyModel = row.latencyModel || 'LEGACY_DUMP_TO_COMPETITOR';
    params.dataQualityStatus = row.dataQualityStatus || 'UNASSESSED';
    params.dataQualityReasonsJson = json(row.dataQualityReasons);
    params.rescueAttemptedHorizonsJson = json(row.rescueAttemptedHorizons || []);
    params.exitPhase = row.exitPhase || 'PRIMARY';
    params.modeledJitoTipSol = number(row.modeledJitoTipSol) || 0;
    params.infrastructureExecutable = 0;
    params.postHorizonTrades = number(row.postHorizonTrades) || 0;
    params.createdAtMs = number(row.createdAtMs) || Date.now();
    params.updatedAtMs = number(row.updatedAtMs) || params.createdAtMs;
    this._enqueue(this.statements.sameSlotShadow, params);
  }

  upsertExecutionProbe(row) {
    const params = {};
    const fields = [
      'probeId','episodeId','shadowId','candidateProfileId','candidateCohortStage',
      'mode','model','status','triggerSignature','chainValidationStatus',
      'triggerAtMs','measuredAtMs','triggerToProbeMs',
      'buildDurationUs','signDurationUs','serializeDurationUs','totalLocalDurationUs',
      'payloadBytes','sendStatus','sendDurationUs','landingStatus','landingDurationMs',
      'landedSignature','landedSlot','landedTransactionIndex','landedRank','rankStatus',
      'error','createdAtMs','updatedAtMs',
    ];
    for (const field of fields) params[field] = value(row[field]);
    params.createdAtMs = number(row.createdAtMs) || Date.now();
    params.updatedAtMs = number(row.updatedAtMs) || params.createdAtMs;
    this._enqueue(this.statements.executionProbe, params);
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

  summary({ flushPending = true } = {}) {
    if (flushPending) this.flush();
    const acceptedVersion = this.config.acceptedDumpParseVersion;
    const shadowModel = this.config.sameSlotQuoteModel;
    const dataQuality = this.db.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN ? IS NULL OR parse_version=? THEN 1 ELSE 0 END) trusted_version,
        SUM(CASE WHEN ? IS NOT NULL AND COALESCE(parse_version,'')<>? THEN 1 ELSE 0 END)
          excluded_legacy_version,
        SUM(CASE WHEN drop_pct>? THEN 1 ELSE 0 END) excluded_over_max_drop
      FROM dump_events
    `).get(acceptedVersion, acceptedVersion, acceptedVersion, acceptedVersion,
      this.config.maxDumpDropPct);
    const abnormalRecovery = this.db.prepare(`
      SELECT COUNT(*) count FROM dump_events
      WHERE max_recovery_pct>?
        AND (drop_pct IS NULL OR drop_pct<=?)
        AND (? IS NULL OR parse_version=?)
    `).get(this.config.maxReportedRecoveryPct, this.config.maxDumpDropPct,
      acceptedVersion, acceptedVersion);
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
        AVG(max_recovery_pct) average_max_recovery_pct,
        AVG(absorption_score) average_absorption_score
      FROM dump_events
      WHERE (drop_pct IS NULL OR drop_pct<=?)
        AND (? IS NULL OR parse_version=?)
        AND (max_recovery_pct IS NULL OR max_recovery_pct<=?)
    `).get(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const confirmation = this.db.prepare(`
      SELECT COUNT(DISTINCT c.episode_id) recovered,
        COUNT(DISTINCT CASE WHEN c.slot_delta=1 THEN c.episode_id END) next_slot_confirmations,
        COUNT(*) total_confirmations
      FROM confirmations c
      JOIN dump_events d ON d.episode_id=c.episode_id
      WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
    `).get(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const watchedWallet = this.db.prepare(`
      SELECT COUNT(*) observations,
        COUNT(DISTINCT wallet) wallets,
        COUNT(DISTINCT mint) mints,
        SUM(CASE WHEN side='BUY' THEN 1 ELSE 0 END) buys,
        SUM(CASE WHEN side='SELL' THEN 1 ELSE 0 END) sells,
        SUM(CASE WHEN side='BUY' THEN COALESCE(sol_amount,0) ELSE 0 END) buy_sol,
        SUM(CASE WHEN side='SELL' THEN COALESCE(sol_amount,0) ELSE 0 END) sell_sol,
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM dump_events d
          WHERE d.pool=watched_wallet_trades.pool
            AND watched_wallet_trades.received_at_ms BETWEEN d.detected_at_ms-5000
              AND d.detected_at_ms+20000
        ) THEN observation_id END) around_dump_trades,
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM dump_events d
          WHERE d.pool=watched_wallet_trades.pool
            AND watched_wallet_trades.side='BUY'
            AND watched_wallet_trades.slot=d.slot
            AND watched_wallet_trades.received_at_ms>=d.detected_at_ms
        ) THEN observation_id END) same_slot_post_dump_buys,
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM dump_events d
          WHERE d.pool=watched_wallet_trades.pool
            AND watched_wallet_trades.side='BUY'
            AND watched_wallet_trades.slot=d.slot+1
        ) THEN observation_id END) next_slot_post_dump_buys
      FROM watched_wallet_trades
    `).get();
    const confirmationCoverage = this.db.prepare(`
      WITH coverage AS (
        SELECT c.confirmation_id,c.episode_id,
          EXISTS(SELECT 1 FROM simulations s
            WHERE s.confirmation_id=c.confirmation_id) has_simulation
        FROM confirmations c
        JOIN dump_events d ON d.episode_id=c.episode_id
        WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
          AND (? IS NULL OR d.parse_version=?)
          AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
      )
      SELECT COUNT(*) total,
        SUM(has_simulation) with_simulation,
        SUM(CASE WHEN has_simulation=0 THEN 1 ELSE 0 END) without_simulation,
        COUNT(DISTINCT CASE WHEN has_simulation=1 THEN episode_id END) simulated_episodes
      FROM coverage
    `).get(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const sameSlotQuarantined = this.db.prepare(`
      SELECT COUNT(*) count
      FROM same_slot_observations o
      JOIN dump_events d ON d.episode_id=o.episode_id
      WHERE COALESCE(o.data_quality_status,'UNASSESSED')='QUARANTINED'
        AND (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
    `).get(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const sameSlot = this.db.prepare(`
      WITH ranked AS (
        SELECT o.*,CASE WHEN o.classification='STRICT_AFTER_DUMP' THEN
          ROW_NUMBER() OVER (
            PARTITION BY o.episode_id,o.classification
            ORDER BY o.buy_transaction_index,o.instruction_index,o.event_index,o.observation_id
          ) END post_dump_buy_rank
        FROM same_slot_observations o
        JOIN dump_events d ON d.episode_id=o.episode_id
        WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
          AND (? IS NULL OR d.parse_version=?)
          AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
          AND COALESCE(o.data_quality_status,'UNASSESSED')<>'QUARANTINED'
      )
      SELECT COUNT(*) observations,
        SUM(CASE WHEN classification='STRICT_AFTER_DUMP' THEN 1 ELSE 0 END) strict_after_dump,
        SUM(CASE WHEN classification='SLOT_CORRELATED' THEN 1 ELSE 0 END) slot_correlated,
        COUNT(DISTINCT CASE WHEN classification='STRICT_AFTER_DUMP' THEN episode_id END)
          events_with_strict_buy,
        SUM(CASE WHEN post_dump_buy_rank=1 THEN 1 ELSE 0 END) rank_1_buys,
        SUM(CASE WHEN post_dump_buy_rank=2 THEN 1 ELSE 0 END) rank_2_buys,
        COUNT(DISTINCT CASE WHEN post_dump_buy_rank=2 THEN episode_id END) events_with_top_2_buys,
        AVG(receive_lag_ms) average_receive_lag_ms,
        AVG(buy_sol) average_buy_sol,
        SUM(buy_sol) total_buy_sol,
        SUM(executable) executable_signals
      FROM ranked
    `).get(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const sameSlotRankLatency = this.db.prepare(`
      WITH ranked AS (
        SELECT o.episode_id,o.receive_lag_ms,CASE WHEN o.classification='STRICT_AFTER_DUMP' THEN
          ROW_NUMBER() OVER (
            PARTITION BY o.episode_id,o.classification
            ORDER BY o.buy_transaction_index,o.instruction_index,o.event_index,o.observation_id
          ) END post_dump_buy_rank
        FROM same_slot_observations o
        JOIN dump_events d ON d.episode_id=o.episode_id
        WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
          AND (? IS NULL OR d.parse_version=?)
          AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
          AND COALESCE(o.data_quality_status,'UNASSESSED')<>'QUARANTINED'
      )
      SELECT episode_id,post_dump_buy_rank,receive_lag_ms FROM ranked
      WHERE post_dump_buy_rank IN (1,2)
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const rankLatencyByEpisode = new Map();
    for (const row of sameSlotRankLatency) {
      const state = rankLatencyByEpisode.get(row.episode_id) || {};
      state[row.post_dump_buy_rank] = number(row.receive_lag_ms);
      rankLatencyByEpisode.set(row.episode_id, state);
    }
    const rank1LagValues = [...rankLatencyByEpisode.values()]
      .map((row) => row[1]).filter(Number.isFinite);
    const rank2ReceiveLagValues = [...rankLatencyByEpisode.values()]
      .map((row) => row[2]).filter(Number.isFinite);
    const rank2InterBuyGapValues = [...rankLatencyByEpisode.values()]
      .filter((row) => Number.isFinite(row[1]) && Number.isFinite(row[2]))
      .map((row) => row[2] - row[1]);
    const sameSlotShadowCounts = this.db.prepare(`
      SELECT SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN 1 ELSE 0 END) scheduled,
        SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          AND s.status<>'NO_ENTRY' THEN 1 ELSE 0 END) entry_filled,
        SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          AND s.status='CLOSED' THEN 1 ELSE 0 END) exit_filled,
        SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          AND s.status='NO_ENTRY' THEN 1 ELSE 0 END) no_entry,
        SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          AND s.status='NO_EXIT' THEN 1 ELSE 0 END) no_exit,
        SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')='QUARANTINED'
          THEN 1 ELSE 0 END) quarantined,
        SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          AND s.status='NO_ENTRY'
          AND s.rejection_reason='INSUFFICIENT_ROUND_TRIP_LIQUIDITY' THEN 1 ELSE 0 END)
          insufficient_round_trip_liquidity,
        SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          AND s.status='NO_ENTRY'
          AND s.rejection_reason='ROUND_TRIP_COST_TOO_HIGH' THEN 1 ELSE 0 END)
          round_trip_cost_too_high,
        COUNT(DISTINCT CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END) episodes,
        COUNT(DISTINCT CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN d.mint END) mints,
        COUNT(DISTINCT CASE WHEN s.target_rank=1
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END) rank_1_episodes,
        COUNT(DISTINCT CASE WHEN s.target_rank=2
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END) rank_2_episodes,
        COUNT(DISTINCT CASE WHEN s.entry_profile_id=?
          AND s.cohort_stage=?
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END) primary_profile_episodes,
        COUNT(DISTINCT CASE WHEN s.entry_profile_id=?
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END) primary_profile_all_episodes,
        COUNT(DISTINCT CASE WHEN s.target_rank=2 AND s.competitor_gap_ms IS NOT NULL
          AND s.competitor_gap_ms>s.response_budget_ms
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END)
          rank_2_positive_headroom,
        COUNT(DISTINCT CASE WHEN s.target_rank=2 AND s.competitor_gap_ms IS NOT NULL
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END) rank_2_headroom_samples,
        COUNT(DISTINCT CASE WHEN s.entry_profile_id=? AND s.cohort_stage=?
          AND s.competitor_gap_ms IS NOT NULL
          AND s.competitor_gap_ms>s.response_budget_ms
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END)
          primary_positive_headroom,
        COUNT(DISTINCT CASE WHEN s.entry_profile_id=? AND s.cohort_stage=?
          AND s.competitor_gap_ms IS NOT NULL
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.episode_id END)
          primary_headroom_samples,
        SUM(CASE WHEN s.status='CLOSED' AND s.exit_reason LIKE 'RESCUE_%'
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED' THEN 1 ELSE 0 END)
          rescue_exit_filled,
        SUM(CASE WHEN s.status='CLOSED' AND s.rescue_horizon_ms=5000
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED' THEN 1 ELSE 0 END)
          rescue_5s_filled,
        SUM(CASE WHEN s.status='CLOSED' AND s.rescue_horizon_ms=10000
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED' THEN 1 ELSE 0 END)
          rescue_10s_filled,
        SUM(CASE WHEN s.status='NO_EXIT' AND s.exit_reason='RESCUE_EXHAUSTED'
          AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED' THEN 1 ELSE 0 END)
          rescue_unresolved,
        MIN(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.created_at_ms END) first_created_at_ms,
        MAX(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
          THEN s.updated_at_ms END) last_updated_at_ms
      FROM same_slot_shadow_simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
        AND (? IS NULL OR s.quote_model=?)
    `).get(this.config.sameSlotPrimaryProfileId, this.config.sameSlotPrimaryCohortStage,
      this.config.sameSlotPrimaryProfileId,
      this.config.sameSlotPrimaryProfileId, this.config.sameSlotPrimaryCohortStage,
      this.config.sameSlotPrimaryProfileId, this.config.sameSlotPrimaryCohortStage,
      this.config.maxDumpDropPct,
      acceptedVersion, acceptedVersion, this.config.maxReportedRecoveryPct,
      shadowModel, shadowModel);
    const sameSlotPrimaryCounts = this.db.prepare(`
      SELECT COUNT(DISTINCT d.mint) primary_profile_mints,
        COUNT(DISTINCT CASE WHEN s.status='CLOSED' AND s.exit_reason='PRIMARY'
          THEN s.episode_id END) primary_exit_episodes,
        COUNT(DISTINCT CASE WHEN s.status='CLOSED' AND s.rescue_horizon_ms=5000
          THEN s.episode_id END) rescue_5s_episodes,
        COUNT(DISTINCT CASE WHEN s.status='CLOSED' AND s.rescue_horizon_ms=10000
          THEN s.episode_id END) rescue_10s_episodes,
        COUNT(DISTINCT CASE WHEN s.status='NO_EXIT'
          THEN s.episode_id END) no_exit_episodes
      FROM same_slot_shadow_simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE s.entry_profile_id=? AND s.cohort_stage=?
        AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
        AND (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
        AND (? IS NULL OR s.quote_model=?)
    `).get(this.config.sameSlotPrimaryProfileId, this.config.sameSlotPrimaryCohortStage,
      this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct, shadowModel, shadowModel);
    const sameSlotShadowReturns = this.db.prepare(`
      SELECT s.episode_id episodeId,s.position_sol,s.modeled_jito_tip_sol,s.net_return_pct
      FROM same_slot_shadow_simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE s.status='CLOSED' AND (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
        AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
        AND (? IS NULL OR s.quote_model=?)
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct, shadowModel, shadowModel);
    const simulationCounts = this.db.prepare(`
      SELECT COUNT(*) scheduled,
        SUM(CASE WHEN s.entry_at_ms IS NOT NULL THEN 1 ELSE 0 END) entry_filled,
        SUM(CASE WHEN s.status='CLOSED' THEN 1 ELSE 0 END) exit_filled,
        SUM(CASE WHEN s.status='NO_ENTRY' THEN 1 ELSE 0 END) no_entry,
        SUM(CASE WHEN s.status='NO_EXIT' THEN 1 ELSE 0 END) no_exit,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='RECOVERY_INVALIDATED_BEFORE_ENTRY' THEN 1 ELSE 0 END)
          invalidated_before_entry,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='INSUFFICIENT_ROUND_TRIP_LIQUIDITY' THEN 1 ELSE 0 END)
          insufficient_round_trip_liquidity,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='ROUND_TRIP_COST_TOO_HIGH' THEN 1 ELSE 0 END)
          round_trip_cost_too_high,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='NO_CAUSAL_ENTRY_QUOTE' THEN 1 ELSE 0 END)
          no_causal_entry_quote
      FROM simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
    `).get(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const returns = this.db.prepare(`
      SELECT s.episode_id episodeId,s.net_return_pct
      FROM simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE s.status='CLOSED'
        AND (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const eligibleDumps = Math.max(0, dump.independent - (dump.toxic_rejected || 0));
    const candidateSummary = this.sameSlotCandidateSummary();
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
        averageAbsorptionScore: dump.average_absorption_score,
        abnormalRecoveryEvents: abnormalRecovery.count || 0,
        totalStoredEvents: dataQuality.total || 0,
        trustedVersionEvents: dataQuality.trusted_version || 0,
        excludedLegacyPriceEvents: dataQuality.excluded_legacy_version || 0,
        excludedOverMaxDropEvents: dataQuality.excluded_over_max_drop || 0,
      },
      walletResearch: {
        observations: watchedWallet.observations || 0,
        wallets: watchedWallet.wallets || 0,
        mints: watchedWallet.mints || 0,
        buys: watchedWallet.buys || 0,
        sells: watchedWallet.sells || 0,
        buySol: watchedWallet.buy_sol || 0,
        sellSol: watchedWallet.sell_sol || 0,
        aroundDumpTrades: watchedWallet.around_dump_trades || 0,
        sameSlotPostDumpBuys: watchedWallet.same_slot_post_dump_buys || 0,
        nextSlotPostDumpBuys: watchedWallet.next_slot_post_dump_buys || 0,
      },
      sameSlotProbe: {
        observations: sameSlot.observations || 0,
        strictAfterDumpBuys: sameSlot.strict_after_dump || 0,
        slotCorrelatedBuys: sameSlot.slot_correlated || 0,
        eventsWithStrictBuy: sameSlot.events_with_strict_buy || 0,
        rank1Buys: sameSlot.rank_1_buys || 0,
        rank2Buys: sameSlot.rank_2_buys || 0,
        eventsWithTop2Buys: sameSlot.events_with_top_2_buys || 0,
        rank1ReceiveLagP50Ms: percentile(rank1LagValues, 0.5),
        rank1ReceiveLagP95Ms: percentile(rank1LagValues, 0.95),
        rank2ReceiveLagP50Ms: percentile(rank2ReceiveLagValues, 0.5),
        rank2ReceiveLagP95Ms: percentile(rank2ReceiveLagValues, 0.95),
        rank2InterBuyGapP50Ms: percentile(rank2InterBuyGapValues, 0.5),
        rank2InterBuyGapP95Ms: percentile(rank2InterBuyGapValues, 0.95),
        eventRatePct: dump.independent
          ? (sameSlot.events_with_strict_buy || 0) / dump.independent * 100 : null,
        averageReceiveLagMs: sameSlot.average_receive_lag_ms,
        averageBuySol: sameSlot.average_buy_sol,
        totalBuySol: sameSlot.total_buy_sol || 0,
        dataQualityQuarantined: sameSlotQuarantined.count || 0,
        executableSignals: sameSlot.executable_signals || 0,
        executionEnabled: false,
      },
      sameSlotShadow: {
        scheduled: sameSlotShadowCounts.scheduled || 0,
        entryFilled: sameSlotShadowCounts.entry_filled || 0,
        exitFilled: sameSlotShadowCounts.exit_filled || 0,
        noEntry: sameSlotShadowCounts.no_entry || 0,
        noExit: sameSlotShadowCounts.no_exit || 0,
        dataQualityQuarantined: sameSlotShadowCounts.quarantined || 0,
        insufficientRoundTripLiquidity:
          sameSlotShadowCounts.insufficient_round_trip_liquidity || 0,
        roundTripCostTooHigh: sameSlotShadowCounts.round_trip_cost_too_high || 0,
        episodes: sameSlotShadowCounts.episodes || 0,
        mints: sameSlotShadowCounts.mints || 0,
        rank1Episodes: sameSlotShadowCounts.rank_1_episodes || 0,
        rank2Episodes: sameSlotShadowCounts.rank_2_episodes || 0,
        primaryProfileId: this.config.sameSlotPrimaryProfileId,
        primaryCohortStage: this.config.sameSlotPrimaryCohortStage,
        primaryProfileEpisodes: sameSlotShadowCounts.primary_profile_episodes || 0,
        primaryProfileAllEpisodes: sameSlotShadowCounts.primary_profile_all_episodes || 0,
        primaryProfileMints: sameSlotPrimaryCounts.primary_profile_mints || 0,
        primaryExitEpisodes: sameSlotPrimaryCounts.primary_exit_episodes || 0,
        primaryRescue5sEpisodes: sameSlotPrimaryCounts.rescue_5s_episodes || 0,
        primaryRescue10sEpisodes: sameSlotPrimaryCounts.rescue_10s_episodes || 0,
        primaryNoExitEpisodes: sameSlotPrimaryCounts.no_exit_episodes || 0,
        rank2PositiveHeadroomPct: sameSlotShadowCounts.rank_2_headroom_samples
          ? sameSlotShadowCounts.rank_2_positive_headroom
            / sameSlotShadowCounts.rank_2_headroom_samples * 100 : null,
        rank2HeadroomSamples: sameSlotShadowCounts.rank_2_headroom_samples || 0,
        primaryPositiveHeadroomPctObserved: sameSlotShadowCounts.primary_headroom_samples
          ? sameSlotShadowCounts.primary_positive_headroom
            / sameSlotShadowCounts.primary_headroom_samples * 100 : null,
        primaryPositiveHeadroomPctOfEpisodes: sameSlotShadowCounts.primary_profile_episodes
          ? sameSlotShadowCounts.primary_positive_headroom
            / sameSlotShadowCounts.primary_profile_episodes * 100 : null,
        primaryPositiveHeadroom: sameSlotShadowCounts.primary_positive_headroom || 0,
        primaryHeadroomSamples: sameSlotShadowCounts.primary_headroom_samples || 0,
        rescueExitFilled: sameSlotShadowCounts.rescue_exit_filled || 0,
        rescue5sFilled: sameSlotShadowCounts.rescue_5s_filled || 0,
        rescue10sFilled: sameSlotShadowCounts.rescue_10s_filled || 0,
        rescueUnresolved: sameSlotShadowCounts.rescue_unresolved || 0,
        coverageHours: sameSlotShadowCounts.first_created_at_ms != null
          && sameSlotShadowCounts.last_updated_at_ms != null
          ? (sameSlotShadowCounts.last_updated_at_ms
            - sameSlotShadowCounts.first_created_at_ms) / 3_600_000 : null,
        entryFillRatePct: sameSlotShadowCounts.scheduled
          ? sameSlotShadowCounts.entry_filled / sameSlotShadowCounts.scheduled * 100 : null,
        exitFillRatePct: sameSlotShadowCounts.entry_filled
          ? sameSlotShadowCounts.exit_filled / sameSlotShadowCounts.entry_filled * 100 : null,
        noExitRatePct: sameSlotShadowCounts.entry_filled
          ? sameSlotShadowCounts.no_exit / sameSlotShadowCounts.entry_filled * 100 : null,
        infrastructureExecutable: false,
        ...returnStats(sameSlotShadowReturns),
        ...eventConcentrationStats(sameSlotShadowReturns),
        ...shadowScenarioStats({
          closedRows: sameSlotShadowReturns,
          noExit: sameSlotShadowCounts.no_exit || 0,
          noExitLossPcts: this.config.sameSlotNoExitScenarioLossPcts,
          jitoTipScenariosSol: this.config.sameSlotJitoTipScenariosSol,
        }),
      },
      sameSlotCandidate: candidateSummary,
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
      sameSlotShadowCohorts: this.sameSlotShadowCohorts(),
      store: this.health(),
    };
  }

  sameSlotCandidateSummary() {
    const candidate = this.config.sameSlotCandidate || {};
    if (!candidate.enabled || !candidate.profileId) {
      return { enabled: false, tradingEnabled: false, status: 'DISABLED' };
    }
    const acceptedVersion = this.config.acceptedDumpParseVersion;
    const rows = this.db.prepare(`
      SELECT s.episode_id episodeId,d.mint,s.status,s.exit_reason exitReason,
        s.position_sol positionSol,s.modeled_jito_tip_sol modeledJitoTipSol,
        s.net_return_pct netReturnPct
      FROM same_slot_shadow_simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE s.candidate_profile_id=? AND s.candidate_cohort_stage=?
        AND s.candidate_primary=1 AND s.candidate_novel_mint=1
        AND s.position_sol=? AND s.exit_horizon_ms=?
        AND COALESCE(s.data_quality_status,'UNASSESSED')='TRUSTED'
        AND (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
    `).all(candidate.profileId, candidate.cohortStage, candidate.primaryPositionSol,
      candidate.primaryExitHorizonMs, this.config.maxDumpDropPct,
      acceptedVersion, acceptedVersion);
    const terminal = rows.filter((row) => ['CLOSED', 'NO_EXIT', 'NO_ENTRY'].includes(row.status));
    const enteredTerminal = terminal.filter((row) => ['CLOSED', 'NO_EXIT'].includes(row.status));
    const scenarioValue = (row, quickOnly) => {
      const modeledTip = Math.max(0, number(row.modeledJitoTipSol) || 0);
      const position = number(row.positionSol);
      const extraJitoPct = position > 0
        ? (candidate.jitoTipSol - modeledTip) * 2 / position * 100 : 0;
      const closed = row.status === 'CLOSED' && (!quickOnly || row.exitReason === 'PRIMARY');
      return closed ? number(row.netReturnPct) - extraJitoPct
        : candidate.noExitLossPct - extraJitoPct;
    };
    const fullLoss = numericScenarioStats(enteredTerminal.map((row) => scenarioValue(row, false)));
    const quickFullLoss = numericScenarioStats(
      enteredTerminal.map((row) => scenarioValue(row, true)),
    );
    const episodes = new Set(rows.map((row) => row.episodeId)).size;
    const mints = new Set(rows.map((row) => row.mint)).size;
    const terminalPct = rows.length ? terminal.length / rows.length * 100 : null;
    const probes = this.db.prepare(`
      SELECT COUNT(*) measured,
        AVG(build_duration_us) average_build_us,
        AVG(sign_duration_us) average_sign_us,
        AVG(serialize_duration_us) average_serialize_us,
        AVG(total_local_duration_us) average_total_local_us,
        AVG(trigger_to_probe_ms) average_trigger_to_probe_ms,
        SUM(CASE WHEN chain_validation_status='MATCHED_FINAL_CHAIN_RANK_1'
          THEN 1 ELSE 0 END) chain_validated,
        SUM(CASE WHEN chain_validation_status='TRIGGER_WAS_NOT_FINAL_CHAIN_RANK_1'
          THEN 1 ELSE 0 END) chain_rejected,
        SUM(CASE WHEN send_status='DISABLED' THEN 1 ELSE 0 END) send_disabled,
        SUM(CASE WHEN landing_status='NOT_SENT' THEN 1 ELSE 0 END) not_sent
      FROM execution_probes WHERE candidate_profile_id=?
    `).get(candidate.profileId);
    const excludedHistoricalMints = this.db.prepare(`
      SELECT COUNT(*) count FROM candidate_excluded_mints WHERE profile_id=?
    `).get(candidate.profileId)?.count || 0;
    const gates = [
      { id: 'NEW_CANDIDATE_EPISODES', actual: episodes, required: candidate.minimumEpisodes,
        passed: episodes >= candidate.minimumEpisodes },
      { id: 'NEW_CANDIDATE_MINTS', actual: mints, required: candidate.minimumMints,
        passed: mints >= candidate.minimumMints },
      { id: 'TERMINAL_ROWS_PCT', actual: terminalPct, required: 95,
        passed: (terminalPct || 0) >= 95 },
      { id: 'NO_EXIT_FULL_LOSS_PROFIT_FACTOR', actual: fullLoss.profitFactor,
        required: candidate.minimumFullLossProfitFactor,
        passed: (fullLoss.profitFactor || 0) >= candidate.minimumFullLossProfitFactor },
    ];
    return {
      enabled: true,
      tradingEnabled: false,
      profileId: candidate.profileId,
      cohortStage: candidate.cohortStage,
      primaryCombination: `${candidate.primaryPositionSol} SOL / ${candidate.primaryExitHorizonMs}ms`,
      criteria: candidate,
      episodes,
      mints,
      rows: rows.length,
      terminalRows: terminal.length,
      terminalRowsPct: terminalPct,
      primaryClosed: terminal.filter((row) => row.status === 'CLOSED'
        && row.exitReason === 'PRIMARY').length,
      rescueClosed: terminal.filter((row) => row.status === 'CLOSED'
        && row.exitReason !== 'PRIMARY').length,
      noEntry: terminal.filter((row) => row.status === 'NO_ENTRY').length,
      noExit: terminal.filter((row) => row.status === 'NO_EXIT').length,
      excludedHistoricalMints,
      fullLoss,
      quickFullLoss,
      executionProbe: {
        measured: probes.measured || 0,
        averageBuildUs: probes.average_build_us,
        averageSignUs: probes.average_sign_us,
        averageSerializeUs: probes.average_serialize_us,
        averageTotalLocalUs: probes.average_total_local_us,
        averageTriggerToProbeMs: probes.average_trigger_to_probe_ms,
        chainValidated: probes.chain_validated || 0,
        chainRejected: probes.chain_rejected || 0,
        sendDisabled: probes.send_disabled || 0,
        notSent: probes.not_sent || 0,
        realLandingSamples: 0,
        realRankSamples: 0,
      },
      gates,
      status: gates.every((gate) => gate.passed)
        ? 'READY_FOR_EXECUTION_REVIEW' : 'COLLECT_MORE_DATA',
      liveTradingDecision: 'TRADING_DISABLED',
    };
  }

  cohorts() {
    const acceptedVersion = this.config.acceptedDumpParseVersion;
    const groups = this.db.prepare(`
      SELECT s.quote_model,s.recovery_profile_id,s.entry_variant_id,s.position_sol,
        s.exit_profile_id,
        COUNT(*) scheduled,
        SUM(CASE WHEN s.entry_at_ms IS NOT NULL THEN 1 ELSE 0 END) entry_filled,
        SUM(CASE WHEN s.status='CLOSED' THEN 1 ELSE 0 END) exit_filled,
        SUM(CASE WHEN s.status='NO_EXIT' THEN 1 ELSE 0 END) no_exit,
        SUM(CASE WHEN s.status='NO_EXIT' AND s.rejection_reason='NO_CAUSAL_EXIT_QUOTE'
          THEN 1 ELSE 0 END) no_exit_quote,
        SUM(CASE WHEN s.status='NO_EXIT'
          AND s.rejection_reason='NO_TRADE_AT_OR_AFTER_EXIT_HORIZON'
          THEN 1 ELSE 0 END) no_trade_after_horizon,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='RECOVERY_INVALIDATED_BEFORE_ENTRY'
          THEN 1 ELSE 0 END) invalidated_before_entry,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='INSUFFICIENT_ROUND_TRIP_LIQUIDITY'
          THEN 1 ELSE 0 END) insufficient_round_trip_liquidity,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='ROUND_TRIP_COST_TOO_HIGH'
          THEN 1 ELSE 0 END) round_trip_cost_too_high,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='NO_CAUSAL_ENTRY_QUOTE'
          THEN 1 ELSE 0 END) no_causal_entry_quote
      FROM simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
      GROUP BY s.quote_model,s.recovery_profile_id,s.entry_variant_id,s.position_sol,
        s.exit_profile_id
      ORDER BY s.quote_model,s.recovery_profile_id,s.entry_variant_id,s.position_sol,
        s.exit_profile_id
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
    const returns = this.db.prepare(`
      SELECT s.episode_id episodeId,s.quote_model,s.recovery_profile_id,s.entry_variant_id,
        s.position_sol,s.exit_profile_id,s.net_return_pct
      FROM simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE s.status='CLOSED'
        AND (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct);
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

  sameSlotShadowCohorts() {
    const acceptedVersion = this.config.acceptedDumpParseVersion;
    const shadowModel = this.config.sameSlotQuoteModel;
    const groups = this.db.prepare(`
      SELECT s.quote_model,s.target_rank,s.entry_profile_id,s.cohort_stage,
        s.candidate_profile_id,s.candidate_cohort_stage,s.candidate_primary,
        s.position_sol,s.exit_horizon_ms,
        AVG(s.trigger_buy_sol) average_trigger_buy_sol,
        AVG(s.trigger_buy_to_dump_pct) average_trigger_buy_to_dump_pct,
        AVG(s.modeled_jito_tip_sol) modeled_jito_tip_sol,
        COUNT(*) scheduled,
        SUM(CASE WHEN s.status<>'NO_ENTRY' THEN 1 ELSE 0 END) entry_filled,
        SUM(CASE WHEN s.status='CLOSED' THEN 1 ELSE 0 END) exit_filled,
        SUM(CASE WHEN s.status='CLOSED' AND s.exit_reason='PRIMARY'
          THEN 1 ELSE 0 END) primary_exit_filled,
        SUM(CASE WHEN s.status='NO_ENTRY' THEN 1 ELSE 0 END) no_entry,
        SUM(CASE WHEN s.status='NO_EXIT' THEN 1 ELSE 0 END) no_exit,
        SUM(CASE WHEN s.status='NO_EXIT'
          AND s.rejection_reason='NO_CAUSAL_EXIT_QUOTE' THEN 1 ELSE 0 END) no_exit_quote,
        SUM(CASE WHEN s.status='NO_EXIT'
          AND s.rejection_reason='NO_TRADE_AT_OR_AFTER_EXIT_HORIZON' THEN 1 ELSE 0 END)
          no_trade_after_horizon,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='INSUFFICIENT_ROUND_TRIP_LIQUIDITY' THEN 1 ELSE 0 END)
          insufficient_round_trip_liquidity,
        SUM(CASE WHEN s.status='NO_ENTRY'
          AND s.rejection_reason='ROUND_TRIP_COST_TOO_HIGH' THEN 1 ELSE 0 END)
          round_trip_cost_too_high,
        SUM(CASE WHEN s.status='CLOSED' AND s.exit_reason LIKE 'RESCUE_%'
          THEN 1 ELSE 0 END) rescue_exit_filled,
        SUM(CASE WHEN s.status='CLOSED' AND s.rescue_horizon_ms=5000
          THEN 1 ELSE 0 END) rescue_5s_filled,
        SUM(CASE WHEN s.status='CLOSED' AND s.rescue_horizon_ms=10000
          THEN 1 ELSE 0 END) rescue_10s_filled,
        SUM(CASE WHEN s.status='NO_EXIT' AND s.exit_reason='RESCUE_EXHAUSTED'
          THEN 1 ELSE 0 END) rescue_unresolved
      FROM same_slot_shadow_simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
        AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
        AND (? IS NULL OR s.quote_model=?)
      GROUP BY s.quote_model,s.target_rank,s.entry_profile_id,s.cohort_stage,
        s.candidate_profile_id,s.candidate_cohort_stage,s.candidate_primary,
        s.position_sol,s.exit_horizon_ms
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct, shadowModel, shadowModel);
    const returns = this.db.prepare(`
      SELECT s.episode_id episodeId,s.quote_model,s.target_rank,s.entry_profile_id,s.cohort_stage,
        s.candidate_profile_id,s.candidate_cohort_stage,s.candidate_primary,
        s.position_sol,s.exit_horizon_ms,s.modeled_jito_tip_sol,s.net_return_pct,
        s.exit_reason,s.hold_ms
      FROM same_slot_shadow_simulations s
      JOIN dump_events d ON d.episode_id=s.episode_id
      WHERE s.status='CLOSED' AND (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND (d.max_recovery_pct IS NULL OR d.max_recovery_pct<=?)
        AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
        AND (? IS NULL OR s.quote_model=?)
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      this.config.maxReportedRecoveryPct, shadowModel, shadowModel);
    return groups.map((group) => {
      const rows = returns.filter((row) => row.quote_model === group.quote_model
        && row.target_rank === group.target_rank
        && row.entry_profile_id === group.entry_profile_id
        && row.cohort_stage === group.cohort_stage
        && row.candidate_profile_id === group.candidate_profile_id
        && row.candidate_cohort_stage === group.candidate_cohort_stage
        && row.candidate_primary === group.candidate_primary
        && row.position_sol === group.position_sol
        && row.exit_horizon_ms === group.exit_horizon_ms);
      const primaryRows = rows.filter((row) => row.exit_reason === 'PRIMARY');
      const primaryHoldValues = primaryRows.map((row) => number(row.hold_ms))
        .filter(Number.isFinite);
      const quickExitScenarios = shadowScenarioStats({
        closedRows: primaryRows,
        noExit: Math.max(0, (group.entry_filled || 0) - primaryRows.length),
        noExitLossPcts: this.config.sameSlotNoExitScenarioLossPcts,
        jitoTipScenariosSol: this.config.sameSlotJitoTipScenariosSol,
        positionSol: group.position_sol,
        modeledTipSol: group.modeled_jito_tip_sol,
      });
      return {
        quoteModel: group.quote_model,
        targetRank: group.target_rank,
        entryProfileId: group.entry_profile_id,
        cohortStage: group.cohort_stage,
        candidateProfileId: group.candidate_profile_id,
        candidateCohortStage: group.candidate_cohort_stage,
        candidatePrimary: Boolean(group.candidate_primary),
        positionSol: group.position_sol,
        exitHorizonMs: group.exit_horizon_ms,
        averageTriggerBuySol: group.average_trigger_buy_sol,
        averageTriggerBuyToDumpPct: group.average_trigger_buy_to_dump_pct,
        scheduled: group.scheduled,
        entryFillRatePct: group.scheduled ? group.entry_filled / group.scheduled * 100 : null,
        exitFillRatePct: group.entry_filled ? group.exit_filled / group.entry_filled * 100 : null,
        primaryExitFilled: group.primary_exit_filled || 0,
        primaryExitFillRatePct: group.entry_filled
          ? (group.primary_exit_filled || 0) / group.entry_filled * 100 : null,
        primaryHoldP50Ms: percentile(primaryHoldValues, 0.5),
        primaryHoldP95Ms: percentile(primaryHoldValues, 0.95),
        noEntry: group.no_entry || 0,
        noExit: group.no_exit || 0,
        noExitRatePct: group.entry_filled ? group.no_exit / group.entry_filled * 100 : null,
        noExitQuote: group.no_exit_quote || 0,
        noTradeAfterHorizon: group.no_trade_after_horizon || 0,
        noExitOther: Math.max(0, (group.no_exit || 0) - (group.no_exit_quote || 0)
          - (group.no_trade_after_horizon || 0)),
        insufficientRoundTripLiquidity: group.insufficient_round_trip_liquidity || 0,
        roundTripCostTooHigh: group.round_trip_cost_too_high || 0,
        rescueExitFilled: group.rescue_exit_filled || 0,
        rescue5sFilled: group.rescue_5s_filled || 0,
        rescue10sFilled: group.rescue_10s_filled || 0,
        rescueUnresolved: group.rescue_unresolved || 0,
        quickExitCombinedScenarios: quickExitScenarios.combinedScenarios,
        infrastructureExecutable: false,
        ...returnStats(rows),
        ...eventConcentrationStats(rows),
        ...shadowScenarioStats({
          closedRows: rows,
          noExit: group.no_exit || 0,
          noExitLossPcts: this.config.sameSlotNoExitScenarioLossPcts,
          jitoTipScenariosSol: this.config.sameSlotJitoTipScenariosSol,
          positionSol: group.position_sol,
          modeledTipSol: group.modeled_jito_tip_sol,
        }),
      };
    }).sort(compareCohortPerformance);
  }

  recentDumps(limit = 100, { flushPending = true } = {}) {
    if (flushPending) this.flush();
    const acceptedVersion = this.config.acceptedDumpParseVersion;
    return this.db.prepare(`
      SELECT * FROM dump_events
      WHERE (drop_pct IS NULL OR drop_pct<=?)
        AND (? IS NULL OR parse_version=?)
      ORDER BY detected_at_ms DESC LIMIT ?
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      Math.max(1, Math.min(1_000, Math.trunc(limit))));
  }

  recentDumpsPage(page = 1, pageSize = 20, { flushPending = true } = {}) {
    if (flushPending) this.flush();
    const acceptedVersion = this.config.acceptedDumpParseVersion;
    const normalizedSize = Math.max(1, Math.min(100, Math.trunc(pageSize) || 20));
    const total = this.db.prepare(`
      SELECT COUNT(*) count FROM dump_events
      WHERE (drop_pct IS NULL OR drop_pct<=?)
        AND (? IS NULL OR parse_version=?)
    `).get(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion).count;
    const totalPages = Math.max(1, Math.ceil(total / normalizedSize));
    const normalizedPage = Math.max(1, Math.min(totalPages, Math.trunc(page) || 1));
    const items = this.db.prepare(`
      SELECT * FROM dump_events
      WHERE (drop_pct IS NULL OR drop_pct<=?)
        AND (? IS NULL OR parse_version=?)
      ORDER BY detected_at_ms DESC LIMIT ? OFFSET ?
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      normalizedSize, (normalizedPage - 1) * normalizedSize);
    return {
      items,
      page: normalizedPage,
      pageSize: normalizedSize,
      total,
      totalPages,
    };
  }

  recentSimulations(limit = 100, { flushPending = true } = {}) {
    if (flushPending) this.flush();
    return this.db.prepare(`SELECT * FROM simulations ORDER BY updated_at_ms DESC LIMIT ?`)
      .all(Math.max(1, Math.min(1_000, Math.trunc(limit))));
  }

  recentSameSlotObservations(limit = 100, { flushPending = true } = {}) {
    if (flushPending) this.flush();
    const acceptedVersion = this.config.acceptedDumpParseVersion;
    return this.db.prepare(`
      WITH ranked AS (
        SELECT o.*,CASE WHEN o.classification='STRICT_AFTER_DUMP' THEN
          ROW_NUMBER() OVER (
            PARTITION BY o.episode_id,o.classification
            ORDER BY o.buy_transaction_index,o.instruction_index,o.event_index,o.observation_id
          ) END post_dump_buy_rank
        FROM same_slot_observations o
        JOIN dump_events d ON d.episode_id=o.episode_id
        WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
          AND (? IS NULL OR d.parse_version=?)
          AND COALESCE(o.data_quality_status,'UNASSESSED')<>'QUARANTINED'
      )
      SELECT * FROM ranked ORDER BY observed_at_ms DESC LIMIT ?
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion,
      Math.max(1, Math.min(1_000, Math.trunc(limit))));
  }

  recentWatchedWalletTradesPage(page = 1, pageSize = 20, { flushPending = true } = {}) {
    if (flushPending) this.flush();
    const normalizedSize = Math.max(1, Math.min(100, Math.trunc(pageSize) || 20));
    const total = this.db.prepare('SELECT COUNT(*) count FROM watched_wallet_trades').get().count;
    const totalPages = Math.max(1, Math.ceil(total / normalizedSize));
    const normalizedPage = Math.max(1, Math.min(totalPages, Math.trunc(page) || 1));
    const items = this.db.prepare(`
      SELECT * FROM watched_wallet_trades
      ORDER BY received_at_ms DESC LIMIT ? OFFSET ?
    `).all(normalizedSize, (normalizedPage - 1) * normalizedSize);
    return {
      items,
      page: normalizedPage,
      pageSize: normalizedSize,
      total,
      totalPages,
    };
  }

  recentSameSlotObservationsPage(page = 1, pageSize = 20, { flushPending = true } = {}) {
    if (flushPending) this.flush();
    const acceptedVersion = this.config.acceptedDumpParseVersion;
    const normalizedSize = Math.max(1, Math.min(100, Math.trunc(pageSize) || 20));
    const total = this.db.prepare(`
      SELECT COUNT(*) count
      FROM same_slot_observations o
      JOIN dump_events d ON d.episode_id=o.episode_id
      WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
        AND (? IS NULL OR d.parse_version=?)
        AND COALESCE(o.data_quality_status,'UNASSESSED')<>'QUARANTINED'
    `).get(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion).count;
    const totalPages = Math.max(1, Math.ceil(total / normalizedSize));
    const normalizedPage = Math.max(1, Math.min(totalPages, Math.trunc(page) || 1));
    const items = this.db.prepare(`
      WITH ranked AS (
        SELECT o.*,CASE WHEN o.classification='STRICT_AFTER_DUMP' THEN
          ROW_NUMBER() OVER (
            PARTITION BY o.episode_id,o.classification
            ORDER BY o.buy_transaction_index,o.instruction_index,o.event_index,o.observation_id
          ) END post_dump_buy_rank
        FROM same_slot_observations o
        JOIN dump_events d ON d.episode_id=o.episode_id
        WHERE (d.drop_pct IS NULL OR d.drop_pct<=?)
          AND (? IS NULL OR d.parse_version=?)
          AND COALESCE(o.data_quality_status,'UNASSESSED')<>'QUARANTINED'
      )
      SELECT * FROM ranked ORDER BY observed_at_ms DESC LIMIT ? OFFSET ?
    `).all(this.config.maxDumpDropPct, acceptedVersion, acceptedVersion, normalizedSize,
      (normalizedPage - 1) * normalizedSize);
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
  shadowScenarioStats,
};
