import type { Recap, RecapSourceGroup } from './types.js';
import { RecapError } from './types.js';

export interface RecapCoverageSelection {
  selected: Recap[];
  missingGroups: RecapSourceGroup[];
}

function compareSources(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function sameSources(left: readonly number[], right: readonly number[]): boolean {
  return compareSources(left, right) === 0;
}

function validateGroups(groups: readonly RecapSourceGroup[]): void {
  const seen = new Set<number>();
  for (const group of groups) {
    if (group.sourceMessageSeqs.length === 0) {
      throw new RecapError('recap_coverage_error', 'A recap source group must not be empty.');
    }
    let previous = 0;
    for (const seq of group.sourceMessageSeqs) {
      if (!Number.isSafeInteger(seq) || seq <= previous || seen.has(seq)) {
        throw new RecapError(
          'recap_coverage_error',
          'Recap source groups must be ordered and non-overlapping.',
        );
      }
      seen.add(seq);
      previous = seq;
    }
  }
}

export function selectRecapCoverage(
  groups: readonly RecapSourceGroup[],
  availableRecaps: readonly Recap[],
  preferredRecapIds: readonly string[] = [],
): RecapCoverageSelection {
  validateGroups(groups);
  const groupBySeq = new Map<number, number>();
  groups.forEach((group, index) => {
    for (const seq of group.sourceMessageSeqs) groupBySeq.set(seq, index);
  });
  const groupSizes = groups.map((group) => group.sourceMessageSeqs.length);
  const covered = new Set<number>();
  const selected: Recap[] = [];

  const isCandidate = (recap: Recap): boolean => {
    if (recap.validity !== 'valid' || recap.sourceMessageSeqs.length === 0) return false;
    const candidateGroups = new Set<number>();
    let sourceCount = 0;
    for (const seq of recap.sourceMessageSeqs) {
      const group = groupBySeq.get(seq);
      if (group === undefined || covered.has(group)) return false;
      candidateGroups.add(group);
      sourceCount += 1;
    }
    const expectedCount = [...candidateGroups].reduce(
      (total, group) => total + (groupSizes[group] ?? 0),
      0,
    );
    return sourceCount === expectedCount && new Set(recap.sourceMessageSeqs).size === sourceCount;
  };

  const select = (recap: Recap): void => {
    for (const seq of recap.sourceMessageSeqs) {
      const group = groupBySeq.get(seq);
      if (group !== undefined) covered.add(group);
    }
    selected.push(recap);
  };

  const byId = new Map(availableRecaps.map((recap) => [recap.recapId, recap]));
  for (const id of preferredRecapIds) {
    const recap = byId.get(id);
    if (recap && isCandidate(recap)) select(recap);
  }

  for (const [index, group] of groups.entries()) {
    if (covered.has(index)) continue;
    const exact = availableRecaps
      .filter(
        (recap) =>
          isCandidate(recap) && sameSources(recap.sourceMessageSeqs, group.sourceMessageSeqs),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.recapId.localeCompare(right.recapId),
      )[0];
    if (exact) select(exact);
  }

  while (covered.size < groups.length) {
    const candidate = availableRecaps.filter(isCandidate).sort((left, right) => {
      const leftGroups = new Set(
        left.sourceMessageSeqs.map((seq) => groupBySeq.get(seq)).filter((seq) => seq !== undefined),
      ).size;
      const rightGroups = new Set(
        right.sourceMessageSeqs
          .map((seq) => groupBySeq.get(seq))
          .filter((seq) => seq !== undefined),
      ).size;
      return (
        rightGroups - leftGroups ||
        compareSources(left.sourceMessageSeqs, right.sourceMessageSeqs) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.recapId.localeCompare(right.recapId)
      );
    })[0];
    if (!candidate) break;
    select(candidate);
  }

  selected.sort(
    (left, right) =>
      compareSources(left.sourceMessageSeqs, right.sourceMessageSeqs) ||
      left.recapId.localeCompare(right.recapId),
  );
  return {
    selected,
    missingGroups: groups.filter((_, index) => !covered.has(index)),
  };
}

export function mergeRecapText(recaps: readonly Recap[]): string {
  return recaps
    .map(
      (recap) =>
        `recap_id: ${recap.recapId}\n来源消息序号: ${recap.sourceMessageSeqs.join(', ')}\n${recap.content}`,
    )
    .join('\n\n');
}
