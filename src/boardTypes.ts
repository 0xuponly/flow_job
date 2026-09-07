// Board variants that share a single checkbox in the picker. A variant
// name maps to its group's display label (the canonical board name); a
// board with no variant maps to itself. The persisted selection and the
// scan payload keep using individual board names — this map only
// changes how the picker renders and counts them, so ticking "Indeed"
// selects both "Indeed" and "Indeed (RSS)" and the scan runs both.
export const BOARD_GROUP_OF: Record<string, string> = {
  'Indeed (RSS)': 'Indeed',
  'Indeed Canada (RSS)': 'Indeed Canada',
  'ZipRecruiter (RSS)': 'ZipRecruiter',
  'We Work Remotely (RSS)': 'We Work Remotely',
  'Remotive (API)': 'Remotive',
  'WorkBC (API)': 'WorkBC',
  'Job Bank GC (API)': 'Job Bank (GC)'
}

// Display group for a board name: the variant's canonical label, or
// the name itself when the board has no variant.
export function groupOf(name: string): string {
  return BOARD_GROUP_OF[name] ?? name
}

// Red "frequent error" flag: a board is failing when its last 2 or
// more CONSECUTIVE health entries are all strictly negative (i.e. the
// board ERRORED on 2+ scans in a row). A zero-find, no-error scan
// records 0, which breaks the streak — legitimately finding no jobs is
// not an error, and such boards must not go red. History is oldest-
// first (recordBoardResults pushes), so the newest entries are at the
// end of the array.
export function isFrequentErrorBoard(history: number[]): boolean {
  let streak = 0
  for (let i = history.length - 1; i >= 0 && history[i] < 0; i--) streak++
  return streak >= 2
}

// Expand failing board names to the full member list of their picker
// group. The red "frequent errors" flag is group-level (the checkbox
// goes red when ANY member is failing), so the "+/- Errors" bulk
// button must toggle whole checkbox units — toggling only the failing
// variant would leave the group partially selected and visually
// unchecked. Names not present in `boards` (settings-disabled or
// removed) are dropped; output is deduped and sorted.
export function expandFailingToGroups(failing: string[], boards: { name: string }[]): string[] {
  const membersByGroup = new Map<string, string[]>()
  for (const b of boards) {
    const g = groupOf(b.name)
    const members = membersByGroup.get(g)
    if (members) members.push(b.name)
    else membersByGroup.set(g, [b.name])
  }
  const groups = new Set(failing.map(groupOf).filter((g) => membersByGroup.has(g)))
  const out: string[] = []
  for (const g of groups) out.push(...membersByGroup.get(g)!)
  return out.sort()
}

// Group-based selection summary for a board list. Registry entries in
// the same group collapse into one selectable unit; a group counts as
// selected only when EVERY member is selected, matching the picker's
// "two states, not three" toggle (clicking a partial group completes
// it, clicking a full group clears it).
export function groupSelection(boards: { name: string }[], selected: Set<string>): { selected: number; total: number } {
  const membersByGroup = new Map<string, string[]>()
  for (const b of boards) {
    const g = groupOf(b.name)
    const members = membersByGroup.get(g)
    if (members) members.push(b.name)
    else membersByGroup.set(g, [b.name])
  }
  let selectedCount = 0
  for (const members of membersByGroup.values()) {
    if (members.every((n) => selected.has(n))) selectedCount++
  }
  return { selected: selectedCount, total: membersByGroup.size }
}

// Classification of job boards by category. A board is listed under a
// category ONLY if it is exclusively that type (general job boards that
// include crypto jobs are not classified as Crypto, etc).
export const BOARD_TYPES: { label: string; boards: string[] }[] = [
  {
    label: 'Crypto',
    boards: [
      'Cryptorecruit',
      'Cryptocurrency Jobs',
      'CryptoJobsList',
      'cryptojobs.com',
      'Crypto.jobs',
      'Web3.career',
      'Braintrust'
    ]
  },
  {
    label: 'Remote',
    boards: [
      'Remote OK',
      'We Work Remotely',
      'We Work Remotely (RSS)',
      'Remotive',
      'Remotive (API)',
      'Remote.co',
      'Working Nomads',
      'JustRemote',
      'Remote3',
      'Hiring Cafe',
      'Sprout',
      'Contra',
      'SkipTheDrive',
      'Jobspresso',
      'Dynamite Jobs',
      'DailyRemote',
      'NoDesk',
      'Remote100k',
      'FlexJobs',
      'Virtual Vocations',
      'Pangian',
      'PowerToFly',
      'Career Vault',
      'Remote Rocketship'
    ]
  },
  {
    label: 'Startup',
    boards: [
      'Startup.jobs',
      'Built In',
      'Built In Toronto',
      'Built In Vancouver',
      'Wellfound',
      'Y Combinator',
      'Top Startups',
      'Rocketships',
      'Arc',
      'Work At A Startup'
    ]
  },
  {
    label: 'Canadian',
    boards: [
      'Indeed Canada',
      'Job Bank (GC)',
      'Job Bank GC (API)',
      'Eluta.ca',
      'Workopolis',
      'Jobboom',
      'WorkBC',
      'WorkBC (API)',
      'CareerBeacon',
      'Vancouver Jobs',
      'UToronto'
    ]
  },
  {
    label: 'Healthcare',
    boards: [
      'Northern Health',
      'Interior Health'
    ]
  },
  {
    label: 'Nonprofit',
    boards: [
      'CharityVillage',
      'Idealist'
    ]
  }
]
