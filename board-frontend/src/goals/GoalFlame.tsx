export function GoalFlame({ level }: { level: 1 | 2 | 3 }) {
  return <span data-goal-flame data-flame-level={level} className="goal-flame" aria-hidden="true">
    <svg viewBox="0 0 40 44" preserveAspectRatio="none">
      <path d="M0 44V25Q4 30 5 15Q9 23 11 4Q20 17 19 23Q26 14 25 0Q38 16 34 27Q39 22 40 16V44Z" fill="currentColor" />
    </svg>
  </span>;
}
