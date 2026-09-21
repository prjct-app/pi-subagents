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
  // Spider-Verse — Miles Morales.
  'Miles', 'Gwen', 'Peter B.', 'Miguel', 'Hobie', 'Pavitr', 'Peni', 'Margo',
  'Jess Drew', 'Spider-Noir', 'Spider-Ham', 'Mayday', 'Ben Reilly', 'Lyla',
  'Rio', 'Jefferson', 'Aaron', 'Ganke', 'Spot', 'Olivia', 'Kingpin',
  'Peter Porker', 'Spider-Byte', 'Spider-Rex', 'Web-Slinger', 'Sun-Spider',
  'Spider-UK', 'Scarlet Spider', 'Superior Spider', 'Cosmic Spider',

  // The wider Marvel universe.
  'Tony', 'Steve', 'Natasha', 'Bruce', 'Thor', 'Loki', 'Wanda', 'Vision',
  'Carol', 'Kamala', 'Monica', 'Shuri', "T'Challa", 'Okoye', 'Nakia', "M'Baku",
  'Sam', 'Bucky', 'Clint', 'Kate', 'Yelena', 'Rhodey', 'Pepper', 'Happy',
  'Stephen', 'Wong', 'Clea', 'America', 'Scott', 'Hope', 'Hank', 'Janet',
  'Cassie', 'Shang-Chi', 'Xialing', 'Katy', 'Matt', 'Foggy', 'Elektra', 'Frank',
  'Jessica', 'Luke', 'Danny', 'Colleen', 'Marc', 'Steven', 'Layla', 'Blade',
  'Peter', 'MJ', 'Ned', 'May', 'Felicia', 'Otto', 'Norman', 'Harry',
  'Eddie', 'Venom', 'Carnage', 'Rocket', 'Groot', 'Gamora', 'Drax', 'Mantis',
  'Nebula', 'Quill', 'Adam', 'Yondu', 'Cosmo', 'Reed', 'Sue', 'Johnny',
  'Ben Grimm', 'Victor', 'Charles', 'Erik', 'Logan', 'Ororo', 'Jean', 'Cyclops',
  'Rogue', 'Remy', 'Kurt', 'Kitty', 'Bobby', 'Jubilee', 'Laura', 'Wade',
  'Cable', 'Domino', 'Bishop', 'Forge', 'Agatha', 'Pietro', 'Riri', 'Namor',
  'Sersi', 'Ikaris', 'Thena', 'Druig', 'Phastos', 'Kingo', 'Ajak', 'Sprite',
  'Moon Girl', 'Devil Dinosaur', 'Squirrel Girl', 'Ms. Marvel', 'She-Hulk',
  'Daredevil', 'Punisher', 'Moon Knight', 'Black Panther', 'Captain Marvel',
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
