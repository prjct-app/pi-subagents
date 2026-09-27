import { createHash } from 'node:crypto';

/**
 * A job is a person, not a serial number.
 *
 * An agent that says "Miles is reviewing the importer" is read at a glance;
 * "job j_7f0c…" is not. The name is derived from the job id, so it is stable
 * for the life of that job and identical everywhere it is drawn — terminal,
 * panel, and the parent's own words — without storing a counter anywhere.
 *
 * These are labels, never identity. They do not enter the team record, do not
 * occupy an alias, and two jobs in different sessions may well share one.
 */
const NAMES = [
  // The Matrix (1999).
  'Neo', 'Trinity', 'Morpheus', 'Smith', 'Oracle', 'Cypher', 'Tank', 'Dozer',
  'Apoc', 'Mouse', 'Switch', 'Agent Brown', 'Agent Jones', 'Spoon Boy', 'DuJour',

  // The Matrix Reloaded and The Matrix Revolutions.
  'Niobe', 'Link', 'Keymaker', 'Persephone', 'Merovingian', 'Architect', 'Seraph',
  'Mifune', 'Zee', 'Cas', 'Vector', 'Hamann', 'Ballard', 'Lock', 'West', 'Soren',
  'Ghost', 'Bane', 'Kid', 'Abel', 'Axel', 'Maggie', 'Agent Johnson', 'Agent Jackson',
  'Agent Thompson', 'Twins', 'Sati', 'Rama Kandra', 'Kamala', 'Trainman', 'Roland',
  'Deus Ex Machina', 'AK', 'Wirtz',

  // The Matrix Resurrections.
  'Bugs', 'Analyst', 'Gwyn de Vere', 'Freya', 'Sequoia', 'Berg', 'Lexy', 'Sheperd',
  'Echo', 'Jude', 'Calliope', 'Astra', 'Chad',

  // The Animatrix.
  'Thadeus', 'Jue', 'Robbie', 'B1-66ER', 'Cis', 'Duo', 'Kaiser', 'Dan Davis',
  'Yoko', 'Yuki', 'Pudgy', 'Manabu', 'Masa', 'Misha', 'Kenny', 'Sara', 'Ash',
  'Clarence', 'Alexa', 'Nonaka', 'Chyron', 'Raul', 'Rox', 'Sandro',

  // Enter the Matrix, The Matrix Online.
  'Sparks', 'Binary', 'Ice', 'Corrupt', 'Malachi', 'Cain', 'Vlad', 'Cujo',
  'Shimada', 'Cryptos', 'Veil',

  // The Matrix Comics.
  'Saga', 'Drummond', 'Krause', 'Dez', 'Mia', 'Marlowe', 'Tiera', 'Eight Ball',
  'Charon', 'Duncan', 'Hope', 'Goliath', 'Sandra', 'Susan', 'Johnny', 'Fria', 'Agent Fine',
] as const;

/** Deterministic: the same job is the same person on every repaint. */
export function nameFor(jobId: string): string {
  const digest = createHash('sha256').update(`pi-subagents:job:${jobId}`).digest();
  return NAMES[digest.readUInt32BE(0) % NAMES.length];
}

/**
 * Two live jobs sharing a name would make a status line ambiguous, so a
 * collision walks the list rather than appending a digit: a person keeps
 * reading as a person.
 */
export function distinctName(jobId: string, taken: readonly string[]): string {
  const digest = createHash('sha256').update(`pi-subagents:job:${jobId}`).digest();
  const start = digest.readUInt32BE(0) % NAMES.length;
  const free = NAMES.findIndex((_, step) => !taken.includes(NAMES[(start + step) % NAMES.length]));
  return free < 0 ? NAMES[start] : NAMES[(start + free) % NAMES.length];
}

export const NAME_COUNT = NAMES.length;
