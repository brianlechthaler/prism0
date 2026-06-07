import type { RunUsageMetrics } from "../hooks/useGeneration";

export function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTokenRate(value: number): string {
  return `${value.toFixed(1)} tok/s`;
}

export function UsageMetricsPanel({ metrics }: { metrics?: RunUsageMetrics }) {
  if (!metrics) {
    return (
      <div className="usage usageEmpty">
        <div className="usageTitle">LLM usage</div>
        <div className="usageHint">Token speed and context usage will appear once streaming begins.</div>
      </div>
    );
  }

  return (
    <div className="usage" aria-label="LLM usage metrics">
      <div className="usageHeader">
        <div>
          <div className="usageTitle">LLM usage</div>
          <div className="usageContext">
            {formatTokens(metrics.contextUsedTokens)} / {formatTokens(metrics.contextWindowTokens)} context
            tokens ({metrics.contextUsedPercent.toFixed(1)}%)
          </div>
        </div>
        <div className="usageRate">{formatTokenRate(metrics.outputTokensPerSecond)}</div>
      </div>

      <div
        className="usageBar"
        role="progressbar"
        aria-label="Context window used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={metrics.contextUsedPercent}
      >
        {metrics.buckets.map((bucket) => (
          <span
            key={bucket.kind}
            className={`usageSegment usageSegment-${bucket.kind}`}
            style={{
              width: `${Math.max(0.5, (bucket.totalTokens / metrics.contextWindowTokens) * 100)}%`
            }}
            title={`${bucket.label}: ${formatTokens(bucket.totalTokens)} tokens`}
          />
        ))}
      </div>

      <div className="usageStats">
        <div>
          <span className="usageStatLabel">input</span>
          <strong>{formatTokens(metrics.inputTokens)}</strong>
        </div>
        <div>
          <span className="usageStatLabel">output</span>
          <strong>{formatTokens(metrics.outputTokens)}</strong>
        </div>
        <div>
          <span className="usageStatLabel">context</span>
          <strong>{metrics.contextUsedPercent.toFixed(1)}%</strong>
        </div>
      </div>

      <div className="usageLegend">
        {metrics.buckets.map((bucket) => (
          <div className="usageLegendItem" key={bucket.kind}>
            <span className={`usageDot usageSegment-${bucket.kind}`} />
            <span>{bucket.label}</span>
            <strong>{formatTokens(bucket.totalTokens)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
