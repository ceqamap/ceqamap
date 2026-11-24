/**
 * Run the project pages job (src/jobs/pages.ts) from the experiment workflow,
 * e.g. on a branch before the Project pages workflow exists on main.
 * Saves to state/pages.json like the scheduled job.
 *
 *   PAGES_MINUTES=100 EXPLAIN=2026040250 node scripts/fetch-pages.ts   (EXPLAIN: fetch these first)
 */
process.argv.push('--minutes', process.env.PAGES_MINUTES ?? '100', '--first', process.env.EXPLAIN ?? '');
await import('../src/jobs/pages.ts');
