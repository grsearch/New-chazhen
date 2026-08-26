'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PUMP_PARSE_VERSION } = require('../src/core/PumpEventParser');

const MAX_DUMP_DROP_PCT = Number(process.env.SDBR_MAX_DUMP_DROP_PCT || 40);
const CANDIDATE_PROFILE_ID = 'R2-B10-Q500-V1';
const CANDIDATE_COHORT_STAGE = 'HOLDOUT_B10_Q500_V1';
const CANDIDATE_PRIMARY_POSITION_SOL = 1;
const CANDIDATE_PRIMARY_EXIT_HORIZON_MS = 250;

const EXPLICIT_FILTERS = Object.freeze({
  trades: {
    where: 'received_at_ms >= ? AND received_at_ms < ?',
    bind: (startMs, endMs) => [startMs, endMs],
  },
  slot_summaries: {
    where: 'last_received_at_ms >= ? AND last_received_at_ms < ?',
    bind: (startMs, endMs) => [startMs, endMs],
  },
  dump_events: {
    where: `detected_at_ms >= ? AND detected_at_ms < ?
      AND (drop_pct IS NULL OR drop_pct <= ?) AND parse_version = ?`,
    bind: (startMs, endMs) => [startMs, endMs, MAX_DUMP_DROP_PCT, PUMP_PARSE_VERSION],
  },
  confirmations: {
    where: 'episode_id IN (SELECT episode_id FROM main.dump_events)',
    bind: () => [],
  },
  same_slot_observations: {
    where: 'episode_id IN (SELECT episode_id FROM main.dump_events)',
    bind: () => [],
  },
  same_slot_shadow_simulations: {
    where: 'episode_id IN (SELECT episode_id FROM main.dump_events)',
    bind: () => [],
  },
  execution_probes: {
    where: 'episode_id IN (SELECT episode_id FROM main.dump_events)',
    bind: () => [],
  },
  simulations: {
    where: 'episode_id IN (SELECT episode_id FROM main.dump_events)',
    bind: () => [],
  },
});

const GENERIC_TIME_COLUMNS = [
  'received_at_ms', 'detected_at_ms', 'confirmed_at_ms', 'observed_at_ms',
  'created_at_ms', 'updated_at_ms', 'last_seen_at_ms',
];

const ANALYSIS_REQUIRED_COLUMNS = Object.freeze({
  trades: [
    'received_at_ms', 'slot', 'transaction_index', 'instruction_index', 'event_index',
    'signature', 'mint', 'pool', 'side', 'sol_amount', 'event_price', 'reserve_price',
    'effective_quote_reserves_raw', 'total_fee_bps', 'parse_version',
    'ingestion_mode',
  ],
  slot_summaries: ['first_received_at_ms', 'last_received_at_ms'],
  dump_events: [
    'episode_id', 'mint', 'detected_at_ms', 'drop_pct', 'toxic_rejected', 'parse_version',
    'ingestion_mode',
  ],
  same_slot_observations: [
    'episode_id', 'observed_at_ms', 'buy_transaction_index', 'instruction_index',
    'event_index', 'receive_lag_ms', 'buy_sol', 'price_bounce_pct', 'data_quality_status',
  ],
  same_slot_shadow_simulations: [
    'episode_id', 'target_rank', 'entry_profile_id', 'cohort_stage', 'position_sol',
    'exit_horizon_ms', 'status', 'competitor_gap_ms', 'competitor_headroom_ms',
    'response_budget_ms', 'trigger_buy_sol', 'data_quality_status', 'entry_at_ms',
    'exit_reason', 'rescue_horizon_ms', 'net_return_pct', 'hold_ms',
    'candidate_profile_id', 'candidate_cohort_stage', 'candidate_primary',
    'candidate_novel_mint',
  ],
  execution_probes: [
    'episode_id', 'candidate_profile_id', 'mode', 'status', 'build_duration_us',
    'sign_duration_us', 'serialize_duration_us', 'send_enabled', 'send_status',
    'landing_status', 'rank_status', 'trigger_signature', 'chain_validation_status',
  ],
});

const GO_NO_GO_THRESHOLDS = Object.freeze({
  minimumCoverageHours: 23,
  minimumB5Episodes: 100,
  minimumB5Mints: 50,
  minimumPrimaryExitEpisodes: 30,
  minimumHeadroomSampleEpisodes: 30,
  minimumTerminalRowsPct: 95,
  minimumAssessedObservationPct: 90,
  minimumCandidateEpisodes: 100,
  minimumCandidateMints: 50,
  minimumCandidateFullLossProfitFactor: 1.3,
  requiredPositionsSol: [1, 2, 5],
  requiredExitHorizonsMs: [100, 250, 500],
});

function parseArgs(argv) {
  const values = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, raw = 'true'] = item.slice(2).split('=', 2);
    values[key] = raw;
  }
  return values;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function chooseFilter(table, columns) {
  if (EXPLICIT_FILTERS[table]) return EXPLICIT_FILTERS[table];
  if (table === 'schema_meta' || table === 'toxic_wallets'
    || table === 'candidate_excluded_mints') {
    return { where: '1 = 1', bind: () => [], fullTable: true };
  }
  const anchor = GENERIC_TIME_COLUMNS.find((column) => columns.includes(column));
  if (!anchor) return { where: '1 = 1', bind: () => [], fullTable: true };
  return {
    where: `${quoteIdentifier(anchor)} >= ? AND ${quoteIdentifier(anchor)} < ?`,
    bind: (startMs, endMs) => [startMs, endMs],
  };
}

function indexCreateSql(name, sourceSql) {
  const match = sourceSql.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+/i);
  if (!match) throw new Error(`Cannot parse CREATE INDEX for ${name}`);
  return `CREATE ${match[1] || ''}INDEX main.${quoteIdentifier(name)} ${sourceSql.slice(match[0].length)}`;
}

function formatShanghai(timestampMs) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestampMs)).replace(' ', 'T') + '+08:00';
}

function writeSchema(databasePath, schemaPath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const sql = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name
    `).all().map((row) => `${row.sql};`).join('\n\n');
    fs.writeFileSync(schemaPath, `${sql}\n`, { encoding: 'utf8', mode: 0o600 });
  } finally {
    db.close();
  }
}

function percentage(part, whole) {
  return whole > 0 ? part / whole * 100 : null;
}

function profitFactor(values) {
  const wins = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0));
  return values.length ? (losses > 0 ? wins / losses : (wins > 0 ? null : 0)) : null;
}

function researchReadiness(databasePath, startMs, endMs) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const missingColumns = [];
    for (const [table, required] of Object.entries(ANALYSIS_REQUIRED_COLUMNS)) {
      const available = new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all().map((column) => column.name));
      for (const column of required) {
        if (!available.has(column)) missingColumns.push(`${table}.${column}`);
      }
    }
    const schemaVersion = db.prepare(`
      SELECT value FROM schema_meta WHERE key='schema_version'
    `).get()?.value || null;
    const windowHours = (endMs - startMs) / 3_600_000;
    const observationQualityColumn = 'same_slot_observations.data_quality_status';
    const blockingMissingColumns = missingColumns
      .filter((column) => column !== observationQualityColumn);
    const empty = {
      stream: { coverageHours: 0, maximumObservedGapMs: null, slotSummaries: 0 },
      dumps: { episodes: 0, mints: 0 },
      observations: {
        total: 0, trusted: 0, unassessed: 0, quarantined: 0, assessedPct: null,
      },
      b5: {
        episodes: 0, mints: 0, rows: 0, entryFilledRows: 0, terminalRows: 0,
        terminalRowsPct: null, primaryExitEpisodes: 0, rescue5sEpisodes: 0,
        rescue10sEpisodes: 0, noExitEpisodes: 0, headroomSampleEpisodes: 0,
        positiveHeadroomEpisodes: 0, positiveHeadroomPct: null,
        quarantinedRows: 0, cohortCount: 0, cohorts: [],
      },
      candidate: {
        profileId: CANDIDATE_PROFILE_ID, episodes: 0, mints: 0, rows: 0,
        terminalRows: 0, terminalRowsPct: null, fullLossProfitFactor: null,
        enteredTerminalRows: 0, noEntryRows: 0, averageNetReturnPct: null,
        probeSamples: 0, chainValidatedProbeSamples: 0, chainRejectedProbeSamples: 0,
        realLandingSamples: 0,
        realRankSamples: 0,
      },
      ingestion: { tradeRowsByMode: {}, dumpEpisodesByMode: {} },
    };
    let metrics = empty;
    if (!blockingMissingColumns.length) {
      const stream = db.prepare(`
        WITH ordered AS (
          SELECT first_received_at_ms,last_received_at_ms,
            LAG(last_received_at_ms) OVER (ORDER BY first_received_at_ms) previous_at_ms
          FROM slot_summaries
        )
        SELECT COUNT(*) slot_summaries,MIN(first_received_at_ms) first_at_ms,
          MAX(last_received_at_ms) last_at_ms,
          MAX(CASE WHEN previous_at_ms IS NOT NULL
            THEN MAX(0,first_received_at_ms-previous_at_ms) END) maximum_observed_gap_ms
        FROM ordered
      `).get();
      const dumps = db.prepare(`
        SELECT COUNT(*) episodes,COUNT(DISTINCT mint) mints FROM dump_events
      `).get();
      const observations = missingColumns.includes(observationQualityColumn)
        ? db.prepare(`
          SELECT COUNT(*) total,0 trusted,COUNT(*) unassessed,0 quarantined
          FROM same_slot_observations
        `).get()
        : db.prepare(`
          SELECT COUNT(*) total,
            SUM(CASE WHEN data_quality_status='TRUSTED' THEN 1 ELSE 0 END) trusted,
            SUM(CASE WHEN COALESCE(data_quality_status,'UNASSESSED')='UNASSESSED'
              THEN 1 ELSE 0 END) unassessed,
            SUM(CASE WHEN data_quality_status='QUARANTINED' THEN 1 ELSE 0 END) quarantined
          FROM same_slot_observations
        `).get();
      const tradeRowsByMode = Object.fromEntries(db.prepare(`
        SELECT COALESCE(ingestion_mode,'UNKNOWN') mode,COUNT(*) count
        FROM trades GROUP BY COALESCE(ingestion_mode,'UNKNOWN')
      `).all().map((row) => [row.mode, row.count]));
      const dumpEpisodesByMode = Object.fromEntries(db.prepare(`
        SELECT COALESCE(ingestion_mode,'UNKNOWN') mode,COUNT(*) count
        FROM dump_events GROUP BY COALESCE(ingestion_mode,'UNKNOWN')
      `).all().map((row) => [row.mode, row.count]));
      const b5 = db.prepare(`
        SELECT COUNT(DISTINCT CASE WHEN COALESCE(data_quality_status,'UNASSESSED')<>
            'QUARANTINED' THEN s.episode_id END) episodes,
          COUNT(DISTINCT CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>
            'QUARANTINED' THEN d.mint END) mints,
          SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            THEN 1 ELSE 0 END) rows,
          SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            AND s.status<>'NO_ENTRY' THEN 1 ELSE 0 END) entry_filled_rows,
          SUM(CASE WHEN COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            AND s.status IN ('CLOSED','NO_EXIT','NO_ENTRY') THEN 1 ELSE 0 END) terminal_rows,
          COUNT(DISTINCT CASE WHEN s.status='CLOSED' AND s.exit_reason='PRIMARY'
            AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            THEN s.episode_id END) primary_exit_episodes,
          COUNT(DISTINCT CASE WHEN s.status='CLOSED' AND s.rescue_horizon_ms=5000
            AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            THEN s.episode_id END) rescue_5s_episodes,
          COUNT(DISTINCT CASE WHEN s.status='CLOSED' AND s.rescue_horizon_ms=10000
            AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            THEN s.episode_id END) rescue_10s_episodes,
          COUNT(DISTINCT CASE WHEN s.status='NO_EXIT'
            AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            THEN s.episode_id END) no_exit_episodes,
          COUNT(DISTINCT CASE WHEN s.competitor_gap_ms IS NOT NULL
            AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            THEN s.episode_id END) headroom_sample_episodes,
          COUNT(DISTINCT CASE WHEN s.competitor_gap_ms>s.response_budget_ms
            AND COALESCE(s.data_quality_status,'UNASSESSED')<>'QUARANTINED'
            THEN s.episode_id END) positive_headroom_episodes,
          SUM(CASE WHEN s.data_quality_status='QUARANTINED' THEN 1 ELSE 0 END)
            quarantined_rows
        FROM same_slot_shadow_simulations s
        JOIN dump_events d ON d.episode_id=s.episode_id
        WHERE s.entry_profile_id='R2-B5' AND s.cohort_stage='HOLDOUT_B5_V1'
      `).get();
      const cohorts = db.prepare(`
        SELECT position_sol positionSol,exit_horizon_ms exitHorizonMs,
          COUNT(*) rows,COUNT(DISTINCT episode_id) episodes,
          SUM(CASE WHEN status<>'NO_ENTRY' THEN 1 ELSE 0 END) entryFilledRows,
          SUM(CASE WHEN status='CLOSED' AND exit_reason='PRIMARY'
            THEN 1 ELSE 0 END) primaryExitRows,
          SUM(CASE WHEN status='CLOSED' AND exit_reason LIKE 'RESCUE_%'
            THEN 1 ELSE 0 END) rescueExitRows,
          SUM(CASE WHEN status='NO_EXIT' THEN 1 ELSE 0 END) noExitRows,
          AVG(CASE WHEN status='CLOSED' THEN net_return_pct END) closedAverageNetReturnPct
        FROM same_slot_shadow_simulations
        WHERE entry_profile_id='R2-B5' AND cohort_stage='HOLDOUT_B5_V1'
          AND COALESCE(data_quality_status,'UNASSESSED')<>'QUARANTINED'
        GROUP BY position_sol,exit_horizon_ms
        ORDER BY position_sol,exit_horizon_ms
      `).all();
      const candidateRows = db.prepare(`
        SELECT s.episode_id episodeId,d.mint,s.status,s.exit_reason exitReason,
          s.position_sol positionSol,s.modeled_jito_tip_sol modeledTipSol,
          s.net_return_pct netReturnPct
        FROM same_slot_shadow_simulations s
        JOIN dump_events d ON d.episode_id=s.episode_id
        WHERE s.candidate_profile_id=? AND s.candidate_cohort_stage=?
          AND s.candidate_primary=1 AND s.candidate_novel_mint=1
          AND s.position_sol=? AND s.exit_horizon_ms=?
          AND COALESCE(s.data_quality_status,'UNASSESSED')='TRUSTED'
      `).all(CANDIDATE_PROFILE_ID, CANDIDATE_COHORT_STAGE,
        CANDIDATE_PRIMARY_POSITION_SOL, CANDIDATE_PRIMARY_EXIT_HORIZON_MS);
      const candidateTerminal = candidateRows
        .filter((row) => ['CLOSED', 'NO_EXIT', 'NO_ENTRY'].includes(row.status));
      const candidateEnteredTerminal = candidateTerminal
        .filter((row) => ['CLOSED', 'NO_EXIT'].includes(row.status));
      const candidateValues = candidateEnteredTerminal.map((row) => {
        const position = Number(row.positionSol) || 1;
        const extraJitoPct = (0.01 - Math.max(0, Number(row.modeledTipSol) || 0))
          * 2 / position * 100;
        return row.status === 'CLOSED'
          ? Number(row.netReturnPct) - extraJitoPct : -100 - extraJitoPct;
      }).filter(Number.isFinite);
      const probeMetrics = db.prepare(`
        SELECT COUNT(*) samples,
          SUM(CASE WHEN chain_validation_status='MATCHED_FINAL_CHAIN_RANK_1'
            THEN 1 ELSE 0 END) chain_validated_samples,
          SUM(CASE WHEN chain_validation_status='TRIGGER_WAS_NOT_FINAL_CHAIN_RANK_1'
            THEN 1 ELSE 0 END) chain_rejected_samples,
          SUM(CASE WHEN landing_status NOT IN ('NOT_SENT','DISABLED') THEN 1 ELSE 0 END)
            real_landing_samples,
          SUM(CASE WHEN landed_rank IS NOT NULL THEN 1 ELSE 0 END) real_rank_samples
        FROM execution_probes WHERE candidate_profile_id=?
      `).get(CANDIDATE_PROFILE_ID);
      const rows = Number(b5.rows) || 0;
      const terminalRows = Number(b5.terminal_rows) || 0;
      const headroomSamples = Number(b5.headroom_sample_episodes) || 0;
      const positiveHeadroom = Number(b5.positive_headroom_episodes) || 0;
      metrics = {
        stream: {
          coverageHours: stream.first_at_ms != null && stream.last_at_ms != null
            ? (stream.last_at_ms - stream.first_at_ms) / 3_600_000 : 0,
          maximumObservedGapMs: stream.maximum_observed_gap_ms,
          slotSummaries: stream.slot_summaries || 0,
        },
        dumps: { episodes: dumps.episodes || 0, mints: dumps.mints || 0 },
        observations: {
          total: observations.total || 0,
          trusted: observations.trusted || 0,
          unassessed: observations.unassessed || 0,
          quarantined: observations.quarantined || 0,
          assessedPct: percentage(
            (observations.trusted || 0) + (observations.quarantined || 0),
            observations.total || 0,
          ),
        },
        b5: {
          episodes: b5.episodes || 0,
          mints: b5.mints || 0,
          rows,
          entryFilledRows: b5.entry_filled_rows || 0,
          terminalRows,
          terminalRowsPct: percentage(terminalRows, rows),
          primaryExitEpisodes: b5.primary_exit_episodes || 0,
          rescue5sEpisodes: b5.rescue_5s_episodes || 0,
          rescue10sEpisodes: b5.rescue_10s_episodes || 0,
          noExitEpisodes: b5.no_exit_episodes || 0,
          headroomSampleEpisodes: headroomSamples,
          positiveHeadroomEpisodes: positiveHeadroom,
          positiveHeadroomPct: percentage(positiveHeadroom, headroomSamples),
          quarantinedRows: b5.quarantined_rows || 0,
          cohortCount: cohorts.length,
          cohorts,
        },
        candidate: {
          profileId: CANDIDATE_PROFILE_ID,
          cohortStage: CANDIDATE_COHORT_STAGE,
          episodes: new Set(candidateRows.map((row) => row.episodeId)).size,
          mints: new Set(candidateRows.map((row) => row.mint)).size,
          rows: candidateRows.length,
          terminalRows: candidateTerminal.length,
          terminalRowsPct: percentage(candidateTerminal.length, candidateRows.length),
          enteredTerminalRows: candidateEnteredTerminal.length,
          noEntryRows: candidateTerminal.filter((row) => row.status === 'NO_ENTRY').length,
          fullLossProfitFactor: profitFactor(candidateValues),
          averageNetReturnPct: candidateValues.length
            ? candidateValues.reduce((sum, value) => sum + value, 0) / candidateValues.length
            : null,
          probeSamples: probeMetrics.samples || 0,
          chainValidatedProbeSamples: probeMetrics.chain_validated_samples || 0,
          chainRejectedProbeSamples: probeMetrics.chain_rejected_samples || 0,
          realLandingSamples: probeMetrics.real_landing_samples || 0,
          realRankSamples: probeMetrics.real_rank_samples || 0,
        },
        ingestion: { tradeRowsByMode, dumpEpisodesByMode },
      };
    }
    const expectedCohorts = GO_NO_GO_THRESHOLDS.requiredPositionsSol.flatMap(
      (positionSol) => GO_NO_GO_THRESHOLDS.requiredExitHorizonsMs
        .map((exitHorizonMs) => `${positionSol}:${exitHorizonMs}`),
    );
    const actualCohorts = new Set(metrics.b5.cohorts
      .map((row) => `${row.positionSol}:${row.exitHorizonMs}`));
    const missingCohorts = expectedCohorts.filter((key) => !actualCohorts.has(key));
    const gates = [
      {
        id: 'REQUIRED_SCHEMA_FIELDS', passed: missingColumns.length === 0,
        actual: missingColumns.length, required: 0,
      },
      {
        id: 'STREAM_COVERAGE_HOURS',
        passed: metrics.stream.coverageHours >= GO_NO_GO_THRESHOLDS.minimumCoverageHours,
        actual: metrics.stream.coverageHours,
        required: GO_NO_GO_THRESHOLDS.minimumCoverageHours,
      },
      {
        id: 'OBSERVATION_QUALITY_ASSESSED_PCT',
        passed: (metrics.observations.assessedPct || 0)
          >= GO_NO_GO_THRESHOLDS.minimumAssessedObservationPct,
        actual: metrics.observations.assessedPct,
        required: GO_NO_GO_THRESHOLDS.minimumAssessedObservationPct,
      },
      {
        id: 'TRUSTED_B5_EPISODES',
        passed: metrics.b5.episodes >= GO_NO_GO_THRESHOLDS.minimumB5Episodes,
        actual: metrics.b5.episodes, required: GO_NO_GO_THRESHOLDS.minimumB5Episodes,
      },
      {
        id: 'TRUSTED_B5_MINTS',
        passed: metrics.b5.mints >= GO_NO_GO_THRESHOLDS.minimumB5Mints,
        actual: metrics.b5.mints, required: GO_NO_GO_THRESHOLDS.minimumB5Mints,
      },
      {
        id: 'PRIMARY_EXIT_EPISODES',
        passed: metrics.b5.primaryExitEpisodes
          >= GO_NO_GO_THRESHOLDS.minimumPrimaryExitEpisodes,
        actual: metrics.b5.primaryExitEpisodes,
        required: GO_NO_GO_THRESHOLDS.minimumPrimaryExitEpisodes,
      },
      {
        id: 'RANK2_HEADROOM_SAMPLE_EPISODES',
        passed: metrics.b5.headroomSampleEpisodes
          >= GO_NO_GO_THRESHOLDS.minimumHeadroomSampleEpisodes,
        actual: metrics.b5.headroomSampleEpisodes,
        required: GO_NO_GO_THRESHOLDS.minimumHeadroomSampleEpisodes,
      },
      {
        id: 'TERMINAL_B5_ROWS_PCT',
        passed: (metrics.b5.terminalRowsPct || 0)
          >= GO_NO_GO_THRESHOLDS.minimumTerminalRowsPct,
        actual: metrics.b5.terminalRowsPct,
        required: GO_NO_GO_THRESHOLDS.minimumTerminalRowsPct,
      },
      {
        id: 'ALL_POSITION_EXIT_COHORTS', passed: missingCohorts.length === 0,
        actual: metrics.b5.cohortCount, required: expectedCohorts.length,
      },
      {
        id: 'NEW_CANDIDATE_EPISODES',
        passed: metrics.candidate.episodes >= GO_NO_GO_THRESHOLDS.minimumCandidateEpisodes,
        actual: metrics.candidate.episodes,
        required: GO_NO_GO_THRESHOLDS.minimumCandidateEpisodes,
      },
      {
        id: 'NEW_CANDIDATE_MINTS',
        passed: metrics.candidate.mints >= GO_NO_GO_THRESHOLDS.minimumCandidateMints,
        actual: metrics.candidate.mints,
        required: GO_NO_GO_THRESHOLDS.minimumCandidateMints,
      },
      {
        id: 'CANDIDATE_TERMINAL_ROWS_PCT',
        passed: (metrics.candidate.terminalRowsPct || 0)
          >= GO_NO_GO_THRESHOLDS.minimumTerminalRowsPct,
        actual: metrics.candidate.terminalRowsPct,
        required: GO_NO_GO_THRESHOLDS.minimumTerminalRowsPct,
      },
      {
        id: 'CANDIDATE_FULL_LOSS_PROFIT_FACTOR',
        passed: (metrics.candidate.fullLossProfitFactor || 0)
          >= GO_NO_GO_THRESHOLDS.minimumCandidateFullLossProfitFactor,
        actual: metrics.candidate.fullLossProfitFactor,
        required: GO_NO_GO_THRESHOLDS.minimumCandidateFullLossProfitFactor,
      },
    ];
    const ready = gates.every((gate) => gate.passed);
    return {
      status: ready ? 'READY_FOR_EXECUTION_REVIEW' : 'COLLECT_MORE_DATA',
      liveTradingDecision: 'TRADING_DISABLED',
      note: 'Readiness only means the dataset can support analysis; it is not permission to trade.',
      schemaVersion,
      windowHours,
      thresholds: GO_NO_GO_THRESHOLDS,
      missingColumns,
      missingCohorts,
      gates,
      ...metrics,
    };
  } finally {
    db.close();
  }
}

function exportResearchWindow({ sourcePath, destinationPath, startMs, endMs, schemaPath = null }) {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error('A valid startMs < endMs window is required');
  }
  if (source === destination) throw new Error('Export destination must differ from source database');
  if (!fs.existsSync(source)) throw new Error(`Source database does not exist: ${source}`);
  if (fs.existsSync(destination)) throw new Error(`Export destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const db = new Database(destination, { timeout: 10_000 });
  const tables = [];
  let committed = false;
  try {
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = OFF');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.prepare('ATTACH DATABASE ? AS source').run(source);
    db.exec('BEGIN');
    db.prepare('SELECT COUNT(*) AS count FROM source.sqlite_master').get();

    const sourceTables = db.prepare(`
      SELECT name, sql FROM source.sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY CASE name
        WHEN 'schema_meta' THEN 1 WHEN 'trades' THEN 2 WHEN 'slot_summaries' THEN 3
        WHEN 'dump_events' THEN 4 WHEN 'confirmations' THEN 5
        WHEN 'same_slot_observations' THEN 6 WHEN 'simulations' THEN 7
        WHEN 'same_slot_shadow_simulations' THEN 7 WHEN 'simulations' THEN 8
        WHEN 'toxic_wallets' THEN 9 ELSE 20 END, name
    `).all();
    for (const table of sourceTables) {
      const columns = db.prepare(`PRAGMA source.table_info(${quoteIdentifier(table.name)})`)
        .all().map((column) => column.name);
      const filter = chooseFilter(table.name, columns);
      db.exec(table.sql);
      const result = db.prepare(`
        INSERT INTO main.${quoteIdentifier(table.name)}
        SELECT * FROM source.${quoteIdentifier(table.name)} WHERE ${filter.where}
      `).run(...filter.bind(startMs, endMs));
      tables.push({ table: table.name, rows: result.changes, fullTable: Boolean(filter.fullTable) });
    }

    const indexes = db.prepare(`
      SELECT name, sql FROM source.sqlite_master
      WHERE type='index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
      ORDER BY name
    `).all();
    for (const index of indexes) db.exec(indexCreateSql(index.name, index.sql));
    db.exec('COMMIT');
    committed = true;
    db.exec('DETACH DATABASE source');
  } catch (error) {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    }
    try { db.exec('DETACH DATABASE source'); } catch (_) {}
    try { fs.rmSync(destination, { force: true }); } catch (_) {}
    throw error;
  } finally {
    db.close();
  }

  const exported = new Database(destination, { readonly: true, fileMustExist: true });
  let integrity;
  try {
    integrity = exported.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Export integrity check failed: ${integrity}`);
  } finally {
    exported.close();
  }
  if (schemaPath) writeSchema(destination, path.resolve(schemaPath));
  const analysisReadiness = researchReadiness(destination, startMs, endMs);

  return {
    formatVersion: 2,
    mode: 'CONSISTENT_READ_TRANSACTION_24H_WINDOW',
    createdAtMs: Date.now(),
    range: {
      startMs, endMs,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(endMs).toISOString(),
      startCst: formatShanghai(startMs),
      endCst: formatShanghai(endMs),
    },
    source,
    destination,
    sourceBytes: fs.statSync(source).size,
    exportBytes: fs.statSync(destination).size,
    integrity,
    tables,
    analysisReadiness,
  };
}

function main() {
  const input = parseArgs(process.argv.slice(2));
  const source = input.db || process.env.SDBR_DB_PATH || './data/sdbr-research.db';
  const destination = input.out;
  if (!destination) throw new Error('--out=/path/to/export.db is required');
  const hours = Number(input.hours || 24);
  const endMs = input['end-ms'] ? Number(input['end-ms']) : Date.now();
  const startMs = input['start-ms'] ? Number(input['start-ms']) : endMs - hours * 3_600_000;
  const manifestPath = input.manifest || `${destination}.manifest.json`;
  const result = exportResearchWindow({
    sourcePath: source,
    destinationPath: destination,
    startMs,
    endMs,
    schemaPath: input.schema || null,
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[WindowExport] ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  chooseFilter, exportResearchWindow, formatShanghai, parseArgs, researchReadiness,
};
