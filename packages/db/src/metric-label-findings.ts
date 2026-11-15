import type { AutoApplyDecision, LabelChangeEvidence, LabelChangeFinding } from "@rakazo/contracts";
import { decideWouldApply } from "@rakazo/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import { runAsSystemInTransaction } from "./row-security.js";

export interface RecordedLabelFinding {
  findingId: string;
  slotId: string;
  kind: string;
  status: string;
  wouldApply: boolean;
}

export async function recordLabelFindings(
  tx: Prisma.TransactionClient,
  input: {
    findings: LabelChangeFinding[];
    restaurantId: string;
    spaceId: string;
    outletId: string;
    fetchId: string;
    periods: string[];
  },
): Promise<RecordedLabelFinding[]> {
  const recorded: RecordedLabelFinding[] = [];
  for (const finding of input.findings) {
    const stored = await runAsSystemInTransaction(tx, "record a label finding", async () => {
      const open = await tx.metricLabelFinding.findFirst({
        where: {
          status: "open",
          kind: finding.kind,
          platform: finding.platform,
          family: finding.family,
          reportKind: finding.reportKind,
          section: finding.section,
          slotId: finding.slotId || null,
          candidateNorm: finding.candidateNorm,
        },
        include: { observations: { select: { outletId: true, createdAt: true } } },
      });
      const outlets = new Set(open?.observations.map((row) => row.outletId) ?? []);
      outlets.add(input.outletId);
      const nights = new Set(
        (open?.observations ?? []).map((row) => row.createdAt.toISOString().slice(0, 10)),
      );
      nights.add(new Date().toISOString().slice(0, 10));
      const decision = decideWouldApply({
        ...finding.ruleInput,
        outlets: outlets.size,
        files: (open?.observations.length ?? 0) + 1,
        nights: nights.size,
        otherFinding: await otherOpenCandidate(tx, finding),
      });
      const evidence = storedEvidence(finding, decision);
      const data = {
        evidence: evidence as unknown as Prisma.InputJsonValue,
        confidence: decision.confidence,
        lastSeenAt: new Date(),
        occurrences: (open?.occurrences ?? 0) + 1,
        outletsAffected: outlets.size,
        daysAffected: input.periods.length,
      };
      const row = open
        ? await tx.metricLabelFinding.update({ where: { id: open.id }, data })
        : await tx.metricLabelFinding.create({
            data: {
              kind: finding.kind,
              platform: finding.platform,
              family: finding.family,
              reportKind: finding.reportKind,
              section: finding.section,
              slotId: finding.slotId || null,
              oldLabel: finding.oldLabel,
              candidateLabel: finding.candidateLabel,
              candidateNorm: finding.candidateNorm,
              status: "open",
              ...data,
            },
          });
      return { row, decision };
    });
    await tx.metricLabelObservation.create({
      data: {
        findingId: stored.row.id,
        restaurantId: input.restaurantId,
        spaceId: input.spaceId,
        outletId: input.outletId,
        platform: finding.platform,
        fetchId: input.fetchId,
        reportKind: finding.reportKind,
        periods: input.periods.join(","),
        rowIndex: finding.rowIndex,
        evidence: observationEvidence(finding),
      },
    });
    recorded.push({
      findingId: stored.row.id,
      slotId: finding.slotId,
      kind: finding.kind,
      status: "open",
      wouldApply: stored.decision.wouldApply,
    });
  }
  return recorded;
}

async function otherOpenCandidate(
  tx: Prisma.TransactionClient,
  finding: LabelChangeFinding,
): Promise<boolean> {
  if (!finding.candidateNorm) return false;
  const other = await tx.metricLabelFinding.findFirst({
    where: {
      status: "open",
      platform: finding.platform,
      candidateNorm: finding.candidateNorm,
      NOT: { slotId: finding.slotId || null },
    },
    select: { id: true },
  });
  return other != null;
}

function storedEvidence(
  finding: LabelChangeFinding,
  decision: AutoApplyDecision,
): LabelChangeEvidence & {
  ruleResults: AutoApplyDecision["ruleResults"];
  wouldApply: boolean;
  reasons: string[];
} {
  const evidence =
    finding.family === "payout" ? withoutCellValues(finding.evidence) : finding.evidence;
  return {
    ...evidence,
    ruleResults: decision.ruleResults,
    wouldApply: decision.wouldApply,
    reasons: decision.reasons,
  };
}

function withoutCellValues(evidence: LabelChangeEvidence): LabelChangeEvidence {
  return {
    ...evidence,
    valueEvidence: {
      method: evidence.valueEvidence.method,
      count: evidence.valueEvidence.count,
      min: null,
      max: null,
      median: null,
    },
  };
}

function observationEvidence(finding: LabelChangeFinding): Prisma.InputJsonValue {
  if (finding.family === "payout") {
    return { kind: finding.kind, count: finding.evidence.valueEvidence.count };
  }
  return {
    count: finding.evidence.valueEvidence.count,
    min: finding.evidence.valueEvidence.min,
    max: finding.evidence.valueEvidence.max,
    median: finding.evidence.valueEvidence.median,
  };
}
