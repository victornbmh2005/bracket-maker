// Turns raw 1–10 scores into averages.
//   item score      = average of that item's scores (criteria it was rated on)
//   criterion avg   = average score given for that criterion across items
//   list score      = average of the item scores (items with at least one score)
// Averages are rounded to 1 decimal; the list score uses unrounded item scores.

const avg = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round1 = x => (x === null ? null : Math.round(x * 10) / 10);

// criteria: [{id, ...}], items: [{id, ...}], ratings: [{item_id, criterion_id, score}]
export function summarize(criteria, items, ratings) {
  const scoresByItem = new Map(items.map(i => [i.id, {}]));
  for (const r of ratings) {
    const scores = scoresByItem.get(r.item_id);
    if (scores) scores[r.criterion_id] = r.score;
  }

  const rawItemScores = [];
  const itemsOut = items.map(item => {
    const scores = scoresByItem.get(item.id);
    const values = criteria.map(c => scores[c.id]).filter(v => v !== undefined);
    const raw = avg(values);
    if (raw !== null) rawItemScores.push(raw);
    return {
      ...item,
      scores,                                            // {criterion_id: score}
      score: round1(raw),
      rated: values.length,                              // how many criteria have a score
      complete: criteria.length > 0 && values.length === criteria.length,
    };
  });

  const criteriaOut = criteria.map(c => {
    const values = items.map(i => scoresByItem.get(i.id)[c.id]).filter(v => v !== undefined);
    return { ...c, average: round1(avg(values)), rated: values.length };
  });

  return {
    criteria: criteriaOut,
    items: itemsOut,
    summary: {
      score: round1(avg(rawItemScores)),
      item_count: items.length,
      criteria_count: criteria.length,
      rated_items: rawItemScores.length,                      // at least one score
      complete_items: itemsOut.filter(i => i.complete).length, // every criterion scored
    },
  };
}
