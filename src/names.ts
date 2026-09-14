import { createHash } from 'node:crypto';

/**
 * A job is a person, not a serial number.
 *
 * An agent that says "Nadia is reviewing the importer" is read at a glance;
 * "job j_7f0c…" is not. The name is derived from the job id, so it is stable
 * for the life of that job and identical everywhere it is drawn — terminal,
 * panel, and the parent's own words — without storing a counter anywhere.
 *
 * These are labels, never identity. They do not enter the team record, do not
 * occupy an alias, and two jobs in different sessions may well share one.
 */
const NAMES = [
  'Ada', 'Adrian', 'Agnes', 'Alba', 'Amara', 'Anders', 'Anita', 'Arne',
  'Asha', 'Astrid', 'Aurora', 'Beatriz', 'Bruno', 'Camila', 'Carmen', 'Cato',
  'Cecilia', 'Clara', 'Cyrus', 'Dalia', 'Damian', 'Delia', 'Dmitri', 'Dorian',
  'Edith', 'Elena', 'Elias', 'Eloise', 'Emeka', 'Enzo', 'Esme', 'Ezra',
  'Farah', 'Felix', 'Fiona', 'Florian', 'Frida', 'Gabriel', 'Gemma', 'Gideon',
  'Greta', 'Hana', 'Harun', 'Hedda', 'Helena', 'Hugo', 'Ida', 'Ilse',
  'Imani', 'Ines', 'Iris', 'Isabel', 'Ivan', 'Jasper', 'Jonas', 'Juno',
  'Kaia', 'Kamil', 'Karim', 'Kasper', 'Keziah', 'Klara', 'Lars', 'Leila',
  'Lena', 'Leonid', 'Linnea', 'Livia', 'Lorenzo', 'Lucia', 'Lukas', 'Maeve',
  'Magnus', 'Maia', 'Malik', 'Marisol', 'Marta', 'Mateo', 'Mira', 'Nadia',
  'Nadir', 'Nasim', 'Nils', 'Nina', 'Noor', 'Nuria', 'Octavia', 'Olga',
  'Omar', 'Oscar', 'Otto', 'Paloma', 'Pascal', 'Petra', 'Pia', 'Quentin',
  'Rafael', 'Ramona', 'Rania', 'Rasmus', 'Renata', 'Rhea', 'Rosa', 'Rudolf',
  'Sabine', 'Salma', 'Samir', 'Sanna', 'Selma', 'Sergei', 'Sibylla', 'Sofia',
  'Solveig', 'Stefan', 'Sven', 'Tamar', 'Tariq', 'Thea', 'Theo', 'Tomas',
  'Ursula', 'Vera', 'Viktor', 'Vivian', 'Wanda', 'Yara', 'Yusuf', 'Zora',
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
